import { Injectable, Logger } from '@nestjs/common';
import type { ImportItem, ImportJob } from '../../generated/prisma/client.js';
import { asRecord } from '../../common/record-values.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { AiService } from '../../lib/ai/ai.service.js';
import { AiError, type AiInputFile } from '../../lib/ai/ai.types.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { DocumentReaderService, MAX_PAGES, type ReadResult } from '../../lib/documents/document-reader.service.js';
import { QueueProcessor, QueueWorker, type QueueJobContext } from '../../lib/queue/queue.decorator.js';
import { DocumentTypesService } from '../document-settings/document-types.service.js';
import { FILE_TYPES, extensionOf } from '../files/files.constants.js';
import { FilesService } from '../files/files.service.js';
import { baseName } from './classification-rules.js';
import { CLASSIFY_INSTRUCTIONS, COMMON_INSTRUCTIONS, KIND_SPECS, blockConfidence, buildExtractionSchema, classificationSchema, readAnswer, type ReadAnswer } from './document-kinds.js';
import { DocumentEvaluatorService } from './document-evaluator.service.js';
import { DocumentFilingService } from './document-filing.service.js';
import { DocumentMatcherService } from './document-matcher.service.js';
import { DOC_TYPES, IMPORT_FILE_PURPOSE, QUEUE_FILE, type ItemConfidence, type ItemWarning } from './imports.constants.js';
import { ImportActorService } from './import-actor.service.js';
import { ImportLookupsService } from './import-lookups.service.js';
import { ImportsService } from './imports.service.js';
import { ItemDataService } from './item-data.service.js';
import { parseDutchDate } from './value-coercion.js';

/** A scanned PDF with more pages than this is not sent to the AI (it would cost a lot and rarely be one document). */
const MAX_AI_PAGES = 15;
/** How much of a document's text goes along with the question. */
const CLASSIFY_CHARACTERS = 2_500;
const EXTRACT_CHARACTERS = 24_000;
/** How much of the message a file came with (the AI inbox) goes along with it, as a hint of what it is. */
const MESSAGE_CHARACTERS = 1_500;

/** Reasons the AI was not asked, that are no problem: the office has it off, or has no key yet. */
const QUIET_REASONS = new Set(['ai_not_configured', 'ai_disabled', 'ai_feature_off']);

interface Classification {
  doc_type: string;
  confidence: number;
  client_name: string | null;
  person_name: string | null;
  document_date: string | null;
  summary: string;
}

const warning = (code: string, level: ItemWarning['level'], params?: ItemWarning['params']): ItemWarning => ({ code, level, ...(params && { params }) });

/**
 * Reads one file of an import: where it was put says a lot (a client folder, a worker, a date), then — only when that is not enough, and the AI is
 * on — the AI sorts it and reads its details. The result is an item waiting in the review list; nothing is saved to any record. Every file is one
 * job on the queue; a rate limit or an outage of the AI is tried again later with a growing wait, and when the AI cannot help at all the file is
 * still sorted by its folder and name, with a note saying so.
 */
@QueueProcessor()
@Injectable()
export class DocumentPipelineService {
  private readonly logger = new Logger(DocumentPipelineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly reader: DocumentReaderService,
    private readonly ai: AiService,
    private readonly matcher: DocumentMatcherService,
    private readonly evaluator: DocumentEvaluatorService,
    private readonly imports: ImportsService,
    private readonly actors: ImportActorService,
    private readonly lookups: ImportLookupsService,
    private readonly data: ItemDataService,
    private readonly filing: DocumentFilingService,
    private readonly documentTypeList: DocumentTypesService,
  ) {}

  @QueueWorker({ queue: QUEUE_FILE, retryLimit: 3, retryDelaySeconds: 30, expireSeconds: 600, concurrency: { setting: 'ai.concurrency' } })
  async handle(payload: { itemId?: string }, job: QueueJobContext): Promise<void> {
    if (payload.itemId) await this.process(payload.itemId, job.isLastAttempt);
  }

