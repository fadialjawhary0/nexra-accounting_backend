import { Body, Controller, Get, Param, Patch, Post, Put, Query, Res, UploadedFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { FileUploadInterceptor } from '../files/file-upload.interceptor.js';
import { DocumentUploadService } from './document-upload.service.js';
import { AcceptAllDto, CreateDocumentsJobDto, CreateInboxDto, ItemListQuery, JobListQuery, PatchItemDto, SheetQuery, SheetSetupDto } from './dto/imports.dto.js';
import { ImportFilesInterceptor, ImportZipInterceptor } from './import-upload.interceptor.js';
import { ImportReportService } from './import-report.service.js';
import { ImportsService } from './imports.service.js';
import { ItemActionsService } from './item-actions.service.js';
import { SheetImportService } from './sheet-import.service.js';

class RereadDto {
  /** Read the file again as this type of document (a code of a document type). */
  @IsOptional() @IsString() @MaxLength(40) docType?: string;
}

/**
 * Imports: a spreadsheet (clients, workers or hours — read by code), a batch of files (read by the AI queue) or a message to the AI inbox of the dashboard, the list
 * of what an import found, and what a person does with it. Viewing needs `imports.view`; starting one `imports.create`; changing items `imports.edit`; saving the
 * results into the records `imports.approve` (and, of course, the right to make those records).
 */
@Controller('imports')
@RequirePermission('imports.view')
export class ImportsController {
  constructor(
    private readonly imports: ImportsService,
    private readonly uploads: DocumentUploadService,
    private readonly sheets: SheetImportService,
    private readonly actions: ItemActionsService,
    private readonly report: ImportReportService,
    private readonly exports: ExportsService,
  ) {}

  /* ── Imports ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  @Get()
  list(@Query() query: JobListQuery, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.list(query, user.id);
  }

  /** A new import of files; the files follow with `POST :id/files` (or `:id/zip`) and `POST :id/start`. */
  @RequirePermission('imports.create')
  @Post()
  create(@Body() dto: CreateDocumentsJobDto, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.createDocumentsJob(dto, user);
  }

  /** A message to the AI inbox `{ instruction }`; files may follow with `POST :id/files`, then `POST :id/start` reads the message first and the files after it. */
  @RequirePermission('imports.create')
  @Post('inbox')
  createInbox(@Body() dto: CreateInboxDto, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.createInboxJob(dto, user);
  }

  /** A new import of a spreadsheet: multipart `file` (xlsx, xls, ods, csv). */
  @RequirePermission('imports.create')
  @UseInterceptors(FileUploadInterceptor)
  @Post('spreadsheet')
  spreadsheet(@UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() user: AuthenticatedUser) {
    return this.sheets.upload(file, user);
  }

  /** The history as Excel / PDF / Word, with the filters of the list (before `:id`, so "export" is not an id). */
  @RequirePermission('imports.export')
  @Get('export')
  async exportList(@Query() query: JobListQuery, @Query('format') format: string | undefined, @Locale() locale: AppLocale, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: Response) {
    return this.exports.download(response, await this.report.listTable(query, locale, user.id), this.exports.parseFormat(format), user.name);
  }

  @Get(':id')
  one(@Param('id') id: string) {
    return this.imports.get(id);
  }

  @RequirePermission('imports.create')
  @Post(':id/start')
  start(@Param('id') id: string) {
    return this.imports.start(id);
  }

  /** The message of an inbox is read again, after the AI could not read it the first time. */
  @RequirePermission('imports.create')
  @Post(':id/message')
  rereadMessage(@Param('id') id: string) {
    return this.imports.rereadMessage(id);
  }

  @RequirePermission('imports.edit')
  @Post(':id/pause')
  pause(@Param('id') id: string) {
    return this.imports.pause(id);
  }

  @RequirePermission('imports.edit')
  @Post(':id/resume')
  resume(@Param('id') id: string) {
    return this.imports.resume(id);
  }

  @RequirePermission('imports.delete')
  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.imports.cancel(id);
  }

  /* ── Files ────────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** A batch of files (multipart `files`, the name of each is its path inside the chosen folder). */
  @RequirePermission('imports.create')
  @UseInterceptors(ImportFilesInterceptor)
  @Post(':id/files')
  addFiles(@Param('id') id: string, @UploadedFiles() files: Express.Multer.File[] | undefined, @CurrentUser() user: AuthenticatedUser) {
    return this.uploads.addFiles(id, files, user);
  }

  /** A ZIP file (multipart `file`): its files are added. */
  @RequirePermission('imports.create')
  @UseInterceptors(ImportZipInterceptor)
  @Post(':id/zip')
  addZip(@Param('id') id: string, @UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() user: AuthenticatedUser) {
    return this.uploads.addZip(id, file, user);
  }

  /* ── Items ────────────────────────────────────────────────────────────────────────────────────────────────────── */

  @Get(':id/items')
  items(@Param('id') id: string, @Query() query: ItemListQuery) {
    return this.imports.items(id, query);
  }

  @Get(':id/items/:itemId')
  item(@Param('id') id: string, @Param('itemId') itemId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.item(id, itemId, user);
  }

  /** What a person changed in the review list; the answer is the item after it was checked again. */
  @RequirePermission('imports.edit')
  @Patch(':id/items/:itemId')
  patch(@Param('id') id: string, @Param('itemId') itemId: string, @Body() dto: PatchItemDto, @CurrentUser() user: AuthenticatedUser) {
    return this.actions.patch(id, itemId, dto, user);
  }

  @RequirePermission('imports.approve')
  @Post(':id/items/:itemId/accept')
  accept(@Param('id') id: string, @Param('itemId') itemId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.actions.acceptOne(id, itemId, user);
  }

  @RequirePermission('imports.edit')
  @Post(':id/items/:itemId/reject')
  reject(@Param('id') id: string, @Param('itemId') itemId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.actions.reject(id, itemId, user);
  }

  @RequirePermission('imports.edit')
  @Post(':id/items/:itemId/reread')
  reread(@Param('id') id: string, @Param('itemId') itemId: string, @Body() dto: RereadDto, @CurrentUser() user: AuthenticatedUser) {
    return this.actions.reread(id, itemId, user, dto.docType);
  }

  /** Accepts every item that is safe (or the ones named), in the background. */
  @RequirePermission('imports.approve')
  @Post(':id/accept')
  acceptAll(@Param('id') id: string, @Body() dto: AcceptAllDto, @CurrentUser() user: AuthenticatedUser) {
    return this.actions.acceptAll(id, dto, user);
  }

  /* ── Spreadsheets ─────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The sheet as the wizard shows it: headings, a few rows, the fields a column can fill and the suggested mapping. */
  @RequirePermission('imports.create')
  @Get(':id/sheet')
  sheet(@Param('id') id: string, @Query() query: SheetQuery, @CurrentUser() user: AuthenticatedUser) {
    return this.sheets.analyse(id, query, user);
  }

  /** The AI's suggestion for the columns (only the headings are sent). */
  @RequirePermission('imports.create')
  @Post(':id/sheet/suggest')
  suggest(@Param('id') id: string, @Query() query: SheetQuery, @CurrentUser() user: AuthenticatedUser) {
    return this.sheets.suggest(id, query, user);
  }

  @RequirePermission('imports.create')
  @Put(':id/setup')
  setup(@Param('id') id: string, @Body() dto: SheetSetupDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sheets.saveSetup(id, dto, user);
  }

  @RequirePermission('imports.create')
  @Post(':id/check')
  check(@Param('id') id: string) {
    return this.sheets.check(id);
  }

  @RequirePermission('imports.approve')
  @Post(':id/commit')
  commit(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sheets.commit(id, user);
  }

  /* ── Report ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  @RequirePermission('imports.export')
  @Get(':id/report')
  async download(@Param('id') id: string, @Query('format') format: string | undefined, @Locale() locale: AppLocale, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: Response) {
    return this.exports.download(response, await this.report.table(id, locale), this.exports.parseFormat(format), user.name);
  }
}
