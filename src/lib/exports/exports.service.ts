import { BadRequestException, Injectable, Logger, StreamableFile, UnprocessableEntityException } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../database/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { StorageService } from '../storage/storage.service.js';
import { writeDocx } from './docx.writer.js';
import { fileBase } from './export-format.js';
import { EXPORT_FORMATS, EXPORT_MIME, MAX_EXPORT_ROWS, type ExportBranding, type ExportFile, type ExportFormat, type ExportTable } from './export.types.js';
import { writePdf } from './pdf.writer.js';
import { writeXlsx } from './xlsx.writer.js';

/**
 * Every list, record and report leaves the app as Excel, PDF or Word through this service: the feature builds an ExportTable from its
 * rows, this writes it with the office's name and logo, Dutch dates / amounts and a "generated on … by …" line.
 */
@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    private readonly settings: SettingsService,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** The `format` of a request (`xlsx`, `pdf`, `docx`); anything else is a 400. */
  parseFormat(value: string | undefined): ExportFormat {
    const format = (value ?? 'xlsx').toLowerCase() as ExportFormat;
    if (!EXPORT_FORMATS.includes(format)) throw new BadRequestException({ code: 'export_format', message: 'Choose Excel, PDF or Word.' });
    return format;
  }

  /** A list that is too long for one export is refused before anything is written. */
  assertSize(rowCount: number): void {
    if (rowCount > MAX_EXPORT_ROWS) throw new UnprocessableEntityException({ code: 'export_too_large', message: `More than ${MAX_EXPORT_ROWS} rows — narrow the list down first.`, details: { max: MAX_EXPORT_ROWS } });
  }

  async write(table: ExportTable, format: ExportFormat, generatedBy: string): Promise<ExportFile> {
    const branding = await this.branding(generatedBy);
    const buffer = format === 'xlsx' ? await writeXlsx(table, branding) : format === 'pdf' ? await writePdf(table, branding) : await writeDocx(table, branding);
    return { buffer, filename: `${fileBase(table.title, branding.generatedAt)}.${format}`, mimeType: EXPORT_MIME[format] };
  }

  /** Builds the file and sends it as a download (`Content-Disposition: attachment`). */
  async download(response: Response, table: ExportTable, format: ExportFormat, generatedBy: string): Promise<StreamableFile> {
    const file = await this.write(table, format, generatedBy);
    response.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    return new StreamableFile(file.buffer, { type: file.mimeType, disposition: `attachment; filename="${file.filename}"`, length: file.buffer.length });
  }

  private async branding(generatedBy: string): Promise<ExportBranding> {
    const organization = this.settings.get<string>('office.tradeName') || this.settings.get<string>('office.name');
    return { organization, generatedBy, generatedAt: new Date(), logo: await this.logo() };
  }

  /** The office logo when it is a PNG or JPEG (PDF and Word cannot embed other types). A missing or unreadable logo is simply left out. */
  private async logo(): Promise<ExportBranding['logo']> {
    const id = this.settings.get<string>('office.logoFileId');
    if (!id) return undefined;
    try {
      const file = await this.prisma.storedFile.findFirst({ where: { id, isActive: true, purpose: 'office_logo' } });
      if (!file || (file.mimeType !== 'image/png' && file.mimeType !== 'image/jpeg')) return undefined;
      const chunks: Buffer[] = [];
      for await (const chunk of await this.storage.get(file.storageKey)) chunks.push(Buffer.from(chunk as Buffer));
      return { data: Buffer.concat(chunks), mimeType: file.mimeType };
    } catch (error) {
      this.logger.warn(`Could not read the office logo for an export: ${(error as Error).message}`);
      return undefined;
    }
  }
}
