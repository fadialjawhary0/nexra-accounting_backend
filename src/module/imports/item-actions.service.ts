import { ConflictException, ForbiddenException, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import type { ImportItem } from '../../generated/prisma/client.js';
import { AiService } from '../../lib/ai/ai.service.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { DocumentTypesService } from '../document-settings/document-types.service.js';
import { QueueProcessor, QueueWorker } from '../../lib/queue/queue.decorator.js';
import { QueueService } from '../../lib/queue/queue.service.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import { CLIENT_NOTES, DocumentAcceptService, KEPT_NOTES } from './document-accept.service.js';
import type { AcceptAllDto, PatchItemDto } from './dto/imports.dto.js';
import { ImportActorService } from './import-actor.service.js';
import { ACCEPTABLE_STATUSES, FILE_JOB_KINDS, QUEUE_ACCEPT, QUEUE_FILE, auditTypeOf, type ItemSections, type ItemStatus, type ItemWarning } from './imports.constants.js';
import { ImportsService } from './imports.service.js';
import { InboxActionsService } from './inbox-actions.service.js';
import { ItemDataService } from './item-data.service.js';
import { SheetRowsService } from './sheet-rows.service.js';

/** Items a person can still change. */
const EDITABLE: readonly string[] = [...ACCEPTABLE_STATUSES, 'skipped', 'rejected'];

/** A value can be edited here only by someone who may change records of that kind (or, for an action of the inbox, make what it makes). */
const SECTION_EDIT: Record<string, string> = {
  client: 'clients.edit',
  person: 'employees.edit',
  employee: 'employees.edit',
  contract: 'contracts.edit',
  invoice: 'invoices.edit',
  hours: 'hours.edit',
  task: 'tasks.create',
  event: 'calendar.create',
  stop: 'employees.delete',
};

/**
 * What a person does with the items of an import: edit the values in the review list (they are checked again at once), leave a file out, read it
 * again (after the AI was switched on, or as another type of document), accept one — or everything that is safe to accept at once, which runs in
 * the background so a hundred files do not hold up the screen.
 */
@QueueProcessor()
@Injectable()
export class ItemActionsService {
  private readonly logger = new Logger(ItemActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly imports: ImportsService,
    private readonly data: ItemDataService,
    private readonly accept: DocumentAcceptService,
    private readonly rows: SheetRowsService,
    private readonly actors: ImportActorService,
    private readonly queue: QueueService,
    private readonly documentTypes: DocumentTypesService,
    private readonly ai: AiService,
    private readonly inbox: InboxActionsService,
  ) {}

  /** Changes what the person edited; the item is checked again and the answer is the item as the review list shows it. */
  async patch(jobId: string, itemId: string, dto: PatchItemDto, user: AuthenticatedUser) {
    const job = await this.imports.findOrThrow(jobId);
    const item = await this.imports.itemOrThrow(jobId, itemId);
    if (job.status === 'cancelled' || !EDITABLE.includes(item.status)) throw new ConflictException({ code: 'item_not_editable', message: 'This item can no longer be changed.' });
    for (const section of Object.keys(dto.data ?? {})) {
      const capability = SECTION_EDIT[section];
      if (capability && !matrixAllows(user.matrix, capability)) throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this.' });
    }
    const patch: ItemSections = dto.data ? await this.data.onlyKnownKeys(dto.data) : {};

    if (job.kind === 'spreadsheet') {
      const result = await this.rows.revalidate(item, job, user, { data: patch, action: dto.action, employeeId: dto.employeeId, personId: dto.personId, clientId: dto.clientId });
      await this.imports.saveItem(itemId, {
        status: result.status,
        action: result.action,
        data: result.data,
        errors: result.errors,
        warnings: result.warnings,
        summary: result.summary,
        clientId: result.clientId,
        employeeId: result.employeeId,
        personId: result.personId,
        message: result.message,
      });
      return this.imports.item(jobId, itemId, user);
    }

    const merged = ItemDataService.merge(this.data.open(item.data), patch);
    if (item.kind === 'action') {
      const evaluation = await this.inbox.evaluate(item, user, {
        data: merged,
        action: dto.action ?? item.action,
        ...(dto.clientId !== undefined && { clientId: dto.clientId }),
        ...(dto.employeeId !== undefined && { employeeId: dto.employeeId }),
      });
      await this.imports.saveItem(itemId, {
        status: item.status === 'error' || item.status === 'skipped' || item.status === 'rejected' ? 'review' : (item.status as ItemStatus),
        action: evaluation.action,
        clientId: evaluation.clientId,
        employeeId: evaluation.employeeId,
        personId: evaluation.personId,
        data: evaluation.data,
        warnings: evaluation.warnings,
        errors: evaluation.errors,
        summary: evaluation.summary.slice(0, 300),
        message: '',
      });
      return this.imports.item(jobId, itemId, user);
    }
    const evaluation = await this.accept.evaluate(item, user, {
      data: merged,
      docType: dto.docType ?? item.docType,
      action: dto.action ?? item.action,
      // A person's own choice of client, worker or person stands; choosing "none" clears it.
      ...(dto.clientId !== undefined && { clientId: dto.clientId }),
      ...(dto.employeeId !== undefined && { employeeId: dto.employeeId }),
      ...(dto.personId !== undefined && { personId: dto.personId }),
    });
    await this.imports.saveItem(itemId, {
      status: item.status === 'error' || item.status === 'skipped' || item.status === 'rejected' ? 'review' : (item.status as ItemStatus),
      docType: evaluation.docType,
      action: evaluation.action,
      clientId: evaluation.clientId,
      employeeId: evaluation.employeeId,
      personId: evaluation.personId,
      data: evaluation.data,
      warnings: this.keepNotes(item, evaluation.warnings, dto.clientId !== undefined && dto.clientId !== item.clientId),
      errors: evaluation.errors,
      summary: evaluation.summary,
      message: '',
    });
    return this.imports.item(jobId, itemId, user);
  }

  /** What the reading noted about the file itself (the AI was off, the file was a duplicate) stays on the item; what the checking found is replaced. */
  private keepNotes(item: ImportItem, fresh: ItemWarning[], clientChanged: boolean): ItemWarning[] {
    const had = (Array.isArray(item.warnings) ? (item.warnings as unknown as ItemWarning[]) : []).filter(entry => KEPT_NOTES.includes(entry.code) && !(clientChanged && CLIENT_NOTES.includes(entry.code)));
    const codes = new Set(fresh.map(entry => `${entry.code}|${entry.field ?? ''}`));
    return [...fresh, ...had.filter(entry => !codes.has(`${entry.code}|${entry.field ?? ''}`))];
  }

  async reject(jobId: string, itemId: string, user: AuthenticatedUser) {
    const job = await this.imports.findOrThrow(jobId);
    const item = await this.imports.itemOrThrow(jobId, itemId);
    if (job.status === 'cancelled' || !(ACCEPTABLE_STATUSES as readonly string[]).includes(item.status)) throw new ConflictException({ code: 'item_not_editable', message: 'This item can no longer be changed.' });
    await this.imports.saveItem(itemId, { status: 'rejected', reviewedById: user.id });
    await this.audit.log({ action: 'rejected', entityType: auditTypeOf(job.kind), entityId: jobId, entityLabel: job.name, meta: { item: item.name } });
    await this.imports.refresh(jobId);
    return this.imports.item(jobId, itemId, user);
  }

  /** The file is read from the start: after the AI was switched on, a budget was raised, or as the type of document the person says it is. */
  async reread(jobId: string, itemId: string, user: AuthenticatedUser, docType?: string) {
    const job = await this.imports.findOrThrow(jobId);
    const item = await this.imports.itemOrThrow(jobId, itemId);
    if (!FILE_JOB_KINDS.includes(job.kind) || item.kind !== 'file' || job.status === 'cancelled' || item.status === 'accepted' || item.status === 'processing') throw new ConflictException({ code: 'item_not_editable', message: 'This item cannot be read again.' });
    this.imports.assertQueue();
    if (docType && !(await this.documentTypes.isUsable(docType))) {
      throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { docType: 'validation.selectOption' } });
    }
    await this.imports.saveItem(itemId, { status: 'pending', docType: docType ?? null, action: null, data: {}, confidence: {}, score: null, warnings: [], errors: {}, result: null, message: '', summary: '', employeeId: null, personId: null });
    if (job.status === 'done' || job.status === 'ready') await this.prisma.importJob.update({ where: { id: jobId }, data: { status: 'processing', activity: 'reading', finishedAt: null } });
    if (job.status !== 'paused') await this.queue.send(QUEUE_FILE, { itemId });
    return this.imports.item(jobId, itemId, user);
  }

  async acceptOne(jobId: string, itemId: string, user: AuthenticatedUser) {
    const job = await this.imports.findOrThrow(jobId);
    if (!FILE_JOB_KINDS.includes(job.kind)) throw new ConflictException({ code: 'import_not_documents', message: 'Rows of a spreadsheet are saved together.' });
    if (job.status === 'cancelled') throw new ConflictException({ code: 'import_finished', message: 'This import has been cancelled.' });
    const item = await this.imports.itemOrThrow(jobId, itemId);
    if (item.kind === 'action') await this.inbox.accept(item, user);
    else await this.accept.accept(item, user);
    await this.imports.refresh(jobId);
    return this.imports.item(jobId, itemId, user);
  }

  /** Accepts the items that are safe — or the ones that were chosen — in the background. */
  async acceptAll(jobId: string, dto: AcceptAllDto, user: AuthenticatedUser) {
    const job = await this.imports.findOrThrow(jobId);
    if (!FILE_JOB_KINDS.includes(job.kind)) throw new ConflictException({ code: 'import_not_documents', message: 'Rows of a spreadsheet are saved together.' });
    if (!['ready', 'processing'].includes(job.status)) throw new ConflictException({ code: 'import_not_running', message: 'There is nothing to accept now.' });
    this.imports.assertQueue();
    const waiting = await this.prisma.importItem.count({ where: { jobId, status: 'review', ...(dto.itemIds?.length && { id: { in: dto.itemIds } }) } });
    if (!waiting) throw new UnprocessableEntityException({ code: 'import_nothing_to_accept', message: 'There is nothing to accept.' });
    await this.prisma.importJob.update({
      where: { id: jobId },
      data: { status: 'processing', activity: 'accepting', options: { ...((job.options ?? {}) as object), acceptIds: dto.itemIds ?? null, runBy: user.id } },
    });
    await this.queue.send(QUEUE_ACCEPT, { jobId });
    await this.audit.log({ action: 'accepted', entityType: auditTypeOf(job.kind), entityId: jobId, entityLabel: job.name, meta: { chosen: dto.itemIds?.length ?? 'all safe' } });
    return this.imports.get(jobId);
  }

  @QueueWorker({ queue: QUEUE_ACCEPT, retryLimit: 1, retryDelaySeconds: 30, expireSeconds: 3600, concurrency: 1 })
  async handleAccept(payload: { jobId?: string }): Promise<void> {
    if (payload.jobId) await this.runAccept(payload.jobId);
  }

  private async runAccept(jobId: string): Promise<void> {
    const job = await this.prisma.importJob.findUnique({ where: { id: jobId } });
    if (!job || job.status !== 'processing' || job.activity !== 'accepting') return;
    const options = (job.options ?? {}) as { acceptIds?: string[] | null; runBy?: string };
    const principal = (options.runBy ? await this.actors.principal(options.runBy) : null) ?? (await this.actors.principal(job.createdById));
    if (!principal) return this.imports.fail(jobId, 'ready', 'user_inactive');
    const chosen = options.acceptIds?.length ? new Set(options.acceptIds) : null;
    const threshold = this.ai.confidenceThreshold();
    try {
      await this.actors.runAs(principal, async () => {
        const items = await this.prisma.importItem.findMany({ where: { jobId, status: 'review', ...(chosen && { id: { in: [...chosen] } }) }, orderBy: { sortOrder: 'asc' } });
        for (const item of items) {
          const current = await this.prisma.importItem.findUnique({ where: { id: item.id } });
          if (!current || current.status !== 'review') continue;
          const action = current.kind === 'action';
          if (!chosen) {
            // Without a choice only what needs no second look is accepted: nothing wrong, nothing to decide, and sure enough.
            const evaluation = action ? await this.inbox.evaluate(current, principal) : await this.accept.evaluate(current, principal);
            const attention = evaluation.warnings.some(entry => entry.level === 'attention');
            const sure = current.score === null || current.score >= threshold;
            if (Object.keys(evaluation.errors).length || attention || !sure || evaluation.action === 'skip') continue;
          }
          try {
            if (action) await this.inbox.accept(current, principal);
            else await this.accept.accept(current, principal);
          } catch (error) {
            // An item that cannot be accepted stays in the list with what is wrong; the rest goes on.
            this.logger.debug(`Item ${item.name} was not accepted: ${(error as Error).message}`);
          }
        }
      });
    } finally {
      await this.prisma.importJob.update({ where: { id: jobId }, data: { options: { ...((job.options ?? {}) as object), acceptIds: null } } });
    }
    await this.imports.refresh(jobId);
  }
}
