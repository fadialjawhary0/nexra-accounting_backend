import { ConflictException, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import PizZip from 'pizzip';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ExportFile, ExportTable } from '../../lib/exports/export.types.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { PdfError, type PdfPart } from '../../lib/pdf/pdf.types.js';
import { PdfService } from '../../lib/pdf/pdf.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { DocumentPreviewService } from '../documents/document-preview.service.js';
import { extensionOf } from '../files/files.constants.js';
import { FilesService } from '../files/files.service.js';
import { findBsns, type BsnFinding } from './bsn-scan.js';
import type { BundleDto, HandoverDto } from './dto/inspections.dto.js';
import { InspectionChecklistService, type ChecklistView, type FileView, type ItemView } from './inspection-checklist.service.js';
import { dutchDay } from './inspection-folders.service.js';
import { InspectionListsService } from './inspection-lists.service.js';
import { day, type InspectionRow } from './inspection-rows.js';
import { INSPECTIONS_NAMESPACE, INSPECTION_ENTITY, type HandoverMethod } from './inspections.constants.js';

/** ASCII only and no characters a file name cannot hold (ZIP programs differ in how they read other letters). */
const ascii = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The text cut at a word, so a folder name does not end in the middle of one. */
const cutWords = (value: string, max: number): string => {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.5 ? cut.slice(0, space) : cut).trimEnd();
};

/** Why a document could not be searched for citizen service numbers. */
export type UncheckedReason = 'scan' | 'pending' | 'failed' | 'unsupported';

interface PlannedFile {
  file: FileView;
  /** The line it is filed under (the first line that uses it). */
  code: string;
  label: string;
  /** The worker it belongs to, for a line asked per worker. */
  subject: string | null;
  bsnAllowed: boolean;
  /** Another line already carries this document; it is not put in twice. */
  duplicateOf: string | null;
}

interface PlannedLine {
  item: ItemView;
  section: string;
  files: PlannedFile[];
}

export interface BundleCheck {
  lines: Array<{ code: string; label: string; state: string; files: Array<{ id: string; name: string; size: number; subject: string | null; duplicateOf: string | null }>; hiddenFiles: number }>;
  totals: { lines: number; files: number; megabytes: number };
  bsnChecked: boolean;
  warnings: {
    bsn: Array<{ id: string; name: string; code: string; certain: number; possible: number; example: string | null }>;
    unchecked: Array<{ id: string; name: string; code: string; reason: UncheckedReason }>;
    /** Lines chosen that have no document. */
    missing: string[];
    tooOld: string[];
    hiddenFiles: number;
    tooLarge: boolean;
  };
  maxMegabytes: number;
}

