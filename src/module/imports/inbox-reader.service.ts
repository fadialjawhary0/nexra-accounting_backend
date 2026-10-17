import { Injectable, Logger } from '@nestjs/common';
import { isValidDay, todayInAmsterdam } from '../../common/dates.js';
import { asRecord } from '../../common/record-values.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import type { ImportJob, Prisma } from '../../generated/prisma/client.js';
import { AiService } from '../../lib/ai/ai.service.js';
import { AiError } from '../../lib/ai/ai.types.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { QueueProcessor, QueueWorker, type QueueJobContext } from '../../lib/queue/queue.decorator.js';
import { MAX_REMINDER_MINUTES, STORED_EVENT_TYPES } from '../agenda/agenda.constants.js';
import { TASK_PRIORITIES } from '../tasks/tasks.constants.js';
import { buildExtractionSchema, readAnswer, type ReadAnswer } from './document-kinds.js';
import { DocumentMatcherService, nameTokens, type ClientRef } from './document-matcher.service.js';
import { MAX_INBOX_ACTIONS, QUEUE_INBOX, type ActionTarget, type InboxMessage, type ItemConfidence, type ItemSections, type ItemWarning } from './imports.constants.js';
import { ImportActorService } from './import-actor.service.js';
import { ImportLookupsService } from './import-lookups.service.js';
import { ImportsService } from './imports.service.js';
import { InboxActionsService, NOBODY } from './inbox-actions.service.js';
import { PLAN_KINDS, PLAN_SCHEMA, RECORD_INSTRUCTIONS, TARGET_OF_KIND, planInstructions, planText, recordSpec, type Plan, type PlanAction } from './inbox-kinds.js';
import { ItemDataService } from './item-data.service.js';
import { coerce } from './value-coercion.js';

/** One action, ready to become an item of the review list. */
interface Draft {
  target: ActionTarget;
  action: 'create' | 'update';
  name: string;
  data: ItemSections;
  confidence: ItemConfidence;
  score: number | null;
  clientId: string | null;
  employeeId: string | null;
  warnings: ItemWarning[];
}

interface Context {
  principal: AuthenticatedUser;
  instruction: string;
  /** The client of the message (what it — and its files — is about), and the number and the name the message called it by. */
  client: ClientRef | null;
  clientNumber: string;
  clientName: string;
  workerName: string | null;
  lastAttempt: boolean;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const day = (value: unknown): string | undefined => (isValidDay(text(value)) ? text(value) : undefined);
const clock = (value: unknown): string | undefined => {
  const match = /^(\d{1,2})[:.](\d{2})$/.exec(text(value));
  return match && Number(match[1]) < 24 && Number(match[2]) < 60 ? `${match[1]!.padStart(2, '0')}:${match[2]}` : undefined;
};
/** An hour later, on the same day. */
const hourAfter = (start: string): string => {
  const minutes = Math.min(Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5)) + 60, 23 * 60 + 59);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};
const warning = (code: string, level: ItemWarning['level'], params?: ItemWarning['params']): ItemWarning => ({ code, level, ...(params && { params }) });
const personLabel = (values: Record<string, unknown>): string => [values.first_name, values.infix, values.last_name].map(text).filter(Boolean).join(' ');
/** The words that mean "the person who wrote this" when a task is "for me". */
const MYSELF = new Set(['ik', 'mij', 'mijzelf', 'mezelf', 'me', 'i', 'myself']);

/**
 * Reads the message of the AI inbox (the box on the dashboard) before its files: what it asks for becomes a short list of actions — tasks, appointments, a new worker, new
 * details of a worker or a client, a worker who leaves — each one an item of the same review list as the files, checked at once and saved only when a person accepts it. The
 * client and the worker the message is about go along with its files, so a photo of an ID sent with "new worker for client 1203" lands with that client. When the AI cannot be
 * used the files are still read, and the message says why it could not be.
 */
@QueueProcessor()
@Injectable()
export class InboxReaderService {
  private readonly logger = new Logger(InboxReaderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly imports: ImportsService,
    private readonly actors: ImportActorService,
    private readonly matcher: DocumentMatcherService,
    private readonly data: ItemDataService,
    private readonly lookups: ImportLookupsService,
    private readonly actions: InboxActionsService,
  ) {}

  @QueueWorker({ queue: QUEUE_INBOX, retryLimit: 3, retryDelaySeconds: 30, expireSeconds: 600, concurrency: 2 })
  async handle(payload: { jobId?: string }, job: QueueJobContext): Promise<void> {
    if (payload.jobId) await this.process(payload.jobId, job.isLastAttempt);
  }

