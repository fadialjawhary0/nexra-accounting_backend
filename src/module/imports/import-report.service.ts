import { Injectable } from '@nestjs/common';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { DocumentTypesService } from '../document-settings/document-types.service.js';
import { MAX_EXPORT_ROWS, type ExportTable } from '../../lib/exports/export.types.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import type { JobListQuery } from './dto/imports.dto.js';
import type { ItemResult } from './imports.constants.js';
import { ImportsService } from './imports.service.js';

type Words = Record<string, { nl: string; en: string }>;

const HEADERS: Words = {
  name: { nl: 'Bestand / rij', en: 'File / row' },
  path: { nl: 'Map / blad', en: 'Folder / sheet' },
  docType: { nl: 'Soort document', en: 'Document type' },
  status: { nl: 'Status', en: 'Status' },
  summary: { nl: 'Inhoud', en: 'Content' },
  result: { nl: 'Resultaat', en: 'Result' },
  problems: { nl: 'Opmerkingen', en: 'Notes' },
};

const STATUS: Words = {
  pending: { nl: 'Wacht', en: 'Waiting' },
  processing: { nl: 'Wordt gelezen', en: 'Being read' },
  review: { nl: 'Te controleren', en: 'To review' },
  ready: { nl: 'Klaar om op te slaan', en: 'Ready to save' },
  invalid: { nl: 'Niet in orde', en: 'Not valid' },
  accepted: { nl: 'Opgeslagen', en: 'Saved' },
  rejected: { nl: 'Afgewezen', en: 'Rejected' },
  skipped: { nl: 'Overgeslagen', en: 'Skipped' },
  error: { nl: 'Fout', en: 'Error' },
};

const TYPES: Words = {
  client: { nl: 'klant', en: 'client' },
  person: { nl: 'persoon', en: 'person' },
  employee: { nl: 'werknemer', en: 'employee' },
  contract: { nl: 'contract', en: 'contract' },
  invoice: { nl: 'factuur', en: 'invoice' },
  hours: { nl: 'uren', en: 'hours' },
  file: { nl: 'bestand', en: 'file' },
  task: { nl: 'taak', en: 'task' },
  event: { nl: 'afspraak', en: 'appointment' },
};

const ACTIONS: Words = {
  created: { nl: 'aangemaakt', en: 'created' },
  updated: { nl: 'bijgewerkt', en: 'updated' },
  linked: { nl: 'gekoppeld', en: 'linked' },
  filed: { nl: 'opgeslagen in map', en: 'filed' },
  stopped: { nl: 'uit dienst gemeld', en: 'marked as left' },
};

/** What an action of a message to the inbox is (in the column of the document type). */
const TARGETS: Words = {
  task: { nl: 'Taak', en: 'Task' },
  event: { nl: 'Afspraak', en: 'Appointment' },
  employee: { nl: 'Werknemer', en: 'Employee' },
  employee_stop: { nl: 'Werknemer uit dienst', en: 'Employee leaves' },
  client: { nl: 'Klant', en: 'Client' },
};

