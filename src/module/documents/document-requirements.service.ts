import { Injectable } from '@nestjs/common';
import { paged, type ApiResult } from '../../common/api-result.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { pageMeta } from '../../common/pagination.js';
import { asRecord, columnValues } from '../../common/record-values.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ExportTable } from '../../lib/exports/export.types.js';
import { MAX_EXPORT_ROWS } from '../../lib/exports/export.types.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { CLIENT_COLUMNS } from '../clients/client-record.js';
import { DocumentTypesService } from '../document-settings/document-types.service.js';
import { RequiredDocumentsService } from '../document-settings/required-documents.service.js';
import type { Validity } from '../document-settings/document-validity.js';
import { EMPLOYEE_COLUMNS } from '../employees/employee-record.js';
import { DOCUMENT_PURPOSES, viewableAreas } from '../files/files.constants.js';
import { evaluate, type Condition } from '../forms/form-doc.js';
import { matrixAllows, type PermissionMatrix } from '../roles/permission-catalog.js';
import { personName } from '../people/person-record.js';
import { DocumentViewService, type ValidityInput } from './document-view.service.js';
import type { OverviewQuery, RequirementExportQuery, RequirementQuery } from './dto/documents.dto.js';

export type RequirementState = 'missing' | 'expired' | 'expiring' | 'ok';

/** One thing that has to be on file for one client or worker, and how it stands. */
export interface Requirement {
  key: string;
  ruleId: string;
  scope: 'client' | 'worker';
  state: RequirementState;
  typeCode: string;
  typeName: string;
  typeOrder: number;
  subject: { id: string; name: string };
  client: { id: string; number: string; name: string };
  document: { id: string; name: string; docDate: string | null; until: string | null; status: string; daysLeft: number | null } | null;
}

const ATTENTION: readonly RequirementState[] = ['missing', 'expired', 'expiring'];
/** A client number sorts the way it reads: `2` before `10`. */
const numberKey = (number: string): string => number.replace(/\d+/g, digits => digits.padStart(10, '0')).toLowerCase();
const SEVERITY: Record<string, number> = { valid: 3, none: 2, expiring: 1, expired: 0 };

/**
 * What is missing. The required documents (Settings → Documents) say which documents each client and worker must have; this looks at the files and
 * answers, for every client and worker that fits a rule, whether a current document of that type is there and whether it is still good. Nothing is
 * stored: a changed rule or a new upload shows at once.
 */
