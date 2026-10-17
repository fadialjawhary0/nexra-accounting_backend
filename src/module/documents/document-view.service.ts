import { Injectable } from '@nestjs/common';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { formatDay, todayInAmsterdam } from '../../common/dates.js';
import { asRecord } from '../../common/record-values.js';
import type { Prisma, StoredFile } from '../../generated/prisma/client.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { validityOf, type Validity } from '../document-settings/document-validity.js';
import { DocumentTypesService } from '../document-settings/document-types.service.js';
import { extensionOf } from '../files/files.constants.js';
import { personName } from '../people/person-record.js';
import { SNIPPET_LENGTH } from './documents.constants.js';

/** The part of a file the validity needs — enough to work out the status of thousands without loading them whole. */
export type ValidityInput = Pick<StoredFile, 'id' | 'docType' | 'docDate' | 'validUntil' | 'entityType' | 'entityId'>;

type PersonRow = { id: string; firstName: string; lastName: string; data: Prisma.JsonValue };

const day = (value: Date | null): string | null => (value ? formatDay(value) : null);

/**
 * What the screens show of a document: the file with the names of its client, worker and folder, its type, the end of its validity and its version.
 * Everything is looked up for a whole page at once (never one query per row).
 */
@Injectable()
export class DocumentViewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly types: DocumentTypesService,
    private readonly settings: SettingsService,
  ) {}

  defaultWarnDays(): number {
    return this.settings.get<number>('documents.expiryWarningDays');
  }

  /** The end of validity and the status of each file (rows whose type has no end date are left out of the map). */
  async validities(rows: readonly ValidityInput[]): Promise<Map<string, Validity>> {
    const types = await this.types.codeMap();
    const today = todayInAmsterdam();
    const warn = this.defaultWarnDays();
    const needing = rows.filter(row => (types.get(row.docType ?? '')?.validity ?? 'none') !== 'none');
    const fieldRows = needing.filter(row => types.get(row.docType ?? '')?.validity === 'field');
    const fieldValues = await this.personFields(fieldRows);
    const out = new Map<string, Validity>();
    for (const row of needing) {
      const type = types.get(row.docType ?? '');
      const value = type?.validityField ? (fieldValues.get(row.id)?.[type.validityField] ?? null) : null;
      out.set(row.id, validityOf(type, { docDate: day(row.docDate), validUntil: day(row.validUntil) }, value, today, warn));
    }
    return out;
  }

  /** `file id → the person's date fields` for files that belong to a worker or a person (an ID follows the date in the person's record). */
  private async personFields(rows: readonly ValidityInput[]): Promise<Map<string, Record<string, string>>> {
    if (!rows.length) return new Map();
    const employeeIds = [...new Set(rows.filter(row => row.entityType === 'employee' && row.entityId).map(row => row.entityId as string))];
    const employees = employeeIds.length ? await this.prisma.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, personId: true } }) : [];
    const personOfEmployee = new Map(employees.map(employee => [employee.id, employee.personId]));
    const personOf = (row: ValidityInput): string | null => (row.entityType === 'person' ? row.entityId : row.entityType === 'employee' ? (personOfEmployee.get(row.entityId ?? '') ?? null) : null);
    const personIds = [...new Set(rows.map(personOf).filter((id): id is string => Boolean(id)))];
    const people = personIds.length ? await this.prisma.person.findMany({ where: { id: { in: personIds } }, select: { id: true, data: true } }) : [];
    const dataOf = new Map(people.map(person => [person.id, asRecord(person.data)]));
    const out = new Map<string, Record<string, string>>();
    for (const row of rows) {
      const data = dataOf.get(personOf(row) ?? '');
      if (!data) continue;
      out.set(row.id, Object.fromEntries(Object.entries(data).filter((entry): entry is [string, string] => typeof entry[1] === 'string')));
    }
    return out;
  }

  /** The files as the screens show them. `terms` (folded) makes a snippet of the text a document was found by. */
  async build(files: readonly StoredFile[], locale: AppLocale, terms: readonly string[] = []) {
    if (!files.length) return [];
    const [types, validities] = await Promise.all([this.types.codeMap(), this.validities(files)]);

    // The people the files belong to: workers (files on a worker) and persons (copies of IDs on a person, possibly with several employments).
    const employeeIds = [...new Set(files.filter(file => file.entityType === 'employee' && file.entityId).map(file => file.entityId as string))];
    const personIds = [...new Set(files.filter(file => file.entityType === 'person' && file.entityId).map(file => file.entityId as string))];
    const employments = await this.prisma.employee.findMany({
      where: { OR: [...(employeeIds.length ? [{ id: { in: employeeIds } }] : []), ...(personIds.length ? [{ personId: { in: personIds } }] : [])] },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, clientId: true, personId: true, person: { select: { id: true, firstName: true, lastName: true, data: true } } },
    });
    const workerById = new Map(employments.map(employment => [employment.id, employment]));
    const workerOfPerson = new Map<string, (typeof employments)[number]>();
    for (const employment of employments) if (!workerOfPerson.has(employment.personId)) workerOfPerson.set(employment.personId, employment);
    const loosePersonIds = personIds.filter(id => !workerOfPerson.has(id));
    const loosePeople: PersonRow[] = loosePersonIds.length ? await this.prisma.person.findMany({ where: { id: { in: loosePersonIds } }, select: { id: true, firstName: true, lastName: true, data: true } }) : [];
    const looseById = new Map(loosePeople.map(person => [person.id, person]));

    const clientIds = [...new Set([...files.map(file => file.clientId), ...employments.map(employment => employment.clientId)].filter((id): id is string => Boolean(id)))];
    const folderIds = [...new Set(files.map(file => file.folderId).filter((id): id is string => Boolean(id)))];
    const userIds = [...new Set(files.map(file => file.uploadedById).filter((id): id is string => Boolean(id)))];
    const roots = [...new Set(files.map(file => file.rootId ?? file.id))];
    const [clients, folders, users, chain, texts] = await Promise.all([
      clientIds.length ? this.prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, number: true, name: true } }) : [],
      folderIds.length ? this.prisma.folder.findMany({ where: { clientId: { in: clientIds } }, select: { id: true, name: true, parentId: true } }) : [],
      userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [],
      this.prisma.storedFile.findMany({ where: { isActive: true, OR: [{ id: { in: roots } }, { rootId: { in: roots } }] }, select: { id: true, rootId: true } }),
      this.prisma.documentText.findMany({ where: { fileId: { in: files.map(file => file.id) } }, select: { fileId: true, status: true, ...(terms.length > 0 && { content: true }) } }),
    ]);
    const clientById = new Map(clients.map(client => [client.id, client]));
    const folderById = new Map(folders.map(folder => [folder.id, folder]));
    const userName = new Map(users.map(user => [user.id, user.name]));
    const versionCount = new Map<string, number>();
    for (const row of chain) versionCount.set(row.rootId ?? row.id, (versionCount.get(row.rootId ?? row.id) ?? 0) + 1);
    const textOf = new Map(texts.map(text => [text.fileId, text as { fileId: string; status: string; content?: string }]));

    /** `Arbeidsovereenkomsten / Jan de Vries` — the path inside the client's folder (the client's own folder is left out). */
    const pathOf = (folderId: string): string => {
      const names: string[] = [];
      let cursor = folderById.get(folderId);
      for (let depth = 0; cursor && cursor.parentId && depth < 10; depth += 1) {
        names.unshift(cursor.name);
        cursor = folderById.get(cursor.parentId);
      }
      return names.join(' / ');
    };

    return files.map(file => {
      const type = file.docType ? types.get(file.docType) : undefined;
      const worker = file.entityType === 'employee' ? workerById.get(file.entityId ?? '') : file.entityType === 'person' ? workerOfPerson.get(file.entityId ?? '') : undefined;
      const loose = file.entityType === 'person' && !worker ? looseById.get(file.entityId ?? '') : undefined;
      const person = worker?.person ?? loose ?? null;
      const clientId = file.clientId ?? worker?.clientId ?? null;
      const client = clientId ? clientById.get(clientId) : undefined;
      const read = textOf.get(file.id);
      const content = read?.content;
      return {
        id: file.id,
        name: file.name,
        extension: extensionOf(file.name),
        mimeType: file.mimeType,
        size: file.size,
        type: type ? { code: type.code, name: DocumentTypesService.nameIn(type, locale) } : file.docType ? { code: file.docType, name: file.docType } : null,
        scope: file.entityType === 'employee' || file.entityType === 'person' ? ('worker' as const) : ('client' as const),
        docDate: day(file.docDate),
        periodFrom: day(file.periodFrom),
        periodTo: day(file.periodTo),
        validity: validities.get(file.id) ?? { until: null, status: 'none' as const, daysLeft: null, source: null },
        client: client ? { id: client.id, number: client.number, name: client.name } : null,
        person: person ? { id: person.id, name: personName(person), employeeId: worker?.id ?? null, kind: file.entityType === 'employee' ? ('worker' as const) : ('person' as const) } : null,
        folder: file.folderId && folderById.has(file.folderId) ? { id: file.folderId, name: folderById.get(file.folderId)!.name, path: pathOf(file.folderId) } : null,
        version: file.version,
        versions: versionCount.get(file.rootId ?? file.id) ?? 1,
        isCurrent: file.isCurrent,
        active: file.isActive,
        area: file.area,
        text: read ? read.status : 'pending',
        uploadedBy: file.uploadedById ? { id: file.uploadedById, name: userName.get(file.uploadedById) ?? '' } : null,
        createdAt: file.createdAt.toISOString(),
        ...(terms.length > 0 && content ? { snippet: snippetOf(content, terms) } : {}),
      };
    });
  }
}

/** One letter without its accent and capital (so the position in the folded text is the position in the real text). */
const foldLetter = (letter: string): string => {
  const plain = letter.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return plain.length === 1 ? plain : letter.toLowerCase();
};

/** A short piece of the text around the first word that was searched for (the words are folded: no accents, no capitals). */
function snippetOf(content: string, terms: readonly string[]): string | undefined {
  const text = content.replace(/\s+/g, ' ');
  const letters = [...text];
  const folded = letters.length === text.length ? letters.map(foldLetter).join('') : text.toLowerCase();
  for (const term of terms) {
    const at = folded.indexOf(term);
    if (at < 0) continue;
    const start = Math.max(0, at - Math.floor(SNIPPET_LENGTH / 3));
    return `${start > 0 ? '… ' : ''}${text.slice(start, start + SNIPPET_LENGTH).trim()}${start + SNIPPET_LENGTH < text.length ? ' …' : ''}`;
  }
  return undefined;
}
