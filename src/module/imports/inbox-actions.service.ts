import { ConflictException, ForbiddenException, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { asRecord } from '../../common/record-values.js';
import { formatDay, isValidDay, todayInAmsterdam } from '../../common/dates.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import type { ImportItem } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { AgendaEventsService } from '../agenda/agenda-events.service.js';
import { MAX_REMINDER_MINUTES, STORED_EVENT_TYPES } from '../agenda/agenda.constants.js';
import { EmployeesService } from '../employees/employees.service.js';
import { isEmptyValue } from '../forms/form-doc.js';
import { FormValidationService } from '../forms/form-validation.service.js';
import { ListsService } from '../lists/lists.service.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import { TASK_PRIORITY_LIST } from '../tasks/tasks.constants.js';
import { TasksService } from '../tasks/tasks.service.js';
import { DocumentAcceptService, failureOf, type Failure } from './document-accept.service.js';
import { DocumentEvaluatorService, type Evaluation } from './document-evaluator.service.js';
import { DocumentMatcherService } from './document-matcher.service.js';
import { ACCEPTABLE_STATUSES, type ActionTarget, type ItemResult, type ItemSections, type ItemWarning } from './imports.constants.js';
import { ImportsService } from './imports.service.js';
import { ItemDataService } from './item-data.service.js';

/** Notes the reading of the message left that no later check can work out again (the details could not be read, a colleague or a client it names was not found). */
export const ACTION_NOTES: readonly string[] = ['ai_failed', 'ai_unavailable', 'assignee_unknown', 'client_unknown', 'worker_unknown', 'worker_ambiguous'];

/** The values of the parts of an action that have no form of their own: anything else a request sends is left out. */
export const ACTION_KEYS: Readonly<Record<string, readonly string[]>> = {
  task: ['title', 'description', 'due_date', 'priority', 'assignee_id'],
  event: ['title', 'type', 'all_day', 'date', 'end_date', 'start_time', 'end_time', 'location', 'description', 'reminder_minutes'],
  stop: ['date', 'reason'],
};

/** "Nobody" as the person a task is for (an empty choice means: the person who saves it). */
export const NOBODY = 'none';

/** The name in a message says whom it is about: it never renames a worker or a client that exists. */
const PERSON_NAME_KEYS = ['first_name', 'infix', 'last_name', 'initials'];
const CLIENT_NAME_KEYS = ['number', 'name'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const dutchDay = (day: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day.slice(8, 10)}-${day.slice(5, 7)}-${day.slice(0, 4)}` : '');
const personLabel = (values: Record<string, unknown>): string => [values.first_name, values.infix, values.last_name].map(text).filter(Boolean).join(' ');
const warning = (code: string, level: ItemWarning['level'], field?: string, params?: ItemWarning['params']): ItemWarning => ({ code, level, ...(field && { field }), ...(params && { params }) });
const prefixed = (prefix: string, errors: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(errors).map(([key, message]) => [`${prefix}.${key}`, message]));
const only = (values: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => Object.fromEntries(Object.entries(values).filter(([key, value]) => keys.includes(key) && value !== undefined && value !== null && value !== ''));

/** The fields of a service's 422 as fields of the item (`dueDate` of the task service is `task.due_date` here). */
function failureIn(error: unknown, field: (key: string) => string): Failure {
  const failure = failureOf(error);
  return { message: failure.message, errors: Object.fromEntries(Object.entries(failure.errors).map(([key, message]) => [field(key), message])) };
}

const TASK_FIELDS: Record<string, string> = { dueDate: 'task.due_date', assigneeId: 'task.assignee_id', linkedType: 'item.client', linkedId: 'item.client' };
const EVENT_FIELDS: Record<string, string> = { start: 'event.date', end: 'event.end_time', clientId: 'item.client', reminderMinutes: 'event.reminder_minutes' };

/**
 * The actions of a message to the AI inbox (a task, an appointment, a worker, a worker who leaves, a client): what is checked before one can be accepted — the same rules the
 * screens apply — and what accepting does, through the services the screens use and as the person who accepts (their permissions, the audit trail). Nothing is saved before that.
 */
@Injectable()
export class InboxActionsService {
  private readonly logger = new Logger(InboxActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly imports: ImportsService,
    private readonly data: ItemDataService,
    private readonly evaluator: DocumentEvaluatorService,
    private readonly matcher: DocumentMatcherService,
    private readonly validation: FormValidationService,
    private readonly lists: ListsService,
    private readonly tasks: TasksService,
    private readonly events: AgendaEventsService,
    private readonly employees: EmployeesService,
    private readonly documents: DocumentAcceptService,
  ) {}

  /* ── Checking ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The action as it is now (after an edit, or just before accepting): its values checked, the records it is about found, every problem written down. */
  async evaluate(item: ImportItem, user: AuthenticatedUser, overrides: { data?: ItemSections; clientId?: string | null; employeeId?: string | null; action?: string | null } = {}): Promise<Evaluation> {
    const clientChanged = overrides.clientId !== undefined && overrides.clientId !== item.clientId;
    const workerChanged = overrides.employeeId !== undefined && overrides.employeeId !== item.employeeId;
    // A client or a worker chosen by hand settles what the message said about them.
    const carried = (Array.isArray(item.warnings) ? (item.warnings as unknown as ItemWarning[]) : []).filter(
      entry => ACTION_NOTES.includes(entry.code) && !(clientChanged && entry.code === 'client_unknown') && !(workerChanged && (entry.code === 'worker_unknown' || entry.code === 'worker_ambiguous')),
    );
    const state: Evaluation = {
      docType: null,
      action: overrides.action === undefined ? item.action : overrides.action,
      clientId: overrides.clientId === undefined ? item.clientId : overrides.clientId,
      employeeId: overrides.employeeId === undefined ? item.employeeId : overrides.employeeId,
      personId: item.personId,
      data: overrides.data ?? this.data.open(item.data),
      warnings: carried,
      errors: {},
      summary: '',
    };
    switch (item.target as ActionTarget | null) {
      case 'task':
        return this.task(state);
      case 'event':
        return this.event(state);
      case 'employee':
        return this.worker(state, user);
      case 'employee_stop':
        return this.stop(state);
      case 'client':
        return this.client(state, user);
      default:
        state.errors['item.type'] = 'imports.typeRequired';
        return state;
    }
  }

  /** The values the form accepts (normalised), plus the ones it refused, so a person sees what was read and why it was refused. */
  private async checked(entity: 'person' | 'employee' | 'client', raw: Record<string, unknown>, existing: Record<string, unknown>, user: AuthenticatedUser) {
    const { values, errors } = await this.validation.check(entity, raw, existing, user.matrix);
    const merged = { ...raw, ...values };
    return { values: Object.fromEntries(Object.entries(merged).filter(([, value]) => !isEmptyValue(value))), errors: prefixed(entity, errors) };
  }

  /** The worker an action is linked to — and so its client; a worker that is not there any more is let go. */
  private async linkWorker(state: Evaluation): Promise<{ isActive: boolean; startDate: Date | null; name: string } | null> {
    if (!state.employeeId) return null;
    const row = await this.prisma.employee.findUnique({ where: { id: state.employeeId }, select: { personId: true, clientId: true, isActive: true, startDate: true, person: { select: { firstName: true, lastName: true } } } });
    if (!row) {
      state.employeeId = null;
      return null;
    }
    state.personId = row.personId;
    state.clientId = row.clientId;
    return { isActive: row.isActive, startDate: row.startDate, name: `${row.person.firstName} ${row.person.lastName}`.trim() };
  }

  private async task(state: Evaluation): Promise<Evaluation> {
    const task = only(asRecord(state.data.task), ACTION_KEYS.task!);
    const title = text(task.title).slice(0, 200);
    if (title) task.title = title;
    else state.errors['task.title'] = 'validation.required';
    const due = text(task.due_date);
    if (due && !isValidDay(due)) state.errors['task.due_date'] = 'validation.invalidDate';
    else if (due && due < todayInAmsterdam()) state.warnings.push(warning('date_in_past', 'attention', 'task.due_date', { date: dutchDay(due) }));
    if (task.priority !== undefined && !(await this.lists.activeCodes(TASK_PRIORITY_LIST)).has(String(task.priority))) state.errors['task.priority'] = 'validation.selectOption';
    const assignee = text(task.assignee_id);
    if (assignee && assignee !== NOBODY && !(await this.prisma.user.findFirst({ where: { id: assignee, status: 'active' }, select: { id: true } }))) state.errors['task.assignee_id'] = 'validation.invalid';
    await this.linkWorker(state);
    state.action = 'create';
    state.data = { task };
    state.summary = [title, due ? dutchDay(due) : ''].filter(Boolean).join(' · ');
    return state;
  }

  private async event(state: Evaluation): Promise<Evaluation> {
    const event = only(asRecord(state.data.event), ACTION_KEYS.event!);
    const title = text(event.title).slice(0, 140);
    if (title) event.title = title;
    else state.errors['event.title'] = 'validation.required';
    if (!(STORED_EVENT_TYPES as readonly string[]).includes(String(event.type))) event.type = 'meeting';
    const allDay = event.all_day === true;
    event.all_day = allDay;
    const date = text(event.date);
    if (!date) state.errors['event.date'] = 'validation.required';
    else if (!isValidDay(date)) state.errors['event.date'] = 'validation.invalidDate';
    else if (date < todayInAmsterdam()) state.warnings.push(warning('date_in_past', 'attention', 'event.date', { date: dutchDay(date) }));
    if (allDay) {
      const last = text(event.end_date);
      if (last && !isValidDay(last)) state.errors['event.end_date'] = 'validation.invalidDate';
      else if (last && date && last < date) state.errors['event.end_date'] = 'validation.endBeforeStart';
      delete event.start_time;
      delete event.end_time;
    } else {
      const start = text(event.start_time);
      const end = text(event.end_time);
      if (!start) state.errors['event.start_time'] = 'validation.required';
      else if (!TIME.test(start)) state.errors['event.start_time'] = 'validation.invalid';
      if (!end) state.errors['event.end_time'] = 'validation.required';
      else if (!TIME.test(end)) state.errors['event.end_time'] = 'validation.invalid';
      else if (TIME.test(start) && end <= start) state.errors['event.end_time'] = 'validation.afterStartTime';
      delete event.end_date;
    }
    if (event.reminder_minutes !== undefined) {
      const minutes = Number(event.reminder_minutes);
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_REMINDER_MINUTES) state.errors['event.reminder_minutes'] = 'validation.invalid';
      else event.reminder_minutes = minutes;
    }
    // An appointment is about a client, not a worker.
    if (state.employeeId) await this.linkWorker(state);
    state.employeeId = null;
    state.personId = null;
    state.action = 'create';
    state.data = { event };
    state.summary = [title, date && isValidDay(date) ? `${dutchDay(date)}${allDay ? '' : ` ${text(event.start_time)}`}`.trim() : ''].filter(Boolean).join(' · ');
    return state;
  }

  /** A new worker of a client (`create`), or new details of a worker who works there (`update`). */
  private async worker(state: Evaluation, user: AuthenticatedUser): Promise<Evaluation> {
    const read = { ...asRecord(state.data.person) };
    const work = { ...asRecord(state.data.employee) };
    delete work.client;
    if (state.action === 'update') {
      const worker = await this.linkWorker(state);
      if (!worker) {
        state.errors['item.worker'] = 'imports.workerRequired';
        state.data = { person: read, employee: work };
        state.summary = personLabel(read);
        return state;
      }
      const existing = await this.evaluator.existingPerson(state.personId!);
      // The name only says whom the message is about.
      const patch = Object.fromEntries(Object.entries(read).filter(([key]) => !PERSON_NAME_KEYS.includes(key) || isEmptyValue(existing[key])));
      const person = await this.checked('person', patch, existing, user);
      const employment = await this.checked('employee', work, { client: state.clientId }, user);
      Object.assign(state.errors, person.errors, employment.errors);
      if (!Object.keys(person.values).length && !Object.keys(employment.values).length) state.errors['item.values'] = 'imports.nothingToChange';
      if (!worker.isActive) state.warnings.push(warning('worker_stopped', 'info', undefined, { worker: worker.name }));
      state.data = { person: person.values, employee: employment.values };
      state.summary = worker.name;
      return state;
    }

    // A new worker: somebody the system knows already (by BSN, or by name and date of birth) becomes the worker; nobody is made twice.
    state.action = 'create';
    state.employeeId = null;
    state.personId = (await this.matcher.personByBsn(text(read.bsn))) ?? (await this.matcher.personByNameAndBirth(text(read.first_name), text(read.last_name), text(read.date_of_birth)));
    if (state.personId) state.warnings.push(warning(text(read.bsn) ? 'person_matched_bsn' : 'person_matched_name', 'info'));
    const existing = state.personId ? await this.evaluator.existingPerson(state.personId) : {};
    const patch = state.personId ? Object.fromEntries(Object.entries(read).filter(([key]) => isEmptyValue(existing[key]))) : read;
    const person = await this.checked('person', patch, existing, user);
    const employment = await this.checked('employee', { ...work, ...(state.clientId && { client: state.clientId }) }, {}, user);
    delete employment.values.client;
    delete employment.errors['employee.client'];
    Object.assign(state.errors, person.errors, employment.errors);
    if (!state.clientId) state.errors['item.client'] = 'imports.clientRequired';
    const name = personLabel({ ...existing, ...person.values });
    if (!name) state.errors['person.last_name'] ??= 'validation.required';
    if (state.clientId && name) {
      const found = await this.matcher.workerByName(state.clientId, name);
      if (found && found !== 'ambiguous') state.warnings.push(warning('worker_exists', 'attention', undefined, { worker: found.name }));
    }
    if (!state.personId) {
      const similar = await this.matcher.similarPeople(text(person.values.first_name), text(person.values.last_name));
      if (similar.length) state.warnings.push(warning('person_possible_duplicate', 'attention', undefined, { name: similar.map(entry => entry.name).join(', ') }));
    }
    state.data = { person: person.values, employee: employment.values };
    state.summary = name;
    return state;
  }

  /** A worker who leaves: the last working day (and why, when the message says). */
  private async stop(state: Evaluation): Promise<Evaluation> {
    const stop = only(asRecord(state.data.stop), ACTION_KEYS.stop!);
    const worker = await this.linkWorker(state);
    if (!worker) state.errors['item.worker'] = 'imports.workerRequired';
    else if (!worker.isActive) state.errors['item.worker'] = 'imports.workerStopped';
    const date = text(stop.date);
    if (!date) state.errors['stop.date'] = 'validation.required';
    else if (!isValidDay(date)) state.errors['stop.date'] = 'validation.invalidDate';
    else if (worker?.startDate && date < formatDay(worker.startDate)) state.errors['stop.date'] = 'validation.endBeforeStart';
    if (stop.reason !== undefined) stop.reason = text(stop.reason).slice(0, 500);
    state.action = 'update';
    state.data = { stop };
    state.summary = [worker?.name ?? '', date && isValidDay(date) ? dutchDay(date) : ''].filter(Boolean).join(' · ');
    return state;
  }

  /** A new client (`create`), or new details of a client (`update`); the owner, partner or director the message names is linked to it. */
  private async client(state: Evaluation, user: AuthenticatedUser): Promise<Evaluation> {
    const read = { ...asRecord(state.data.client) };
    const owner = { ...asRecord(state.data.person) };
    let updating = state.action === 'update';
    state.employeeId = null;
    if (!updating) {
      state.clientId = null;
      // A client the system knows by its KvK number is not made a second time.
      const holder = await this.matcher.clientByKvk(text(read.kvk));
      if (holder) {
        state.clientId = holder.id;
        updating = true;
        state.warnings.push(warning('client_from_kvk', 'info', undefined, { client: `${holder.number} – ${holder.name}` }));
      }
    }
    if (updating) {
      if (!state.clientId) state.errors['item.client'] = 'imports.clientRequired';
      const existing = state.clientId ? await this.evaluator.existingClient(state.clientId) : {};
      const patch = Object.fromEntries(Object.entries(read).filter(([key]) => !CLIENT_NAME_KEYS.includes(key) || isEmptyValue(existing[key])));
      const checked = await this.checked('client', patch, existing, user);
      Object.assign(state.errors, checked.errors);
      if (state.clientId && !Object.keys(checked.values).length && !personLabel(owner)) state.errors['item.values'] = 'imports.nothingToChange';
      state.data = { client: checked.values };
      state.summary = [text(existing.number), text(existing.name)].filter(Boolean).join(' – ');
    } else {
      const checked = await this.checked('client', { ...read, number: text(read.number) || 'auto' }, {}, user);
      if (checked.values.number === 'auto') {
        delete checked.values.number;
        delete checked.errors['client.number'];
        state.warnings.push(warning('number_assigned', 'info'));
      }
      Object.assign(state.errors, checked.errors);
      state.data = { client: checked.values };
      state.summary = [text(checked.values.name), text(checked.values.kvk) ? `KvK ${text(checked.values.kvk)}` : ''].filter(Boolean).join(' · ');
    }
    if (personLabel(owner)) {
      const person = await this.checked('person', owner, {}, user);
      Object.assign(state.errors, person.errors);
      state.data.person = person.values;
    }
    state.action = updating ? 'update' : 'create';
    return state;
  }

  /* ── Accepting ────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** Accepts one action as `user`. Returns the item as it is afterwards (`accepted`, or still waiting with what is wrong). */
  async accept(item: ImportItem, user: AuthenticatedUser): Promise<ImportItem> {
    if (!(ACCEPTABLE_STATUSES as readonly string[]).includes(item.status)) throw new ConflictException({ code: 'item_not_acceptable', message: 'This item cannot be accepted now.' });
    const evaluation = await this.evaluate(item, user);
    if (Object.keys(evaluation.errors).length) {
      await this.imports.saveItem(item.id, { status: 'review', ...this.stateOf(evaluation), errors: evaluation.errors, message: '' });
      throw new UnprocessableEntityException({ code: 'item_invalid', message: 'This item has problems.', fields: evaluation.errors, details: { itemId: item.id } });
    }
    const target = item.target as ActionTarget;
    this.allowed(target, evaluation, user);

    const results: ItemResult[] = [];
    const intent = evaluation.action;
    try {
      await this.make(item, target, evaluation, user, results);
      // Done: the item says what it was asked to do (a step in between may have turned "make" into "change" for a second try).
      await this.imports.saveItem(item.id, { status: 'accepted', ...this.stateOf(evaluation), action: intent, errors: {}, message: '', result: results, reviewedById: user.id });
      await this.audit.log({ action: 'accepted', entityType: 'inbox', entityId: item.jobId, entityLabel: item.name, meta: { target, action: intent, results: results.map(result => `${result.type}:${result.action}`) } });
    } catch (error) {
      const failure = this.failure(target, error);
      this.logger.warn(`Accepting ${target} "${item.name}" failed: ${failure.message}`);
      await this.imports.saveItem(item.id, { status: 'error', ...this.stateOf(evaluation), errors: failure.errors, message: failure.message, result: results });
    }
    return this.prisma.importItem.findUniqueOrThrow({ where: { id: item.id } });
  }

  private stateOf(evaluation: Evaluation) {
    return {
      action: evaluation.action,
      clientId: evaluation.clientId,
      employeeId: evaluation.employeeId,
      personId: evaluation.personId,
      data: evaluation.data,
      warnings: evaluation.warnings,
      summary: evaluation.summary,
    };
  }

  /** A record that was made is written on the item at once: accepting again after a later step failed changes that record instead of making a second one. */
  private async remember(item: ImportItem, state: Evaluation, changes: { clientId?: string; employeeId?: string; personId?: string }): Promise<void> {
    state.action = 'update';
    Object.assign(state, changes);
    await this.prisma.importItem.update({ where: { id: item.id }, data: { ...changes, action: 'update' } });
  }

  /** The right to make or change what the action is about. */
  private allowed(target: ActionTarget, evaluation: Evaluation, user: AuthenticatedUser): void {
    const creating = evaluation.action !== 'update';
    const needs: Record<ActionTarget, string> = {
      task: 'tasks.create',
      event: 'calendar.create',
      employee: creating ? 'employees.create' : 'employees.edit',
      employee_stop: 'employees.delete',
      client: creating ? 'clients.create' : 'clients.edit',
    };
    if (!matrixAllows(user.matrix, needs[target])) throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this.', details: { missing: [needs[target]] } });
  }

  private async make(item: ImportItem, target: ActionTarget, state: Evaluation, user: AuthenticatedUser, results: ItemResult[]): Promise<void> {
    switch (target) {
      case 'task': {
        const task = asRecord(state.data.task);
        const assignee = text(task.assignee_id);
        const created = await this.tasks.create(
          {
            title: text(task.title),
            ...(text(task.description) && { description: text(task.description) }),
            ...(text(task.priority) && { priority: text(task.priority) }),
            ...(text(task.due_date) && { dueDate: text(task.due_date) }),
            // No choice: the task is for the person who saves it.
            ...(assignee && { assigneeId: assignee === NOBODY ? null : assignee }),
            ...(state.employeeId ? { linkedType: 'employee', linkedId: state.employeeId } : state.clientId ? { linkedType: 'client', linkedId: state.clientId } : {}),
          },
          user,
        );
        results.push({ type: 'task', id: created.id, action: 'created', label: created.title });
        return;
      }
      case 'event': {
        const event = asRecord(state.data.event);
        const allDay = event.all_day === true;
        const date = text(event.date);
        const created = await this.events.create(
          {
            title: text(event.title),
            type: text(event.type) || 'meeting',
            allDay,
            start: allDay ? date : `${date}T${text(event.start_time)}`,
            end: allDay ? text(event.end_date) || date : `${date}T${text(event.end_time)}`,
            ...(text(event.location) && { location: text(event.location) }),
            ...(text(event.description) && { description: text(event.description) }),
            ...(state.clientId && { clientId: state.clientId }),
            ...(typeof event.reminder_minutes === 'number' && { reminderMinutes: event.reminder_minutes }),
          },
          user,
        );
        results.push({ type: 'event', id: created.id, action: 'created', label: created.title, date });
        return;
      }
      case 'employee': {
        const person = asRecord(state.data.person);
        const employment = asRecord(state.data.employee);
        if (state.action === 'update') {
          await this.employees.update(state.employeeId!, { values: employment, person: { values: person } }, user);
          results.push({ type: 'employee', id: state.employeeId!, action: 'updated', label: state.summary });
          return;
        }
        const known = state.personId;
        const created = await this.employees.create({ values: { ...employment, client: state.clientId }, person: known ? { personId: known } : { values: person } }, user);
        results.push({ type: 'employee', id: created.id, action: 'created', label: state.summary });
        await this.remember(item, state, { employeeId: created.id });
        // A person who was known already gets the details the message adds.
        if (known && Object.keys(person).length) await this.employees.update(created.id, { person: { values: person } }, user);
        return;
      }
      case 'employee_stop': {
        const stop = asRecord(state.data.stop);
        await this.employees.setStatus(state.employeeId!, { status: 'stopped', date: text(stop.date), ...(text(stop.reason) && { reason: text(stop.reason) }) }, user);
        results.push({ type: 'employee', id: state.employeeId!, action: 'stopped', label: state.summary });
        return;
      }
      case 'client':
        await this.documents.makeClient(state, user, results, changes => this.remember(item, state, { ...(changes.clientId && { clientId: changes.clientId }) }));
        return;
    }
  }

  /** What a refusal of a service means for the fields of the item. */
  private failure(target: ActionTarget, error: unknown): Failure {
    switch (target) {
      case 'task':
        return failureIn(error, key => TASK_FIELDS[key] ?? `task.${key}`);
      case 'event':
        return failureIn(error, key => EVENT_FIELDS[key] ?? `event.${key}`);
      case 'employee':
        // The worker service names the person's fields `person.…` and its own without a prefix.
        return failureIn(error, key => (key.startsWith('person.') ? key : `employee.${key}`));
      case 'employee_stop':
        return failureIn(error, key => (key === 'date' ? 'stop.date' : 'item.worker'));
      case 'client':
        return failureIn(error, key => (key.includes('.') ? key : `client.${key}`));
    }
  }
}