const toBuffer = async (source: Buffer | NodeJS.ReadableStream): Promise<Buffer> => {
  if (Buffer.isBuffer(source)) return source;
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

/**
 * The bundle for the inspector (docs/11): one click gives a ZIP (a folder per line of the checklist, numbered like it) or one PDF (the documents one after the other, with
 * an index and a label at the foot of every page), plus the checklist itself. Before anything is made it looks for citizen service numbers (BSN) in the documents — the
 * inspector's own list asks for them to be taken out — and reports what it could not read. Every handover is written down: what, when, to whom.
 */
@Injectable()
export class InspectionBundleService {
  private readonly logger = new Logger(InspectionBundleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly checklist: InspectionChecklistService,
    private readonly files: FilesService,
    private readonly previews: DocumentPreviewService,
    private readonly pdf: PdfService,
    private readonly exports: ExportsService,
    private readonly lists: InspectionListsService,
  ) {}

  private setting<T extends string | number | boolean>(name: 'bsnCheck' | 'maxBundleMegabytes'): T {
    return this.settings.get<T>(`${INSPECTIONS_NAMESPACE}.${name}`);
  }

  /* ── What goes in ─────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The lines to put in (those chosen, else every line that applies) with their documents; a document that two lines use is filed under the first. */
  private plan(view: ChecklistView, codes: readonly string[] | undefined): PlannedLine[] {
    const chosen = codes?.length ? new Set(codes) : null;
    const seen = new Map<string, string>();
    const lines: PlannedLine[] = [];
    for (const section of view.sections) {
      for (const item of section.items) {
        if (!item.applicable || (chosen && !chosen.has(item.code ?? ''))) continue;
        const entries = item.subjects ? item.subjects.flatMap(subject => subject.files.map(file => ({ file, subject: subject.name }))) : item.files.map(file => ({ file, subject: null as string | null }));
        lines.push({
          item,
          section: section.name,
          files: entries.map(entry => {
            const duplicateOf = seen.get(entry.file.id) ?? null;
            if (!duplicateOf) seen.set(entry.file.id, item.code ?? '');
            return { file: entry.file, code: item.code ?? '', label: item.label, subject: entry.subject, bsnAllowed: item.bsnAllowed, duplicateOf };
          }),
        });
      }
    }
    return lines;
  }

  /** What a bundle of these lines would hold, with the warnings — nothing is made yet. */
  async check(row: InspectionRow, codes: readonly string[] | undefined, user: AuthenticatedUser, locale: AppLocale): Promise<BundleCheck> {
    const view = await this.checklist.build(row, user, locale);
    return this.describe(this.plan(view, codes));
  }

  private async describe(plan: PlannedLine[]): Promise<BundleCheck> {
    const bsnChecked = this.setting<boolean>('bsnCheck');
    const maxMegabytes = this.setting<number>('maxBundleMegabytes');
    const unique = plan.flatMap(line => line.files).filter(entry => !entry.duplicateOf);
    const toScan = unique.filter(entry => !entry.bsnAllowed);
    const texts = bsnChecked && toScan.length ? await this.prisma.documentText.findMany({ where: { fileId: { in: toScan.map(entry => entry.file.id) } }, select: { fileId: true, status: true, content: true } }) : [];
    const textOf = new Map(texts.map(text => [text.fileId, text]));

    const bsn: BundleCheck['warnings']['bsn'] = [];
    const unchecked: BundleCheck['warnings']['unchecked'] = [];
    if (bsnChecked) {
      for (const entry of toScan) {
        const text = textOf.get(entry.file.id);
        if (!text) {
          unchecked.push({ id: entry.file.id, name: entry.file.name, code: entry.code, reason: 'pending' });
        } else if (text.status === 'done') {
          const found: BsnFinding = findBsns(text.content);
          if (found.certain || found.possible) bsn.push({ id: entry.file.id, name: entry.file.name, code: entry.code, certain: found.certain, possible: found.possible, example: found.example });
        } else {
          unchecked.push({ id: entry.file.id, name: entry.file.name, code: entry.code, reason: text.status === 'empty' ? 'scan' : text.status === 'failed' ? 'failed' : 'unsupported' });
        }
      }
    }
    const bytes = unique.reduce((sum, entry) => sum + entry.file.size, 0);
    return {
      lines: plan.map(line => ({
        code: line.item.code ?? '',
        label: line.item.label,
        state: line.item.state,
        files: line.files.map(entry => ({ id: entry.file.id, name: entry.file.name, size: entry.file.size, subject: entry.subject, duplicateOf: entry.duplicateOf })),
        hiddenFiles: line.item.hiddenFiles + (line.item.subjects?.reduce((sum, subject) => sum + subject.hiddenFiles, 0) ?? 0),
      })),
      totals: { lines: plan.length, files: unique.length, megabytes: Math.round((bytes / 1024 / 1024) * 10) / 10 },
      bsnChecked,
      warnings: {
        bsn,
        unchecked,
        missing: plan.filter(line => !line.files.length && !line.item.optional && line.item.state !== 'done' && line.item.state !== 'manual').map(line => line.item.code ?? ''),
        tooOld: plan.filter(line => line.item.state === 'too_old').map(line => line.item.code ?? ''),
        hiddenFiles: plan.reduce((sum, line) => sum + line.item.hiddenFiles + (line.item.subjects?.reduce((inner, subject) => inner + subject.hiddenFiles, 0) ?? 0), 0),
        tooLarge: bytes > maxMegabytes * 1024 * 1024,
      },
      maxMegabytes,
    };
  }

  /* ── Making it ────────────────────────────────────────────────────────────────────────────────────────────────── */

  private remark(line: PlannedLine, locale: AppLocale): string {
    const nl = locale === 'nl';
    if (line.item.state === 'done' || (line.item.state === 'manual' && line.item.onSite)) return nl ? 'Ter inzage ter plaatse' : 'Available on site';
    return nl ? 'Niet in dit dossier' : 'Not in this file';
  }

  /** The index of the bundle as a table: every line, its documents and where to find them (the page in a PDF, the folder in a ZIP). */
  private indexTable(row: InspectionRow, plan: PlannedLine[], where: (code: string, file: PlannedFile | null) => string | number | null, locale: AppLocale, format: 'zip' | 'pdf'): ExportTable {
    const nl = locale === 'nl';
    const rows: Array<Record<string, unknown>> = [];
    for (const line of plan) {
      if (!line.files.length) {
        rows.push({ code: line.item.code, item: line.item.label, document: this.remark(line, locale), date: null, where: null });
        continue;
      }
      line.files.forEach((entry, index) => {
        rows.push({
          code: index === 0 ? line.item.code : '',
          item: index === 0 ? line.item.label : '',
          document: `${entry.subject ? `${entry.subject}: ` : ''}${entry.file.name}`,
          date: entry.file.docDate,
          where: entry.duplicateOf ? (nl ? `zie ${entry.duplicateOf}` : `see ${entry.duplicateOf}`) : where(line.item.code ?? '', entry),
        });
      });
    }
    return {
      title: `${nl ? 'Inhoud van het controledossier' : 'Contents of the inspection file'} – ${row.client.number} ${row.client.name}`,
      subtitle: `${row.number} · ${nl ? 'controle op' : 'inspection on'} ${dutchDay(day(row.date)!)}`,
      locale,
      columns: [
        { key: 'code', header: nl ? 'Nr.' : 'No.', width: 8 },
        { key: 'item', header: nl ? 'Onderdeel' : 'Item', width: 46 },
        { key: 'document', header: nl ? 'Document' : 'Document', width: 46 },
        { key: 'date', header: nl ? 'Datum' : 'Date', type: 'date', width: 12 },
        { key: 'where', header: format === 'pdf' ? (nl ? 'Pagina' : 'Page') : nl ? 'Map' : 'Folder', width: 14 },
      ],
      rows,
    };
  }

  /** The bytes of a document as PDF pages: a PDF as it is, a photo on a page, a Word / Excel file through its PDF, a text file as text. */
  private async pdfOf(file: FileView, user: AuthenticatedUser): Promise<Buffer> {
    const preview = await this.previews.open(file.id, user);
    const bytes = await toBuffer(preview.stream as Buffer | NodeJS.ReadableStream);
    if (preview.mime === 'application/pdf') return bytes;
    if (preview.mime === 'image/png' || preview.mime === 'image/jpeg') return this.pdf.imagePage(bytes, preview.mime);
    if (preview.mime.startsWith('text/')) return this.pdf.textDocument(bytes.toString('utf8'), file.name);
    throw new UnprocessableEntityException({ code: 'preview_unavailable', message: 'This kind of file cannot be put in a PDF.' });
  }

  private assertSize(check: BundleCheck): void {
    if (check.warnings.tooLarge) throw new UnprocessableEntityException({ code: 'bundle_too_large', message: `The bundle is larger than ${check.maxMegabytes} MB.`, details: { megabytes: check.totals.megabytes, max: check.maxMegabytes } });
    if (!check.totals.files) throw new UnprocessableEntityException({ code: 'bundle_empty', message: 'There are no documents to put in the bundle.' });
  }

  async make(row: InspectionRow, dto: BundleDto, user: AuthenticatedUser, locale: AppLocale): Promise<ExportFile> {
    const view = await this.checklist.build(row, user, locale);
    const plan = this.plan(view, dto.codes);
    const check = await this.describe(plan);
    this.assertSize(check);
    if (check.bsnChecked && check.warnings.bsn.length && !dto.acceptBsn) {
      throw new ConflictException({ code: 'bsn_warning', message: 'Some documents seem to hold a citizen service number (BSN).', details: { files: check.warnings.bsn } });
    }

    const base = `${locale === 'nl' ? 'Controledossier' : 'Inspection file'}_${ascii(row.client.number)}_${day(row.date)!}`.replace(/ /g, '_');
    const file = dto.format === 'pdf' ? await this.makePdf(row, plan, user, locale, base) : await this.makeZip(row, plan, user, locale, base, dto.includeChecklist === true);

    await this.record(row, user, {
      method: dto.format === 'pdf' ? 'pdf' : 'zip',
      toName: dto.toName?.trim() || row.inspectorName,
      note: dto.note?.trim() ?? '',
      plan,
      bsnAccepted: check.warnings.bsn.length > 0 && dto.acceptBsn === true,
      extra: { format: dto.format, megabytes: Math.round((file.buffer.length / 1024 / 1024) * 10) / 10 },
    });
    return file;
  }

  private async makeZip(row: InspectionRow, plan: PlannedLine[], user: AuthenticatedUser, locale: AppLocale, base: string, includeChecklist: boolean): Promise<ExportFile> {
    const zip = new PizZip();
    const root = ascii(`${row.client.number} ${row.client.name} - ${dutchDay(day(row.date)!)}`).slice(0, 80) || base;
    const used = new Set<string>();
    const folderOf = new Map<string, string>();
    const place = (folder: string, name: string): string => {
      const cleaned = ascii(name) || 'file';
      const extension = extensionOf(cleaned);
      const stem = extension ? cleaned.slice(0, -(extension.length + 1)) : cleaned;
      let candidate = `${root}/${folder}/${cleaned}`;
      for (let number = 2; used.has(candidate.toLowerCase()); number += 1) candidate = `${root}/${folder}/${stem} (${number})${extension ? `.${extension}` : ''}`;
      used.add(candidate.toLowerCase());
      return candidate;
    };
    for (const line of plan) {
      // A folder is named like the line: its number and what it holds (the kind of document, else the first words of the line).
      const kinds = line.item.docTypes.map(type => type.name).join(' - ');
      const folder = ascii(`${line.item.code} ${kinds && kinds.length <= 50 ? kinds : cutWords(line.item.label, 44)}`) || ascii(String(line.item.code));
      folderOf.set(line.item.code ?? '', folder);
      for (const entry of line.files) {
        if (entry.duplicateOf) continue;
        try {
          const { buffer } = await this.files.bytes(entry.file.id);
          zip.file(place(entry.subject ? `${folder}/${ascii(entry.subject).slice(0, 40)}` : folder, entry.file.name), buffer);
        } catch (error) {
          this.logger.warn(`A document could not be read for the bundle of ${row.number}: ${(error as Error).message.split('\n')[0]}`);
        }
      }
    }
    const table = this.indexTable(row, plan, (code, entry) => (entry ? `${folderOf.get(code) ?? code}${entry.subject ? `/${ascii(entry.subject).slice(0, 40)}` : ''}` : null), locale, 'zip');
    zip.file(`${root}/00 ${locale === 'nl' ? 'Inhoud' : 'Index'}.pdf`, (await this.exports.write(table, 'pdf', user.name)).buffer);
    if (includeChecklist) zip.file(`${root}/00 ${locale === 'nl' ? 'Controlelijst' : 'Checklist'}.xlsx`, (await this.exports.write(await this.checklist.exportTable(row, user, locale), 'xlsx', user.name)).buffer);
    return { buffer: zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer, filename: `${base}.zip`, mimeType: 'application/zip' };
  }

  private async makePdf(row: InspectionRow, plan: PlannedLine[], user: AuthenticatedUser, locale: AppLocale, base: string): Promise<ExportFile> {
    const nl = locale === 'nl';
    const parts: PdfPart[] = [];
    const where = new Map<string, number>();
    const failed = new Set<string>();
    for (const line of plan) {
      for (const entry of line.files) {
        if (entry.duplicateOf) continue;
        const label = `${line.item.code} · ${entry.file.name}`;
        let bytes: Buffer;
        try {
          bytes = await this.pdfOf(entry.file, user);
          await this.pdf.pageCount(bytes);
        } catch (error) {
          this.logger.warn(`${entry.file.name} could not be put in the PDF of ${row.number}: ${error instanceof PdfError ? error.code : (error as Error).message.split('\n')[0]}`);
          failed.add(entry.file.id);
          bytes = await this.pdf.noticePage(entry.file.name, [nl ? 'Dit document kon niet in deze pdf worden opgenomen.' : 'This document could not be put in this PDF.', nl ? 'Het zit wel in de zip van het dossier.' : 'It is in the ZIP of the file.']);
        }
        where.set(entry.file.id, parts.length);
        parts.push({ bytes, label });
      }
    }
    const counts = await Promise.all(parts.map(part => this.pdf.pageCount(part.bytes)));
    const starts: number[] = [];
    let cursor = 0;
    for (const count of counts) {
      starts.push(cursor);
      cursor += count;
    }

    // The index goes first and says on which page each document starts; its own length decides where the documents start, so it is made until it holds still.
    let indexPages = 1;
    let index: Buffer = Buffer.alloc(0);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const table = this.indexTable(row, plan, (_code, entry) => (entry && where.has(entry.file.id) ? indexPages + 1 + (starts[where.get(entry.file.id)!] ?? 0) : null), locale, 'pdf');
      index = (await this.exports.write(table, 'pdf', user.name)).buffer;
      const pages = await this.pdf.pageCount(index);
      if (pages === indexPages) break;
      indexPages = pages;
    }
    const combined = await this.pdf.combine([{ bytes: index, label: nl ? 'Inhoud' : 'Index' }, ...parts], { firstPage: 1, title: `${nl ? 'Controledossier' : 'Inspection file'} ${row.client.number} ${row.client.name}` });
    return { buffer: combined.bytes, filename: `${base}.pdf`, mimeType: 'application/pdf' };
  }

  /* ── The log of what was handed over ──────────────────────────────────────────────────────────────────────────── */

  private manifest(plan: PlannedLine[], extra: Record<string, unknown> = {}): Prisma.InputJsonValue {
    return {
      items: plan.map(line => ({ code: line.item.code, label: line.item.label, files: line.files.map(entry => ({ id: entry.file.id, name: entry.file.name })) })),
      files: new Set(plan.flatMap(line => line.files.map(entry => entry.file.id))).size,
      ...extra,
    } as Prisma.InputJsonValue;
  }

  private async record(row: InspectionRow, user: AuthenticatedUser, input: { method: HandoverMethod; toName: string; note: string; plan: PlannedLine[]; bsnAccepted: boolean; extra?: Record<string, unknown> }) {
    const created = await this.prisma.inspectionHandover.create({
      data: { inspectionId: row.id, method: input.method, toName: input.toName, note: input.note, manifest: this.manifest(input.plan, input.extra), bsnAccepted: input.bsnAccepted, createdById: user.id },
    });
    await this.audit.log({
      action: 'updated',
      entityType: INSPECTION_ENTITY,
      entityId: row.id,
      entityLabel: `${row.number} – ${row.client.number} ${row.client.name}`,
      before: { handover: null },
      after: { handover: `${input.method}${input.toName ? ` → ${input.toName}` : ''}`, files: new Set(input.plan.flatMap(line => line.files.map(entry => entry.file.id))).size, ...(input.bsnAccepted && { bsnAccepted: true }) },
    });
    return created;
  }

  /** Writes down that something was handed over without making a bundle (shown on site, sent by e-mail …). */
  async log(row: InspectionRow, dto: HandoverDto, user: AuthenticatedUser, locale: AppLocale) {
    const toName = dto.toName.trim();
    if (!toName) throw validationFailed({ toName: 'validation.required' });
    const view = await this.checklist.build(row, user, locale);
    const plan = this.plan(view, dto.codes?.length ? dto.codes : view.sections.flatMap(section => section.items).filter(item => item.state === 'ready' || item.state === 'done').map(item => item.code ?? ''));
    const created = await this.record(row, user, { method: dto.method as HandoverMethod, toName, note: dto.note?.trim() ?? '', plan, bsnAccepted: false });
    return (await this.handovers(row.id, locale)).find(entry => entry.id === created.id)!;
  }

  async handovers(inspectionId: string, locale: AppLocale) {
    const [rows, methods] = await Promise.all([this.prisma.inspectionHandover.findMany({ where: { inspectionId }, orderBy: { at: 'desc' } }), this.lists.names('inspection_handover_method', locale)]);
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map(entry => entry.createdById).filter((id): id is string => Boolean(id)))] } }, select: { id: true, name: true } });
    const userName = new Map(users.map(user => [user.id, user.name]));
    return rows.map(entry => {
      const manifest = (entry.manifest ?? {}) as { items?: Array<{ code: string | null; label: string; files: Array<{ id: string; name: string }> }>; files?: number };
      return {
        id: entry.id,
        at: entry.at.toISOString(),
        method: { code: entry.method, name: methods.get(entry.method) ?? entry.method },
        toName: entry.toName,
        note: entry.note,
        files: manifest.files ?? 0,
        items: manifest.items ?? [],
        bsnAccepted: entry.bsnAccepted,
        by: entry.createdById ? { id: entry.createdById, name: userName.get(entry.createdById) ?? '' } : null,
      };
    });
  }
}
