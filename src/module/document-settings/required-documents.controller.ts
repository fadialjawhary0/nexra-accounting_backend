import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional } from 'class-validator';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { REQUIREMENT_SCOPES, type RequirementScope } from './document-settings.constants.js';
import { RequiredDocumentDto } from './dto/document-settings.dto.js';
import { RequiredDocumentsService } from './required-documents.service.js';

class FieldsQuery {
  @IsOptional() @IsIn(REQUIREMENT_SCOPES) scope?: RequirementScope;
}

/** Which documents a client or a worker must have (Settings → Documents → Required documents). */
@Controller('required-documents')
@RequirePermission('settings.view')
export class RequiredDocumentsController {
  constructor(private readonly required: RequiredDocumentsService) {}

  @Get()
  list(@Locale() locale: AppLocale) {
    return this.required.list(locale);
  }

  /** The fields a rule's condition may look at (keys carry the form: `client.`, `employee.`, `person.`). */
  @Get('fields')
  fields(@Query() query: FieldsQuery) {
    return this.required.fields(query.scope ?? null);
  }

  @RequirePermission('settings.edit')
  @Post()
  create(@Body() dto: RequiredDocumentDto, @Locale() locale: AppLocale) {
    return this.required.create(dto, locale);
  }

  @RequirePermission('settings.edit')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: RequiredDocumentDto, @Locale() locale: AppLocale) {
    return this.required.update(id, dto, locale);
  }

  @RequirePermission('settings.edit')
  @Post(':id/activate')
  activate(@Param('id') id: string, @Locale() locale: AppLocale) {
    return this.required.setActive(id, true, locale);
  }

  @RequirePermission('settings.edit')
  @Post(':id/deactivate')
  deactivate(@Param('id') id: string, @Locale() locale: AppLocale) {
    return this.required.setActive(id, false, locale);
  }

  @RequirePermission('settings.edit')
  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.required.remove(id);
    return { id };
  }
}
