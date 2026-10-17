import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { contentDisposition } from '../../common/content-disposition.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { FileUploadInterceptor } from '../files/file-upload.interceptor.js';
import { CreateVersionDto, FillValuesDto, FormExportQuery, FormListQuery, FormStatusDto, PrepareDto, SaveFormDto, SaveMappingDto, SubjectsQuery, SubmitDto } from './dto/official-forms.dto.js';
import { FormAiService } from './form-ai.service.js';
import { FormFillService } from './form-fill.service.js';
import { FormSourcesService } from './form-sources.service.js';
import { OfficialFormVersionsService } from './official-form-versions.service.js';
import { OfficialFormsService } from './official-forms.service.js';

/** A PDF as the answer: shown in the browser's viewer, never run by the app (no sniffing, only this app may frame it). */
function pdfAnswer(response: Response, bytes: Buffer, name: string, download = false): StreamableFile {
  response.set({ 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "frame-ancestors 'self'", 'X-Content-Type-Options': 'nosniff' });
  return new StreamableFile(bytes, { type: 'application/pdf', disposition: contentDisposition(download ? 'attachment' : 'inline', name), length: bytes.length });
}

/**
 * The library of official PDF forms and filling them in: the forms and their editions (the PDFs and what goes into each field), where a value comes from, the
 * people a form can be about, and the three steps of filling one in — what it would be filled with, the PDF to look at, and filing it.
 */
@Controller('official-forms')
@RequirePermission('official_forms.view')
export class OfficialFormsController {
  constructor(
    private readonly forms: OfficialFormsService,
    private readonly versions: OfficialFormVersionsService,
    private readonly fill: FormFillService,
    private readonly ai: FormAiService,
    private readonly sources: FormSourcesService,
    private readonly exports: ExportsService,
  ) {}

  /* ── The library ──────────────────────────────────────────────────────────────────────────────────────────────── */

  @Get()
  list(@Query() query: FormListQuery, @Locale() locale: AppLocale) {
    return this.forms.list(query, locale);
  }

  @RequirePermission('official_forms.export')
  @Get('export')
  async export(@Query() query: FormExportQuery, @Locale() locale: AppLocale, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: Response) {
    return this.exports.download(response, await this.forms.exportTable(query, locale), this.exports.parseFormat(query.format), user.name);
  }

  /** Where a value of a field can come from: the fields of the client, person and employee forms, what the system works out, the office, the date, the period. */
  @Get('sources')
  catalog(@Locale() locale: AppLocale) {
    return this.sources.catalog(locale);
  }

  /** The people of a client (owner, directors, partners, contacts) and its workers — what a form that is about a person or a worker is filled in for. */
  @Get('subjects')
  subjects(@Query() query: SubjectsQuery, @Locale() locale: AppLocale) {
    return this.sources.subjects(query.clientId, locale);
  }

  @RequirePermission('official_forms.edit')
  @Post()
  create(@Body() dto: SaveFormDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.forms.create(dto, user, locale);
  }

  @Get(':id')
  one(@Param('id') id: string, @Locale() locale: AppLocale) {
    return this.forms.one(id, locale);
  }

  @RequirePermission('official_forms.edit')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: SaveFormDto, @Locale() locale: AppLocale) {
    return this.forms.update(id, dto, locale);
  }

  /** `{ isActive, reason? }` — switch a form off (it stays for what was filled in with it) or on again. */
  @RequirePermission('official_forms.delete')
  @HttpCode(200)
  @Post(':id/status')
  status(@Param('id') id: string, @Body() dto: FormStatusDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.forms.setStatus(id, dto, user, locale);
  }

  /* ── Editions and their mapping ───────────────────────────────────────────────────────────────────────────────── */

  /** `{ fileId, note?, copyMapping? }` — a new edition of the blank PDF (uploaded through `POST /files` with the purpose `form_blank`). */
  @RequirePermission('official_forms.edit')
  @Post(':id/versions')
  addVersion(@Param('id') id: string, @Body() dto: CreateVersionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.versions.create(id, dto, user);
  }

  /** An edition with every field of its PDF and what is mapped to it. */
  @Get(':id/versions/:versionId')
  edition(@Param('id') id: string, @Param('versionId') versionId: string) {
    return this.versions.one(id, versionId);
  }

  /** `{ mapping: [...] }` — saves what goes into each field of the PDF. */
  @RequirePermission('official_forms.edit')
  @Put(':id/versions/:versionId/mapping')
  saveMapping(@Param('id') id: string, @Param('versionId') versionId: string, @Body() dto: SaveMappingDto) {
    return this.versions.saveMapping(id, versionId, dto);
  }

  /** The blank PDF of an edition. */
  @Get(':id/versions/:versionId/blank')
  async blank(@Param('id') id: string, @Param('versionId') versionId: string, @Query('download') download: string | undefined, @Res({ passthrough: true }) response: Response) {
    const file = await this.versions.blank(id, versionId);
    return pdfAnswer(response, file.buffer, file.name, Boolean(download));
  }

  /* ── Filling a form in ────────────────────────────────────────────────────────────────────────────────────────── */

  /** What the form would be filled with for this client (and person, worker, period): every field with its value, what is still empty, and what to be careful about. */
  @RequirePermission('official_forms.create')
  @HttpCode(200)
  @Post(':id/prepare')
  prepare(@Param('id') id: string, @Body() dto: PrepareDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.fill.prepare(id, dto, user, locale);
  }

  /** The PDF with the values of the screen in it — nothing is saved. */
  @RequirePermission('official_forms.create')
  @HttpCode(200)
  @Post(':id/preview')
  async preview(@Param('id') id: string, @Body() dto: FillValuesDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale, @Res({ passthrough: true }) response: Response) {
    const filled = await this.fill.preview(id, dto, user, locale);
    return pdfAnswer(response, filled.bytes, filled.name);
  }

  /** Files the PDF with the client's documents and writes it in the log of sent forms. */
  @RequirePermission('official_forms.create')
  @Post(':id/submissions')
  submit(@Param('id') id: string, @Body() dto: SubmitDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.fill.submit(id, dto, user, locale);
  }

  /** multipart/form-data: `file` (a photo, a scan or a PDF). The AI reads what this form needs from it; nothing is saved. */
  @RequirePermission('official_forms.create')
  @UseInterceptors(FileUploadInterceptor)
  @Post(':id/read-source')
  readSource(@Param('id') id: string, @UploadedFile() file: Express.Multer.File | undefined, @Body() dto: { versionId?: string }, @CurrentUser() user: AuthenticatedUser) {
    return this.ai.read(id, file, { versionId: typeof dto?.versionId === 'string' ? dto.versionId : undefined }, user);
  }
}
