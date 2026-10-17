import { ForbiddenException, Injectable } from '@nestjs/common';
import { addMonths } from '../../common/dates.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import type { ExportTable } from '../../lib/exports/export.types.js';
import { personName } from '../people/person-record.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import { itemLabel } from './checklist-doc.js';
import { InspectionChecklistService } from './inspection-checklist.service.js';
import { dutchDay } from './inspection-folders.service.js';
import { InspectionListsService } from './inspection-lists.service.js';
import type { ItemState } from './inspection-matching.js';
import { day, docOf, toDay, type InspectionRow } from './inspection-rows.js';
import { INSPECTIONS_NAMESPACE } from './inspections.constants.js';

export interface SampleWorkerView {
  id: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  /** What the checklist asks for of each sampled worker (the final payslips …) and how it stands. */
  documents: Array<{ code: string; label: string; state: ItemState; files: Array<{ id: string; name: string }> }>;
}

export interface SampleView {
  asOf: string;
  /** The start of the stretch the joiners and leavers are listed for. */
  since: string;
  /** The inspection before this one (the stretch starts the day after it). */
  previous: { id: string; number: string; date: string } | null;
  /** The most recent leavers: the inspector's sample. */
  sample: SampleWorkerView[];
  joiners: Array<{ id: string; name: string; startDate: string }>;
  leavers: Array<{ id: string; name: string; endDate: string; startDate: string | null }>;
}

/**
 * What the inspector draws the sample from (docs/11): the most recent leavers with the papers asked for of each of them, and who joined and left since the last
 * inspection with the periods they worked. The worker inquiry (hours, salary and invoices side by side) is one click further, per worker.
 */
@Injectable()
export class InspectionSampleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly checklist: InspectionChecklistService,
    private readonly lists: InspectionListsService,
  ) {}

  async sample(row: InspectionRow, user: AuthenticatedUser, locale: AppLocale): Promise<SampleView> {
    if (!matrixAllows(user.matrix, 'employees.view')) throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this.' });
    const asOf = day(row.date)!;
    const previous = await this.prisma.inspection.findFirst({
      where: { clientId: row.clientId, isActive: true, status: { not: 'cancelled' }, date: { lt: row.date }, NOT: { id: row.id } },
      orderBy: { date: 'desc' },
      select: { id: true, number: true, date: true },
    });
    const since = previous ? day(previous.date)! : addMonths(asOf, -this.settings.get<number>(`${INSPECTIONS_NAMESPACE}.sampleLookbackMonths`));

    const { evaluation } = await this.checklist.evaluation(row);
    const doc = docOf(row);
    const sampleItems = doc.items.filter(item => item.scope === 'sample');
    const byCode = new Map(evaluation.items.map(result => [result.code, result]));
    const fileIds = [...new Set(sampleItems.flatMap(item => (byCode.get(item.code)?.subjects ?? []).flatMap(subject => subject.files.map(file => file.id))))];
    const files = fileIds.length ? await this.prisma.storedFile.findMany({ where: { id: { in: fileIds } }, select: { id: true, name: true, area: true } }) : [];
    // Only documents the person may open are named.
    const nameOf = new Map(files.filter(file => file.area && matrixAllows(user.matrix, `${file.area}.view`)).map(file => [file.id, file.name]));

    const workers = await this.prisma.employee.findMany({
      where: { clientId: row.clientId, OR: [{ startDate: { gt: toDay(since), lte: toDay(asOf) } }, { endDate: { gt: toDay(since), lte: toDay(asOf) } }] },
      select: { id: true, startDate: true, endDate: true, person: { select: { firstName: true, lastName: true, data: true } } },
    });
    const joiners = workers.filter(worker => worker.startDate && day(worker.startDate)! > since && day(worker.startDate)! <= asOf).sort((a, b) => day(b.startDate)!.localeCompare(day(a.startDate)!));
    const leavers = workers.filter(worker => worker.endDate && day(worker.endDate)! > since && day(worker.endDate)! <= asOf).sort((a, b) => day(b.endDate)!.localeCompare(day(a.endDate)!));
    return {
      asOf,
      since,
      previous: previous ? { id: previous.id, number: previous.number, date: day(previous.date)! } : null,
      sample: evaluation.sample.map(worker => ({
        id: worker.id,
        name: worker.name,
        startDate: worker.startDate,
        endDate: worker.endDate,
        documents: sampleItems.flatMap(item => {
          const subject = byCode.get(item.code)?.subjects?.find(entry => entry.id === worker.id);
          return subject ? [{ code: item.code, label: itemLabel(item, locale), state: subject.state, files: subject.files.filter(file => nameOf.has(file.id)).map(file => ({ id: file.id, name: nameOf.get(file.id)! })) }] : [];
        }),
      })),
      joiners: joiners.map(worker => ({ id: worker.id, name: personName(worker.person), startDate: day(worker.startDate)! })),
      leavers: leavers.map(worker => ({ id: worker.id, name: personName(worker.person), endDate: day(worker.endDate)!, startDate: day(worker.startDate) })),
    };
  }

  /** The sample and the joiners / leavers as one table (Excel, PDF or Word): the list the inspector draws from. */
  async exportTable(row: InspectionRow, user: AuthenticatedUser, locale: AppLocale): Promise<ExportTable> {
    const view = await this.sample(row, user, locale);
    const states = await this.lists.names('inspection_item_state', locale);
    const nl = locale === 'nl';
    const rows: Array<Record<string, unknown>> = [
      ...view.sample.map(worker => ({
        kind: nl ? 'Steekproef: recent vertrokken' : 'Sample: recent leaver',
        worker: worker.name,
        startDate: worker.startDate,
        endDate: worker.endDate,
        documents: worker.documents.map(entry => `${entry.code}: ${states.get(entry.state) ?? entry.state}`).join('; '),
      })),
      ...view.joiners.map(worker => ({ kind: nl ? 'Nieuw in dienst' : 'Joiner', worker: worker.name, startDate: worker.startDate, endDate: null, documents: '' })),
      ...view.leavers.map(worker => ({ kind: nl ? 'Uit dienst' : 'Leaver', worker: worker.name, startDate: worker.startDate, endDate: worker.endDate, documents: '' })),
    ];
    return {
      title: `${nl ? 'Steekproef en in- en uitdiensttreders' : 'Sample, joiners and leavers'} ${row.client.number} ${row.client.name}`,
      subtitle: `${row.number} · ${nl ? 'sinds' : 'since'} ${dutchDay(view.since)} · ${nl ? 'tot' : 'until'} ${dutchDay(view.asOf)}`,
      locale,
      columns: [
        { key: 'kind', header: nl ? 'Wie' : 'Who', width: 28 },
        { key: 'worker', header: nl ? 'Medewerker' : 'Employee', width: 28 },
        { key: 'startDate', header: nl ? 'In dienst' : 'Start', type: 'date', width: 12 },
        { key: 'endDate', header: nl ? 'Uit dienst' : 'End', type: 'date', width: 12 },
        { key: 'documents', header: nl ? 'Gevraagde stukken' : 'Papers asked for', width: 50 },
      ],
      rows,
    };
  }
}
