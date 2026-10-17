import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { ApplyTemplateDto, FolderTemplateDto, OrderDto } from './dto/document-settings.dto.js';
import { FolderTemplatesService } from './folder-templates.service.js';

/** The standard folders of a client (Settings → Documents → Folders). */
@Controller('folder-templates')
@RequirePermission('settings.view')
export class FolderTemplatesController {
  constructor(private readonly templates: FolderTemplatesService) {}

  @Get()
  list(@Locale() locale: AppLocale) {
    return this.templates.list(locale);
  }

  @RequirePermission('settings.edit')
  @Put('order')
  async reorder(@Body() dto: OrderDto) {
    await this.templates.reorder(dto.ids);
    return { ok: true };
  }

  /** Adds the standard folders that clients do not have yet (one client, or all that are not stopped). */
  @RequirePermission('settings.edit')
  @Post('apply')
  apply(@Body() dto: ApplyTemplateDto) {
    return this.templates.apply(dto.clientId);
  }

  @RequirePermission('settings.edit')
  @Post()
  create(@Body() dto: FolderTemplateDto, @Locale() locale: AppLocale) {
    return this.templates.create(dto, locale);
  }

  @RequirePermission('settings.edit')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: FolderTemplateDto, @Locale() locale: AppLocale) {
    return this.templates.update(id, dto, locale);
  }

  @RequirePermission('settings.edit')
  @Post(':id/activate')
  activate(@Param('id') id: string, @Locale() locale: AppLocale) {
    return this.templates.setActive(id, true, locale);
  }

  @RequirePermission('settings.edit')
  @Post(':id/deactivate')
  deactivate(@Param('id') id: string, @Locale() locale: AppLocale) {
    return this.templates.setActive(id, false, locale);
  }
}