  async process(jobId: string, lastAttempt: boolean): Promise<void> {
    const job = await this.prisma.importJob.findUnique({ where: { id: jobId } });
    if (!job || job.kind !== 'inbox' || job.status !== 'processing' || job.activity !== 'understanding') return;
    const principal = await this.actors.principal(job.createdById);
    let message: InboxMessage;
    if (!principal) {
      message = { status: 'failed', reason: 'user_inactive' };
    } else {
      try {
        message = await this.actors.runAs(principal, () => this.understand(job, principal, lastAttempt));
      } catch (error) {
        // A rate limit or an outage may pass: the queue tries again after a pause.
        if (error instanceof AiError && error.retryable && !lastAttempt) throw error;
        if (!(error instanceof AiError)) this.logger.warn(`Reading the message of ${job.id} failed: ${(error as Error).message}`);
        message = { status: 'failed', reason: error instanceof AiError ? error.code : 'failed' };
      }
    }
    await this.carryOn(jobId, message);
  }

  /** After the message: its files are read (they know their client now), or — without files — the job waits for the person or is done. */
  private async carryOn(jobId: string, message: InboxMessage): Promise<void> {
    const job = await this.prisma.importJob.findUnique({ where: { id: jobId } });
    if (!job || job.status !== 'processing' || job.activity !== 'understanding') return;
    const pending = await this.prisma.importItem.count({ where: { jobId, kind: 'file', status: 'pending' } });
    await this.prisma.importJob.update({
      where: { id: jobId },
      data: { activity: pending ? 'reading' : null, ...(message.status === 'failed' && { options: { ...asRecord(job.options), message } as unknown as Prisma.InputJsonObject }) },
    });
    if (pending) await this.imports.enqueuePending(jobId);
    else await this.imports.refresh(jobId);
  }

  /* ── The message ──────────────────────────────────────────────────────────────────────────────────────────────── */

  private async understand(job: ImportJob, principal: AuthenticatedUser, lastAttempt: boolean): Promise<InboxMessage> {
    const options = asRecord(job.options);
    const instruction = text(options.instruction);
    const files = await this.prisma.importItem.findMany({ where: { jobId: job.id, kind: 'file' }, select: { name: true }, orderBy: { sortOrder: 'asc' }, take: 40 });
    const { data: plan } = await this.ai.extract<Plan>({
      feature: 'inbox',
      tier: 'main',
      instructions: planInstructions(todayInAmsterdam()),
      text: planText(instruction, files.map(file => file.name)),
      schemaName: 'inbox_message',
      schema: PLAN_SCHEMA,
      maxOutputTokens: 3000,
      userId: principal.id,
    });

    const context: Context = {
      principal,
      instruction,
      client: await this.clientOf(plan.client_number, plan.client_name),
      clientNumber: text(plan.client_number),
      clientName: text(plan.client_name),
      workerName: text(plan.worker_name) || null,
      lastAttempt,
    };
    const drafts: Draft[] = [];
    for (const action of (Array.isArray(plan.actions) ? plan.actions : []).slice(0, MAX_INBOX_ACTIONS)) {
      if ((PLAN_KINDS as readonly string[]).includes(action.kind)) drafts.push(await this.draft(action, context));
    }
    const summary = text(plan.summary).slice(0, 300);
    const message: InboxMessage = { status: drafts.length || files.length ? 'read' : 'empty', ...(summary && { summary }) };
    const sealed = await Promise.all(drafts.map(draft => this.data.seal(draft.data)));
    // A new worker whose ID came with the message: the first day, the job and the wage the message gives go with the worker the ID becomes.
    const employment = files.length ? await this.employmentOf(plan.employment) : {};

    // In one step: what an earlier try that was cut off left behind goes, and the files learn their client before they are read.
    const created = await this.prisma.$transaction(async tx => {
      await tx.importItem.deleteMany({ where: { jobId: job.id, kind: 'action', status: { in: ['pending', 'review'] }, reviewedById: null } });
      const rows = [];
      for (const [index, draft] of drafts.entries()) {
        rows.push(
          await tx.importItem.create({
            data: {
              jobId: job.id,
              // Before the files: what the message asks for comes first in the list.
              sortOrder: index - MAX_INBOX_ACTIONS - 1,
              kind: 'action',
              target: draft.target,
              status: 'review',
              name: draft.name.slice(0, 200),
              action: draft.action,
              clientId: draft.clientId,
              employeeId: draft.employeeId,
              data: sealed[index] as Prisma.InputJsonObject,
              confidence: draft.confidence as Prisma.InputJsonObject,
              score: draft.score,
              warnings: draft.warnings as unknown as Prisma.InputJsonArray,
            },
          }),
        );
      }
      await tx.importJob.update({
        where: { id: job.id },
        data: {
          options: {
            ...options,
            ...(context.client && files.length && { clientId: context.client.id }),
            ...(context.workerName && { workerName: context.workerName }),
            ...(Object.keys(employment).length && { employment }),
            message,
          } as unknown as Prisma.InputJsonObject,
        },
      });
      return rows;
    });

    // Every action is checked like after an edit: what is missing or wrong is on it before anybody opens it.
    for (const item of created) {
      const evaluation = await this.actions.evaluate(item, principal);
      await this.imports.saveItem(item.id, {
        action: evaluation.action,
        clientId: evaluation.clientId,
        employeeId: evaluation.employeeId,
        personId: evaluation.personId,
        data: evaluation.data,
        warnings: evaluation.warnings,
        errors: evaluation.errors,
        summary: evaluation.summary.slice(0, 300),
      });
    }
    return message;
  }

