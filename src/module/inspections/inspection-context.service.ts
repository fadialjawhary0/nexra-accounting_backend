import { Injectable } from '@nestjs/common';
import { formatDay, parseDay } from '../../common/dates.js';
import { asRecord, columnValues } from '../../common/record-values.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { CLIENT_COLUMNS } from '../clients/client-record.js';
import { DOCUMENT_PURPOSES } from '../files/files.constants.js';
import { personName } from '../people/person-record.js';
import { readDoc, type ChecklistItem } from './checklist-doc.js';
import { evaluateChecklist, type ItemChoice, type ItemResult, type MatchFile, type MatchInput, type Summary } from './inspection-matching.js';
import { INSPECTIONS_NAMESPACE, OPEN_STATUSES } from './inspections.constants.js';

/** One checklist to be worked out for one client on one day. */
export interface EvaluateRequest {
  /** Whatever the caller wants the answer filed under (an inspection id, a client id). */
  key: string;
  clientId: string;
  /** The day of the inspection (`YYYY-MM-DD`). */
  asOf: string;
  items: readonly ChecklistItem[];
  choices: ReadonlyMap<string, ItemChoice>;
  /** The checklist the lines are of: the client's earlier inspections with it say when a line was last asked for. */
  templateId?: string | null;
  /** The inspection being worked out (it is not one of its own earlier inspections). */
  inspectionId?: string | null;
}

type EarlierInspection = {
  id: string;
  clientId: string;
  date: Date;
  status: string;
  snapshot: unknown;
  version: { templateId: string; items: unknown } | null;
  items: Array<{ code: string | null; decision: string | null }>;
};

/**
 * The lines an earlier inspection asked for: as they stood when it was closed, or — while it is still open — the lines that were switched on by hand or ticked, and the
 * lines asked at every inspection that nobody switched off.
 */
function askedCodes(row: EarlierInspection): string[] {
  const snapshot = row.snapshot as { items?: Array<{ code?: unknown; applicable?: unknown }> } | null;
  if (!OPEN_STATUSES.includes(row.status) && snapshot && Array.isArray(snapshot.items)) {
    return snapshot.items.filter(item => item.applicable === true && typeof item.code === 'string').map(item => item.code as string);
  }
  const decisions = new Map(row.items.filter(item => item.code).map(item => [item.code!, item.decision]));
  return readDoc([], row.version?.items)
    .items.filter(line => {
      const decision = decisions.get(line.code);
      return decision === 'asked' || decision === 'done' || (!decision && line.ask === 'every');
    })
    .map(line => line.code);
}

/** A worker of the inspector's sample: one of the most recent leavers. */
export interface SampleWorker {
  id: string;
  personId: string;
  name: string;
  startDate: string | null;
  endDate: string;
}

export interface ChecklistEvaluation {
  items: ItemResult[];
  summary: Summary;
  sample: SampleWorker[];
  /** The companies above the client that the evaluation looked at. */
  parents: Array<{ id: string; number: string; name: string }>;
}

const FILE_SELECT = { id: true, name: true, docType: true, docDate: true, periodFrom: true, periodTo: true } as const;

type FileRow = { id: string; name: string; docType: string | null; docDate: Date | null; periodFrom: Date | null; periodTo: Date | null };

const toMatchFile = (row: FileRow): MatchFile => ({
  id: row.id,
  name: row.name,
  docType: row.docType,
  docDate: row.docDate ? formatDay(row.docDate) : null,
  periodFrom: row.periodFrom ? formatDay(row.periodFrom) : null,
  periodTo: row.periodTo ? formatDay(row.periodTo) : null,
});

const prefixed = (prefix: string, values: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(values).map(([key, value]) => [`${prefix}${key}`, value]));

/**
 * Gathers what the matching needs — the client's documents, the companies above it, the workers of the sample and their documents — for many checklists at once, and runs the
 * matching. Nothing is stored: readiness is worked out from the files every time, so a document that is uploaded counts at once.
 */
