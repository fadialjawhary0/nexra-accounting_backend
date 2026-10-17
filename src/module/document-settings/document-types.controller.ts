import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { DocumentTypesService } from './document-types.service.js';
import { DocumentTypeDto, DocumentTypeListQuery, NamePreviewDto, OrderDto } from './dto/document-settings.dto.js';

/**
 * The types of document. Reading them is open to every signed-in person (the upload dialog, the review list of an import and the filters all need the
 * names); changing them is part of Settings.
 */
@Controller('document-types')
export class DocumentTypesController {
  constructor(private readonly types: DocumentTypesService) {}

  @Get()
  list(@Query() query: DocumentTypeListQuery, @Locale() locale: AppLocale) {
    return this.types.list(locale, query.active === true);
  }

  /** What a naming pattern makes for an example (shown while it is typed). */
  @RequirePermission('settings.edit')
  @Post('name-preview')
  namePreview(@Body() dto: NamePreviewDto, @Locale() locale: AppLocale) {
    return this.types.namePreview(dto.pattern, dto.typeCode, locale);
  }

  @RequirePermission('settings.edit')
  @Put('order')
  async reorder(@Body() dto: OrderDto) {
    await this.types.reorder(dto.ids);
    return { ok: true };
  }

  @RequirePermission('settings.edit')
  @Post()
  create(@Body() dto: DocumentTypeDto, @Locale() locale: AppLocale) {
    return this.types.create(dto, locale);
  }

  @RequirePermission('settings.edit')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: DocumentTypeDto, @Locale() locale: AppLocale) {
    return this.types.update(id, dto, locale);
  }

  @RequirePermission('settings.edit')
  @Post(':id/activate')
  activate(@Param('id') id: string, @Locale() locale: AppLocale) {
    return this.types.setActive(id, true, locale);
  }

  @RequirePermission('settings.edit')
  @Post(':id/deactivate')
  deactivate(@Param('id') id: string, @Locale() locale: AppLocale) {
    return this.types.setActive(id, false, locale);
  }
}