  async process(itemId: string, lastAttempt: boolean): Promise<void> {
    const item = await this.prisma.importItem.findUnique({ where: { id: itemId } });
    if (!item || item.kind !== 'file') return;
    const job = await this.prisma.importJob.findUnique({ where: { id: item.jobId } });
    if (!job) return;
    if (job.status === 'cancelled') {
      await this.prisma.importItem.updateMany({ where: { id: itemId, status: 'pending' }, data: { status: 'skipped', message: 'cancelled' } });
      return;
    }
    // Paused (or not started): the file waits; starting again puts it on the queue again.
    if (job.status !== 'processing') return;
    const claimed = await this.prisma.importItem.updateMany({ where: { id: itemId, status: 'pending' }, data: { status: 'processing', attempts: { increment: 1 } } });
    if (!claimed.count) return;

    try {
      const principal = await this.actors.principal(job.createdById);
      if (!principal) {
        await this.imports.saveItem(itemId, { status: 'error', message: 'user_inactive' });
      } else {
        await this.actors.runAs(principal, () => this.read(item, job, principal, lastAttempt));
      }
    } catch (error) {
      if (error instanceof AiError && error.retryable && !lastAttempt) {
        // Back to waiting: the queue tries again after a pause.
        await this.prisma.importItem.update({ where: { id: itemId }, data: { status: 'pending' } });
        throw error;
      }
      this.logger.warn(`Reading ${item.path || item.name} failed: ${(error as Error).message}`);
      await this.imports.saveItem(itemId, { status: 'error', message: error instanceof AiError ? error.code : 'unreadable' });
    }
    await this.imports.refresh(item.jobId);
  }

