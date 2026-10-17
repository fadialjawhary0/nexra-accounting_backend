import { Injectable } from '@nestjs/common';
import { paged, type ApiResult } from '../../common/api-result.js';
import { todayInAmsterdam } from '../../common/dates.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { pageMeta } from '../../common/pagination.js';
import { fold } from '../../common/text.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ExportTable } from '../../lib/exports/export.types.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { MAX_EXPORT_ROWS } from '../../lib/exports/export.types.js';
import { ChecklistTemplatesService } from './checklist-templates.service.js';
import { readDoc, type ChecklistItem } from './checklist-doc.js';
import type { ReadinessExportQuery, ReadinessQuery } from './dto/inspections.dto.js';
import { InspectionChecklistService } from './inspection-checklist.service.js';
import { InspectionContextService } from './inspection-context.service.js';
import { InspectionListsService } from './inspection-lists.service.js';
import type { Summary } from './inspection-matching.js';
import { INSPECTION_INCLUDE, day, type InspectionRow } from './inspection-rows.js';
import { OPEN_STATUSES } from './inspections.constants.js';

/** A client number sorts the way it reads: `2` before `10`. */
const numberKey = (number: string): string => number.replace(/\d+/g, digits => digits.padStart(10, '0')).toLowerCase();

export interface ReadinessRow {
  client: { id: string; number: string; name: string };
  /** The inspection that is next (or over time), when one is planned. */
  inspection: { id: string; number: string; date: string; status: string; type: string; overdue: boolean } | null;
  /** The last inspection that took place (or is under way), for the clients that have none planned. */
  last: { id: string; number: string; date: string; type: string } | null;
  /** The day the documents are measured against (the inspection day, or today). */
  asOf: string;
  version: { id: string; number: number; label: string; template: string } | null;
  readiness: Summary | null;
  /** The readiness is of a planned inspection (with its decisions), not of the standard checklist on today's date. */
  planned: boolean;
}

/**
 * How ready each client is for its next inspection, side by side: "KvK extract too old at 3 of 12 clients" is a list to work through before the season, not a surprise on
 * the day. A client with an inspection planned is measured on that day with its own checklist; one without is measured today against the standard checklist of its kind.
 */
