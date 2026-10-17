import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { contentDisposition } from '../../common/content-disposition.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { FileUploadInterceptor } from '../files/file-upload.interceptor.js';
import { DocumentIntakeService } from './document-intake.service.js';
import { DocumentPreviewService } from './document-preview.service.js';
import { DocumentRequirementsService } from './document-requirements.service.js';
import { DocumentTextService } from './document-text.service.js';
import { DocumentsService } from './documents.service.js';
import { DocumentExportQuery, DocumentListQuery, LinkDto, OverviewQuery, RequirementExportQuery, RequirementQuery, SuggestDto, UpdateDocumentDto, UploadDocumentDto } from './dto/documents.dto.js';

class FoldersQuery {
  @IsString() @MaxLength(60) clientId!: string;
}

class CurrentQuery {
  @IsString() @MaxLength(40) type!: string;
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  @IsOptional() @IsString() @MaxLength(60) employeeId?: string;
}

class PreviewQuery {
  @IsOptional() @IsIn(['1']) download?: string;
}

/**
 * The Documents page: every document of every client and worker with its type, its validity and its versions, what is missing, adding documents
 * (drag and drop, many at once), looking at them and finding them by what they say. Opening the page needs `documents.view`; what a person sees of each
 * document follows the permission area of the file.
 */
@Controller('documents')
@RequirePermission('documents.view')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly intake: DocumentIntakeService,
    private readonly requirements: DocumentRequirementsService,
    private readonly previews: DocumentPreviewService,
    private readonly text: DocumentTextService,
    private readonly exports: ExportsService,
  ) {}

  /* ── Lists ────────────────────────────────────────────────────────────────────────────────────────────────────── */

  @Get()
  list(@Query() query: DocumentListQuery, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.documents.list(query, user, locale);
  }

  @RequirePermission('documents.export')
  @Get('export')
  async exportList(@Query() query: DocumentExportQuery, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale, @Res({ passthrough: true }) response: Response) {
    return this.exports.download(response, await this.documents.exportTable(query, user, locale), this.exports.parseFormat(query.format), user.name);
  }

  /** The clients with how many documents each has and what needs attention. */
  @Get('overview')
  overview(@Query() query: OverviewQuery, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.requirements.overview(query, user, locale);
  }

  /** What has to be on file: missing, expired and expiring documents of clients and workers. */
  @Get('requirements')
  requirementList(@Query() query: RequirementQuery, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.requirements.list(query, user, locale);
  }

  @RequirePermission('documents.export')
  @Get('requirements/export')
  async exportRequirements(@Query() query: RequirementExportQuery, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale, @Res({ passthrough: true }) response: Response) {
    return this.exports.download(response, await this.requirements.exportTable(query, user, locale), this.exports.parseFormat(query.format), user.name);
  }

  /** The folders of a client, with how many documents each holds. */
  @Get('folders')
  folders(@Query() query: FoldersQuery, @CurrentUser() user: AuthenticatedUser) {
    return this.documents.folders(query.clientId, user);
  }

  /** The document a new file of this type would replace (for the "new version?" question of the upload). */
  @Get('current')
  current(@Query() query: CurrentQuery, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.intake.current(query.type, query.clientId, query.employeeId, user, locale);
  }

  /* ── Adding ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The type and the date each file name points to — to prefill the upload dialog. */
  @RequirePermission('documents.create')
  @Post('suggest')
  suggest(@Body() dto: SuggestDto) {
    return this.intake.suggest(dto);
  }

  /** multipart/form-data: `file` + what is known about it (`clientId` or `employeeId`, `folderId`, `docType`, `docDate`, `validUntil`, `name`, `replaces` …). */
  @RequirePermission('documents.create')
  @UseInterceptors(FileUploadInterceptor)
  @Post()
  upload(@UploadedFile() file: Express.Multer.File | undefined, @Body() dto: UploadDocumentDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.intake.upload(file, dto, user, locale);
  }

  /* ── One document ─────────────────────────────────────────────────────────────────────────────────────────────── */

  @Get(':id')
  one(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.documents.one(id, user, locale);
  }

  /** A PDF or an image as it is, a Word / Excel file as the PDF made of it, a text file as text. */
  @Get(':id/preview')
  async preview(@Param('id') id: string, @Query() query: PreviewQuery, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: Response) {
    const shown = await this.previews.open(id, user);
    // Nothing a file contains may ever run in the app's origin: no sniffing, no scripts (the browser's PDF viewer needs frame-ancestors only).
    const policy = shown.mime === 'application/pdf' ? "frame-ancestors 'self'" : "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
    response.set({ 'Cache-Control': 'private, max-age=300', 'Content-Security-Policy': policy, 'X-Content-Type-Options': 'nosniff' });
    const options = { type: shown.mime, disposition: contentDisposition(query.download ? 'attachment' : 'inline', shown.name), ...(shown.length !== undefined && { length: shown.length }) };
    return Buffer.isBuffer(shown.stream) ? new StreamableFile(shown.stream, options) : new StreamableFile(shown.stream, options);
  }

  @RequirePermission('documents.edit')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateDocumentDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.documents.update(id, dto, user, locale);
  }

  @RequirePermission('documents.delete')
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.documents.remove(id, user);
  }

  @RequirePermission('documents.delete')
  @Post(':id/restore')
  restore(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.documents.restore(id, user, locale);
  }

  /** An older version becomes the current one again. */
  @RequirePermission('documents.edit')
  @Post(':id/current')
  makeCurrent(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.documents.makeCurrent(id, user, locale);
  }

  /** Reads the text of the document again (for the search). */
  @RequirePermission('documents.edit')
  @Post(':id/read')
  async read(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.documents.readable(id, user);
    await this.text.reindex(id);
    return { id };
  }

  @RequirePermission('documents.edit')
  @Post(':id/links')
  addLink(@Param('id') id: string, @Body() dto: LinkDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.documents.addLink(id, dto, user, locale);
  }

  @RequirePermission('documents.edit')
  @Delete(':id/links/:linkId')
  removeLink(@Param('id') id: string, @Param('linkId') linkId: string, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.documents.removeLink(id, linkId, user, locale);
  }
}
