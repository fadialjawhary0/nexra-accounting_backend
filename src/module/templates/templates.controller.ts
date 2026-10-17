import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { contentDisposition } from '../../common/content-disposition.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequireAnyPermission, RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { MergeFieldsService } from './merge-fields.service.js';
import { TemplatesService } from './templates.service.js';
import { AddTemplateVersionDto, CreateTemplateDto, InspectTemplateDto, SetTemplateStatusDto, TemplateListQuery, TemplateLookupQuery, TemplatePreviewQuery, UpdateTemplateDto } from './dto/template.dto.js';

/** Word templates for contracts and letters: the list, a template with its versions, upload, preview and the merge fields that can be used. */
@Controller('templates')
@RequirePermission('templates.view')
export class TemplatesController {
  constructor(
    private readonly templates: TemplatesService,
    private readonly merge: MergeFieldsService,
  ) {}

  @Get()
  list(@Query() query: TemplateListQuery) {
    return this.templates.list(query);
  }

  /** The templates a person can pick when making a contract or a letter (`?kind=contract&contractType=on_call&clientId=…`). */
  @RequireAnyPermission('templates.view', 'contracts.create', 'contracts.edit')
  @Get('lookup')
  lookup(@Query() query: TemplateLookupQuery) {
    return this.templates.lookup(query);
  }

  /** Every merge field a template can use, in groups (contract or salary statement, employee, client, office, document); `?kind=salary_statement` for a statement template. */
  @Get('merge-fields')
  mergeFields(@Query('kind') kind: string | undefined, @Locale() locale: AppLocale, @CurrentUser() user: AuthenticatedUser) {
    return this.merge.catalog(locale, user.matrix, kind);
  }

  /** Reads an uploaded Word file before it is saved: the merge fields it uses and the ones that do not exist. */
  @RequireAnyPermission('templates.create', 'templates.edit')
  @HttpCode(200)
  @Post('inspect')
  inspect(@Body() dto: InspectTemplateDto) {
    return this.templates.inspect(dto.fileId, dto.kind);
  }

  @Get(':id')
  get(@Param('id') id: string, @Locale() locale: AppLocale) {
    return this.templates.get(id, locale);
  }

  /** The template filled with made-up data (`?format=pdf|docx&version=2`). */
  @Get(':id/preview')
  async preview(@Param('id') id: string, @Query() query: TemplatePreviewQuery, @Res({ passthrough: true }) response: Response) {
    const result = await this.templates.preview(id, query.version, query.format ?? 'pdf');
    response.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Unknown-Fields': encodeURIComponent(result.unknown.join(',')) });
    return new StreamableFile(result.buffer, { type: result.mime, disposition: contentDisposition(query.format === 'docx' ? 'attachment' : 'inline', result.name), length: result.buffer.length });
  }

  /** `{ name, kind, scope?, clientId?, language?, contractType?, description?, fileId }` — the Word file was uploaded with `POST /files` (`purpose=template`). */
  @RequirePermission('templates.create')
  @Post()
  create(@Body() dto: CreateTemplateDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.templates.create(dto, user, locale);
  }

  @RequirePermission('templates.edit')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTemplateDto, @Locale() locale: AppLocale) {
    return this.templates.update(id, dto, locale);
  }

  /** A new Word file for the template (`{ fileId, note? }`): version 2, 3 … */
  @RequirePermission('templates.edit')
  @Post(':id/versions')
  addVersion(@Param('id') id: string, @Body() dto: AddTemplateVersionDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.templates.addVersion(id, dto, user, locale);
  }

  /** Templates are never deleted: `{ status: 'inactive' | 'active' }`. */
  @RequirePermission('templates.delete')
  @HttpCode(200)
  @Post(':id/status')
  setStatus(@Param('id') id: string, @Body() dto: SetTemplateStatusDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.templates.setStatus(id, dto, user, locale);
  }
}
