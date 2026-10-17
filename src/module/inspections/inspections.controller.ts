import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { FileUploadInterceptor } from '../files/file-upload.interceptor.js';
import {
  BundleCheckDto,
  BundleDto,
  ChecklistExportQuery,
  CreateInspectionDto,
  CustomItemDto,
  FollowUpDto,
  HandoverDto,
  InspectionActiveDto,
  InspectionExportQuery,
  InspectionListQuery,
  InspectionStatusDto,
  ItemDecisionDto,
  ItemFileDto,
  PlanNextDto,
  ReadinessExportQuery,
  ReadinessQuery,
  RequestApplyDto,
  RequestTextDto,
  SwitchLinesDto,
  UpdateInspectionDto,
} from './dto/inspections.dto.js';
import { InspectionBundleService } from './inspection-bundle.service.js';
import { InspectionChecklistService } from './inspection-checklist.service.js';
import { InspectionReadinessService } from './inspection-readiness.service.js';
import { InspectionRequestAiService } from './inspection-request-ai.service.js';
import { InspectionSampleService } from './inspection-sample.service.js';
import { InspectionsService } from './inspections.service.js';

/**
 * Inspections ("Controle"): planning one, the checklist and what is ready for it, the sample, the bundle for the inspector, the follow-up and the log of what was handed over.
 * Everything is checked against the permission area `inspections`; what a person sees of a document is decided by the area of the document itself.
 */
@Controller('inspections')
@RequirePermission('inspections.view')
export class InspectionsController {
  constructor(
    private readonly inspections: InspectionsService,
    private readonly checklist: InspectionChecklistService,
    private readonly readiness: InspectionReadinessService,
    private readonly sample: InspectionSampleService,
    private readonly bundle: InspectionBundleService,
    private readonly request: InspectionRequestAiService,
    private readonly exports: ExportsService,
  ) {}

  /* ── Lists ────────────────────────────────────────────────────────────────────────────────────────────────────── */

  @Get()
  list(@Query() query: InspectionListQuery, @Locale() locale: AppLocale) {
    return this.inspections.list(query, locale);
  }

  @RequirePermission('inspections.export')
  @Get('export')
  async export(@Query() query: InspectionExportQuery, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale, @Res({ passthrough: true }) response: Response) {
    return this.exports.download(response, await this.inspections.exportTable(query, locale), this.exports.parseFormat(query.format), user.name);
  }

  /** How ready each client is for its next inspection. */
  @Get('readiness')
  readinessList(@Query() query: ReadinessQuery) {
    return this.readiness.list(query);
  }

  @RequirePermission('inspections.export')
  @Get('readiness/export')
  async readinessExport(@Query() query: ReadinessExportQuery, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale, @Res({ passthrough: true }) response: Response) {
    return this.exports.download(response, await this.readiness.exportTable(query, locale), this.exports.parseFormat(query.format), user.name);
  }

  /* ── One inspection ───────────────────────────────────────────────────────────────────────────────────────────── */

  @RequirePermission('inspections.create')
  @Post()
  create(@Body() dto: CreateInspectionDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.inspections.create(dto, user, locale);
  }

  @Get(':id')
  one(@Param('id') id: string, @Locale() locale: AppLocale) {
    return this.inspections.one(id, locale);
  }