  /* ── One file ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  private async read(item: ImportItem, job: ImportJob, principal: AuthenticatedUser, lastAttempt: boolean): Promise<void> {
    const options = asRecord(job.options);
    const { file, buffer } = await this.files.bytes(item.fileId!);
    const extension = extensionOf(file.name);
    const warnings: ItemWarning[] = [];
    // A file sent to the AI inbox comes with a message ("the ID of the new worker of 1203"): it helps to tell what the file is.
    const message = typeof options.instruction === 'string' ? options.instruction.trim().slice(0, MESSAGE_CHARACTERS) : '';

    // A file that is in the system already (the same content) is not read again.
    if (options.skipKnownFiles !== false && item.sha256) {
      const known = await this.prisma.storedFile.findFirst({ where: { sha256: item.sha256, isActive: true, id: { not: file.id }, purpose: { not: IMPORT_FILE_PURPOSE } }, select: { name: true } });
      if (known) {
        await this.imports.saveItem(item.id, { status: 'skipped', message: 'duplicate', warnings: [warning('duplicate_known', 'info', { name: known.name })] });
        return;
      }
      const earlier = await this.prisma.importItem.findFirst({ where: { jobId: job.id, sha256: item.sha256, id: { not: item.id }, sortOrder: { lt: item.sortOrder }, status: { notIn: ['error', 'skipped'] } }, select: { name: true } });
      if (earlier) {
        await this.imports.saveItem(item.id, { status: 'skipped', message: 'duplicate_in_import', warnings: [warning('duplicate_in_import', 'info', { name: earlier.name })] });
        return;
      }
    }

    // What the path says.
    const hints = await this.filing.hints(item);
    // A client chosen for the whole import — or by a person for this file when it is read again — comes before what the path says.
    let clientId = typeof options.clientId === 'string' ? options.clientId : item.clientId;
    if (!clientId) {
      const found = await this.matcher.clientByNumbers(hints.clientNumbers);
      clientId = found?.id ?? null;
      if (found) warnings.push(warning('client_from_path', 'info', { client: `${found.number} – ${found.name}` }));
    }
    const unknownClientNumber = clientId ? null : (hints.clientNumbers.find(number => /^[A-Za-z]{0,3}[-.]?\d+[A-Za-z]?$/.test(number)) ?? null);
    if (unknownClientNumber) warnings.push(warning('client_unknown_number', 'attention', { number: unknownClientNumber }));

    // A type chosen by a person ("read again as a contract") is not questioned.
    let docType = item.docType ?? hints.docType;
    let docDate = hints.docDate;
    const chosen = item.docType !== null;
    const matchNames: string[] = [];
    const matchKvks: string[] = [];
    const scores: number[] = [];

    // What the file holds.
    const content = await this.reader.read(buffer, extension);
    const aiPossible = options.readWithAi !== false && this.ai.isEnabled() && file.size <= this.ai.maxFileBytes() && this.readableByAi(content);
    if (options.readWithAi !== false && this.ai.isEnabled() && !aiPossible) {
      warnings.push(warning(file.size > this.ai.maxFileBytes() ? 'ai_file_too_large' : content.kind === 'pdf' && (content.pages ?? 0) > MAX_AI_PAGES ? 'ai_too_many_pages' : 'ai_not_readable', 'info'));
    }

    // Sorting: the rules first; the AI only for what they could not place with certainty.
    const types = await this.documentTypes();
    let classification: Classification | null = null;
    if (aiPossible && !chosen && (!docType || !hints.strong) && this.ai.isEnabled('classify')) {
      try {
        classification = await this.classify(item, file.name, buffer, content, types, principal, message);
      } catch (error) {
        this.noteAiProblem(error, warnings, lastAttempt);
      }
    }
    if (classification) {
      const sure = Math.min(1, Math.max(0, classification.confidence / 100));
      scores.push(sure);
      if (types.includes(classification.doc_type) && (!docType || sure >= 0.6)) docType = classification.doc_type;
      if (sure < this.ai.confidenceThreshold()) warnings.push(warning('type_unsure', 'attention'));
      docDate ??= (classification.document_date ? parseDutchDate(classification.document_date) : null) ?? null;
      if (classification.client_name) matchNames.push(classification.client_name);
    }
    if (docType && !types.includes(docType)) docType = types.includes(DOC_TYPES.other) ? docType : null;
    // Without the AI the person types what it would have read: the file says why its fields are empty (a budget that ran out is said where it happens).
    if (options.readWithAi !== false && !this.ai.isEnabled() && (!docType || KIND_SPECS[docType])) {
      warnings.push(warning('ai_unavailable', 'info', { reason: this.ai.isConfigured() ? 'ai_disabled' : 'ai_not_configured' }));
    }

    // Reading the details of what was recognised.
    let answer: ReadAnswer | null = null;
    const spec = docType ? KIND_SPECS[docType] : undefined;
    if (spec && aiPossible && this.ai.isEnabled(spec.feature)) {
      try {
        answer = await this.extract(item, file.name, buffer, content, spec, principal, message);
      } catch (error) {
        this.noteAiProblem(error, warnings, lastAttempt);
      }
    }
    if (answer) {
      if (answer.score !== null) scores.push(answer.score);
      // The blocks that are not forms (invoice, sheet, letter …) state their own confidence.
      for (const key of ['invoice', 'sheet', 'letter', 'extract', 'employer']) {
        const sure = blockConfidence(answer.extras[key]);
        if (answer.extras[key] !== undefined && sure > 0) scores.push(sure);
      }
      for (const [field, message] of Object.entries(answer.problems)) warnings.push({ code: 'value_unreadable', level: 'attention', field, params: { message } });
      const employer = asRecord(answer.extras.employer);
      if (typeof employer.name === 'string') matchNames.push(employer.name);
      if (typeof employer.kvk === 'string') matchKvks.push(employer.kvk);
      const recipient = asRecord(answer.extras.recipient);
      if (typeof recipient.name === 'string') matchNames.push(recipient.name);
      if (typeof recipient.kvk === 'string') matchKvks.push(recipient.kvk);
      const kvkValue = answer.sections.client?.kvk;
      if (typeof kvkValue === 'string') matchKvks.push(kvkValue);
    }

    const extract = asRecord(answer?.extras.extract);
    // The first day, the job, the wage the message of an inbox gives for the new worker whose ID this is.
    const employment = asRecord(options.employment);
    const identity = docType === DOC_TYPES.idDocument || docType === DOC_TYPES.residencePermit;
    const evaluation = await this.evaluator.evaluate({
      principal,
      docType,
      data: { ...answer?.sections, ...(identity && Object.keys(employment).length && { employee: employment }) },
      confidence: answer?.confidence ?? {},
      clientId,
      employeeId: null,
      personId: null,
      action: null,
      fresh: true,
      // The worker a message names stands in for the worker's folder a file has no folder for.
      hints: { workerFolder: hints.workerFolder ?? (typeof options.workerName === 'string' ? options.workerName : null), stopped: hints.stopped, unknownClientNumber },
      match: { clientNames: matchNames, clientKvks: matchKvks },
      extras: answer?.extras ?? {},
      carried: warnings,
    });

    // The date and the role the document gives (a KvK extract's date, the role of its owner).
    const fileSection = { ...asRecord(evaluation.data.file) };
    const extractDate = typeof extract.extract_date === 'string' ? parseDutchDate(extract.extract_date) : null;
    if (!fileSection.doc_date) {
      const date = extractDate ?? docDate;
      if (date) fileSection.doc_date = date;
    }
    if (typeof extract.person_role === 'string' && !fileSection.person_role) fileSection.person_role = extract.person_role;
    evaluation.data.file = fileSection;

    const confidence: ItemConfidence = answer?.confidence ?? {};
    await this.imports.saveItem(item.id, {
      status: 'review',
      docType: evaluation.docType,
      action: evaluation.action,
      clientId: evaluation.clientId,
      employeeId: evaluation.employeeId,
      personId: evaluation.personId,
      data: evaluation.data,
      confidence,
      score: scores.length ? Math.min(...scores) : null,
      warnings: evaluation.warnings,
      errors: evaluation.errors,
      summary: (evaluation.summary || classification?.summary || '').slice(0, 300),
      message: '',
    });
  }

  /* ── Asking the AI ────────────────────────────────────────────────────────────────────────────────────────────── */

