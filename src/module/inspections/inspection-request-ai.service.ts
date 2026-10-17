import { ConflictException, Injectable, PayloadTooLargeException, UnprocessableEntityException, UnsupportedMediaTypeException } from '@nestjs/common';
import { isValidDay } from '../../common/dates.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import { AiService } from '../../lib/ai/ai.service.js';
import { AiError, type AiInputFile } from '../../lib/ai/ai.types.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { DocumentReaderService, type ReadResult } from '../../lib/documents/document-reader.service.js';
import { DocumentTypesService } from '../document-settings/document-types.service.js';
import { FILE_TYPES, extensionOf } from '../files/files.constants.js';
import { itemLabel } from './checklist-doc.js';
import type { RequestApplyDto } from './dto/inspections.dto.js';
import { InspectionsService } from './inspections.service.js';
import { docOf, isOpen, toDay } from './inspection-rows.js';
import { INSPECTION_ENTITY, INSPECTION_REQUEST_FEATURE, MAX_CUSTOM_ITEMS, MAX_REQUEST_CHARACTERS } from './inspections.constants.js';

const READABLE = new Set(['png', 'jpg', 'jpeg', 'webp', 'pdf', 'docx', 'txt']);
const MAX_PAGES = 20;
const TEXT_CHARACTERS = 20_000;

export interface RequestReading {
  inspectorName: string | null;
  reference: string | null;
  responseDue: string | null;
  /** The things the inspector asks for, in their words; `code` is the line of the checklist it matches (null = the checklist has no such line). */
  lines: Array<{ text: string; code: string | null; label: string | null; dueDate: string | null; confidence: number }>;
  /** The text found in the request (a photo has none), to keep with the inspection. */
  requestText: string;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['inspector', 'reference', 'responseDue', 'lines'],
  properties: {
    inspector: { type: ['string', 'null'] },
    reference: { type: ['string', 'null'] },
    responseDue: { type: ['string', 'null'] },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'code', 'dueDate', 'confidence'],
        properties: { text: { type: 'string' }, code: { type: ['string', 'null'] }, dueDate: { type: ['string', 'null'] }, confidence: { type: 'number' } },
      },
    },
  },
} as const;

interface RawReading {
  inspector: string | null;
  reference: string | null;
  responseDue: string | null;
  lines: Array<{ text: string; code: string | null; dueDate: string | null; confidence: number }>;
}

/**
 * "Read an inspector's request into a checklist" (docs/05): the letter or e-mail of an inspector — a photo, a PDF or pasted text — is read, and the documents it asks for are
 * matched to the lines of the checklist. Only suggestions come out: the person sees them next to the checklist and decides, and nothing is saved until they confirm. Only the
 * request itself and the names of the lines of the checklist go to the AI — no data of the client.
 */
