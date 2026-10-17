import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ApiResult, paged } from '../../common/api-result.js';
import { addDays, formatDay, todayInAmsterdam } from '../../common/dates.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { pageMeta, toSkipTake } from '../../common/pagination.js';
import { asRecord } from '../../common/record-values.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import type { AddressBookEntry, FormSubmission, OfficialForm, Person, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ExportTable } from '../../lib/exports/export.types.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { addressLines } from '../address-book/address-book.service.js';
import { AddressLabelsService, type LabelOptions } from '../address-book/address-labels.service.js';
import { CalendarService } from '../calendar/calendar.service.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import { fullName } from '../templates/merge-format.js';
import type { SubmissionExportQuery, SubmissionListQuery, SubmissionStatusDto, UpdateSubmissionDto } from './dto/official-forms.dto.js';
import { SUBMISSION_ENTITY } from './official-forms.constants.js';

type Row = FormSubmission & {
  form: Pick<OfficialForm, 'id' | 'code' | 'nameNl' | 'nameEn' | 'followUpDays'>;
  client: { id: string; number: string; name: string };
  person: Pick<Person, 'firstName' | 'lastName' | 'data'> | null;
  recipient: AddressBookEntry | null;
};

const include = {
  form: { select: { id: true, code: true, nameNl: true, nameEn: true, followUpDays: true } },
  client: { select: { id: true, number: true, name: true } },
  person: { select: { firstName: true, lastName: true, data: true } },
  recipient: true,
} satisfies Prisma.FormSubmissionInclude;

const day = (value: Date | null): string | null => (value ? formatDay(value) : null);
const toDay = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/**
 * The log of sent forms: every form that was filled in for a client — who it was for, where it went, when it was sent and when an answer is expected, and what has
 * become of it. A form that was sent and not answered by its follow-up day is flagged and reminded. Entries are cancelled or taken out of the log, never deleted.
 */
