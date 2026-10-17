import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequireAnyPermission, RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { MergeFieldsService } from '../templates/merge-fields.service.js';
import { CreateMessageTemplateDto, MessageTemplateQuery, UpdateMessageTemplateDto, WhatsAppLinkDto } from './dto/messaging.dto.js';
import { MessagingService } from './messaging.service.js';

/** Ready-made WhatsApp messages (Settings → WhatsApp messages) and the link behind the "Open WhatsApp" buttons. */
@Controller('messaging')
export class MessagingController {
  constructor(
    private readonly messaging: MessagingService,
    private readonly merge: MergeFieldsService,
  ) {}

  /** `?audience=worker|client` for the menu of a button; `?all=true` (Settings) also lists the ones that are switched off. */
  @RequireAnyPermission('contracts.view', 'settings.view')
  @Get('templates')
  list(@Query() query: MessageTemplateQuery, @Locale() locale: AppLocale) {
    return this.messaging.list(query, locale);
  }

  /** The fields a message can use (`{employee.first_name}`, `{contract.end_date}` …). */
  @RequirePermission('settings.view')
  @Get('merge-fields')
  mergeFields(@Locale() locale: AppLocale, @CurrentUser() user: AuthenticatedUser) {
    return this.merge.catalog(locale, user.matrix);
  }

  @RequirePermission('settings.edit')
  @Post('templates')
  create(@Body() dto: CreateMessageTemplateDto, @Locale() locale: AppLocale) {
    return this.messaging.create(dto, locale);
  }

  @RequirePermission('settings.edit')
  @Patch('templates/:id')
  update(@Param('id') id: string, @Body() dto: UpdateMessageTemplateDto, @Locale() locale: AppLocale) {
    return this.messaging.update(id, dto, locale);
  }

  /** `{ templateId | templateCode, contractId, to?, language? }` → `{ url, text, phone, to, name }`; `url` is empty when there is no phone number. */
  @RequirePermission('contracts.view')
  @HttpCode(200)
  @Post('whatsapp-link')
  whatsappLink(@Body() dto: WhatsAppLinkDto, @CurrentUser() user: AuthenticatedUser) {
    return this.messaging.whatsappLink(dto, user);
  }
}