  /** One action of the answer as an item: its values in the shape the review list edits, the client and the worker it is about. */
  private async draft(action: PlanAction, context: Context): Promise<Draft> {
    const target = TARGET_OF_KIND[action.kind];
    const warnings: ItemWarning[] = [];
    const title = text(action.title).slice(0, 200);
    const details = text(action.details).slice(0, 4000);

    // The client: the one the action names, otherwise the one of the message. A number nobody has is said (a new client may bring its own number).
    let client = context.client;
    const ownAsked = text(action.client_number) || text(action.client_name);
    if (ownAsked) client = await this.clientOf(action.client_number, action.client_name);
    const asked = ownAsked || context.clientNumber || context.clientName;
    if (!client && asked && target !== 'client') warnings.push(warning('client_unknown', 'attention', { client: asked }));

    // The worker, for what is about one who works there.
    const workerName = text(action.worker_name) || context.workerName;
    let employeeId: string | null = null;
    if (workerName && (target === 'task' || target === 'employee_stop' || action.kind === 'worker_change')) {
      const found = client ? await this.matcher.workerByName(client.id, workerName) : await this.matcher.workerAnywhere(workerName);
      if (found && found !== 'ambiguous') employeeId = found.employeeId;
      else if (target !== 'task') warnings.push(warning(found === 'ambiguous' ? 'worker_ambiguous' : 'worker_unknown', 'attention', { name: workerName }));
    }

    const base = { target, warnings, confidence: {}, score: null, clientId: client?.id ?? null, employeeId };
    switch (target) {
      case 'task': {
        const assignee = await this.assignee(action.assignee_name, context.principal);
        if (assignee.unknown) warnings.push(warning('assignee_unknown', 'attention', { name: assignee.unknown }));
        const name = title || details.slice(0, 120) || text(context.instruction).slice(0, 120);
        const priority = (TASK_PRIORITIES as readonly string[]).includes(text(action.priority)) ? text(action.priority) : 'medium';
        return { ...base, action: 'create', name, data: { task: { title: name, ...(details && details !== name && { description: details }), ...(day(action.due_date) && { due_date: day(action.due_date) }), priority, assignee_id: assignee.id } } };
      }
      case 'event': {
        const start = clock(action.start_time);
        const end = start ? (clock(action.end_time) ?? hourAfter(start)) : undefined;
        const reminder = typeof action.reminder_minutes === 'number' && Number.isInteger(action.reminder_minutes) && action.reminder_minutes >= 0 && action.reminder_minutes <= MAX_REMINDER_MINUTES ? action.reminder_minutes : undefined;
        const name = title || details.slice(0, 120) || text(context.instruction).slice(0, 120);
        const event = {
          title: name.slice(0, 140),
          type: (STORED_EVENT_TYPES as readonly string[]).includes(text(action.event_type)) ? text(action.event_type) : 'meeting',
          all_day: !start,
          ...(day(action.date) && { date: day(action.date) }),
          ...(!start && day(action.end_date) && day(action.end_date) !== day(action.date) && { end_date: day(action.end_date) }),
          ...(start && { start_time: start, end_time: end }),
          ...(text(action.location) && { location: text(action.location).slice(0, 200) }),
          ...(details && details !== name && { description: details }),
          ...(reminder !== undefined && { reminder_minutes: reminder }),
        };
        return { ...base, action: 'create', name, data: { event } };
      }
      case 'employee_stop':
        return { ...base, action: 'update', name: workerName ?? '', data: { stop: { ...(day(action.date) && { date: day(action.date) }), ...(details && { reason: details.slice(0, 500) }) } } };
      case 'employee': {
        const change = action.kind === 'worker_change';
        const read = await this.readRecord('employee', context, { name: workerName, client: client ? `${client.number} – ${client.name}` : null, change }, warnings);
        const person = read?.sections.person ?? {};
        return { ...base, action: change ? 'update' : 'create', name: personLabel(person) || workerName || '', data: { person, employee: read?.sections.employee ?? {} }, confidence: read?.confidence ?? {}, score: read?.score ?? null };
      }
      case 'client': {
        // The number and the name the action gives, otherwise the ones the message gives.
        const number = ownAsked ? text(action.client_number) : context.clientNumber;
        const named = ownAsked ? text(action.client_name) : context.clientName;
        const read = await this.readRecord('client', context, { name: named || null, client: number || (client ? client.number : null), change: Boolean(client) }, warnings);
        const values = { ...read?.sections.client };
        // A new client keeps the number the message gives it.
        if (!client && number && !values.number) values.number = number;
        if (!client && named && !values.name) values.name = named;
        const owner = read?.sections.person ?? {};
        return {
          ...base,
          action: client ? 'update' : 'create',
          name: text(values.name) || named || (client ? `${client.number} – ${client.name}` : ''),
          data: { client: values, ...(personLabel(owner) && { person: owner }) },
          confidence: read?.confidence ?? {},
          score: read?.score ?? null,
        };
      }
    }
  }

