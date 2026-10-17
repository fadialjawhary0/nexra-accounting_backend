import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { ChecklistTemplatesService } from './checklist-templates.service.js';
import { CreateTemplateDto, NewDraftDto, SaveVersionDto, TemplateExportQuery, UpdateTemplateDto } from './dto/checklist-templates.dto.js';

/**
 * The checklists of inspections (Settings → Inspections): what an inspector asks for, in editions. Reading them is part of working with inspections; changing them is part of the
 * settings.
 */
@Controller('checklist-templates')
@RequirePermission('inspections.view')
export class ChecklistTemplatesController {
  constructor(
    private readonly templates: ChecklistTemplatesService,
    private readonly exports: ExportsService,
  ) {}

  @Get()
  list(@Locale() locale: AppLocale) {
    return this.templates.list(locale);
  }

  /** The checklists an inspection can be prepared with (each with its newest published edition). */
  @Get('choices')
  choices(@Locale() locale: AppLocale) {
    return this.templates.choices(locale);
  }

  /** The document types and client fields a line of a checklist may use. */
  @Get('options')
  options(@Locale() locale: AppLocale) {
    return this.templates.editorOptions(locale);
  }

  @Get(':id')
  one(@Param('id') id: string, @Locale() locale: AppLocale) {
    return this.templates.one(id, locale);
  }

  @Get(':id/versions/:versionId')
  version(@Param('id') id: string, @Param('versionId') versionId: string, @Locale() locale: AppLocale) {
    return this.templates.version(id, versionId, locale);
  }

  @RequirePermission('inspections.export')
  @Get(':id/versions/:versionId/export')
  async export(@Param('id') id: string, @Param('versionId') versionId: string, @Query() query: TemplateExportQuery, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale, @Res({ passthrough: true }) response: Response) {
    return this.exports.download(response, await this.templates.exportTable(id, versionId, locale), this.exports.parseFormat(query.format), user.name);
  }

  @RequirePermission('settings.edit')
  @Post()
  create(@Body() dto: CreateTemplateDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.templates.create(dto, user, locale);
  }

  @RequirePermission('settings.edit')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTemplateDto, @Locale() locale: AppLocale) {
    return this.templates.update(id, dto, locale);
  }

  @RequirePermission('settings.edit')
  @HttpCode(200)
  @Post(':id/activate')
  activate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.templates.setActive(id, true, user, locale);
  }

  @RequirePermission('settings.edit')
  @HttpCode(200)
  @Post(':id/deactivate')
  deactivate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.templates.setActive(id, false, user, locale);
  }

  /** Starts a new edition as a draft (a copy of the newest published one). */
  @RequirePermission('settings.edit')
  @Post(':id/versions')
  newDraft(@Param('id') id: string, @Body() dto: NewDraftDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.templates.newDraft(id, dto.fromVersionId, user, locale);
  }

  /** Saves the draft: `{ label?, note?, sections, items }`. Problems come back as `fields` under `items.<n>.<part>`. */
  @RequirePermission('settings.edit')
  @Put(':id/versions/:versionId')
  save(@Param('id') id: string, @Param('versionId') versionId: string, @Body() dto: SaveVersionDto, @Locale() locale: AppLocale) {
    return this.templates.saveDraft(id, versionId, dto, locale);
  }

  @RequirePermission('settings.edit')
  @HttpCode(200)
  @Post(':id/versions/:versionId/publish')
  publish(@Param('id') id: string, @Param('versionId') versionId: string, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.templates.publish(id, versionId, user, locale);
  }

  /** Throws a draft away (a published edition stays). */
  @RequirePermission('settings.edit')
  @Delete(':id/versions/:versionId')
  async discard(@Param('id') id: string, @Param('versionId') versionId: string) {
    await this.templates.discard(id, versionId);
    return { id: versionId };
  }
}