  @RequirePermission('inspections.edit')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateInspectionDto, @Locale() locale: AppLocale) {
    return this.inspections.update(id, dto, locale);
  }

  /** `{ status, outcome?, closedOn?, findings?, planNext? }` — moves the inspection on, closes it (with its outcome) or opens it again. */
  @RequirePermission('inspections.edit')
  @HttpCode(200)
  @Post(':id/status')
  status(@Param('id') id: string, @Body() dto: InspectionStatusDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.inspections.setStatus(id, dto, user, locale);
  }

  /** `{ isActive, reason? }` — switches an inspection off (it stays for history) or on again. */
  @RequirePermission('inspections.delete')
  @HttpCode(200)
  @Post(':id/active')
  active(@Param('id') id: string, @Body() dto: InspectionActiveDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.inspections.setActive(id, dto, user, locale);
  }

  /** Plans the inspection that follows this one (`{ date? }`; by default the recurrence of the setting). */
  @RequirePermission('inspections.create')
  @HttpCode(200)
  @Post(':id/plan-next')
  async planNext(@Param('id') id: string, @Body() dto: PlanNextDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.inspections.planNext(id, dto.date, user, locale);
  }

  /* ── The checklist ────────────────────────────────────────────────────────────────────────────────────────────── */

  @Get(':id/checklist')
  async checklistOf(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.checklist.build(await this.inspections.rowOrThrow(id), user, locale);
  }

  @RequirePermission('inspections.export')
  @Get(':id/checklist/export')
  async checklistExport(@Param('id') id: string, @Query() query: ChecklistExportQuery, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale, @Res({ passthrough: true }) response: Response) {
    const table = await this.checklist.exportTable(await this.inspections.rowOrThrow(id), user, locale);
    return this.exports.download(response, table, this.exports.parseFormat(query.format), user.name);
  }

  /** `{ decision?, note?, dueDate? }` — "not applicable", "done", a note, the inspector's own deadline for one line. */
  @RequirePermission('inspections.edit')
  @Put(':id/items/:code')
  async item(@Param('id') id: string, @Param('code') code: string, @Body() dto: ItemDecisionDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    await this.checklist.setItem(await this.inspections.rowOrThrow(id), code, dto, user);
    return this.checklist.build(await this.inspections.rowOrThrow(id), user, locale);
  }

  /** `{ codes, on }` — switches lines on (asked for this time) or off; one line, or all lines of a part. */
  @RequirePermission('inspections.edit')
  @Put(':id/lines/switch')
  async switchLines(@Param('id') id: string, @Body() dto: SwitchLinesDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    await this.checklist.switchLines(await this.inspections.rowOrThrow(id), dto.codes, dto.on, user);
    return this.checklist.build(await this.inspections.rowOrThrow(id), user, locale);
  }

  /** `{ fileId, kind: 'added' | 'excluded' | 'none' }` — puts a document on a line, takes one off it, or forgets the choice. */
  @RequirePermission('inspections.edit')
  @Put(':id/items/:code/files')
  async itemFile(@Param('id') id: string, @Param('code') code: string, @Body() dto: ItemFileDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    await this.checklist.setFile(await this.inspections.rowOrThrow(id), code, dto, user);
    return this.checklist.build(await this.inspections.rowOrThrow(id), user, locale);
  }

  /** A line the checklist does not have (something the inspector asked for in their own words). */
  @RequirePermission('inspections.edit')
  @Post(':id/custom-items')
  async addCustom(@Param('id') id: string, @Body() dto: CustomItemDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    await this.checklist.addCustom(await this.inspections.rowOrThrow(id), dto, user);
    return this.checklist.build(await this.inspections.rowOrThrow(id), user, locale);
  }

  @RequirePermission('inspections.edit')
  @Patch(':id/custom-items/:itemId')
  async updateCustom(@Param('id') id: string, @Param('itemId') itemId: string, @Body() dto: CustomItemDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    await this.checklist.updateCustom(await this.inspections.rowOrThrow(id), itemId, dto, user);
    return this.checklist.build(await this.inspections.rowOrThrow(id), user, locale);
  }

  @RequirePermission('inspections.edit')
  @Delete(':id/custom-items/:itemId')
  async removeCustom(@Param('id') id: string, @Param('itemId') itemId: string, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    await this.checklist.removeCustom(await this.inspections.rowOrThrow(id), itemId);
    return this.checklist.build(await this.inspections.rowOrThrow(id), user, locale);
  }

  /* ── The sample ───────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The most recent leavers (the inspector's sample), with the papers asked for, and who joined and left since the last inspection. */
  @Get(':id/sample')
  async sampleOf(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.sample.sample(await this.inspections.rowOrThrow(id), user, locale);
  }

  @RequirePermission('inspections.export')
  @Get(':id/sample/export')
  async sampleExport(@Param('id') id: string, @Query() query: ChecklistExportQuery, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale, @Res({ passthrough: true }) response: Response) {
    const table = await this.sample.exportTable(await this.inspections.rowOrThrow(id), user, locale);
    return this.exports.download(response, table, this.exports.parseFormat(query.format), user.name);
  }

  /* ── Follow-up ────────────────────────────────────────────────────────────────────────────────────────────────── */

  @RequirePermission('inspections.edit')
  @Post(':id/follow-ups')
  addFollowUp(@Param('id') id: string, @Body() dto: FollowUpDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.inspections.addFollowUp(id, dto, user, locale);
  }

  @RequirePermission('inspections.edit')
  @Patch(':id/follow-ups/:followUpId')
  updateFollowUp(@Param('id') id: string, @Param('followUpId') followUpId: string, @Body() dto: FollowUpDto, @Locale() locale: AppLocale) {
    return this.inspections.updateFollowUp(id, followUpId, dto, locale);
  }

  @RequirePermission('inspections.edit')
  @Delete(':id/follow-ups/:followUpId')
  removeFollowUp(@Param('id') id: string, @Param('followUpId') followUpId: string, @Locale() locale: AppLocale) {
    return this.inspections.removeFollowUp(id, followUpId, locale);
  }

  /* ── The bundle and the log of what was handed over ───────────────────────────────────────────────────────────── */

  @Get(':id/handovers')
  handovers(@Param('id') id: string, @Locale() locale: AppLocale) {
    return this.bundle.handovers(id, locale);
  }

  /** Writes down that something was handed over without making a bundle (shown on site, sent by e-mail …). */
  @RequirePermission('inspections.edit')
  @Post(':id/handovers')
  async logHandover(@Param('id') id: string, @Body() dto: HandoverDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.bundle.log(await this.inspections.rowOrThrow(id), dto, user, locale);
  }

  /** What a bundle of these lines would hold, and what to look out for (citizen service numbers, documents that cannot be read, missing and too old lines). */
  @RequirePermission('inspections.export')
  @HttpCode(200)
  @Post(':id/bundle/check')
  async bundleCheck(@Param('id') id: string, @Body() dto: BundleCheckDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.bundle.check(await this.inspections.rowOrThrow(id), dto.codes, user, locale);
  }

  /** `{ format: 'zip' | 'pdf', codes?, acceptBsn?, includeChecklist?, toName?, note? }` — makes the bundle, writes down the handover and sends the file. */
  @RequirePermission('inspections.export')
  @HttpCode(200)
  @Post(':id/bundle')
  async makeBundle(@Param('id') id: string, @Body() dto: BundleDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale, @Res({ passthrough: true }) response: Response) {
    const file = await this.bundle.make(await this.inspections.rowOrThrow(id), dto, user, locale);
    response.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    return new StreamableFile(file.buffer, { type: file.mimeType, disposition: `attachment; filename="${file.filename}"`, length: file.buffer.length });
  }

  /* ── The inspector's request (AI) ─────────────────────────────────────────────────────────────────────────────── */

  /** multipart/form-data with `file` (a photo, a scan or a PDF), or JSON `{ text }`. The AI reads what is asked for; nothing is saved. */
  @RequirePermission('inspections.edit')
  @UseInterceptors(FileUploadInterceptor)
  @HttpCode(200)
  @Post(':id/request/read')
  readRequest(@Param('id') id: string, @UploadedFile() file: Express.Multer.File | undefined, @Body() dto: RequestTextDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.request.read(id, file, typeof dto?.text === 'string' ? dto.text : undefined, user, locale);
  }

  /** What the person confirmed of the reading. */
  @RequirePermission('inspections.edit')
  @HttpCode(200)
  @Post(':id/request/apply')
  applyRequest(@Param('id') id: string, @Body() dto: RequestApplyDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.request.apply(id, dto, user, locale);
  }
}