@Injectable()
export class InspectionRequestAiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ai: AiService,
    private readonly reader: DocumentReaderService,
    private readonly types: DocumentTypesService,
    private readonly inspections: InspectionsService,
  ) {}

  available(): boolean {
    return this.ai.isEnabled(INSPECTION_REQUEST_FEATURE);
  }

  async read(id: string, file: Express.Multer.File | undefined, text: string | undefined, user: AuthenticatedUser, locale: AppLocale): Promise<RequestReading> {
    const row = await this.inspections.rowOrThrow(id);
    if (!row.isActive || !isOpen(row)) throw new ConflictException({ code: 'inspection_closed', message: 'This inspection is closed — open it again to change it.' });
    const pasted = (text ?? '').trim();
    if (!file && !pasted) throw new UnprocessableEntityException({ code: 'file_missing', message: 'Choose a file or paste the text of the request.' });

    let content: ReadResult | null = null;
    let attachments: AiInputFile[] = [];
    let name = '';
    if (file) {
      name = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const extension = extensionOf(name);
      if (!READABLE.has(extension) || !FILE_TYPES[extension]?.matches(file.buffer.subarray(0, 4096))) {
        throw new UnsupportedMediaTypeException({ code: 'file_type_not_allowed', message: 'This type of file cannot be read.', details: { allowed: [...READABLE] } });
      }
      if (file.size > this.ai.maxFileBytes()) throw new PayloadTooLargeException({ code: 'file_too_large', message: 'The file is too large for the AI.', details: { maxMegabytes: Math.round(this.ai.maxFileBytes() / 1024 / 1024) } });
      content = await this.reader.read(file.buffer, extension);
      if (content.kind === 'pdf' && content.pages !== null && content.pages > MAX_PAGES) throw new UnprocessableEntityException({ code: 'file_too_large', message: 'The PDF has too many pages to read.' });
      // A photo or a scanned PDF goes to the AI as it is; a document with text went along as text.
      if (!content.text && (content.kind === 'image' || content.kind === 'pdf')) attachments = [{ kind: content.kind, mime: FILE_TYPES[extension]?.mime ?? 'application/pdf', name, data: file.buffer, detail: 'high' }];
    }

    const doc = docOf(row);
    const types = await this.types.codeMap();
    const known = new Map(doc.items.map(item => [item.code, item]));
    const list = doc.items
      .map(item => `${item.code}: ${itemLabel(item, 'nl')}${item.docTypes.length ? ` (${item.docTypes.map(code => (types.get(code) ? DocumentTypesService.nameIn(types.get(code)!, 'nl') : code)).join(', ')})` : ''}`)
      .join('\n');
    const requestText = (content?.text || pasted).slice(0, MAX_REQUEST_CHARACTERS);
    try {
      const result = await this.ask({
        instructions: [
          'A Dutch accounting office received a request from an inspection body (a NEN 4400-1 certifying body, the tax authority or the labour inspectorate) before an inspection.',
          'List every document or piece of information the inspector asks for, one line each, short and in the language of the request.',
          'For each line give the code of the line of the office checklist it matches (the codes are listed below), or null when no line fits.',
          'Also give the name of the inspector, the reference (case or file number) and the day by which the documents must be sent (YYYY-MM-DD), each null when the request does not say.',
          'A line may carry its own day (YYYY-MM-DD) when the request gives one for that document, else null. Confidence is a number from 0 to 1 for how sure you are of the match.',
          'Only use what the request says. Do not invent documents.',
        ].join(' '),
        text: [name ? `File name: ${name}` : '', requestText ? `The request:\n${requestText.slice(0, TEXT_CHARACTERS)}` : '', `Lines of the office checklist:\n${list || '(none)'}`].filter(Boolean).join('\n\n'),
        files: attachments,
        userId: user.id,
      });
      const lines = result.lines
        .filter(line => line.text.trim())
        .slice(0, 60)
        .map(line => {
          const item = line.code ? known.get(line.code) : undefined;
          return { text: line.text.trim().slice(0, 240), code: item?.code ?? null, label: item ? itemLabel(item, locale) : null, dueDate: line.dueDate && isValidDay(line.dueDate) ? line.dueDate : null, confidence: Math.max(0, Math.min(1, Number(line.confidence) || 0)) };
        });
      return {
        inspectorName: result.inspector?.trim().slice(0, 120) || null,
        reference: result.reference?.trim().slice(0, 80) || null,
        responseDue: result.responseDue && isValidDay(result.responseDue) ? result.responseDue : null,
        lines,
        requestText,
      };
    } catch (error) {
      if (error instanceof AiError) throw new UnprocessableEntityException({ code: error.code, message: 'The AI could not read this request.' });
      throw error;
    }
  }

  /**
   * What the person confirmed of the reading: the lines the inspector asked for are switched on and get the inspector's own words as a note (and day), lines the checklist does
   * not have are added as lines of their own, and — when asked — the checklist lines the inspector did not ask for are switched off. The facts (inspector, reference, answer day)
   * and the request text are filed on the inspection.
   */
  async apply(id: string, dto: RequestApplyDto, user: AuthenticatedUser, locale: AppLocale) {
    const row = await this.inspections.rowOrThrow(id);
    if (!row.isActive) throw new ConflictException({ code: 'inspection_inactive', message: 'This inspection is switched off.' });
    if (!isOpen(row)) throw new ConflictException({ code: 'inspection_closed', message: 'This inspection is closed — open it again to change it.' });
    const doc = docOf(row);
    const codes = new Set(doc.items.map(item => item.code));
    const problems: Record<string, string> = {};
    dto.lines.forEach((line, index) => {
      if (line.code && !codes.has(line.code)) problems[`lines.${index}.code`] = 'validation.invalid';
      if (!line.code && !(line.text ?? '').trim()) problems[`lines.${index}.text`] = 'validation.required';
      if (line.dueDate && !isValidDay(line.dueDate)) problems[`lines.${index}.dueDate`] = 'validation.invalid';
    });
    if (dto.responseDue && !isValidDay(dto.responseDue)) problems.responseDue = 'validation.invalid';
    if (Object.keys(problems).length) throw validationFailed(problems);

    const asked = new Map<string, { text: string; dueDate: string | null }>();
    const extra: Array<{ text: string; dueDate: string | null }> = [];
    for (const line of dto.lines) {
      const text = (line.text ?? '').trim();
      if (line.code) asked.set(line.code, { text, dueDate: line.dueDate ?? null });
      else extra.push({ text, dueDate: line.dueDate ?? null });
    }
    const customNow = row.items.filter(item => !item.code).length;
    if (customNow + extra.length > MAX_CUSTOM_ITEMS) throw new ConflictException({ code: 'too_many_lines', message: 'This inspection has as many extra lines as it can hold.' });

    await this.prisma.$transaction(async tx => {
      for (const code of codes) {
        const existing = row.items.find(item => item.code === code);
        const request = asked.get(code);
        if (request) {
          const note = request.text && !(existing?.note ?? '').includes(request.text) ? [existing?.note, `${locale === 'nl' ? 'Gevraagd' : 'Asked'}: ${request.text}`].filter(Boolean).join('\n') : (existing?.note ?? '');
          // The inspector asks for it: the line is switched on, also when its rule ("once a year", "only when switched on") would leave it off. A tick stays.
          const decision = existing?.decision === 'done' ? 'done' : 'asked';
          await tx.inspectionItem.upsert({
            where: { inspectionId_code: { inspectionId: id, code } },
            create: { inspectionId: id, code, decision, note, dueDate: request.dueDate ? toDay(request.dueDate) : null, updatedById: user.id },
            update: { decision, note, ...(request.dueDate && { dueDate: toDay(request.dueDate) }), updatedById: user.id },
          });
        } else if (dto.markOthers && !existing?.decision) {
          await tx.inspectionItem.upsert({
            where: { inspectionId_code: { inspectionId: id, code } },
            create: { inspectionId: id, code, decision: 'not_applicable', note: locale === 'nl' ? 'Niet gevraagd' : 'Not asked for', updatedById: user.id },
            update: { decision: 'not_applicable', note: [existing?.note, locale === 'nl' ? 'Niet gevraagd' : 'Not asked for'].filter(Boolean).join('\n'), updatedById: user.id },
          });
        }
      }
      let order = Math.max(0, ...row.items.map(item => item.sortOrder));
      for (const line of extra) {
        order += 10;
        await tx.inspectionItem.create({ data: { inspectionId: id, code: null, label: line.text.slice(0, 240), dueDate: line.dueDate ? toDay(line.dueDate) : null, sortOrder: order, updatedById: user.id } });
      }
      await tx.inspection.update({
        where: { id },
        data: {
          ...(dto.inspectorName?.trim() && { inspectorName: dto.inspectorName.trim() }),
          ...(dto.reference?.trim() && { reference: dto.reference.trim() }),
          ...(dto.responseDue && { responseDue: toDay(dto.responseDue) }),
          ...(dto.requestText !== undefined && { requestText: dto.requestText.trim().slice(0, MAX_REQUEST_CHARACTERS) }),
        },
      });
    });
    await this.audit.log({
      action: 'updated',
      entityType: INSPECTION_ENTITY,
      entityId: id,
      entityLabel: this.inspections.label(row),
      before: { request: null },
      after: { request: { asked: asked.size, extraLines: extra.length, markedNotAsked: dto.markOthers ? codes.size - asked.size : 0 }, ...(dto.responseDue && { responseDue: dto.responseDue }) },
    });
    return this.inspections.one(id, locale);
  }

  /** One question to the AI, answered in the shape of `SCHEMA`. */
  private async ask(input: { instructions: string; text: string; files: AiInputFile[]; userId: string }): Promise<RawReading> {
    const result = await this.ai.extract<RawReading>({
      feature: INSPECTION_REQUEST_FEATURE,
      tier: 'main',
      instructions: input.instructions,
      text: input.text,
      files: input.files,
      schemaName: 'inspection_request',
      schema: SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: 3000,
      userId: input.userId,
    });
    return result.data;
  }
}