const MESSAGES: Words = {
  exists: { nl: 'Bestaat al', en: 'Exists already' },
  unchanged: { nl: 'Bestaat al, er is niets nieuws', en: 'Exists already, nothing new' },
  duplicate: { nl: 'Dit bestand staat al in het systeem', en: 'This file is in the system already' },
  duplicate_in_import: { nl: 'Dit bestand zit al eerder in deze import', en: 'This file is earlier in this import' },
  cancelled: { nl: 'Import geannuleerd', en: 'Import cancelled' },
  unreadable: { nl: 'Bestand kon niet worden gelezen', en: 'The file could not be read' },
  user_inactive: { nl: 'De gebruiker is niet meer actief', en: 'The user is no longer active' },
  forbidden: { nl: 'Geen toegang om dit op te slaan', en: 'No access to save this' },
  failed: { nl: 'Opslaan is mislukt', en: 'Saving failed' },
  hours_partly: { nl: 'Een deel van de dagen kon niet worden opgeslagen', en: 'Some days could not be saved' },
  ai_budget_exceeded: { nl: 'Het AI-budget is op', en: 'The AI budget is used up' },
  ai_not_configured: { nl: 'AI is niet ingesteld', en: 'AI is not set up' },
  'validation.required': { nl: 'verplicht', en: 'required' },
  'validation.alreadyExists': { nl: 'bestaat al', en: 'exists already' },
  'validation.invalidDate': { nl: 'ongeldige datum', en: 'invalid date' },
  'validation.notInFuture': { nl: 'datum in de toekomst', en: 'date in the future' },
  'validation.selectOption': { nl: 'onbekende keuze', en: 'unknown choice' },
  'validation.invalid': { nl: 'ongeldig', en: 'invalid' },
  'imports.clientRequired': { nl: 'kies een klant', en: 'choose a client' },
  'imports.workerRequired': { nl: 'kies een werknemer', en: 'choose a worker' },
  'imports.workerUnknown': { nl: 'werknemer niet gevonden', en: 'worker not found' },
  'imports.workerAmbiguous': { nl: 'meerdere werknemers passen', en: 'several workers fit' },
  'imports.duplicateInSheet': { nl: 'staat twee keer in de sheet', en: 'is in the sheet twice' },
  'imports.noHours': { nl: 'geen uren', en: 'no hours' },
  'imports.nothingToChange': { nl: 'niets te wijzigen', en: 'nothing to change' },
  'imports.workerStopped': { nl: 'werknemer is al uit dienst', en: 'the employee has left already' },
  'validation.endBeforeStart': { nl: 'ligt vóór de eerste dag', en: 'is before the first day' },
  'validation.afterStartTime': { nl: 'moet na de begintijd liggen', en: 'must be after the start time' },
};

const JOB_STATUS: Words = {
  draft: { nl: 'In voorbereiding', en: 'Being set up' },
  processing: { nl: 'Bezig', en: 'Working' },
  ready: { nl: 'Te controleren', en: 'To check' },
  paused: { nl: 'Gepauzeerd', en: 'Paused' },
  done: { nl: 'Klaar', en: 'Done' },
  cancelled: { nl: 'Geannuleerd', en: 'Cancelled' },
};

const JOB_KIND: Words = {
  documents: { nl: 'Bestanden', en: 'Files' },
  spreadsheet: { nl: 'Spreadsheet', en: 'Spreadsheet' },
  inbox: { nl: 'AI-inbox', en: 'AI inbox' },
};

const LIST_HEADERS: Words = {
  name: { nl: 'Import', en: 'Import' },
  kind: { nl: 'Soort', en: 'Kind' },
  status: { nl: 'Status', en: 'Status' },
  total: { nl: 'Bestanden / rijen', en: 'Files / rows' },
  review: { nl: 'Te controleren', en: 'To check' },
  accepted: { nl: 'Opgeslagen', en: 'Saved' },
  failed: { nl: 'Mislukt', en: 'Failed' },
  by: { nl: 'Door', en: 'By' },
  createdAt: { nl: 'Gestart', en: 'Started' },
};

const word = (words: Words, key: string, locale: AppLocale): string => words[key]?.[locale] ?? key;

