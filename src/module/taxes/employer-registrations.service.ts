import { Injectable } from '@nestjs/common';
import { ApiResult, paged } from '../../common/api-result.js';
import { formatDay } from '../../common/dates.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { pageMeta } from '../../common/pagination.js';
import { asRecord } from '../../common/record-values.js';
import { fold } from '../../common/text.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ExportTable } from '../../lib/exports/export.types.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import type { EmployerExportQuery, EmployerListQuery } from './dto/taxes.dto.js';
import { TaxListsService } from './tax-lists.service.js';
import { CLIENT_FIELDS, EMPLOYER_FORM_CODE, EMPLOYER_STATES, type EmployerState } from './taxes.constants.js';

export interface EmployerRow {
  client: { id: string; number: string; name: string };
  responsible: { id: string; name: string } | null;
  payrollTaxNumber: string;
  payrollPeriod: string | null;
  employees: number;
  state: EmployerState;
  submission: { id: string; status: string; preparedOn: string; sentOn: string | null; doneOn: string | null; fileId: string } | null;
}

const split = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

/** What the screens show by default: everything except the clients that have no workers and no registration. */
const DEFAULT_STATES: readonly EmployerState[] = ['to_register', 'submitted', 'registered'];

/**
 * Employer registrations: which clients are registered with the tax authority as an employer (they have a payroll tax number), which have asked for it (the "Melding
 * loonheffingen" form was made and sent) and which have workers but nothing yet. Nothing is typed in twice: the number and the payroll period come from the client's record,
 * the request from the log of official forms, the workers from the employees.
 */