  /** The details of a worker or a client the message tells about, read with the live forms; `null` (with a note) when the AI could not do it. */
  private async readRecord(target: 'employee' | 'client', context: Context, about: { name: string | null; client: string | null; change: boolean }, warnings: ItemWarning[]): Promise<ReadAnswer | null> {
    const [docs, lookups] = await Promise.all([this.data.docs(), this.lookups.context()]);
    const spec = recordSpec(target, docs, about);
    const built = buildExtractionSchema(spec, docs, context.principal.matrix, lookups);
    if (!Object.keys((built.schema.properties as Record<string, unknown>) ?? {}).length) return null;
    try {
      const result = await this.ai.extract<unknown>({
        feature: 'inbox',
        tier: 'main',
        instructions: `${RECORD_INSTRUCTIONS} ${spec.task}`,
        text: `The message:\n"""\n${context.instruction}\n"""`,
        schemaName: `inbox_${target}`,
        schema: built.schema,
        maxOutputTokens: spec.maxOutputTokens,
        userId: context.principal.id,
      });
      const answer = readAnswer(result.data, built, lookups);
      for (const [field, message] of Object.entries(answer.problems)) warnings.push({ code: 'value_unreadable', level: 'attention', field, params: { message } });
      return answer;
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      if (error.retryable && !context.lastAttempt) throw error;
      warnings.push(warning('ai_failed', 'attention', { reason: error.code }));
      return null;
    }
  }

  /** What the message says about the employment of a new worker in its files, as values of the live employee form (what does not fit a field is left out). */
  private async employmentOf(raw: Plan['employment'] | undefined): Promise<Record<string, unknown>> {
    const given = asRecord(raw);
    if (!Object.values(given).some(value => value !== null && value !== undefined && value !== '')) return {};
    const [docs, lookups] = await Promise.all([this.data.docs(['employee']), this.lookups.context()]);
    const values: Record<string, unknown> = {};
    for (const key of ['start_date', 'function', 'hourly_rate']) {
      const field = docs.employee?.fields.find(entry => entry.key === key && entry.active);
      if (!field || given[key] === null || given[key] === undefined || given[key] === '') continue;
      const coerced = coerce(field, given[key], lookups);
      if ('value' in coerced && coerced.value !== null) values[key] = coerced.value;
    }
    return values;
  }

  /** The client a message names: by its number first, then by its name (only when one client fits). */
  private async clientOf(number: string | null | undefined, name: string | null | undefined): Promise<ClientRef | null> {
    const wanted = text(number);
    if (wanted) {
      const found = await this.matcher.clientByNumbers([wanted, wanted.replace(/^(klant|client|nr\.?|no\.?)\s*/i, '')]);
      if (found) return found;
    }
    return text(name) ? this.matcher.clientByName(text(name)) : null;
  }

  /** The colleague a task is for: the one whose name fits (one only), the writer when the message says "me" or names nobody — or "nobody" when it asks for that. */
  private async assignee(name: string | null | undefined, principal: AuthenticatedUser): Promise<{ id: string; unknown?: string }> {
    const wanted = text(name);
    if (!wanted || MYSELF.has(fold(wanted))) return { id: principal.id };
    if (['niemand', 'nobody', 'no one'].includes(fold(wanted))) return { id: NOBODY };
    const tokens = nameTokens(wanted);
    const users = await this.prisma.user.findMany({ where: { status: 'active' }, select: { id: true, name: true } });
    const matches = users.filter(user => {
      const own = nameTokens(user.name);
      return tokens.length > 0 && tokens.every(token => own.includes(token));
    });
    return matches.length === 1 ? { id: matches[0]!.id } : { id: principal.id, unknown: wanted };
  }
}