  private readableByAi(content: ReadResult): boolean {
    if (content.kind === 'image') return true;
    if (content.kind === 'pdf') return content.pages !== null && content.pages <= Math.min(MAX_PAGES, MAX_AI_PAGES);
    return content.kind === 'docx' || content.kind === 'text' ? content.text.length > 0 : false;
  }

  /** The file as the AI gets it: an image, or a PDF; a Word file and a text file go along as text. */
  private attachment(name: string, buffer: Buffer, content: ReadResult, detail: AiInputFile['detail']): AiInputFile[] {
    const extension = extensionOf(name);
    if (content.kind === 'image') return [{ kind: 'image', mime: FILE_TYPES[extension]?.mime ?? 'image/jpeg', name, data: buffer, detail }];
    if (content.kind === 'pdf') return [{ kind: 'pdf', mime: 'application/pdf', name, data: buffer, detail }];
    return [];
  }

  /** The message a file came with, as the AI gets it: a hint from the person who sent it, never an instruction. */
  private messageLine(message: string): string {
    return message ? `What the person who sent the file wrote with it (a hint of what it is; it may be about several files):\n"""\n${message}\n"""` : '';
  }

  private async classify(item: ImportItem, name: string, buffer: Buffer, content: ReadResult, types: string[], principal: AuthenticatedUser, message: string): Promise<Classification> {
    const lines = [`File name: ${name}`, item.path.includes('/') ? `Folder: ${item.path.slice(0, item.path.lastIndexOf('/'))}` : '', this.messageLine(message), content.text ? `Text found on the document (the first part):\n${content.text.slice(0, CLASSIFY_CHARACTERS)}` : ''];
    // A document with text is sorted from its text; a scan or a photo is looked at (cheaply: sorting does not need small print).
    const files = content.text ? [] : this.attachment(name, buffer, content, 'low');
    const result = await this.ai.extract<Classification>({
      feature: 'classify',
      tier: 'light',
      instructions: CLASSIFY_INSTRUCTIONS,
      text: lines.filter(Boolean).join('\n'),
      files,
      schemaName: 'classification',
      schema: classificationSchema(types),
      maxOutputTokens: 600,
      itemId: item.id,
      userId: principal.id,
    });
    return result.data;
  }

  private async extract(item: ImportItem, name: string, buffer: Buffer, content: ReadResult, spec: (typeof KIND_SPECS)[string], principal: AuthenticatedUser, message: string): Promise<ReadAnswer | null> {
    const [docs, context] = await Promise.all([this.data.docs(), this.lookups.context()]);
    const built = buildExtractionSchema(spec, docs, principal.matrix, context);
    if (!Object.keys((built.schema.properties as Record<string, unknown>) ?? {}).length) return null;
    // Tables (invoice lines, timesheets) are read from the page itself; everything else from its text when there is any.
    const needsPages = spec.type === DOC_TYPES.staffingInvoice || spec.type === DOC_TYPES.timesheet;
    const files = !content.text || (needsPages && content.kind === 'pdf') ? this.attachment(name, buffer, content, 'high') : [];
    const result = await this.ai.extract<unknown>({
      feature: spec.feature,
      tier: 'main',
      instructions: `${COMMON_INSTRUCTIONS} ${spec.task}`,
      text: [`File name: ${baseName(name)}`, this.messageLine(message), content.text ? `Text found on the document:\n${content.text.slice(0, EXTRACT_CHARACTERS)}` : ''].filter(Boolean).join('\n'),
      files,
      schemaName: `read_${spec.type}`,
      schema: built.schema,
      maxOutputTokens: spec.maxOutputTokens,
      itemId: item.id,
      userId: principal.id,
    });
    return readAnswer(result.data, built, context);
  }

  /** The AI could not be used for this file: said on the item; a problem that may pass (a rate limit) is tried again by the queue. */
  private noteAiProblem(error: unknown, warnings: ItemWarning[], lastAttempt: boolean): void {
    if (!(error instanceof AiError)) throw error;
    if (QUIET_REASONS.has(error.code)) {
      if (!warnings.some(entry => entry.code === 'ai_unavailable')) warnings.push(warning('ai_unavailable', 'info', { reason: error.code }));
      return;
    }
    if (error.retryable && !lastAttempt) throw error;
    // The same reason is said once, however many steps ran into it.
    if (!warnings.some(entry => entry.code === 'ai_failed' && entry.params?.reason === error.code)) warnings.push(warning('ai_failed', 'attention', { reason: error.code }));
  }

  /* ── Lookups ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  private async documentTypes(): Promise<string[]> {
    return (await this.documentTypeList.active()).map(entry => entry.code);
  }
}