/** The report of an import: every file or row, what it was and what became of it — as Excel, PDF or Word. */
@Injectable()
export class ImportReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly imports: ImportsService,
    private readonly exports: ExportsService,
    private readonly documentTypes: DocumentTypesService,
  ) {}

  /** The history of imports (what the list on `/imports` shows, with its filters) as a table to export. */
  async listTable(query: JobListQuery, locale: AppLocale, userId?: string): Promise<ExportTable> {
    const where = this.imports.jobWhere(query, userId);
    this.exports.assertSize(Math.min(await this.prisma.importJob.count({ where }), MAX_EXPORT_ROWS + 1));
    const jobs = await this.prisma.importJob.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: MAX_EXPORT_ROWS });
    const rows = (await this.imports.describeMany(jobs)).map(job => ({
      name: job.name,
      kind: word(JOB_KIND, job.kind, locale),
      status: word(JOB_STATUS, job.status, locale),
      total: job.counts.total,
      review: job.counts.review + job.counts.ready + job.counts.invalid,
      accepted: job.counts.accepted,
      failed: job.counts.error,
      by: job.createdBy.name,
      createdAt: new Date(job.createdAt),
    }));
    const columns = ['name', 'kind', 'status', 'total', 'review', 'accepted', 'failed', 'by', 'createdAt'].map(key => ({
      key,
      header: word(LIST_HEADERS, key, locale),
      width: key === 'name' ? 34 : key === 'createdAt' || key === 'by' ? 20 : 16,
      ...(['total', 'review', 'accepted', 'failed'].includes(key) && { type: 'number' as const }),
      ...(key === 'createdAt' && { type: 'datetime' as const }),
    }));
    return { title: 'Imports', columns, rows, locale };
  }

  async table(jobId: string, locale: AppLocale): Promise<ExportTable> {
    const job = await this.imports.findOrThrow(jobId);
    const count = await this.prisma.importItem.count({ where: { jobId } });
    this.exports.assertSize(Math.min(count, MAX_EXPORT_ROWS + 1));
    const [items, types] = await Promise.all([
      this.prisma.importItem.findMany({ where: { jobId }, orderBy: { sortOrder: 'asc' } }),
      this.documentTypes.all(),
    ]);
    const typeNames = new Map(types.map(type => [type.code, locale === 'en' ? type.nameEn : type.nameNl]));
    const clientIds = [...new Set(items.map(item => item.clientId).filter((id): id is string => Boolean(id)))];
    const clients = clientIds.length ? await this.prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, number: true, name: true } }) : [];
    const clientLabel = new Map(clients.map(client => [client.id, `${client.number} – ${client.name}`]));

    const rows = items.map(item => {
      const results = ((item.result as ItemResult[] | null) ?? []).map(result => `${word(TYPES, result.type, locale)} ${word(ACTIONS, result.action, locale)}${result.label ? ` (${result.label})` : ''}`);
      const problems = [
        item.message ? word(MESSAGES, item.message, locale) : '',
        ...Object.entries((item.errors ?? {}) as Record<string, string>).map(([field, key]) => `${field}: ${word(MESSAGES, key.split('|')[0]!, locale)}`),
      ].filter(Boolean);
      return {
        name: job.kind === 'spreadsheet' ? `${locale === 'en' ? 'Row' : 'Rij'} ${item.name}` : item.name,
        path: job.kind === 'spreadsheet' ? item.path : item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '',
        docType: item.kind === 'action' ? word(TARGETS, item.target ?? '', locale) : item.docType ? (typeNames.get(item.docType) ?? item.docType) : '',
        status: word(STATUS, item.status, locale),
        summary: [item.summary, item.clientId ? clientLabel.get(item.clientId) : ''].filter(Boolean).join(' · '),
        result: results.join('; '),
        problems: problems.join('; '),
      };
    });
    const columns = (job.kind === 'spreadsheet' ? ['name', 'status', 'summary', 'result', 'problems'] : ['name', 'path', 'docType', 'status', 'summary', 'result', 'problems']).map(key => ({
      key,
      header: word(HEADERS, key, locale),
      width: key === 'summary' || key === 'result' || key === 'problems' || key === 'path' ? 36 : 22,
    }));
    return { title: job.kind === 'spreadsheet' ? job.name.replace(/\.[^.]+$/, '') : job.name, subtitle: `${locale === 'en' ? 'Import report' : 'Importverslag'} · ${job.createdAt.toISOString().slice(0, 10)}`, columns, rows, locale };
  }
}