@Injectable()
export class DocumentRequirementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: RequiredDocumentsService,
    private readonly types: DocumentTypesService,
    private readonly view: DocumentViewService,
    private readonly exports: ExportsService,
  ) {}

  /** Every requirement of every client and worker in scope (the people who are active), for what the person may see. */
  async compute(filter: { clientId?: string; employeeId?: string }, matrix: PermissionMatrix, locale: AppLocale): Promise<Requirement[]> {
    const rules = (await this.rules.active()).filter(rule => !rule.type.personal || matrixAllows(matrix, 'personal_data.view'));
    const clientRules = matrixAllows(matrix, 'clients.view') ? rules.filter(rule => rule.scope === 'client') : [];
    const workerRules = matrixAllows(matrix, 'employees.view') ? rules.filter(rule => rule.scope === 'worker') : [];
    if (!clientRules.length && !workerRules.length) return [];

    const clients = await this.prisma.client.findMany({
      where: { isActive: true, ...(filter.clientId && { id: filter.clientId }), ...(filter.employeeId && { employees: { some: { id: filter.employeeId } } }) },
      select: { id: true, number: true, name: true, data: true, legalForm: true, kvk: true, vatNumber: true, responsibleUserId: true },
    });
    const clientIds = clients.map(client => client.id);
    const workers = workerRules.length && clientIds.length
      ? await this.prisma.employee.findMany({
          where: { isActive: true, clientId: { in: clientIds }, ...(filter.employeeId && { id: filter.employeeId }) },
          select: { id: true, clientId: true, personId: true, functionCode: true, startDate: true, endDate: true, data: true, person: { select: { firstName: true, lastName: true, data: true } } },
        })
      : [];

    const typeCodes = [...new Set([...clientRules, ...workerRules].map(rule => rule.typeCode))];
    const personIds = [...new Set(workers.map(worker => worker.personId))];
    const documents = await this.prisma.storedFile.findMany({
      where: {
        isActive: true,
        isCurrent: true,
        purpose: { in: [...DOCUMENT_PURPOSES] },
        docType: { in: typeCodes },
        OR: [{ clientId: { in: clientIds } }, ...(personIds.length ? [{ entityType: 'person', entityId: { in: personIds } }] : [])],
      },
      select: { id: true, name: true, docType: true, docDate: true, validUntil: true, entityType: true, entityId: true, clientId: true },
    });
    const validities = await this.view.validities(documents as ValidityInput[]);

    const byClient = new Map<string, typeof documents>();
    const byWorker = new Map<string, typeof documents>();
    const byPerson = new Map<string, typeof documents>();
    const push = (map: Map<string, typeof documents>, key: string, file: (typeof documents)[number]) => map.set(key, [...(map.get(key) ?? []), file]);
    for (const file of documents) {
      if (file.entityType === 'employee' && file.entityId) push(byWorker, `${file.entityId}|${file.docType}`, file);
      else if (file.entityType === 'person' && file.entityId) push(byPerson, `${file.entityId}|${file.docType}`, file);
      else if (file.clientId) push(byClient, `${file.clientId}|${file.docType}`, file);
    }

    const out: Requirement[] = [];
    const found = (rule: (typeof rules)[number], candidates: typeof documents | undefined): Requirement['document'] => {
      const best = [...(candidates ?? [])].sort((a, b) => (SEVERITY[validities.get(b.id)?.status ?? 'none'] ?? 0) - (SEVERITY[validities.get(a.id)?.status ?? 'none'] ?? 0) || (validities.get(b.id)?.until ?? '').localeCompare(validities.get(a.id)?.until ?? ''))[0];
      if (!best) return null;
      const validity: Validity | undefined = validities.get(best.id);
      return { id: best.id, name: best.name, docDate: best.docDate ? best.docDate.toISOString().slice(0, 10) : null, until: validity?.until ?? null, status: validity?.status ?? 'none', daysLeft: validity?.daysLeft ?? null };
    };
    const stateOf = (document: Requirement['document']): RequirementState => (!document ? 'missing' : document.status === 'expired' ? 'expired' : document.status === 'expiring' ? 'expiring' : 'ok');
    const typeName = (rule: (typeof rules)[number]) => DocumentTypesService.nameIn(rule.type, locale);

    const prefixed = (prefix: string, values: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(values).map(([key, value]) => [`${prefix}${key}`, value]));
    for (const client of clients) {
      const clientValues = prefixed('client.', { ...asRecord(client.data), ...columnValues(CLIENT_COLUMNS, client) });
      for (const rule of clientRules) {
        if (!evaluate(rule.condition as Condition | null, clientValues)) continue;
        const document = found(rule, byClient.get(`${client.id}|${rule.typeCode}`));
        out.push({
          key: `${rule.id}:${client.id}`,
          ruleId: rule.id,
          scope: 'client',
          state: stateOf(document),
          typeCode: rule.typeCode,
          typeName: typeName(rule),
          typeOrder: rule.type.sortOrder,
          subject: { id: client.id, name: client.name },
          client: { id: client.id, number: client.number, name: client.name },
          document,
        });
      }
      for (const worker of workers.filter(candidate => candidate.clientId === client.id)) {
        const values = {
          ...clientValues,
          ...prefixed('employee.', { ...asRecord(worker.data), ...columnValues(EMPLOYEE_COLUMNS, worker) }),
          ...prefixed('person.', { ...asRecord(worker.person.data), first_name: worker.person.firstName, last_name: worker.person.lastName }),
        };
        for (const rule of workerRules) {
          if (!evaluate(rule.condition as Condition | null, values)) continue;
          const document = found(rule, [...(byWorker.get(`${worker.id}|${rule.typeCode}`) ?? []), ...(byPerson.get(`${worker.personId}|${rule.typeCode}`) ?? [])]);
          out.push({
            key: `${rule.id}:${worker.id}`,
            ruleId: rule.id,
            scope: 'worker',
            state: stateOf(document),
            typeCode: rule.typeCode,
            typeName: typeName(rule),
            typeOrder: rule.type.sortOrder,
            subject: { id: worker.id, name: personName(worker.person) },
            client: { id: client.id, number: client.number, name: client.name },
            document,
          });
        }
      }
    }
    return out.sort((a, b) => numberKey(a.client.number).localeCompare(numberKey(b.client.number)) || (a.scope === b.scope ? 0 : a.scope === 'client' ? -1 : 1) || a.subject.name.localeCompare(b.subject.name) || a.typeOrder - b.typeOrder);
  }

  /** The requirements as a list: by default what needs attention, or every state with `state=all`. */
  async list(query: RequirementQuery, user: AuthenticatedUser, locale: AppLocale): Promise<ApiResult> {
    const rows = await this.filtered(query, user, locale);
    const start = (query.page - 1) * query.pageSize;
    const all = rows.all;
    const counts = { missing: 0, expired: 0, expiring: 0, ok: 0 };
    for (const row of all) counts[row.state] += 1;
    return paged(rows.shown.slice(start, start + query.pageSize), pageMeta(rows.shown.length, query, { counts, clients: new Set(all.filter(row => row.state !== 'ok').map(row => row.client.id)).size }));
  }

  private async filtered(query: RequirementQuery, user: AuthenticatedUser, locale: AppLocale) {
    const all = await this.compute({ clientId: query.clientId, employeeId: query.employeeId }, user.matrix, locale);
    const wanted = (query.state ?? '').split(',').map(part => part.trim()).filter(Boolean);
    const states: readonly string[] = wanted.includes('all') ? ['missing', 'expired', 'expiring', 'ok'] : wanted.length ? wanted : ATTENTION;
    const types = (query.type ?? '').split(',').map(part => part.trim()).filter(Boolean);
    const terms = fold(query.search ?? '').split(' ').filter(Boolean);
    const shown = all.filter(
      row =>
        states.includes(row.state) &&
        (!query.scope || row.scope === query.scope) &&
        (!types.length || types.includes(row.typeCode)) &&
        terms.every(term => fold(`${row.client.number} ${row.client.name} ${row.subject.name} ${row.typeName}`).includes(term)),
    );
    return { all, shown };
  }

  /** The clients with how many documents each has and what needs attention — the rail of the Documents page. */
  async overview(query: OverviewQuery, user: AuthenticatedUser, locale: AppLocale): Promise<ApiResult> {
    const terms = fold(query.search ?? '').split(' ').filter(Boolean);
    const [requirements, counts, clients] = await Promise.all([
      this.compute({}, user.matrix, locale),
      this.prisma.storedFile.groupBy({ by: ['clientId'], where: { clientId: { not: null }, isActive: true, isCurrent: true, purpose: { in: [...DOCUMENT_PURPOSES] }, area: { in: viewableAreas(user.matrix) } }, _count: { _all: true } }),
      this.prisma.client.findMany({ where: { isActive: true }, select: { id: true, number: true, name: true } }),
    ]);
    const documents = new Map(counts.map(row => [row.clientId, row._count._all]));
    const attention = new Map<string, { missing: number; expired: number; expiring: number }>();
    for (const row of requirements) {
      if (row.state === 'ok') continue;
      const entry = attention.get(row.client.id) ?? { missing: 0, expired: 0, expiring: 0 };
      entry[row.state] += 1;
      attention.set(row.client.id, entry);
    }
    const rows = clients
      .filter(client => terms.every(term => fold(`${client.number} ${client.name}`).includes(term)))
      .map(client => ({ id: client.id, number: client.number, name: client.name, documents: documents.get(client.id) ?? 0, ...(attention.get(client.id) ?? { missing: 0, expired: 0, expiring: 0 }) }))
      .filter(client => query.show !== 'attention' || client.missing + client.expired + client.expiring > 0)
      .sort((a, b) => numberKey(a.number).localeCompare(numberKey(b.number)));
    const start = (query.page - 1) * query.pageSize;
    return paged(rows.slice(start, start + query.pageSize), pageMeta(rows.length, query, { attention: [...attention.keys()].length }));
  }

  /** What needs attention, as a table. */
  async exportTable(query: RequirementExportQuery, user: AuthenticatedUser, locale: AppLocale): Promise<ExportTable> {
    const { shown } = await this.filtered(query, user, locale);
    this.exports.assertSize(Math.min(shown.length, MAX_EXPORT_ROWS + 1));
    const nl = locale === 'nl';
    const stateName: Record<string, string> = nl ? { missing: 'Ontbreekt', expired: 'Verlopen', expiring: 'Verloopt binnenkort', ok: 'In orde' } : { missing: 'Missing', expired: 'Expired', expiring: 'Expiring soon', ok: 'In order' };
    return {
      title: nl ? 'Ontbrekende documenten' : 'Missing documents',
      locale,
      columns: [
        { key: 'clientNumber', header: nl ? 'Klantnr.' : 'Client no.', width: 10 },
        { key: 'client', header: nl ? 'Klant' : 'Client', width: 26 },
        { key: 'subject', header: nl ? 'Voor' : 'For', width: 24 },
        { key: 'type', header: nl ? 'Document' : 'Document', width: 28 },
        { key: 'state', header: 'Status', width: 18 },
        { key: 'file', header: nl ? 'Bestand' : 'File', width: 30 },
        { key: 'until', header: nl ? 'Geldig tot' : 'Valid until', type: 'date', width: 12 },
      ],
      rows: shown.slice(0, MAX_EXPORT_ROWS).map(row => ({
        clientNumber: row.client.number,
        client: row.client.name,
        subject: row.scope === 'client' ? '' : row.subject.name,
        type: row.typeName,
        state: stateName[row.state],
        file: row.document?.name ?? '',
        until: row.document?.until ?? null,
      })),
    };
  }
}
