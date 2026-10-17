import { Injectable } from '@nestjs/common';
import { daysBetween, formatDay, parseDay, todayInAmsterdam } from '../../common/dates.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ExportFormat } from '../../lib/exports/export.types.js';
import { ClientsService } from '../clients/clients.service.js';
import type { ClientExportQuery } from '../clients/dto/client.dto.js';
import { ContractsService } from '../contracts/contracts.service.js';
import type { ContractExportQuery } from '../contracts/dto/contract.dto.js';
import { DocumentRequirementsService } from '../documents/document-requirements.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import type { DocumentListQuery, RequirementExportQuery } from '../documents/dto/documents.dto.js';
import { EmployeesService } from '../employees/employees.service.js';
import type { EmployeeExportQuery } from '../employees/dto/employee.dto.js';
import type { EntryExportQuery } from '../hours/dto/hours.dto.js';
import { HoursService } from '../hours/hours.service.js';
import type { InspectionExportQuery } from '../inspections/dto/inspections.dto.js';
import { InspectionsService } from '../inspections/inspections.service.js';
import type { InvoiceExportQuery, MarkupQuery } from '../invoices/dto/invoice.dto.js';
import { InvoicesService } from '../invoices/invoices.service.js';
import { MarkupReportService } from '../invoices/markup-report.service.js';
import type { SubmissionExportQuery } from '../official-forms/dto/official-forms.dto.js';
import { FormSubmissionsService } from '../official-forms/form-submissions.service.js';
import { personName } from '../people/person-record.js';
import type { ReconciliationQuery } from '../reconciliation/dto/reconciliation.dto.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import type { StatementExportQuery } from '../salary-statements/dto/statement.dto.js';
import { SalaryStatementsService } from '../salary-statements/salary-statements.service.js';
import type { TaskExportQuery } from '../tasks/dto/tasks.dto.js';
import { OPEN_TASK_STATUSES } from '../tasks/tasks.constants.js';
import { TasksService } from '../tasks/tasks.service.js';
import type { ReturnExportQuery, VatExportQuery } from '../taxes/dto/taxes.dto.js';
import { TaxReturnsService } from '../taxes/tax-returns.service.js';
import { VatPeriodsService } from '../taxes/vat-periods.service.js';
import { PERIOD_NAMES, periodText, resolvePeriod, type PeriodKey } from './report-period.js';
import type { Named, ReportDefinition, ReportParam, ReportRunInput } from './reports.types.js';

const named = (nl: string, en: string): Named => ({ nl, en });
const pick = (text: Named, locale: AppLocale): string => text[locale];

const clientParam: ReportParam = { key: 'client', type: 'client', label: named('Klant', 'Client') };
const periodParam = (options: PeriodKey[], fallback: PeriodKey, label = named('Periode', 'Period')): ReportParam => ({ key: 'period', type: 'period', label, options, default: fallback });
const selectParam = (key: string, label: Named, options: Array<[string, string, string]>, fallback?: string): ReportParam => ({
  key,
  type: 'select',
  label,
  options: options.map(([value, nl, en]) => ({ value, label: named(nl, en) })),
  ...(fallback !== undefined && { default: fallback }),
});

/** The length of a table that is shown on screen; everything is in the file. */
const toFormat = (format: ReportRunInput['format']): ExportFormat => (format === 'screen' ? 'pdf' : format);

/** The last eight VAT quarters, newest first: `2026-Q3` → "Q3 2026". */
function quarterOptions(today: string): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  let year = Number(today.slice(0, 4));
  let quarter = Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1;
  for (let index = 0; index < 8; index += 1) {
    out.push([`${year}-Q${quarter}`, `Q${quarter} ${year}`, `Q${quarter} ${year}`]);
    quarter -= 1;
    if (quarter === 0) {
      quarter = 4;
      year -= 1;
    }
  }
  return out;
}

/**
 * Every report of the reports centre. Most are the lists and overviews the pages already have — the same table the page exports — asked from one place with a period and the
 * filters that matter; two are made here (contracts that end, the workload of the team). What a person may open follows the permission areas: a report needs `reports.view` and
 * the area it is about, and the ones that show wages need Salary statements as well.
 */