@Injectable()
export class EmployerRegistrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lists: TaxListsService,
    private readonly exports: ExportsService,
  ) {}

  /** Every active client with where it stands as an employer, worked out from its record, its workers and the forms made for it. */
  private async rows(clientId: string | undefined, search: string | undefined): Promise<EmployerRow[]> {
    const terms = fold(search ?? '').split(' ').filter(Boolean).slice(0, 6);
    const clients = await this.prisma.client.findMany({
      where: {
        isActive: true,
        ...(clientId && { id: clientId }),
        AND: terms.map(term => ({ OR: [{ searchText: { contains: term } }, { number: { contains: term, mode: 'insensitive' as const } }] })),
      },
      select: { id: true, number: true, name: true, data: true, responsibleUserId: true },
      orderBy: { number: 'asc' },
    });
    if (!clients.length) return [];
    const ids = clients.map(client => client.id);
    const [workers, submissions, users] = await Promise.all([
      this.prisma.employee.groupBy({ by: ['clientId'], where: { clientId: { in: ids }, isActive: true }, _count: { _all: true } }),
      this.prisma.formSubmission.findMany({
        where: { clientId: { in: ids }, form: { code: EMPLOYER_FORM_CODE }, status: { not: 'cancelled' }, isActive: true },
        select: { id: true, clientId: true, status: true, preparedOn: true, sentOn: true, doneOn: true, fileId: true },
        orderBy: [{ preparedOn: 'desc' }, { createdAt: 'desc' }],
      }),
      this.prisma.user.findMany({ where: { id: { in: clients.map(client => client.responsibleUserId).filter((id): id is string => Boolean(id)) } }, select: { id: true, name: true } }),
    ]);
    const workerCount = new Map(workers.map(entry => [entry.clientId, entry._count._all]));
    const latest = new Map<string, (typeof submissions)[number]>();
    for (const submission of submissions) if (!latest.has(submission.clientId)) latest.set(submission.clientId, submission);
    const userName = new Map(users.map(user => [user.id, user.name]));

    return clients.map(client => {
      const data = asRecord(client.data);
      const number = typeof data[CLIENT_FIELDS.payrollTaxNumber] === 'string' ? (data[CLIENT_FIELDS.payrollTaxNumber] as string).trim() : '';
      const period = typeof data[CLIENT_FIELDS.payrollPeriod] === 'string' ? (data[CLIENT_FIELDS.payrollPeriod] as string) : null;
      const employees = workerCount.get(client.id) ?? 0;
      const submission = latest.get(client.id) ?? null;
      // A payroll tax number means registered; a form that was made or sent means it was asked for; workers without either need to be registered.
      const state: EmployerState = number ? 'registered' : submission ? 'submitted' : employees > 0 ? 'to_register' : 'not_needed';
      return {
        client: { id: client.id, number: client.number, name: client.name },
        responsible: client.responsibleUserId ? { id: client.responsibleUserId, name: userName.get(client.responsibleUserId) ?? '' } : null,
        payrollTaxNumber: number,
        payrollPeriod: period,
        employees,
        state,
        submission: submission ? { id: submission.id, status: submission.status, preparedOn: formatDay(submission.preparedOn), sentOn: submission.sentOn ? formatDay(submission.sentOn) : null, doneOn: submission.doneOn ? formatDay(submission.doneOn) : null, fileId: submission.fileId } : null,
      };
    });
  }

  /** How many active clients are in each state (for the counters on the tabs of the taxes). */
  async counts(): Promise<Record<EmployerState, number>> {
    const rows = await this.rows(undefined, undefined);
    return Object.fromEntries(EMPLOYER_STATES.map(state => [state, rows.filter(row => row.state === state).length])) as Record<EmployerState, number>;
  }

  private order(sort: string | undefined) {
    const [key, direction] = (split(sort)[0] ?? 'number:asc').split(':') as [string, string?];
    const sign = direction === 'desc' ? -1 : 1;
    const rank = (state: EmployerState) => EMPLOYER_STATES.indexOf(state);
    const compare: Record<string, (a: EmployerRow, b: EmployerRow) => number> = {
      number: (a, b) => a.client.number.localeCompare(b.client.number, 'nl', { numeric: true }),
      client: (a, b) => a.client.name.localeCompare(b.client.name, 'nl'),
      state: (a, b) => rank(a.state) - rank(b.state),
      employees: (a, b) => a.employees - b.employees,
      payrollTaxNumber: (a, b) => a.payrollTaxNumber.localeCompare(b.payrollTaxNumber),
    };
    const base = compare[key] ?? compare.number!;
    return (a: EmployerRow, b: EmployerRow) => sign * base(a, b) || a.client.number.localeCompare(b.client.number, 'nl', { numeric: true });
  }

  async list(query: EmployerListQuery, locale: AppLocale): Promise<ApiResult> {
    const everything = await this.rows(query.clientId, query.search);
    const wanted = split(query.state).filter((state): state is EmployerState => (EMPLOYER_STATES as readonly string[]).includes(state));
    // One client is always shown, whatever its state (its own Taxes tab).
    const states = wanted.length ? wanted : query.clientId ? [...EMPLOYER_STATES] : [...DEFAULT_STATES];
    const rows = everything.filter(row => states.includes(row.state)).sort(this.order(query.sort));
    const start = (query.page - 1) * query.pageSize;
    const page = rows.slice(start, start + query.pageSize);
    const names = await this.lists.names('employer_registration_status', locale);
    const extra: Record<string, unknown> = {};
    if (query.stats) extra.stats = Object.fromEntries(EMPLOYER_STATES.map(state => [state, everything.filter(row => row.state === state).length]));
    return paged(
      page.map(row => ({ ...row, stateName: names.get(row.state) ?? row.state })),
      pageMeta(rows.length, query, extra),
    );
  }

  async exportTable(query: EmployerExportQuery, locale: AppLocale): Promise<ExportTable> {
    const everything = await this.rows(query.clientId, query.search);
    const wanted = split(query.state).filter((state): state is EmployerState => (EMPLOYER_STATES as readonly string[]).includes(state));
    const states = wanted.length ? wanted : query.clientId ? [...EMPLOYER_STATES] : [...DEFAULT_STATES];
    const rows = everything.filter(row => states.includes(row.state)).sort(this.order(query.sort));
    this.exports.assertSize(rows.length);
    const [stateNames, periodNames, formNames] = await Promise.all([this.lists.names('employer_registration_status', locale), this.lists.names('payroll_period', locale), this.lists.names('form_submission_status', locale)]);
    const nl = locale === 'nl';
    return {
      title: nl ? 'Werkgeversregistraties' : 'Employer registrations',
      subtitle: query.search?.trim() ? `${nl ? 'Zoekterm' : 'Search'}: ${query.search.trim()}` : undefined,
      locale,
      columns: [
        { key: 'number', header: nl ? 'Klantnr.' : 'Client no.', width: 10 },
        { key: 'client', header: nl ? 'Klant' : 'Client', width: 28 },
        { key: 'state', header: 'Status', width: 22 },
        { key: 'payrollTaxNumber', header: nl ? 'Loonheffingennummer' : 'Payroll tax number', width: 20 },
        { key: 'period', header: nl ? 'Aangifteperiode' : 'Return period', width: 16 },
        { key: 'employees', header: nl ? 'Medewerkers' : 'Workers', type: 'number', width: 12 },
        { key: 'form', header: nl ? 'Melding loonheffingen' : 'Payroll tax notification', width: 20 },
        { key: 'sentOn', header: nl ? 'Verstuurd op' : 'Sent on', type: 'date', width: 12 },
        { key: 'responsible', header: nl ? 'Verantwoordelijke' : 'Responsible', width: 20 },
      ],
      rows: rows.map(row => ({
        number: row.client.number,
        client: row.client.name,
        state: stateNames.get(row.state) ?? row.state,
        payrollTaxNumber: row.payrollTaxNumber,
        period: row.payrollPeriod ? (periodNames.get(row.payrollPeriod) ?? row.payrollPeriod) : '',
        employees: row.employees,
        form: row.submission ? (formNames.get(row.submission.status) ?? row.submission.status) : '',
        sentOn: row.submission?.sentOn ?? null,
        responsible: row.responsible?.name ?? '',
      })),
    };
  }
}
