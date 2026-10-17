import { Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { formatDay, todayInAmsterdam } from '../../common/dates.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import type { Contract, ContractDocument, Employee, Person, StoredFile, Template, TemplateVersion, Client } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { DocumentsService } from '../../lib/documents/documents.service.js';
import { EmployeeFoldersService } from '../employees/employee-folders.service.js';
import { personName } from '../people/person-record.js';
import { FilesService } from '../files/files.service.js';
import { MergeFieldsService } from '../templates/merge-fields.service.js';
import { TemplatesService } from '../templates/templates.service.js';
import { contractLink } from './contract-record.js';

type LoadedContract = Contract & { client: Client; employee: Employee & { person: Person }; template: Template | null; templateVersion: TemplateVersion | null };

export interface GeneratedDocument {
  document: ReturnType<ContractDocumentsService['serialize']>;
  /** A PDF was made next to the Word file (needs LibreOffice on the server). */
  pdf: boolean;
  /** Fields the template uses that do not exist (left as `{field}` in the document) and fields that are empty (left blank). */
  unknown: string[];
  empty: string[];
}

/** A file name people can see: no characters a file name cannot hold. */
const clean = (value: string): string => value.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The documents of a contract: the contract itself and the letters made from templates (Word + PDF, filled with the contract's data), and the signed
 * scan. They are filed in the worker's folder inside the client's contracts folder and named `<template>_<client>_<worker>`; making a document
 * again replaces the earlier one (it is switched off, not left behind as a "copy of a copy").
 */
@Injectable()
export class ContractDocumentsService {
  private readonly logger = new Logger(ContractDocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly documents: DocumentsService,
    private readonly templates: TemplatesService,
    private readonly merge: MergeFieldsService,
    private readonly folders: EmployeeFoldersService,
  ) {}

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The documents of a contract, newest first (switched-off ones only when asked for). */
  async list(contractId: string, includeInactive = false) {
    const rows = await this.prisma.contractDocument.findMany({
      where: { contractId, ...(!includeInactive && { isActive: true }) },
      include: { templateVersion: { include: { template: { select: { id: true, name: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
    const ids = rows.flatMap(row => [row.fileId, row.pdfFileId]).filter((id): id is string => Boolean(id));
    const files = ids.length ? await this.prisma.storedFile.findMany({ where: { id: { in: ids } } }) : [];
    const byId = new Map(files.map(file => [file.id, file]));
    return rows.map(row => this.serialize(row, byId, row.templateVersion ? { id: row.templateVersion.template.id, name: row.templateVersion.template.name, version: row.templateVersion.version } : null));
  }

  serialize(row: ContractDocument, files: Map<string, StoredFile>, template: { id: string; name: string; version: number } | null) {
    const brief = (id: string | null) => {
      const file = id ? files.get(id) : undefined;
      return file ? { id: file.id, name: file.name, size: file.size, mimeType: file.mimeType, isActive: file.isActive } : null;
    };
    return { id: row.id, kind: row.kind, letterKind: row.letterKind, title: row.title, createdAt: row.createdAt.toISOString(), template, file: brief(row.fileId), pdf: brief(row.pdfFileId) };
  }

  /* ── Making documents ─────────────────────────────────────────────────────────────────────────────────────────── */

  /**
   * (Re)makes the contract itself from its template. With `templateId` (and `version`) another template is used from now on; otherwise the
   * contract's own template and version. Only a contract that is not signed yet can be made again — a signed one has its scan.
   */
  async generate(contractId: string, options: { templateId?: string; version?: number }, user: AuthenticatedUser): Promise<GeneratedDocument> {
    const contract = await this.load(contractId);
    const hasCurrent = (await this.prisma.contractDocument.count({ where: { contractId, kind: 'contract', isActive: true } })) > 0;
    if (!['draft', 'sent'].includes(contract.status) && !(contract.status === 'active' && !hasCurrent)) {
      throw new UnprocessableEntityException({ code: 'contract_locked', message: 'This contract can no longer be made again.' });
    }
    const templateId = options.templateId ?? contract.templateId;
    if (!templateId) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { templateId: 'validation.required' } });
    const sameTemplate = templateId === contract.templateId;
    const version = options.version ?? (sameTemplate && !options.templateId ? contract.templateVersion?.version : undefined);
    const { template, version: used, buffer } = await this.templates.read(templateId, version);
    if (template.kind !== 'contract') throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { templateId: 'validation.invalid' } });

    const result = await this.make(contract, template, used, buffer, { kind: 'contract', letterKind: null }, user);
    if (contract.templateId !== template.id || contract.templateVersionId !== used.id) {
      await this.prisma.contract.update({ where: { id: contractId }, data: { templateId: template.id, templateVersionId: used.id } });
    }
    return result;
  }

  /** A letter from a template (termination letter, notice of non-renewal, any other letter) with the contract's data. */
  async letter(contractId: string, templateId: string, version: number | undefined, user: AuthenticatedUser): Promise<GeneratedDocument> {
    const contract = await this.load(contractId);
    const { template, version: used, buffer } = await this.templates.read(templateId, version);
    if (template.kind === 'contract') throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { templateId: 'validation.invalid' } });
    return this.make(contract, template, used, buffer, { kind: 'letter', letterKind: template.kind }, user);
  }

  /** The contract (or a letter) filled in with the real data, for looking at — nothing is saved. */
  async preview(contractId: string, options: { templateId?: string; version?: number; format: 'pdf' | 'docx' }, user: AuthenticatedUser) {
    const contract = await this.load(contractId);
    const templateId = options.templateId ?? contract.templateId;
    if (!templateId) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { templateId: 'validation.required' } });
    const version = options.version ?? (templateId === contract.templateId ? contract.templateVersion?.version : undefined);
    const { template, buffer } = await this.templates.read(templateId, version);
    const data = await this.merge.forContract(contractId, template.language as 'nl' | 'en', user.matrix);
    const rendered = this.documents.render(buffer, data);
    const base = `${clean(template.name)}_${clean(contract.client.name)}_${clean(personName(contract.employee.person))}`;
    if (options.format === 'pdf') return { buffer: await this.documents.toPdf(rendered.buffer), name: `${base}.pdf`, mime: 'application/pdf', unknown: rendered.unknown, empty: rendered.empty };
    return { buffer: rendered.buffer, name: `${base}.docx`, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', unknown: rendered.unknown, empty: rendered.empty };
  }

  /** The signed copy: a scan or a photo (uploaded with `purpose=contract_scan`). A new scan replaces the earlier one. */
  async attachScan(contractId: string, fileId: string, user: AuthenticatedUser) {
    const contract = await this.load(contractId);
    const file = await this.files.uploaded(fileId, ['contract_scan']);
    const folder = await this.folders.describe(contract.employeeId);
    await this.prisma.$transaction(async tx => {
      const earlier = await tx.contractDocument.findMany({ where: { contractId, kind: 'signed', isActive: true } });
      await tx.contractDocument.updateMany({ where: { id: { in: earlier.map(row => row.id) } }, data: { isActive: false } });
      await tx.contractDocument.create({ data: { contractId, kind: 'signed', title: file.name, fileId: file.id, createdById: user.id } });
    });
    await this.files.place([file.id], { entityType: 'employee', entityId: contract.employeeId, folderId: folder?.id });
    await this.files.tag([file.id], { docType: 'contract', docDate: todayInAmsterdam(), links: [{ entityType: 'contract', entityId: contractId }] }, user.id);
    await this.retireEarlier(contractId, 'signed', file.id);
    await this.audit.log({ action: 'uploaded', entityType: 'contract', entityId: contractId, entityLabel: this.label(contract), meta: { kind: 'signed', fileName: file.name } });
    return this.list(contractId);
  }

  /** Switches a document (and its files) off. Nothing is deleted. */
  async remove(contractId: string, documentId: string): Promise<void> {
    const contract = await this.load(contractId);
    const row = await this.prisma.contractDocument.findFirst({ where: { id: documentId, contractId } });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Document not found' });
    await this.prisma.contractDocument.update({ where: { id: documentId }, data: { isActive: false } });
    await this.files.retire(row.fileId);
    await this.files.retire(row.pdfFileId);
    await this.audit.log({ action: 'deactivated', entityType: 'contract', entityId: contractId, entityLabel: this.label(contract), meta: { document: row.title, kind: row.kind } });
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  private async make(
    contract: LoadedContract,
    template: Template,
    version: TemplateVersion,
    buffer: Buffer,
    what: { kind: 'contract' | 'letter'; letterKind: string | null },
    user: AuthenticatedUser,
  ): Promise<GeneratedDocument> {
    const data = await this.merge.forContract(contract.id, template.language as 'nl' | 'en', user.matrix);
    const rendered = this.documents.render(buffer, data);
    let pdf: Buffer | null = null;
    try {
      pdf = await this.documents.toPdf(rendered.buffer);
    } catch (error) {
      this.logger.warn(`No PDF for contract ${contract.id}: ${(error as Error).message}`);
    }

    const folder = await this.folders.describe(contract.employeeId);
    const where = { entityType: 'employee', entityId: contract.employeeId, folderId: folder?.id };
    // A new contract replaces the earlier one (versions, not copies of copies): switch the old files off first so the new ones keep the clean name.
    if (what.kind === 'contract') await this.retireAll(contract.id, 'contract');
    const base = await this.freeName(folder?.id ?? null, `${clean(template.name)}_${clean(contract.client.name)}_${clean(personName(contract.employee.person))}`.slice(0, 150));

    const made = { meta: { docType: what.kind === 'letter' ? 'letter' : 'contract', docDate: todayInAmsterdam() }, links: [{ entityType: 'contract', entityId: contract.id }] };
    const docx = await this.files.store(rendered.buffer, { name: `${base}.docx`, purpose: 'contract_document', userId: user.id, ...where, ...made });
    const pdfFile = pdf ? await this.files.store(pdf, { name: `${base}.pdf`, purpose: 'contract_document', userId: user.id, ...where, ...made }) : null;
    const row = await this.prisma.contractDocument.create({
      data: {
        contractId: contract.id,
        kind: what.kind,
        letterKind: what.letterKind,
        title: base,
        templateId: template.id,
        templateVersionId: version.id,
        fileId: docx.id,
        pdfFileId: pdfFile?.id ?? null,
        createdById: user.id,
      },
    });
    await this.audit.log({
      action: 'generated',
      entityType: 'contract',
      entityId: contract.id,
      entityLabel: this.label(contract),
      meta: { document: base, template: template.name, version: version.version, pdf: Boolean(pdfFile), ...(rendered.unknown.length && { unknown: rendered.unknown }) },
    });
    const files = new Map<string, StoredFile>([[docx.id, docx], ...(pdfFile ? [[pdfFile.id, pdfFile] as const] : [])]);
    return { document: this.serialize(row, files, { id: template.id, name: template.name, version: version.version }), pdf: Boolean(pdfFile), unknown: rendered.unknown, empty: rendered.empty };
  }

  /** `base`, or `base-2`, `base-3` … when a file with that name is already in the folder (Ahmad's `-` / `-2` suffixes for renewals). */
  private async freeName(folderId: string | null, base: string): Promise<string> {
    if (!folderId) return base;
    const taken = new Set((await this.prisma.storedFile.findMany({ where: { folderId, isActive: true }, select: { name: true } })).map(file => file.name.toLowerCase()));
    for (let number = 1; number < 200; number += 1) {
      const candidate = number === 1 ? base : `${base}-${number}`;
      if (!taken.has(`${candidate}.docx`.toLowerCase()) && !taken.has(`${candidate}.pdf`.toLowerCase())) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  /** Switches every current document of a kind off — and its files. */
  private async retireAll(contractId: string, kind: string): Promise<void> {
    const rows = await this.prisma.contractDocument.findMany({ where: { contractId, kind, isActive: true } });
    for (const row of rows) {
      await this.prisma.contractDocument.update({ where: { id: row.id }, data: { isActive: false } });
      await this.files.retire(row.fileId);
      await this.files.retire(row.pdfFileId);
    }
  }

  /** The files of the documents of a kind that were replaced by `keepFileId` are switched off. */
  private async retireEarlier(contractId: string, kind: string, keepFileId: string): Promise<void> {
    const rows = await this.prisma.contractDocument.findMany({ where: { contractId, kind, isActive: false } });
    for (const row of rows) if (row.fileId !== keepFileId) await this.files.retire(row.fileId);
  }

  private async load(contractId: string): Promise<LoadedContract> {
    const row = await this.prisma.contract.findUnique({ where: { id: contractId }, include: { client: true, employee: { include: { person: true } }, template: true, templateVersion: true } });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Contract not found' });
    return row;
  }

  private label(contract: LoadedContract): string {
    return `${contract.client.number} – ${personName(contract.employee.person)} (${formatDay(contract.startDate)})`;
  }

  /** Link of a contract (for notifications and e-mails). */
  linkOf(contractId: string): string {
    return contractLink(contractId);
  }
}