@Injectable()
export class ReportsCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clients: ClientsService,
    private readonly employees: EmployeesService,
    private readonly contracts: ContractsService,
    private readonly documents: DocumentsService,
    private readonly requirements: DocumentRequirementsService,
    private readonly hours: HoursService,
    private readonly statements: SalaryStatementsService,
    private readonly invoices: InvoicesService,
    private readonly markup: MarkupReportService,
    private readonly reconciliation: ReconciliationService,
    private readonly vat: VatPeriodsService,
    private readonly returns: TaxReturnsService,
    private readonly inspections: InspectionsService,
    private readonly forms: FormSubmissionsService,
    private readonly tasks: TasksService,
  ) {}

  /** The report definitions, in the order of the report page. */
  definitions(): ReportDefinition[] {
    const today = todayInAmsterdam();
    return [
      /* ── Lists ──────────────────────────────────────────────────────────────────────────────────────────────── */
      {
        key: 'clients',
        group: 'lists',
        area: 'clients',
        names: named('Klanten', 'Clients'),
        descriptions: named('Alle klanten met hun gegevens, per status.', 'All clients with their details, by status.'),
        params: [selectParam('status', named('Status', 'Status'), [['active', 'Actief', 'Active'], ['stopped', 'Gestopt', 'Stopped'], ['active,stopped', 'Alle', 'All']], 'active')],
        run: async ({ params, user, locale, format }) => ({
          table: (await this.clients.exportTable({ status: params.status || 'active', page: 1, pageSize: 500 } as ClientExportQuery, {}, user, locale, toFormat(format))).table,
        }),
      },
      {
        key: 'workers',
        group: 'lists',
        area: 'employees',
        names: named('Werknemers', 'Workers'),
        descriptions: named('Alle werknemers met hun klant, functie en datum in en uit dienst.', 'All workers with their client, function and start and end dates.'),
        params: [selectParam('status', named('Status', 'Status'), [['active', 'In dienst', 'Employed'], ['stopped', 'Uit dienst', 'Left'], ['active,stopped', 'Alle', 'All']], 'active')],
        run: async ({ params, user, locale, format }) => ({
          table: (await this.employees.exportTable({ status: params.status || 'active', page: 1, pageSize: 500 } as EmployeeExportQuery, {}, user, locale, toFormat(format))).table,
        }),
      },
      {
        key: 'contracts',
        group: 'lists',
        area: 'contracts',
        names: named('Contracten', 'Contracts'),
        descriptions: named('Alle contracten per status of klant.', 'All contracts by status or client.'),
        params: [
          selectParam('status', named('Status', 'Status'), [['active', 'Lopend', 'Running'], ['draft,sent', 'Concept of verstuurd', 'Draft or sent'], ['ended,terminated,cancelled', 'Afgelopen', 'Ended']]),
          clientParam,
        ],
        run: async ({ params, user, locale, format }) => ({
          table: (await this.contracts.exportTable({ status: params.status || undefined, clientId: params.client || undefined, page: 1, pageSize: 500 } as ContractExportQuery, {}, user, locale, toFormat(format))).table,
        }),
      },
      {
        key: 'contract-expiries',
        group: 'lists',
        area: 'contracts',
        names: named('Contracten die aflopen', 'Contracts ending'),
        descriptions: named('Lopende contracten met een einddatum in de gekozen periode — verlengen, beëindigen of laten aflopen.', 'Running contracts with an end date in the chosen period — renew, end or let them expire.'),
        params: [periodParam(['next_30', 'next_60', 'next_90', 'next_180', 'next_365', 'this_month', 'this_quarter', 'this_year', 'custom'], 'next_90', named('Loopt af in', 'Ends in')), clientParam],
        run: input => this.contractExpiries(input),
      },
      {
        key: 'documents-attention',
        group: 'lists',
        area: 'documents',
        names: named('Documenten: ontbrekend of verlopen', 'Documents: missing or expired'),
        descriptions: named('Welke verplichte documenten ontbreken, verlopen of binnenkort verlopen — per klant en werknemer.', 'Which required documents are missing, expired or about to expire — by client and worker.'),
        params: [selectParam('state', named('Toestand', 'State'), [['missing', 'Ontbreekt', 'Missing'], ['expired', 'Verlopen', 'Expired'], ['expiring', 'Verloopt binnenkort', 'Expiring soon'], ['missing,expired,expiring', 'Alles wat aandacht nodig heeft', 'Everything that needs attention'], ['all', 'Alles', 'Everything']], 'missing,expired,expiring'), clientParam],
        run: async ({ params, user, locale }) => ({
          table: await this.requirements.exportTable({ state: params.state || undefined, clientId: params.client || undefined, page: 1, pageSize: 500 } as RequirementExportQuery, user, locale),
        }),
      },
      {
        key: 'documents',
        group: 'lists',
        area: 'documents',
        names: named('Documenten', 'Documents'),
        descriptions: named('Alle documenten met type, klant en geldigheid, voor de gekozen periode (de datum op het document).', 'All documents with their type, client and validity, for the chosen period (the date on the document).'),
        params: [periodParam(['all', 'this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_year', 'last_year', 'custom'], 'all', named('Datum op het document', 'Date on the document')), clientParam],
        run: async ({ params, user, locale }) => {
          const period = resolvePeriod(params.period ?? 'all', params);
          return { table: await this.documents.exportTable({ clientId: params.client || undefined, from: period?.from, to: period?.to, page: 1, pageSize: 500 } as DocumentListQuery, user, locale) };
        },
      },
      {
        key: 'tasks',
        group: 'lists',
        area: 'tasks',
        names: named('Taken', 'Tasks'),
        descriptions: named('Alle taken met wie ze doet en wanneer ze klaar moeten zijn.', 'All tasks with who does them and when they are due.'),
        params: [selectParam('open', named('Taken', 'Tasks'), [['true', 'Nog te doen', 'Still to do'], ['false', 'Klaar', 'Done']], 'true')],
        run: async ({ params, user, locale }) => ({ table: await this.tasks.exportTable({ open: params.open ? params.open === 'true' : undefined, state: 'active', page: 1, pageSize: 500 } as TaskExportQuery, user, locale) }),
      },
      {
        key: 'tasks-workload',
        group: 'lists',
        area: 'tasks',
        names: named('Werkverdeling van het team', 'Team workload'),
        descriptions: named('Hoeveel open taken elke medewerker heeft, en hoeveel daarvan te laat zijn.', 'How many open tasks each member of staff has, and how many of them are late.'),
        params: [],
        run: input => this.workload(input),
      },
      /* ── Hours and money ────────────────────────────────────────────────────────────────────────────────────── */
      {
        key: 'hours',
        group: 'money',
        area: 'hours',
        names: named('Uren', 'Hours'),
        descriptions: named('Geregistreerde uren per werknemer en dag in de gekozen periode.', 'Registered hours per worker and day in the chosen period.'),
        params: [periodParam(['last_month', 'this_month', 'last_quarter', 'this_quarter', 'this_year', 'last_year', 'custom'], 'last_month'), clientParam],
        run: async ({ params, user, locale }) => {
          const period = resolvePeriod(params.period ?? 'last_month', params);
          return { table: await this.hours.exportTable({ clientId: params.client || undefined, from: period?.from, to: period?.to, page: 1, pageSize: 500 } as EntryExportQuery, user, locale) };
        },
      },
      {
        key: 'salary-statements',
        group: 'money',
        area: 'salary_statements',
        names: named('Loonstaten', 'Salary statements'),
        descriptions: named('De loonstaten van de gekozen periode, met uren en bedragen.', 'The salary statements of the chosen period, with hours and amounts.'),
        params: [periodParam(['last_month', 'this_month', 'last_quarter', 'this_quarter', 'this_year', 'last_year', 'custom'], 'last_month'), clientParam],
        run: async ({ params, locale }) => {
          const period = resolvePeriod(params.period ?? 'last_month', params);
          return { table: await this.statements.listTable({ clientId: params.client || undefined, from: period?.from, to: period?.to, status: 'final', page: 1, pageSize: 500 } as StatementExportQuery, locale) };
        },
      },
      {
        key: 'invoices',
        group: 'money',
        area: 'invoices',
        names: named('Facturen', 'Invoices'),
        descriptions: named('Inkomende en uitgaande facturen in de gekozen periode, met bedragen en status.', 'Incoming and outgoing invoices in the chosen period, with amounts and status.'),
        params: [
          periodParam(['this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_year', 'last_year', 'all', 'custom'], 'last_month'),
          selectParam('direction', named('Soort', 'Kind'), [['incoming', 'Inkomend', 'Incoming'], ['outgoing', 'Uitgaand', 'Outgoing']]),
          selectParam('open', named('Betaling', 'Payment'), [['true', 'Nog niet betaald', 'Not paid yet'], ['overdue', 'Te laat', 'Overdue']]),
          clientParam,
        ],
        run: async ({ params, locale }) => {
          const period = resolvePeriod(params.period ?? 'last_month', params);
          return {
            table: await this.invoices.listTable(
              { direction: params.direction || undefined, clientId: params.client || undefined, from: period?.from, to: period?.to, status: 'all', open: params.open === 'true' || undefined, overdue: params.open === 'overdue' || undefined, page: 1, pageSize: 500 } as unknown as InvoiceExportQuery,
              locale,
            ),
          };
        },
      },
      {
        key: 'markup',
        group: 'money',
        area: 'invoices',
        alsoNeeds: ['salary_statements'],
        names: named('Opslagrapport', 'Markup report'),
        descriptions: named('Wat bureaus en klanten rekenen boven op het loon van werknemers, per maand en klant.', 'What agencies and clients charge on top of the workers’ pay, by month and client.'),
        params: [periodParam(['last_month', 'this_month', 'last_quarter', 'this_quarter', 'this_year', 'last_year', 'custom'], 'last_month'), selectParam('direction', named('Soort', 'Kind'), [['incoming', 'Inkomend', 'Incoming'], ['outgoing', 'Uitgaand', 'Outgoing']]), clientParam],
        run: async ({ params, locale }) => {
          const period = resolvePeriod(params.period ?? 'last_month', params);
          return { table: await this.markup.table({ from: period?.from, to: period?.to, clientId: params.client || undefined, direction: params.direction || undefined } as MarkupQuery, locale) };
        },
      },
      {
        key: 'reconciliation',
        group: 'money',
        area: 'invoices',
        names: named('Uren, loon en facturen: afstemming', 'Hours, pay and invoices: reconciliation'),
        descriptions: named('Per werknemer: komen de uren, het loon en de facturen overeen? Wat niet klopt staat bovenaan.', 'Per worker: do the hours, the pay and the invoices match? What does not match comes first.'),
        params: [periodParam(['last_month', 'this_month', 'last_quarter', 'this_quarter', 'custom'], 'last_month'), selectParam('status', named('Toestand', 'State'), [['differences', 'Alleen verschillen', 'Differences only'], ['ok', 'Alleen wat klopt', 'Matching only']]), clientParam],
        run: async ({ params, user, locale }) => {
          const period = resolvePeriod(params.period ?? 'last_month', params);
          const money = matrixAllows(user.matrix, 'salary_statements.view');
          return { table: await this.reconciliation.table({ from: period?.from, to: period?.to, clientId: params.client || undefined, status: params.status || 'all', page: 1, pageSize: 500 } as unknown as ReconciliationQuery, money, locale) };
        },
      },
      /* ── Taxes ──────────────────────────────────────────────────────────────────────────────────────────────── */
      {
        key: 'vat',
        group: 'taxes',
        area: 'taxes',
        names: named('Btw-aangiften', 'VAT returns'),
        descriptions: named('De voortgang van de btw-aangiften van één kwartaal: welke stappen klaar zijn, per klant.', 'The progress of the VAT returns of one quarter: which steps are done, per client.'),
        params: [selectParam('vatPeriod', named('Kwartaal', 'Quarter'), quarterOptions(today), quarterOptions(today)[1]?.[0]), selectParam('open', named('Aangiften', 'Returns'), [['true', 'Nog niet verstuurd', 'Not filed yet']])],
        run: async ({ params, locale }) => ({ table: await this.vat.exportTable({ period: params.vatPeriod || quarterOptions(today)[1]?.[0], open: params.open === 'true' || undefined, page: 1, pageSize: 500 } as unknown as VatExportQuery, locale) }),
      },
      {
        key: 'tax-returns',
        group: 'taxes',
        area: 'taxes',
        names: named('Aangiften inkomstenbelasting en vennootschapsbelasting', 'Income tax and corporate tax returns'),
        descriptions: named('De jaaraangiften met status, deadline en uitstel.', 'The yearly returns with status, deadline and extension.'),
        params: [
          selectParam('kind', named('Soort', 'Kind'), [['income_tax', 'Inkomstenbelasting', 'Income tax'], ['corporate_tax', 'Vennootschapsbelasting', 'Corporate income tax']], 'income_tax'),
          selectParam('year', named('Jaar', 'Year'), [0, 1, 2, 3].map(back => [String(Number(today.slice(0, 4)) - 1 - back), String(Number(today.slice(0, 4)) - 1 - back), String(Number(today.slice(0, 4)) - 1 - back)] as [string, string, string]), String(Number(today.slice(0, 4)) - 1)),
          selectParam('open', named('Aangiften', 'Returns'), [['true', 'Nog niet ingediend', 'Not filed yet']]),
        ],
        run: async ({ params, locale }) => ({ table: await this.returns.exportTable({ kind: params.kind || 'income_tax', taxYear: params.year || undefined, open: params.open === 'true' || undefined, state: 'active', page: 1, pageSize: 500 } as ReturnExportQuery, locale) }),
      },
      /* ── Control ────────────────────────────────────────────────────────────────────────────────────────────── */
      {
        key: 'inspections',
        group: 'control',
        area: 'inspections',
        names: named('Controles', 'Inspections'),
        descriptions: named('De controles in de gekozen periode met status en uitkomst.', 'The inspections in the chosen period with their status and outcome.'),
        params: [periodParam(['this_year', 'last_year', 'this_quarter', 'last_quarter', 'next_90', 'all', 'custom'], 'this_year', named('Datum van de controle', 'Date of the inspection')), clientParam],
        run: async ({ params, locale }) => {
          const period = resolvePeriod(params.period ?? 'this_year', params);
          return { table: await this.inspections.exportTable({ clientId: params.client || undefined, from: period?.from, to: period?.to, state: 'active', page: 1, pageSize: 500 } as InspectionExportQuery, locale) };
        },
      },
      {
        key: 'forms-log',
        group: 'control',
        area: 'official_forms',
        names: named('Verstuurde formulieren', 'Forms sent'),
        descriptions: named('De officiële formulieren die zijn ingevuld, met waar ze naartoe gingen en of er al antwoord is.', 'The official forms that were filled in, where they went and whether there is an answer yet.'),
        params: [periodParam(['this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_year', 'last_year', 'all', 'custom'], 'this_year', named('Datum van het formulier', 'Date of the form')), clientParam],
        run: async ({ params, user, locale }) => {
          const period = resolvePeriod(params.period ?? 'this_year', params);
          return { table: await this.forms.exportTable({ clientId: params.client || undefined, from: period?.from, to: period?.to, state: 'active', page: 1, pageSize: 500 } as SubmissionExportQuery, user, locale) };
        },
      },
    ];
  }

  /* ── The two reports made here ────────────────────────────────────────────────────────────────────────────────── */

  private async listNames(key: string, locale: AppLocale): Promise<Map<string, string>> {
    const items = await this.prisma.listItem.findMany({ where: { list: { key } }, select: { code: true, nameNl: true, nameEn: true } });
    return new Map(items.map(item => [item.code, locale === 'nl' ? item.nameNl : item.nameEn]));
  }

  private async contractExpiries({ params, locale }: ReportRunInput) {
    const nl = locale === 'nl';
    const today = todayInAmsterdam();
    const period = resolvePeriod(params.period ?? 'next_90', params, today);
    const [rows, types] = await Promise.all([
      this.prisma.contract.findMany({
        where: { status: 'active', endDate: period ? { gte: parseDay(period.from), lte: parseDay(period.to) } : { not: null }, ...(params.client && { clientId: params.client }) },
        orderBy: [{ endDate: 'asc' }],
        take: 5000,
        select: { id: true, type: true, startDate: true, endDate: true, client: { select: { number: true, name: true } }, employee: { select: { person: { select: { firstName: true, lastName: true, data: true } } } } },
      }),
      this.listNames('contract_type', locale),
    ]);
    const byMonth = new Map<string, number>();
    for (const row of rows) byMonth.set(formatDay(row.endDate!).slice(0, 7), (byMonth.get(formatDay(row.endDate!).slice(0, 7)) ?? 0) + 1);
    const next = rows.find(row => formatDay(row.endDate!) >= today);
    return {
      table: {
        title: nl ? 'Contracten die aflopen' : 'Contracts ending',
        subtitle: periodText(period, locale),
        locale,
        columns: [
          { key: 'number', header: nl ? 'Klantnr.' : 'Client no.', width: 10 },
          { key: 'client', header: nl ? 'Klant' : 'Client', width: 28 },
          { key: 'worker', header: nl ? 'Werknemer' : 'Worker', width: 26 },
          { key: 'type', header: nl ? 'Soort contract' : 'Contract type', width: 20 },
          { key: 'startDate', header: nl ? 'Begin' : 'Start', type: 'date' as const, width: 12 },
          { key: 'endDate', header: nl ? 'Einde' : 'End', type: 'date' as const, width: 12 },
          { key: 'daysLeft', header: nl ? 'Dagen te gaan' : 'Days left', type: 'number' as const, width: 12 },
        ],
        rows: rows.map(row => ({
          number: row.client.number,
          client: row.client.name,
          worker: personName(row.employee.person),
          type: types.get(row.type) ?? row.type,
          startDate: formatDay(row.startDate),
          endDate: formatDay(row.endDate!),
          daysLeft: daysBetween(today, formatDay(row.endDate!)),
        })),
      },
      summary: [
        { label: nl ? 'Contracten die aflopen' : 'Contracts ending', value: rows.length, format: 'number' as const },
        { label: nl ? 'Klanten' : 'Clients', value: new Set(rows.map(row => row.client.number)).size, format: 'number' as const },
        { label: nl ? 'Eerstvolgende' : 'Next one', value: next ? (nl ? `over ${daysBetween(today, formatDay(next.endDate!))} dagen` : `in ${daysBetween(today, formatDay(next.endDate!))} days`) : '—', format: 'text' as const },
      ],
      chart: byMonth.size ? { type: 'bar' as const, categories: [...byMonth.keys()].map(month => `${month.slice(5, 7)}-${month.slice(0, 4)}`), series: [{ name: nl ? 'Contracten die aflopen' : 'Contracts ending', data: [...byMonth.values()] }] } : null,
    };
  }

  private async workload({ locale }: ReportRunInput) {
    const nl = locale === 'nl';
    const today = todayInAmsterdam();
    const [open, users] = await Promise.all([
      this.prisma.task.findMany({ where: { isActive: true, status: { in: [...OPEN_TASK_STATUSES] } }, select: { assigneeId: true, dueDate: true } }),
      this.prisma.user.findMany({ where: { status: 'active' }, select: { id: true, name: true, title: true }, orderBy: { name: 'asc' } }),
    ]);
    const line = (assigneeId: string | null) => {
      const mine = open.filter(task => task.assigneeId === assigneeId);
      const overdue = mine.filter(task => task.dueDate && formatDay(task.dueDate) < today).length;
      const week = mine.filter(task => task.dueDate && formatDay(task.dueDate) >= today && daysBetween(today, formatDay(task.dueDate)) <= 7).length;
      return { open: mine.length, overdue, week };
    };
    const people = users.map(user => ({ person: user.name, role: user.title, ...line(user.id) }));
    const nobody = line(null);
    const rows = [...people, ...(nobody.open ? [{ person: nl ? 'Niet toegewezen' : 'Not assigned', role: '', ...nobody }] : [])];
    return {
      table: {
        title: nl ? 'Werkverdeling van het team' : 'Team workload',
        locale,
        columns: [
          { key: 'person', header: nl ? 'Medewerker' : 'Member of staff', width: 26 },
          { key: 'role', header: nl ? 'Functie' : 'Title', width: 22 },
          { key: 'open', header: nl ? 'Open taken' : 'Open tasks', type: 'number' as const, width: 12 },
          { key: 'overdue', header: nl ? 'Te laat' : 'Overdue', type: 'number' as const, width: 12 },
          { key: 'week', header: nl ? 'Komende 7 dagen' : 'Next 7 days', type: 'number' as const, width: 16 },
        ],
        rows,
      },
      summary: [
        { label: nl ? 'Open taken' : 'Open tasks', value: rows.reduce((sum, row) => sum + row.open, 0), format: 'number' as const },
        { label: nl ? 'Te laat' : 'Overdue', value: rows.reduce((sum, row) => sum + row.overdue, 0), format: 'number' as const, tone: 'danger' as const },
      ],
      chart: rows.length
        ? {
            type: 'bar' as const,
            stacked: true,
            categories: rows.map(row => row.person),
            series: [
              { name: nl ? 'Op schema' : 'On track', data: rows.map(row => row.open - row.overdue), tone: 'brand' as const },
              { name: nl ? 'Te laat' : 'Overdue', data: rows.map(row => row.overdue), tone: 'danger' as const },
            ],
          }
        : null,
    };
  }

  /** The option labels of a parameter in the person's language (the page draws them as they are). */
  localizeParam(param: ReportParam, locale: AppLocale) {
    if (param.type === 'select') return { key: param.key, type: param.type, label: pick(param.label, locale), options: param.options.map(option => ({ value: option.value, label: pick(option.label, locale) })), ...(param.default !== undefined && { default: param.default }) };
    if (param.type === 'period') return { key: param.key, type: param.type, label: pick(param.label, locale), options: param.options.map(value => ({ value, label: PERIOD_NAMES[value as PeriodKey]?.[locale] ?? value })), default: param.default };
    return { key: param.key, type: param.type, label: pick(param.label, locale) };
  }
}