@Injectable()
export class InspectionContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  sampleSize(): number {
    return this.settings.get<number>(`${INSPECTIONS_NAMESPACE}.sampleSize`);
  }

  /** The most recent leavers of each client on the day given for it: workers whose last day is on or before that day, newest first. */
  async pickSample(days: ReadonlyMap<string, string>, size = this.sampleSize()): Promise<Map<string, SampleWorker[]>> {
    const out = new Map<string, SampleWorker[]>();
    if (!days.size) return out;
    const latest = [...days.values()].reduce((a, b) => (a > b ? a : b));
    const rows = await this.prisma.employee.findMany({
      where: { clientId: { in: [...days.keys()] }, endDate: { not: null, lte: parseDay(latest) } },
      orderBy: [{ endDate: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, clientId: true, personId: true, startDate: true, endDate: true, person: { select: { firstName: true, lastName: true, data: true } } },
    });
    for (const row of rows) {
      const day = days.get(row.clientId);
      const end = row.endDate ? formatDay(row.endDate) : null;
      if (!day || !end || end > day) continue;
      const list = out.get(row.clientId) ?? [];
      if (list.length < size) list.push({ id: row.id, personId: row.personId, name: personName(row.person), startDate: row.startDate ? formatDay(row.startDate) : null, endDate: end });
      out.set(row.clientId, list);
    }
    return out;
  }

  /** `client id → the companies above it, nearest first` (holding, and the holding's holding …). A relation of kind `parent` runs from the holding to the subsidiary. */
  async parentChains(clientIds: readonly string[]): Promise<Map<string, string[]>> {
    const relations = await this.prisma.clientRelation.findMany({ where: { kind: 'parent' }, select: { fromId: true, toId: true } });
    const parentOf = new Map<string, string[]>();
    for (const relation of relations) parentOf.set(relation.toId, [...(parentOf.get(relation.toId) ?? []), relation.fromId]);
    const chains = new Map<string, string[]>();
    for (const id of clientIds) {
      const chain: string[] = [];
      let level = parentOf.get(id) ?? [];
      for (let depth = 0; depth < 6 && level.length; depth += 1) {
        const next: string[] = [];
        for (const parent of level) {
          if (parent === id || chain.includes(parent)) continue;
          chain.push(parent);
          next.push(...(parentOf.get(parent) ?? []));
        }
        level = next;
      }
      chains.set(id, chain);
    }
    return chains;
  }

  /** The current documents of these clients of the given types: filed on the client (not on one of its workers) or linked to it. */
  private async clientFiles(clientIds: readonly string[], types: readonly string[]): Promise<Map<string, MatchFile[]>> {
    const out = new Map<string, MatchFile[]>();
    if (!clientIds.length || !types.length) return out;
    const rows = await this.prisma.storedFile.findMany({
      where: {
        isActive: true,
        isCurrent: true,
        purpose: { in: [...DOCUMENT_PURPOSES] },
        docType: { in: [...types] },
        OR: [
          { clientId: { in: [...clientIds] }, OR: [{ entityType: null }, { entityType: { notIn: ['employee', 'person'] } }] },
          { links: { some: { entityType: 'client', entityId: { in: [...clientIds] } } } },
        ],
      },
      select: { ...FILE_SELECT, clientId: true, entityType: true, links: { where: { entityType: 'client', entityId: { in: [...clientIds] } }, select: { entityId: true } } },
    });
    const wanted = new Set(clientIds);
    for (const row of rows) {
      const owners = new Set<string>();
      if (row.clientId && wanted.has(row.clientId) && row.entityType !== 'employee' && row.entityType !== 'person') owners.add(row.clientId);
      for (const link of row.links) owners.add(link.entityId);
      for (const owner of owners) out.set(owner, [...(out.get(owner) ?? []), toMatchFile(row)]);
    }
    return out;
  }

  /** The current documents of workers of the given types: filed on the worker, on their person (a copy of an ID) or linked to them. */
  private async workerFiles(workers: readonly SampleWorker[], types: readonly string[]): Promise<Map<string, MatchFile[]>> {
    const out = new Map<string, MatchFile[]>();
    if (!workers.length || !types.length) return out;
    const employeeIds = workers.map(worker => worker.id);
    const personIds = [...new Set(workers.map(worker => worker.personId))];
    const rows = await this.prisma.storedFile.findMany({
      where: {
        isActive: true,
        isCurrent: true,
        purpose: { in: [...DOCUMENT_PURPOSES] },
        docType: { in: [...types] },
        OR: [{ entityType: 'employee', entityId: { in: employeeIds } }, { entityType: 'person', entityId: { in: personIds } }, { links: { some: { entityType: 'employee', entityId: { in: employeeIds } } } }],
      },
      select: { ...FILE_SELECT, entityType: true, entityId: true, links: { where: { entityType: 'employee', entityId: { in: employeeIds } }, select: { entityId: true } } },
    });
    for (const row of rows) {
      const owners = new Set<string>();
      if (row.entityType === 'employee' && row.entityId) owners.add(row.entityId);
      if (row.entityType === 'person' && row.entityId) for (const worker of workers) if (worker.personId === row.entityId) owners.add(worker.id);
      for (const link of row.links) owners.add(link.entityId);
      for (const owner of owners) if (employeeIds.includes(owner)) out.set(owner, [...(out.get(owner) ?? []), toMatchFile(row)]);
    }
    return out;
  }

  /** Documents that were put on a line by hand, by id. */
  async filesById(ids: readonly string[]): Promise<Map<string, MatchFile>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.storedFile.findMany({ where: { id: { in: [...ids] } }, select: FILE_SELECT });
    return new Map(rows.map(row => [row.id, toMatchFile(row)]));
  }

  /**
   * `request key → code of a line → the day of the client's most recent earlier inspection with the same checklist that asked for the line` — only for checklists that
   * have lines asked once every so many months.
   */
  private async lastAskedFor(requests: readonly EvaluateRequest[]): Promise<Map<string, Map<string, string>>> {
    const out = new Map<string, Map<string, string>>();
    const wanted = requests.filter(request => request.templateId && request.items.some(item => item.ask === 'months'));
    if (!wanted.length) return out;
    const rows: EarlierInspection[] = await this.prisma.inspection.findMany({
      where: {
        clientId: { in: [...new Set(wanted.map(request => request.clientId))] },
        isActive: true,
        status: { not: 'cancelled' },
        version: { templateId: { in: [...new Set(wanted.map(request => request.templateId!))] } },
      },
      select: { id: true, clientId: true, date: true, status: true, snapshot: true, version: { select: { templateId: true, items: true } }, items: { select: { code: true, decision: true } } },
    });
    for (const request of wanted) {
      const days = new Map<string, string>();
      for (const row of rows) {
        if (row.clientId !== request.clientId || row.version?.templateId !== request.templateId || row.id === request.inspectionId) continue;
        const day = formatDay(row.date);
        if (day >= request.asOf) continue;
        for (const code of askedCodes(row)) if ((days.get(code) ?? '') < day) days.set(code, day);
      }
      out.set(request.key, days);
    }
    return out;
  }

  /** Works out every request. The answers are filed under the request's `key`. */
  async evaluate(requests: readonly EvaluateRequest[]): Promise<Map<string, ChecklistEvaluation>> {
    const answers = new Map<string, ChecklistEvaluation>();
    if (!requests.length) return answers;
    const lastAsked = await this.lastAskedFor(requests);
    const clientIds = [...new Set(requests.map(request => request.clientId))];
    // The sample is the most recent leavers on the day of each inspection (two inspections of one client can fall on different days).
    const byDay = new Map<string, Set<string>>();
    for (const request of requests) byDay.set(request.asOf, (byDay.get(request.asOf) ?? new Set<string>()).add(request.clientId));
    const sampleOf = new Map<string, SampleWorker[]>();
    for (const [day, ids] of byDay) {
      const picked = await this.pickSample(new Map([...ids].map(id => [id, day] as const)));
      for (const id of ids) sampleOf.set(`${id}|${day}`, picked.get(id) ?? []);
    }

    const [clients, chains] = await Promise.all([
      this.prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, number: true, name: true, data: true, legalForm: true, kvk: true, vatNumber: true, responsibleUserId: true } }),
      this.parentChains(clientIds),
    ]);
    const clientById = new Map(clients.map(client => [client.id, client]));
    const parentIds = [...new Set([...chains.values()].flat())];
    const parents = parentIds.length ? await this.prisma.client.findMany({ where: { id: { in: parentIds } }, select: { id: true, number: true, name: true } }) : [];
    const parentById = new Map(parents.map(parent => [parent.id, parent]));

    const typesOf = (scopes: readonly string[]) => [...new Set(requests.flatMap(request => request.items.filter(item => scopes.includes(item.scope)).flatMap(item => item.docTypes)))];
    const workers = [...new Map([...sampleOf.values()].flat().map(worker => [worker.id, worker])).values()];
    const [clientFiles, workerFiles, added] = await Promise.all([
      this.clientFiles([...clientIds, ...parentIds], typesOf(['client', 'parents'])),
      this.workerFiles(workers, typesOf(['sample'])),
      this.filesById([...new Set(requests.flatMap(request => [...request.choices.values()].flatMap(choice => [...choice.added])))]),
    ]);

    for (const request of requests) {
      const client = clientById.get(request.clientId);
      if (!client) continue;
      const sample = sampleOf.get(`${request.clientId}|${request.asOf}`) ?? [];
      const chain = (chains.get(request.clientId) ?? []).map(id => parentById.get(id)).filter((parent): parent is NonNullable<typeof parent> => Boolean(parent));
      const input: MatchInput = {
        asOf: request.asOf,
        items: request.items,
        clientValues: prefixed('client.', { ...asRecord(client.data), ...columnValues(CLIENT_COLUMNS, client) }),
        files: clientFiles.get(request.clientId) ?? [],
        sample: sample.map(worker => ({ id: worker.id, name: worker.name, files: workerFiles.get(worker.id) ?? [] })),
        parents: chain.map(parent => ({ id: parent.id, name: `${parent.number} – ${parent.name}`, files: clientFiles.get(parent.id) ?? [] })),
        choices: request.choices,
        added,
        lastAsked: lastAsked.get(request.key) ?? new Map(),
      };
      const result = evaluateChecklist(input);
      answers.set(request.key, { ...result, sample, parents: chain });
    }
    return answers;
  }
}