@Injectable()
export class FormSubmissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly calendar: CalendarService,
    private readonly exports: ExportsService,
    private readonly labels: AddressLabelsService,
  ) {}

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  private async fileInfo(ids: string[]) {
    const files = ids.length ? await this.prisma.storedFile.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, size: true, area: true, isActive: true } }) : [];
    return new Map(files.map(file => [file.id, file]));
  }

  private view(row: Row, files: Awaited<ReturnType<FormSubmissionsService['fileInfo']>>, user: AuthenticatedUser, locale: AppLocale, today: string) {
    const file = files.get(row.fileId);
    const nl = locale === 'nl';
    const followUpOn = day(row.followUpOn);
    return {
      id: row.id,
      form: { id: row.form.id, code: row.form.code, name: nl ? row.form.nameNl : row.form.nameEn },
      client: row.client,
      person: row.person ? fullName({ firstName: row.person.firstName, lastName: row.person.lastName, infix: String(asRecord(row.person.data).infix ?? '') }) : null,
      employeeId: row.employeeId,
      period: row.periodStart && row.periodEnd ? { start: formatDay(row.periodStart), end: formatDay(row.periodEnd) } : null,
      status: row.status,
      preparedOn: formatDay(row.preparedOn),
      sentOn: day(row.sentOn),
      doneOn: day(row.doneOn),
      followUpOn,
      /** It was sent, and the day somebody should have heard back has come. */
      due: row.status === 'sent' && followUpOn !== null && followUpOn <= today,
      recipient: row.recipient ? { id: row.recipient.id, name: row.recipient.name } : null,
      recipientText: row.recipientText,
      reference: row.reference,
      note: row.note,
      values: asRecord(row.values),
      hasPersonalData: row.hasPersonalData,
      usedAi: row.usedAi,
      isActive: row.isActive,
      deactivationReason: row.deactivationReason,
      file: file ? { id: file.id, name: file.name, size: file.size, canOpen: Boolean(file.area && matrixAllows(user.matrix, `${file.area}.view`)) && file.isActive } : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private where(query: Pick<SubmissionListQuery, 'search' | 'clientId' | 'employeeId' | 'formId' | 'status' | 'state' | 'overdue' | 'from' | 'to'>, today: string): Prisma.FormSubmissionWhereInput {
    const terms = fold(query.search ?? '').split(' ').filter(Boolean);
    const statuses = (query.status ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
    const state = query.state ?? 'active';
    return {
      ...(state !== 'all' && { isActive: state === 'active' }),
      ...(query.clientId && { clientId: query.clientId }),
      ...(query.employeeId && { employeeId: query.employeeId }),
      ...(query.formId && { formId: query.formId }),
      ...(statuses.length && { status: { in: statuses } }),
      ...(query.overdue && { status: 'sent', followUpOn: { lte: toDay(today) } }),
      ...((query.from || query.to) && { preparedOn: { ...(query.from && { gte: toDay(query.from) }), ...(query.to && { lte: toDay(query.to) }) } }),
      ...(terms.length && { AND: terms.map(term => ({ searchText: { contains: term } })) }),
    };
  }

  private orderBy(sort: string | undefined): Prisma.FormSubmissionOrderByWithRelationInput[] {
    const [field, direction] = (sort ?? '').split(',')[0]?.split(':') ?? [];
    const dir = direction === 'asc' ? 'asc' : 'desc';
    const map: Record<string, Prisma.FormSubmissionOrderByWithRelationInput> = {
      preparedOn: { preparedOn: dir },
      sentOn: { sentOn: dir },
      followUpOn: { followUpOn: dir },
      status: { status: dir },
      client: { client: { number: dir } },
      form: { form: { nameNl: dir } },
      createdAt: { createdAt: dir },
    };
    return [map[field ?? ''] ?? { preparedOn: 'desc' }, { createdAt: 'desc' }];
  }

  async list(query: SubmissionListQuery, user: AuthenticatedUser, locale: AppLocale): Promise<ApiResult> {
    const today = todayInAmsterdam();
    const where = this.where(query, today);
    const [total, rows, counts, due] = await Promise.all([
      this.prisma.formSubmission.count({ where }),
      this.prisma.formSubmission.findMany({ where, orderBy: this.orderBy(query.sort), include, ...toSkipTake(query) }),
      query.stats ? this.prisma.formSubmission.groupBy({ by: ['status'], where: this.where({ ...query, status: undefined, overdue: undefined }, today), _count: { _all: true } }) : Promise.resolve(null),
      query.stats ? this.prisma.formSubmission.count({ where: { ...this.where({ ...query, status: undefined, overdue: undefined }, today), status: 'sent', followUpOn: { lte: toDay(today) } } }) : Promise.resolve(0),
    ]);
    const files = await this.fileInfo(rows.map(row => row.fileId));
    return paged(
      rows.map(row => this.view(row, files, user, locale, today)),
      pageMeta(total, query, counts ? { counts: { ...Object.fromEntries(counts.map(entry => [entry.status, entry._count._all])), due } } : {}),
    );
  }

  async rowOrThrow(id: string): Promise<Row> {
    const row = await this.prisma.formSubmission.findUnique({ where: { id }, include });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Form not found in the log' });
    return row;
  }

  async one(id: string, user: AuthenticatedUser, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    return this.view(row, await this.fileInfo([row.fileId]), user, locale, todayInAmsterdam());
  }

  /* ── Changing ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The day somebody should look at a form that was sent on `sentOn` again: the form's number of days later, on a working day. */
  followUpDay(row: Pick<Row, 'clientId' | 'form'>, sentOn: string): string | null {
    return row.form.followUpDays ? this.calendar.moveDeadline(addDays(sentOn, row.form.followUpDays), row.clientId) : null;
  }

  async update(id: string, dto: UpdateSubmissionDto, user: AuthenticatedUser, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    if (!row.isActive) throw new ConflictException({ code: 'submission_inactive', message: 'This entry was taken out of the log.' });
    const today = todayInAmsterdam();
    const problems: Record<string, string> = {};
    const status = dto.status ?? row.status;
    const changing = dto.status !== undefined && dto.status !== row.status;

    let sentOn = dto.sentOn === undefined ? day(row.sentOn) : dto.sentOn;
    let doneOn = dto.doneOn === undefined ? day(row.doneOn) : dto.doneOn;
    let followUpOn = dto.followUpOn === undefined ? day(row.followUpOn) : dto.followUpOn;
    if (changing) {
      if (status === 'sent') {
        sentOn = dto.sentOn ?? day(row.sentOn) ?? today;
        doneOn = null;
        followUpOn = dto.followUpOn !== undefined ? dto.followUpOn : this.followUpDay(row, sentOn);
      } else if (status === 'done') {
        doneOn = dto.doneOn ?? today;
        followUpOn = null;
      } else if (status === 'prepared') {
        sentOn = null;
        doneOn = null;
        followUpOn = null;
      } else {
        doneOn = null;
        followUpOn = null;
      }
    } else if (dto.sentOn && dto.followUpOn === undefined && status === 'sent') {
      // The day it was sent was corrected: the follow-up moves with it.
      followUpOn = this.followUpDay(row, dto.sentOn);
    }
    if (sentOn && status !== 'sent' && status !== 'done') problems.sentOn = 'validation.invalid';
    if (doneOn && status !== 'done') problems.doneOn = 'validation.invalid';
    if (followUpOn && status !== 'sent') problems.followUpOn = 'validation.invalid';
    if (sentOn && doneOn && doneOn < sentOn) problems.doneOn = 'validation.afterStart';
    if (sentOn && followUpOn && followUpOn < sentOn) problems.followUpOn = 'validation.afterStart';
    if (Object.keys(problems).length) throw validationFailed(problems);

    let recipient: AddressBookEntry | null | undefined;
    if (dto.recipientId !== undefined) {
      recipient = dto.recipientId ? await this.prisma.addressBookEntry.findUnique({ where: { id: dto.recipientId } }) : null;
      if (dto.recipientId && !recipient) throw validationFailed({ recipientId: 'validation.invalid' });
    }

    const next = {
      status,
      sentOn,
      doneOn,
      followUpOn,
      reference: dto.reference === undefined ? row.reference : dto.reference.trim(),
      note: dto.note === undefined ? row.note : dto.note.trim(),
      ...(recipient !== undefined && { recipient: recipient ? recipient.name : '' }),
    };
    const before = { status: row.status, sentOn: day(row.sentOn), doneOn: day(row.doneOn), followUpOn: day(row.followUpOn), reference: row.reference, note: row.note, ...(recipient !== undefined && { recipient: row.recipient?.name ?? '' }) };
    const diff = AuditService.changes(before, next);
    if (!Object.keys(diff.after).length) return this.one(id, user, locale);
    await this.prisma.formSubmission.update({
      where: { id },
      data: {
        status,
        sentOn: sentOn ? toDay(sentOn) : null,
        doneOn: doneOn ? toDay(doneOn) : null,
        followUpOn: followUpOn ? toDay(followUpOn) : null,
        reference: next.reference,
        note: next.note,
        ...(recipient !== undefined && { recipientId: recipient?.id ?? null, recipientText: recipient ? addressLines(recipient, 'nl').join('\n') : '' }),
        searchText: [row.form.nameNl, row.form.nameEn, row.client.number, row.client.name, next.reference, next.note].map(fold).filter(Boolean).join(' '),
      },
    });
    await this.audit.log({ action: 'updated', entityType: SUBMISSION_ENTITY, entityId: id, entityLabel: `${row.form.nameNl} – ${row.client.number} ${row.client.name}`, before: diff.before, after: diff.after });
    return this.one(id, user, locale);
  }

  /** Takes an entry out of the log (an entry made by mistake) or puts it back. The PDF stays with the client's documents. */
  async setActive(id: string, dto: SubmissionStatusDto, user: AuthenticatedUser, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    if (row.isActive === dto.isActive) return this.one(id, user, locale);
    await this.prisma.formSubmission.update({
      where: { id },
      data: dto.isActive ? { isActive: true, deactivatedAt: null, deactivatedById: null, deactivationReason: '' } : { isActive: false, deactivatedAt: new Date(), deactivatedById: user.id, deactivationReason: dto.reason?.trim() ?? '' },
    });
    await this.audit.log({ action: dto.isActive ? 'activated' : 'deactivated', entityType: SUBMISSION_ENTITY, entityId: id, entityLabel: `${row.form.nameNl} – ${row.client.number} ${row.client.name}`, ...(dto.reason?.trim() && { meta: { reason: dto.reason.trim() } }) });
    return this.one(id, user, locale);
  }

  /* ── The envelope ─────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The label of the envelope the form goes in: the address it was filed with, else the form's own recipient. */
  async label(id: string, options: LabelOptions): Promise<{ bytes: Buffer; name: string }> {
    const row = await this.rowOrThrow(id);
    const recipient = row.recipient ?? (await this.prisma.officialForm.findUnique({ where: { id: row.formId }, select: { recipient: true } }))?.recipient ?? null;
    if (!recipient) throw new ConflictException({ code: 'no_recipient', message: 'This form has no address to send it to.' });
    return this.labels.forLines(addressLines(recipient, options.locale), options);
  }

  /* ── Reminders ────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The forms that were sent and have a follow-up day that has not passed (the reminder engine says when to tell). */
  async followUps(today: string) {
    return this.prisma.formSubmission.findMany({
      where: { isActive: true, status: 'sent', followUpOn: { gte: toDay(today) }, client: { isActive: true } },
      select: { id: true, clientId: true, followUpOn: true, sentOn: true, form: { select: { nameNl: true } }, client: { select: { number: true, name: true } } },
    });
  }

  /* ── Export ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  async exportTable(query: SubmissionExportQuery, user: AuthenticatedUser, locale: AppLocale): Promise<ExportTable> {
    const today = todayInAmsterdam();
    const where = this.where(query, today);
    this.exports.assertSize(await this.prisma.formSubmission.count({ where }));
    const rows = await this.prisma.formSubmission.findMany({ where, orderBy: this.orderBy(query.sort), include });
    const files = await this.fileInfo(rows.map(row => row.fileId));
    const items = await this.prisma.listItem.findMany({ where: { list: { key: 'form_submission_status' } }, select: { code: true, nameNl: true, nameEn: true } });
    const nl = locale === 'nl';
    const statusName = new Map(items.map(item => [item.code, nl ? item.nameNl : item.nameEn]));
    return {
      title: nl ? 'Verstuurde formulieren' : 'Sent forms',
      subtitle: query.search?.trim() ? `${nl ? 'Zoekterm' : 'Search'}: ${query.search.trim()}` : undefined,
      locale,
      columns: [
        { key: 'clientNumber', header: nl ? 'Klantnr.' : 'Client no.', width: 10 },
        { key: 'client', header: nl ? 'Klant' : 'Client', width: 26 },
        { key: 'form', header: nl ? 'Formulier' : 'Form', width: 34 },
        { key: 'person', header: nl ? 'Persoon' : 'Person', width: 22 },
        { key: 'status', header: 'Status', width: 14 },
        { key: 'preparedOn', header: nl ? 'Opgesteld' : 'Made', type: 'date', width: 12 },
        { key: 'sentOn', header: nl ? 'Verstuurd' : 'Sent', type: 'date', width: 12 },
        { key: 'followUpOn', header: nl ? 'Opvolgen op' : 'Follow up on', type: 'date', width: 12 },
        { key: 'doneOn', header: nl ? 'Afgehandeld' : 'Dealt with', type: 'date', width: 12 },
        { key: 'recipient', header: nl ? 'Gestuurd naar' : 'Sent to', width: 30 },
        { key: 'reference', header: nl ? 'Kenmerk' : 'Reference', width: 16 },
        { key: 'note', header: nl ? 'Opmerking' : 'Note', width: 30 },
      ],
      rows: rows.map(row => {
        const view = this.view(row, files, user, locale, today);
        return {
          clientNumber: view.client.number,
          client: view.client.name,
          form: view.form.name,
          person: view.person ?? '',
          status: statusName.get(view.status) ?? view.status,
          preparedOn: view.preparedOn,
          sentOn: view.sentOn,
          followUpOn: view.followUpOn,
          doneOn: view.doneOn,
          recipient: row.recipientText.split('\n')[0] ?? '',
          reference: view.reference,
          note: view.note,
        };
      }),
    };
  }
}