@Injectable()
export class InspectionReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: InspectionContextService,
    private readonly checklist: InspectionChecklistService,
    private readonly templates: ChecklistTemplatesService,
    private readonly lists: InspectionListsService,
    private readonly exports: ExportsService,
  ) {}

  /** The kind of inspection that comes back (the first one flagged as recurring), for measuring clients that have none planned. */
  private async recurringType(): Promise<string | null> {
    return (await this.lists.entries('inspection_type')).find(entry => entry.isActive && entry.meta.recurring === true)?.code ?? null;
  }

  async compute(query: Pick<ReadinessQuery, 'show' | 'clientId' | 'search'>): Promise<ReadinessRow[]> {
    const today = todayInAmsterdam();
    const show = query.show ?? 'relevant';
    const terms = fold(query.search ?? '').split(' ').filter(Boolean);

    const open = await this.prisma.inspection.findMany({
      where: { isActive: true, status: { in: [...OPEN_STATUSES] }, client: { isActive: true }, ...(query.clientId && { clientId: query.clientId }) },
      include: INSPECTION_INCLUDE,
      orderBy: { date: 'asc' },
    });
    // The inspection to measure each client by: the first one that has not passed yet, else the oldest one still open.
    const next = new Map<string, InspectionRow>();
    for (const row of open) {
      const current = next.get(row.clientId);
      const upcoming = day(row.date)! >= today;
      if (!current || (upcoming && day(current.date)! < today)) next.set(row.clientId, row);
    }

    // The clients to look at: with an inspection that is not over, or marked as NEN 4400-1 certified (the client form's own flag) — or every active client.
    let clients = await this.prisma.client.findMany({
      where: {
        isActive: true,
        ...(query.clientId && { id: query.clientId }),
        ...(show !== 'all' && { OR: [{ id: { in: [...next.keys()] } }, { data: { path: ['nen_4400'], equals: true } }] }),
      },
      select: { id: true, number: true, name: true },
    });
    clients = clients.filter(client => terms.every(term => fold(`${client.number} ${client.name}`).includes(term)));

    // The last inspection of each client that is not planned any more (shown next to the ones that have nothing planned).
    const lastRows = await this.prisma.inspection.findMany({
      where: { isActive: true, status: { not: 'cancelled' }, clientId: { in: clients.map(client => client.id) } },
      orderBy: { date: 'desc' },
      select: { id: true, number: true, clientId: true, date: true, type: true, status: true },
    });
    const last = new Map<string, (typeof lastRows)[number]>();
    for (const row of lastRows) if (!last.has(row.clientId) && !OPEN_STATUSES.includes(row.status)) last.set(row.clientId, row);

    // Measuring: planned inspections with their own checklist, the others with the standard checklist of the kind that comes back.
    const standardType = await this.recurringType();
    const standard = standardType ? await this.templates.forType(standardType) : null;
    const standardItems: ChecklistItem[] = standard ? readDoc(standard.version.sections, standard.version.items).items : [];

    const planned = clients.map(client => next.get(client.id)).filter((row): row is InspectionRow => Boolean(row));
    const summaries = await this.checklist.summaries(planned);
    const loose = clients.filter(client => !next.has(client.id));
    const answers = standard
      ? await this.context.evaluate(loose.map(client => ({ key: client.id, clientId: client.id, asOf: today, items: standardItems, choices: new Map(), templateId: standard.version.templateId })))
      : new Map();

    return clients.map((client): ReadinessRow => {
      const inspection = next.get(client.id);
      const finished = last.get(client.id);
      const base = { client, last: finished ? { id: finished.id, number: finished.number, date: day(finished.date)!, type: finished.type } : null };
      if (inspection) {
        return {
          ...base,
          inspection: { id: inspection.id, number: inspection.number, date: day(inspection.date)!, status: inspection.status, type: inspection.type, overdue: day(inspection.date)! < today },
          asOf: day(inspection.date)!,
          version: inspection.version ? { id: inspection.version.id, number: inspection.version.version, label: inspection.version.label, template: inspection.version.template.nameNl } : null,
          readiness: summaries.get(inspection.id) ?? null,
          planned: true,
        };
      }
      return {
        ...base,
        inspection: null,
        asOf: today,
        version: standard ? { id: standard.version.id, number: standard.version.version, label: standard.version.label, template: standard.template.nameNl } : null,
        readiness: answers.get(client.id)?.summary ?? null,
        planned: false,
      };
    });
  }

  private sorted(rows: ReadinessRow[], sort: string | undefined): ReadinessRow[] {
    const [field, direction] = (sort ?? '').split(',')[0]?.split(':') ?? [];
    const dir = direction === 'desc' ? -1 : 1;
    const date = (row: ReadinessRow) => row.inspection?.date ?? '9999-12-31';
    const percent = (row: ReadinessRow) => row.readiness?.percent ?? 101;
    const open = (row: ReadinessRow) => (row.readiness ? row.readiness.total - row.readiness.ready : -1);
    const compare: Record<string, (a: ReadinessRow, b: ReadinessRow) => number> = {
      client: (a, b) => numberKey(a.client.number).localeCompare(numberKey(b.client.number)),
      date: (a, b) => date(a).localeCompare(date(b)),
      percent: (a, b) => percent(a) - percent(b),
      open: (a, b) => open(a) - open(b),
    };
    const primary = compare[field ?? ''] ?? compare.date!;
    return [...rows].sort((a, b) => dir * primary(a, b) || numberKey(a.client.number).localeCompare(numberKey(b.client.number)));
  }

  async list(query: ReadinessQuery): Promise<ApiResult> {
    const all = await this.compute(query);
    const shown = query.attention ? all.filter(row => row.readiness !== null && row.readiness.ready < row.readiness.total) : all;
    const rows = this.sorted(shown, query.sort);
    const start = (query.page - 1) * query.pageSize;
    const counts = {
      clients: all.length,
      ready: all.filter(row => row.readiness && row.readiness.ready >= row.readiness.total).length,
      attention: all.filter(row => row.readiness && row.readiness.ready < row.readiness.total).length,
      planned: all.filter(row => row.planned).length,
    };
    return paged(rows.slice(start, start + query.pageSize), pageMeta(rows.length, query, { counts }));
  }

  async exportTable(query: ReadinessExportQuery, locale: AppLocale): Promise<ExportTable> {
    const rows = this.sorted((await this.compute(query)).filter(row => !query.attention || (row.readiness !== null && row.readiness.ready < row.readiness.total)), query.sort);
    this.exports.assertSize(Math.min(rows.length, MAX_EXPORT_ROWS + 1));
    const types = await this.lists.names('inspection_type', locale);
    const nl = locale === 'nl';
    return {
      title: nl ? 'Gereedheid voor controles' : 'Readiness for inspections',
      subtitle: nl ? `Peildatum ${todayInAmsterdam().split('-').reverse().join('-')}` : `As of ${todayInAmsterdam().split('-').reverse().join('-')}`,
      locale,
      columns: [
        { key: 'clientNumber', header: nl ? 'Klantnr.' : 'Client no.', width: 10 },
        { key: 'client', header: nl ? 'Klant' : 'Client', width: 28 },
        { key: 'inspection', header: nl ? 'Eerstvolgende controle' : 'Next inspection', width: 24 },
        { key: 'date', header: nl ? 'Datum' : 'Date', type: 'date', width: 12 },
        { key: 'percent', header: nl ? 'Gereed (%)' : 'Ready (%)', type: 'number', width: 10 },
        { key: 'ready', header: nl ? 'Gereed' : 'Ready', type: 'number', width: 8 },
        { key: 'missing', header: nl ? 'Ontbreekt' : 'Missing', type: 'number', width: 10 },
        { key: 'tooOld', header: nl ? 'Te oud' : 'Too old', type: 'number', width: 8 },
        { key: 'partial', header: nl ? 'Gedeeltelijk' : 'Partly', type: 'number', width: 12 },
        { key: 'manual', header: nl ? 'Afvinken' : 'To tick', type: 'number', width: 10 },
        { key: 'last', header: nl ? 'Laatste controle' : 'Last inspection', type: 'date', width: 14 },
      ],
      rows: rows.map(row => ({
        clientNumber: row.client.number,
        client: row.client.name,
        inspection: row.inspection ? `${row.inspection.number} · ${types.get(row.inspection.type) ?? row.inspection.type}` : '',
        date: row.inspection?.date ?? null,
        percent: row.readiness?.percent ?? null,
        ready: row.readiness?.ready ?? null,
        missing: row.readiness?.missing ?? null,
        tooOld: row.readiness?.tooOld ?? null,
        partial: row.readiness?.partial ?? null,
        manual: row.readiness?.manual ?? null,
        last: row.last?.date ?? null,
      })),
    };
  }
}
