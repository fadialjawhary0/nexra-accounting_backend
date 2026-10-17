import { ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { paged, type ApiResult } from '../../common/api-result.js';
import { fold } from '../../common/text.js';
import { pageMeta, toSkipTake } from '../../common/pagination.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { Prisma, type ImportItem, type ImportJob, type StoredFile } from '../../generated/prisma/client.js';
import { AiService } from '../../lib/ai/ai.service.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { QueueService } from '../../lib/queue/queue.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { FILE_TYPES, extensionOf } from '../files/files.constants.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { effectiveMatrix, matrixAllows } from '../roles/permission-catalog.js';
import type { CreateDocumentsJobDto, CreateInboxDto, ItemListQuery, JobListQuery } from './dto/imports.dto.js';
import {
  FILE_JOB_KINDS,
  auditTypeOf,
  IMPORTS_NAMESPACE,
  IMPORT_DEFINITIONS,
  ITEM_STATUSES,
  JOB_KINDS,
  JOB_STATUSES,
  QUEUE_ACCEPT,
  QUEUE_FILE,
  QUEUE_INBOX,
  QUEUE_SHEET,
  WORKING_STATUSES,
  type ItemConfidence,
  type ItemResult,
  type ItemSections,
  type ItemStatus,
  type ItemWarning,
  type JobActivity,
  type JobKind,
  type JobStatus,
} from './imports.constants.js';
import { ItemDataService } from './item-data.service.js';

export type JobCounts = Record<ItemStatus | 'total', number>;

const emptyCounts = (): JobCounts => ({ total: 0, ...Object.fromEntries(ITEM_STATUSES.map(status => [status, 0])) }) as JobCounts;
const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const splitList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
/** How many jobs are put on the queue at once when a whole import is started again. */
const ENQUEUE_CHUNK = 100;

/** Job options a person never needs to see. */
const INTERNAL_OPTIONS = new Set(['acceptIds', 'acceptAll']);

/**
 * Imports: the list of jobs, one job with its items, and what happens to a job as a whole — started, paused, cancelled, finished. The work on
 * the items themselves (reading a file, checking a row, accepting) is done by the services next to this one; they report back through `refresh`,
 * which decides when a job is waiting for a person or done, and tells the person who started it.
 */
@Injectable()
export class ImportsService {
  private readonly logger = new Logger(ImportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    private readonly notifications: NotificationsService,
    private readonly data: ItemDataService,
    private readonly settings: SettingsService,
    private readonly ai: AiService,
  ) {
    settings.register(IMPORTS_NAMESPACE, IMPORT_DEFINITIONS, { exposed: true });
    // Work that was waiting when the server stopped is picked up again as soon as the queue is up.
    queue.onReady(() => this.recover());
    ai.onBudgetLevel(async (level, status) => {
      const recipients = await this.recipients('settings.edit');
      await this.notifications.deliver(
        recipients.map(userId => ({
          userId,
          channels: ['in_app', 'email'] as const,
          draft: {
            type: 'ai_budget',
            severity: level === 'exceeded' ? ('critical' as const) : ('warning' as const),
            textKey: level === 'exceeded' ? 'ai.budget_exceeded' : 'ai.budget_warning',
            params: { percent: Math.round(status.percent ?? 0), spent: status.spentUsd.toFixed(2), limit: status.limitUsd },
            link: '/settings/ai',
          },
        })),
      );
    });
  }

  /* ── Reading jobs ─────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The filters of the history list, also used by its export. `mine`: only what this person started (the inbox on the dashboard). */
  jobWhere(query: JobListQuery, userId?: string): Prisma.ImportJobWhereInput {
    const kinds = splitList(query.kind).filter(kind => (JOB_KINDS as readonly string[]).includes(kind));
    const statuses = splitList(query.status).filter(status => (JOB_STATUSES as readonly string[]).includes(status));
    const search = fold(query.search ?? '');
    return {
      ...(kinds.length && { kind: { in: kinds } }),
      ...(statuses.length && { status: { in: statuses } }),
      ...(search && { name: { contains: search, mode: 'insensitive' as const } }),
      ...(query.mine && userId && { createdById: userId }),
    };
  }

  async list(query: JobListQuery, userId?: string): Promise<ApiResult> {
    const where = this.jobWhere(query, userId);
    const [total, rows] = await Promise.all([
      this.prisma.importJob.count({ where }),
      this.prisma.importJob.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...toSkipTake(query) }),
    ]);
    return paged(await this.describeMany(rows), pageMeta(total, query));
  }

  async get(id: string) {
    const job = await this.findOrThrow(id);
    return (await this.describeMany([job]))[0]!;
  }

  async findOrThrow(id: string): Promise<ImportJob> {
    const job = await this.prisma.importJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException({ code: 'not_found', message: 'Import not found' });
    return job;
  }

  /** Jobs as the screens get them: with the people, the file and a counter per status. */
  async describeMany(jobs: ImportJob[]) {
    if (!jobs.length) return [];
    const ids = jobs.map(job => job.id);
    const [grouped, users, files] = await Promise.all([
      this.prisma.importItem.groupBy({ by: ['jobId', 'status'], where: { jobId: { in: ids } }, _count: { _all: true } }),
      this.prisma.user.findMany({ where: { id: { in: [...new Set(jobs.map(job => job.createdById))] } }, select: { id: true, name: true } }),
      this.prisma.storedFile.findMany({ where: { id: { in: jobs.map(job => job.fileId).filter((id): id is string => Boolean(id)) } }, select: { id: true, name: true, size: true } }),
    ]);
    const counts = new Map<string, JobCounts>();
    for (const row of grouped) {
      const entry = counts.get(row.jobId) ?? emptyCounts();
      entry[row.status as ItemStatus] = row._count._all;
      entry.total += row._count._all;
      counts.set(row.jobId, entry);
    }
    const names = new Map(users.map(user => [user.id, user.name]));
    const fileById = new Map(files.map(file => [file.id, file]));
    return jobs.map(job => ({
      id: job.id,
      kind: job.kind as JobKind,
      name: job.name,
      status: job.status as JobStatus,
      activity: job.activity as JobActivity | null,
      target: job.target,
      options: Object.fromEntries(Object.entries(asRecord(job.options)).filter(([key]) => !INTERNAL_OPTIONS.has(key))),
      note: job.note,
      file: job.fileId ? { id: job.fileId, name: fileById.get(job.fileId)?.name ?? '', size: fileById.get(job.fileId)?.size ?? 0 } : null,
      createdBy: { id: job.createdById, name: names.get(job.createdById) ?? '' },
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      counts: counts.get(job.id) ?? emptyCounts(),
    }));
  }

  /* ── Reading items ────────────────────────────────────────────────────────────────────────────────────────────── */

  async items(jobId: string, query: ItemListQuery): Promise<ApiResult> {
    await this.findOrThrow(jobId);
    const statuses = splitList(query.status).filter(status => (ITEM_STATUSES as readonly string[]).includes(status));
    const search = (query.search ?? '').trim();
    const where: Prisma.ImportItemWhereInput = {
      jobId,
      ...(statuses.length && { status: { in: statuses } }),
      ...(query.docType && { docType: query.docType }),
      ...(search && { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { path: { contains: search, mode: 'insensitive' as const } }, { summary: { contains: search, mode: 'insensitive' as const } }] }),
      ...(query.attention && { OR: [{ NOT: { errors: { equals: {} } } }, { NOT: { warnings: { equals: [] } } }] }),
    };
    const [total, rows, grouped] = await Promise.all([
      this.prisma.importItem.count({ where }),
      this.prisma.importItem.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], ...toSkipTake(query) }),
      this.prisma.importItem.groupBy({ by: ['status'], where: { jobId }, _count: { _all: true } }),
    ]);
    const counts = emptyCounts();
    for (const row of grouped) {
      counts[row.status as ItemStatus] = row._count._all;
      counts.total += row._count._all;
    }
    return paged(await this.summaries(rows), pageMeta(total, query, { counts, threshold: this.ai.confidenceThreshold() }));
  }

  /** The lines of the list: what a person needs to pick an item, without the values. */
  async summaries(items: ImportItem[]) {
    const clientIds = [...new Set(items.map(item => item.clientId).filter((id): id is string => Boolean(id)))];
    const clients = clientIds.length ? await this.prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, number: true, name: true } }) : [];
    const byId = new Map(clients.map(client => [client.id, client]));
    return items.map(item => ({
      id: item.id,
      jobId: item.jobId,
      kind: item.kind,
      target: item.target,
      status: item.status as ItemStatus,
      name: item.name,
      path: item.path,
      size: item.size,
      docType: item.docType,
      action: item.action,
      summary: item.summary,
      message: item.message,
      score: item.score,
      fileId: item.fileId,
      client: item.clientId ? (byId.get(item.clientId) ?? null) : null,
      employeeId: item.employeeId,
      personId: item.personId,
      errorCount: Object.keys(asRecord(item.errors)).length,
      warningCount: Array.isArray(item.warnings) ? item.warnings.length : 0,
      result: (item.result as ItemResult[] | null) ?? [],
    }));
  }

  /** One item with everything the review screen shows: the values (those this person may see), the confidence, the problems and the file. */
  async item(jobId: string, itemId: string, user: AuthenticatedUser) {
    const row = await this.itemOrThrow(jobId, itemId);
    const sections = this.data.open(row.data);
    const shown = await this.data.visible(sections, row.confidence as ItemConfidence, user.matrix);
    const [summary] = await this.summaries([row]);
    const file = row.fileId ? await this.prisma.storedFile.findUnique({ where: { id: row.fileId } }) : null;
    const [employee, person] = await Promise.all([
      row.employeeId ? this.prisma.employee.findUnique({ where: { id: row.employeeId }, select: { id: true, person: { select: { firstName: true, lastName: true } }, client: { select: { number: true } } } }) : null,
      row.personId ? this.prisma.person.findUnique({ where: { id: row.personId }, select: { id: true, firstName: true, lastName: true } }) : null,
    ]);
    return {
      ...summary!,
      data: shown.data,
      confidence: shown.confidence,
      warnings: (Array.isArray(row.warnings) ? row.warnings : []) as unknown as ItemWarning[],
      errors: asRecord(row.errors) as Record<string, string>,
      file: file ? this.fileView(file) : null,
      employee: employee ? { id: employee.id, name: `${employee.person.firstName} ${employee.person.lastName}`.trim(), clientNumber: employee.client.number } : null,
      person: person ? { id: person.id, name: `${person.firstName} ${person.lastName}`.trim() } : null,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      threshold: this.ai.confidenceThreshold(),
    };
  }

  fileView(file: StoredFile) {
    return { id: file.id, name: file.name, mimeType: file.mimeType, size: file.size, inline: FILE_TYPES[extensionOf(file.name)]?.inline === true };
  }

  async itemOrThrow(jobId: string, itemId: string): Promise<ImportItem> {
    const row = await this.prisma.importItem.findFirst({ where: { id: itemId, jobId } });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Import item not found' });
    return row;
  }

  /* ── Making and steering jobs ─────────────────────────────────────────────────────────────────────────────────── */

  async createDocumentsJob(dto: CreateDocumentsJobDto, user: AuthenticatedUser) {
    if (dto.clientId && !(await this.prisma.client.findUnique({ where: { id: dto.clientId }, select: { id: true } }))) {
      throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { clientId: 'validation.invalid' } });
    }
    const name = dto.name?.trim() || `Import ${new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }).slice(0, 16)}`;
    const job = await this.prisma.importJob.create({
      data: {
        kind: 'documents',
        name: name.slice(0, 150),
        status: 'draft',
        options: {
          ...(dto.clientId && { clientId: dto.clientId }),
          skipKnownFiles: dto.skipKnownFiles ?? this.settings.get<boolean>(`${IMPORTS_NAMESPACE}.skipKnownFiles`),
          readWithAi: dto.readWithAi ?? true,
        },
        createdById: user.id,
      },
    });
    await this.audit.log({ action: 'created', entityType: 'import', entityId: job.id, entityLabel: job.name, after: { kind: job.kind } });
    return this.get(job.id);
  }

  /**
   * A message to the AI inbox: what the person wants done, in their own words (the files follow, then `start`). Refused straight away when the AI cannot read it now —
   * switched off, not set up, or this month's budget used up — so nobody waits for an answer that cannot come.
   */
  async createInboxJob(dto: CreateInboxDto, user: AuthenticatedUser) {
    const instruction = dto.instruction.trim();
    if (!instruction) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { instruction: 'validation.required' } });
    const reason = !this.ai.isConfigured() ? 'ai_not_configured' : !this.ai.isEnabled() ? 'ai_disabled' : !this.ai.isEnabled('inbox') ? 'ai_feature_off' : (await this.ai.budget()).level === 'exceeded' ? 'ai_budget_exceeded' : null;
    if (reason) throw new UnprocessableEntityException({ code: reason, message: 'The AI cannot read messages now.' });
    // The first line names it in the lists and the notices.
    const first = instruction.split(/\r?\n/).find(line => line.trim())!.trim();
    const job = await this.prisma.importJob.create({
      data: {
        kind: 'inbox',
        name: first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first,
        status: 'draft',
        options: { instruction, skipKnownFiles: this.settings.get<boolean>(`${IMPORTS_NAMESPACE}.skipKnownFiles`), readWithAi: true, message: { status: 'pending' } },
        createdById: user.id,
      },
    });
    await this.audit.log({ action: 'created', entityType: auditTypeOf(job.kind), entityId: job.id, entityLabel: job.name, after: { kind: job.kind } });
    return this.get(job.id);
  }

  /** Starts reading the uploaded files: every file becomes one job on the queue. A message to the inbox is read first (its files after it), and needs no files. */
  async start(id: string) {
    const job = await this.findOrThrow(id);
    if (!FILE_JOB_KINDS.includes(job.kind) || job.status !== 'draft') throw new ConflictException({ code: 'import_not_draft', message: 'This import was started already.' });
    const waiting = await this.prisma.importItem.count({ where: { jobId: id, status: 'pending' } });
    if (!waiting && job.kind === 'documents') throw new UnprocessableEntityException({ code: 'import_no_files', message: 'Add files first.' });
    this.assertQueue();
    if (job.kind === 'inbox') {
      await this.prisma.importJob.update({ where: { id }, data: { status: 'processing', activity: 'understanding', startedAt: new Date() } });
      await this.queue.send(QUEUE_INBOX, { jobId: id });
    } else {
      await this.prisma.importJob.update({ where: { id }, data: { status: 'processing', activity: 'reading', startedAt: new Date() } });
      await this.enqueuePending(id);
    }
    await this.audit.log({ action: job.kind === 'inbox' ? 'sent' : 'started', entityType: auditTypeOf(job.kind), entityId: id, entityLabel: job.name, meta: { files: waiting } });
    return this.get(id);
  }

  /** The AI could not read the message of an inbox (it was off, the budget was used up, it was too busy): it is read again. What it made of it the first time stays. */
  async rereadMessage(id: string) {
    const job = await this.findOrThrow(id);
    const options = asRecord(job.options);
    if (job.kind !== 'inbox' || asRecord(options.message).status !== 'failed' || !['ready', 'done'].includes(job.status)) {
      throw new ConflictException({ code: 'inbox_not_failed', message: 'This message does not need to be read again.' });
    }
    this.assertQueue();
    await this.prisma.importJob.update({ where: { id }, data: { status: 'processing', activity: 'understanding', finishedAt: null, options: { ...options, message: { status: 'pending' } } as Prisma.InputJsonObject } });
    await this.queue.send(QUEUE_INBOX, { jobId: id });
    await this.audit.log({ action: 'reread', entityType: auditTypeOf(job.kind), entityId: id, entityLabel: job.name });
    return this.get(id);
  }

  async pause(id: string) {
    const job = await this.findOrThrow(id);
    // Reading a message takes a moment and cannot be stopped halfway.
    if (job.status !== 'processing' || job.activity === 'understanding') throw new ConflictException({ code: 'import_not_running', message: 'This import is not running.' });
    await this.prisma.importJob.update({ where: { id }, data: { status: 'paused' } });
    await this.audit.log({ action: 'paused', entityType: auditTypeOf(job.kind), entityId: id, entityLabel: job.name });
    return this.get(id);
  }

  async resume(id: string) {
    const job = await this.findOrThrow(id);
    if (job.status !== 'paused') throw new ConflictException({ code: 'import_not_paused', message: 'This import is not paused.' });
    this.assertQueue();
    await this.prisma.importJob.update({ where: { id }, data: { status: 'processing' } });
    await this.enqueuePending(id);
    await this.refresh(id);
    await this.audit.log({ action: 'resumed', entityType: auditTypeOf(job.kind), entityId: id, entityLabel: job.name });
    return this.get(id);
  }

  /** Stops an import: what was not accepted yet is left out. Records that were made stay. */
  async cancel(id: string) {
    const job = await this.findOrThrow(id);
    if (['done', 'cancelled'].includes(job.status)) throw new ConflictException({ code: 'import_finished', message: 'This import has finished.' });
    await this.prisma.$transaction([
      this.prisma.importItem.updateMany({ where: { jobId: id, status: { in: ['pending', 'review', 'ready', 'invalid'] } }, data: { status: 'skipped', message: 'cancelled' } }),
      this.prisma.importJob.update({ where: { id }, data: { status: 'cancelled', activity: null, finishedAt: new Date() } }),
    ]);
    await this.audit.log({ action: 'cancelled', entityType: auditTypeOf(job.kind), entityId: id, entityLabel: job.name });
    return this.get(id);
  }

  /** Puts a job on the queue for every file that is waiting. */
  async enqueuePending(jobId: string): Promise<number> {
    const pending = await this.prisma.importItem.findMany({ where: { jobId, status: 'pending' }, select: { id: true }, orderBy: { sortOrder: 'asc' } });
    for (let index = 0; index < pending.length; index += ENQUEUE_CHUNK) {
      await Promise.all(pending.slice(index, index + ENQUEUE_CHUNK).map(item => this.queue.send(QUEUE_FILE, { itemId: item.id })));
    }
    return pending.length;
  }

  assertQueue(): void {
    if (!this.queue.isReady()) throw new UnprocessableEntityException({ code: 'queue_unavailable', message: 'The background queue is not running.' });
  }

  /* ── When the background reports back ─────────────────────────────────────────────────────────────────────────── */

  /**
   * Called after an item was handled. When nothing is waiting for the background any more the job is either waiting for a person (there is
   * something to review) or done — and the person who started it is told, once.
   */
  async refresh(jobId: string): Promise<void> {
    const job = await this.prisma.importJob.findUnique({ where: { id: jobId } });
    if (!job || (job.status !== 'processing' && job.status !== 'ready')) return;
    // The message of an inbox is still being read: what it asks for is not in the list yet.
    if (job.activity === 'understanding') return;
    const working = await this.prisma.importItem.count({ where: { jobId, status: { in: [...WORKING_STATUSES] } } });
    if (working > 0) return;
    const [review, failed, accepted] = await Promise.all([
      this.prisma.importItem.count({ where: { jobId, status: { in: ['review', 'ready', 'invalid'] } } }),
      this.prisma.importItem.count({ where: { jobId, status: 'error' } }),
      this.prisma.importItem.count({ where: { jobId, status: 'accepted' } }),
    ]);
    const next: JobStatus = review > 0 ? 'ready' : 'done';
    if (job.status === next) return;
    const moved = await this.prisma.importJob.updateMany({
      where: { id: jobId, status: job.status },
      data: { status: next, activity: null, ...(next === 'done' && { finishedAt: new Date() }) },
    });
    if (!moved.count) return;
    await this.tell(job, next === 'ready' ? 'import.review' : 'import.done', { count: review, done: accepted, failed });
  }

  /** The job failed as a whole (a spreadsheet that could not be read, a crash): back to a state a person can act on. */
  async fail(jobId: string, status: JobStatus, note: string): Promise<void> {
    const job = await this.prisma.importJob.findUnique({ where: { id: jobId } });
    if (!job) return;
    await this.prisma.importJob.update({ where: { id: jobId }, data: { status, activity: null, note: note.slice(0, 300), ...(status === 'done' && { finishedAt: new Date() }) } });
    await this.tell(job, 'import.failed', {});
  }

  async tell(job: ImportJob, textKey: string, params: Record<string, unknown>): Promise<void> {
    // A message to the inbox is usually followed on the dashboard: its writer is told only when something waits for them, or went wrong.
    const key = job.kind === 'inbox' ? textKey.replace(/^import\./, 'inbox.') : textKey;
    if (key === 'inbox.done') return;
    try {
      await this.notifications.deliver([
        {
          userId: job.createdById,
          channels: ['in_app'],
          draft: { type: 'import', severity: key.endsWith('.failed') ? 'warning' : 'info', textKey: key, params: { name: job.name, ...params }, entityType: 'import', entityId: job.id, link: `/imports/${job.id}` },
        },
      ]);
    } catch (error) {
      this.logger.warn(`Could not tell about import ${job.id}: ${(error as Error).message}`);
    }
  }

  /** Active people whose role allows `permission` (the owner always does). */
  async recipients(permission: string): Promise<string[]> {
    const users = await this.prisma.user.findMany({ where: { status: 'active' }, include: { role: true } });
    return users.filter(user => matrixAllows(effectiveMatrix(user.role, user.permissionOverrides), permission)).map(user => user.id);
  }

  /* ── After a restart ──────────────────────────────────────────────────────────────────────────────────────────── */

  /** The server was stopped while files were being read: they are read again; messages, spreadsheets and bulk accepts that were running are started again. */
  async recover(): Promise<void> {
    const reset = await this.prisma.importItem.updateMany({ where: { status: 'processing', kind: 'file' }, data: { status: 'pending' } });
    const running = await this.prisma.importJob.findMany({ where: { status: 'processing' } });
    let requeued = 0;
    for (const job of running) {
      if (job.kind === 'inbox' && job.activity === 'understanding') await this.queue.send(QUEUE_INBOX, { jobId: job.id });
      else if (FILE_JOB_KINDS.includes(job.kind) && job.activity === 'reading') requeued += await this.enqueuePending(job.id);
      else if (FILE_JOB_KINDS.includes(job.kind) && job.activity === 'accepting') await this.queue.send(QUEUE_ACCEPT, { jobId: job.id });
      else if (job.kind === 'spreadsheet' && (job.activity === 'checking' || job.activity === 'committing')) await this.queue.send(QUEUE_SHEET, { jobId: job.id, step: job.activity === 'checking' ? 'check' : 'commit' });
    }
    if (reset.count || requeued || running.length) this.logger.log(`Imports picked up again: ${running.length} running, ${requeued} files waiting`);
  }

  /** Saves an item's values and bookkeeping (the services that work on items all end here). */
  async saveItem(
    id: string,
    changes: {
      status?: ItemStatus;
      data?: ItemSections;
      confidence?: ItemConfidence;
      score?: number | null;
      warnings?: ItemWarning[];
      errors?: Record<string, string>;
      result?: ItemResult[] | null;
      message?: string;
      summary?: string;
      docType?: string | null;
      action?: string | null;
      clientId?: string | null;
      employeeId?: string | null;
      personId?: string | null;
      reviewedById?: string | null;
    },
  ): Promise<ImportItem> {
    const { data, confidence, warnings, errors, result, ...rest } = changes;
    return this.prisma.importItem.update({
      where: { id },
      data: {
        ...rest,
        ...(data !== undefined && { data: (await this.data.seal(data)) as Prisma.InputJsonObject }),
        ...(confidence !== undefined && { confidence: confidence as Prisma.InputJsonObject }),
        ...(warnings !== undefined && { warnings: warnings as unknown as Prisma.InputJsonArray }),
        ...(errors !== undefined && { errors: errors as Prisma.InputJsonObject }),
        ...(result !== undefined && { result: result === null ? Prisma.JsonNull : (result as unknown as Prisma.InputJsonArray) }),
        ...(rest.reviewedById && { reviewedAt: new Date() }),
      },
    });
  }
}
