import { Injectable, Logger } from '@nestjs/common';
import { formatDay } from '../../common/dates.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { DocumentsService } from '../../lib/documents/documents.service.js';
import type { ExportTable } from '../../lib/exports/export.types.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { FilesService } from '../files/files.service.js';
import { INVOICE_KIND, MergeFieldsService } from '../templates/merge-fields.service.js';
import { TemplatesService } from '../templates/templates.service.js';
import { INVOICE_FILE_PURPOSE, INVOICE_FOLDER_CODE } from './invoices.constants.js';

/** A file name people can see: no characters a file name cannot hold. */
const clean = (value: string): string => value.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');

export interface MadeDocuments {
  word: boolean;
  pdf: boolean;
  template: { id: string; name: string; version: number } | null;
}

/**
 * The documents of an outgoing invoice: a Word file and a PDF made from the office's invoice template (a client's own template first, the language of the
 * invoice preferred) and filed in the client's "Uren en facturen" folder. Without a template — or when the template cannot be filled — the plain table of the
 * invoice is used, so an issued invoice always has something to send. Without LibreOffice the Word file is still made; only the PDF is missing.
 */
@Injectable()
export class InvoiceDocumentsService {
  private readonly logger = new Logger(InvoiceDocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly documents: DocumentsService,
    private readonly templates: TemplatesService,
    private readonly merge: MergeFieldsService,
    private readonly exports: ExportsService,
  ) {}

  /** (Re)makes the Word and PDF files of an invoice and links them to it; the invoice's earlier files are switched off once the new ones exist. */
  async make(invoiceId: string, table: ExportTable, user: AuthenticatedUser): Promise<MadeDocuments> {
    const row = await this.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { client: { select: { id: true, name: true } }, counterparty: { select: { name: true } }, otherClient: { select: { name: true } } } });
    const locale = row.locale === 'en' ? 'en' : 'nl';
    const template = await this.chooseTemplate(row.clientId, row.locale);
    let docx: Buffer | null = null;
    let pdf: Buffer | null = null;
    let used: MadeDocuments['template'] = null;

    try {
      if (template) {
        const { template: found, version, buffer } = await this.templates.read(template.id);
        docx = this.documents.render(buffer, await this.merge.forInvoice(row.id, locale)).buffer;
        used = { id: found.id, name: found.name, version: version.version };
        pdf = await this.documents.toPdf(docx).catch(error => {
          this.logger.warn(`No PDF from the template for invoice ${row.id}: ${(error as Error).message}`);
          return null;
        });
      }
    } catch (error) {
      // A template that cannot be filled in (damaged, wrong fields) must not stop the invoice: the plain table takes over.
      this.logger.warn(`Invoice template failed for ${row.id}: ${(error as Error).message}`);
      docx = null;
      pdf = null;
      used = null;
    }
    if (!docx) {
      docx = (await this.exports.write(table, 'docx', user.name)).buffer;
      pdf = await this.exports.write(table, 'pdf', user.name).then(file => file.buffer, () => null);
    }

    const folder = await this.folderOf(row.clientId);
    const earlier = [row.fileId, row.pdfFileId].filter((id): id is string => Boolean(id));
    const word = row.kind === 'credit' ? (locale === 'nl' ? 'Creditnota' : 'Credit note') : locale === 'nl' ? 'Factuur' : 'Invoice';
    const party = row.counterparty?.name ?? row.otherClient?.name ?? '';
    const base = await this.freeName(folder?.id ?? null, `${word}_${clean(row.number ?? 'concept')}_${clean(party)}`.slice(0, 150), earlier);
    // Filed on the client (that is what a folder accepts); the invoice itself points at the files (`fileId`, `pdfFileId`).
    const where = { entityType: 'client', entityId: row.clientId, folderId: folder?.id };
    const made = {
      meta: {
        docType: row.direction === 'incoming' ? 'staffing_invoice' : 'invoice',
        docDate: row.invoiceDate ? formatDay(row.invoiceDate) : null,
        periodFrom: row.periodFrom ? formatDay(row.periodFrom) : null,
        periodTo: row.periodTo ? formatDay(row.periodTo) : null,
      },
      links: [{ entityType: 'invoice', entityId: row.id }],
    };
    const wordFile = await this.files.store(docx, { name: `${base}.docx`, purpose: INVOICE_FILE_PURPOSE, userId: user.id, ...where, ...made });
    const pdfFile = pdf ? await this.files.store(pdf, { name: `${base}.pdf`, purpose: INVOICE_FILE_PURPOSE, userId: user.id, ...where, ...made }) : null;
    await this.files.retire(row.fileId);
    await this.files.retire(row.pdfFileId);
    await this.prisma.invoice.update({ where: { id: row.id }, data: { fileId: wordFile.id, pdfFileId: pdfFile?.id ?? null, templateId: used?.id ?? null, templateVersion: used?.version ?? null } });
    return { word: true, pdf: Boolean(pdfFile), template: used };
  }

  /** The "Uren en facturen" folder of a client (its main folder when the client has none). */
  async folderOf(clientId: string): Promise<{ id: string } | null> {
    return (await this.prisma.folder.findFirst({ where: { clientId, templateCode: INVOICE_FOLDER_CODE, isActive: true }, select: { id: true } })) ?? (await this.prisma.folder.findFirst({ where: { clientId, parentId: null, isActive: true }, select: { id: true } }));
  }

  /** The active invoice template that fits: the client's own, else the office's — in the language of the document, else any. */
  private async chooseTemplate(clientId: string, locale: string) {
    const rows = await this.prisma.template.findMany({
      where: { kind: INVOICE_KIND, isActive: true, OR: [{ scope: 'office' }, { scope: 'client', clientId }] },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    const usable = rows.filter(entry => entry.versions.length > 0);
    const rank = (entry: (typeof rows)[number]) => (entry.scope === 'client' ? 0 : 2) + (entry.language === locale ? 0 : 1);
    return usable.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))[0] ?? null;
  }

  /** `base`, or `base-2`, `base-3` … when a file with that name is already in the folder (the files in `ignore` are not counted). */
  private async freeName(folderId: string | null, base: string, ignore: string[]): Promise<string> {
    if (!folderId) return base;
    const taken = new Set((await this.prisma.storedFile.findMany({ where: { folderId, isActive: true, id: { notIn: ignore } }, select: { name: true } })).map(file => file.name.toLowerCase()));
    for (let number = 1; number < 200; number += 1) {
      const candidate = number === 1 ? base : `${base}-${number}`;
      if (!taken.has(`${candidate}.docx`.toLowerCase()) && !taken.has(`${candidate}.pdf`.toLowerCase())) return candidate;
    }
    return `${base}-${Date.now()}`;
  }
}
