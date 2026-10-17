import { Injectable, Logger } from '@nestjs/common';
import { formatDay } from '../../common/dates.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import type { Client, Employee, Person, SalaryStatement, StoredFile } from '../../generated/prisma/client.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { DocumentsService } from '../../lib/documents/documents.service.js';
import type { ExportTable } from '../../lib/exports/export.types.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { EmployeeFoldersService } from '../employees/employee-folders.service.js';
import { FilesService } from '../files/files.service.js';
import type { PayLine } from '../hours/pay-calculator.js';
import { personName } from '../people/person-record.js';
import { MergeFieldsService, STATEMENT_KIND } from '../templates/merge-fields.service.js';
import type { StatementInput } from '../templates/statement-merge.js';
import { TemplatesService } from '../templates/templates.service.js';

export type StatementRow = SalaryStatement & { employee: Employee & { person: Person }; client: Client };

/** A file name people can see: no characters a file name cannot hold. */
const clean = (value: string): string => value.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();

const cents = (decimal: { toNumber(): number }): number => Math.round(decimal.toNumber() * 100);

/** What a salary statement prints, from the frozen statement (never from today's hours). */
export function statementInput(row: SalaryStatement): StatementInput {
  return {
    from: formatDay(row.periodFrom),
    to: formatDay(row.periodTo),
    note: row.note,
    createdOn: formatDay(row.createdAt),
    totals: {
      minutes: row.totalMinutes,
      days: row.daysCount,
      baseCents: cents(row.baseAmount),
      surchargeCents: cents(row.surchargeAmount),
      grossCents: cents(row.grossAmount),
      allowancePercent: row.allowancePercent.toNumber(),
      allowanceCents: cents(row.allowanceAmount),
      totalCents: cents(row.totalAmount),
      vacationMinutes: row.vacationMinutes,
    },
    lines: row.lines as unknown as PayLine[],
  };
}

/** `2026-09` for a whole month, otherwise `2026-09-01_2026-09-15`: the period as it goes into a file name. */
export function periodLabel(from: string, to: string): string {
  const wholeMonth = from.slice(0, 7) === to.slice(0, 7) && from.endsWith('-01') && formatDay(new Date(Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)), 0))) === to;
  return wholeMonth ? from.slice(0, 7) : `${from}_${to}`;
}

/**
 * The documents of a salary statement: a Word file and a PDF made from the office's salary-statement template (a client's own template first), filed
 * in the worker's folder. Without a template the plain table of the statement is used, so a statement always has something to file. Without
 * LibreOffice the Word file is still made — only the PDF is missing.
 */
@Injectable()
export class StatementDocumentsService {
  private readonly logger = new Logger(StatementDocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly documents: DocumentsService,
    private readonly templates: TemplatesService,
    private readonly merge: MergeFieldsService,
    private readonly folders: EmployeeFoldersService,
    private readonly exports: ExportsService,
  ) {}

  /** (Re)makes the Word and PDF files of a statement and links them to it. Earlier files of the statement are switched off. */
  async make(row: StatementRow, table: ExportTable, user: AuthenticatedUser): Promise<{ word: boolean; pdf: boolean; template: { id: string; name: string; version: number } | null }> {
    const locale = row.locale as 'nl' | 'en';
    const template = await this.chooseTemplate(row);
    let docx: Buffer | null = null;
    let pdf: Buffer | null = null;
    let used: { id: string; name: string; version: number } | null = null;

    try {
      if (template) {
        const { template: found, version, buffer } = await this.templates.read(template.id);
        const data = await this.merge.forStatement(row.employeeId, statementInput(row), locale, null);
        docx = this.documents.render(buffer, data).buffer;
        used = { id: found.id, name: found.name, version: version.version };
        pdf = await this.documents.toPdf(docx).catch(error => {
          this.logger.warn(`No PDF from the template for statement ${row.id}: ${(error as Error).message}`);
          return null;
        });
      }
    } catch (error) {
      // A template that cannot be filled in (damaged, wrong fields) must not stop the statement: the plain table takes over.
      this.logger.warn(`Statement template failed for ${row.id}: ${(error as Error).message}`);
      docx = null;
      pdf = null;
      used = null;
    }
    if (!docx) {
      docx = (await this.exports.write(table, 'docx', user.name)).buffer;
      pdf = await this.exports.write(table, 'pdf', user.name).then(file => file.buffer, () => null);
    }

    const folder = await this.folders.describe(row.employeeId);
    const where = { entityType: 'employee', entityId: row.employeeId, folderId: folder?.id };
    // The statement's own earlier files do not count when a name is chosen: they are switched off as soon as the new ones are there, so the clean name is kept.
    const earlier = [row.fileId, row.pdfFileId].filter((id): id is string => Boolean(id));
    const base = await this.freeName(folder?.id ?? null, `${locale === 'nl' ? 'Loonstaat' : 'Salary statement'}_${clean(row.client.name)}_${clean(personName(row.employee.person))}_${periodLabel(formatDay(row.periodFrom), formatDay(row.periodTo))}`.slice(0, 150), earlier);
    const made = { meta: { docType: 'payslip', docDate: formatDay(row.periodTo), periodFrom: formatDay(row.periodFrom), periodTo: formatDay(row.periodTo) }, links: [{ entityType: 'salary_statement', entityId: row.id }] };
    const word = await this.files.store(docx, { name: `${base}.docx`, purpose: 'salary_statement', userId: user.id, ...where, ...made });
    const pdfFile = pdf ? await this.files.store(pdf, { name: `${base}.pdf`, purpose: 'salary_statement', userId: user.id, ...where, ...made }) : null;
    await this.files.retire(row.fileId);
    await this.files.retire(row.pdfFileId);
    await this.prisma.salaryStatement.update({ where: { id: row.id }, data: { fileId: word.id, pdfFileId: pdfFile?.id ?? null, templateId: used?.id ?? null, templateVersion: used?.version ?? null } });
    return { word: true, pdf: Boolean(pdfFile), template: used };
  }

  /** The brief of a stored file for the screens. */
  brief(file: StoredFile | null | undefined) {
    return file ? { id: file.id, name: file.name, size: file.size, mimeType: file.mimeType, isActive: file.isActive } : null;
  }

  /** The active salary-statement template that fits: the client's own, else the office's — in the language of the document, else any. */
  private async chooseTemplate(row: StatementRow) {
    const rows = await this.prisma.template.findMany({
      where: { kind: STATEMENT_KIND, isActive: true, OR: [{ scope: 'office' }, { scope: 'client', clientId: row.clientId }] },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    const usable = rows.filter(entry => entry.versions.length > 0);
    const rank = (entry: (typeof rows)[number]) => (entry.scope === 'client' ? 0 : 2) + (entry.language === row.locale ? 0 : 1);
    return usable.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))[0] ?? null;
  }

  /** `base`, or `base-2`, `base-3` … when a file with that name is already in the folder (the files in `ignore` are not counted). */
  private async freeName(folderId: string | null, base: string, ignore: string[] = []): Promise<string> {
    if (!folderId) return base;
    const taken = new Set((await this.prisma.storedFile.findMany({ where: { folderId, isActive: true, id: { notIn: ignore } }, select: { name: true } })).map(file => file.name.toLowerCase()));
    for (let number = 1; number < 200; number += 1) {
      const candidate = number === 1 ? base : `${base}-${number}`;
      if (!taken.has(`${candidate}.docx`.toLowerCase()) && !taken.has(`${candidate}.pdf`.toLowerCase())) return candidate;
    }
    return `${base}-${Date.now()}`;
  }
}
