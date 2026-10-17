import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { MarkAllReadDto, NotificationListQuery } from './dto/notification.dto.js';
import { NotificationsService } from './notifications.service.js';

/** The inbox of the signed-in person (the bell and the Notifications page): everyone only ever sees their own. */
@Controller('notifications')
@RequirePermission('notifications.view')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** `?read=false`, `?type=contract,deadline`, `?severity=critical`, `page`, `pageSize`; `meta.counts = { all, unread, byType }`. */
  @Get()
  list(@Query() query: NotificationListQuery, @CurrentUser('id') userId: string, @Locale() locale: AppLocale) {
    return this.notifications.list(userId, query, locale);
  }

  /** `{ count }` — the number on the bell and in the sidebar. */
  @Get('unread-count')
  async unreadCount(@CurrentUser('id') userId: string) {
    return { count: await this.notifications.unreadCount(userId) };
  }

  /** Marks everything (or only some types: `{ type: 'contract,deadline' }`) as read. */
  @HttpCode(200)
  @Post('read-all')
  readAll(@Body() dto: MarkAllReadDto, @CurrentUser('id') userId: string) {
    return this.notifications.markAllRead(userId, dto?.type);
  }

  @HttpCode(200)
  @Post(':id/read')
  read(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.notifications.markRead(userId, id, true);
  }

  @HttpCode(200)
  @Post(':id/unread')
  unread(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.notifications.markRead(userId, id, false);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.notifications.remove(userId, id);
  }
}

/** Settings → Notifications: which types a person wants in the app and by e-mail. */
@Controller('settings/notification-preferences')
@RequirePermission('notifications.view')
export class NotificationPreferencesController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  get(@CurrentUser('id') userId: string) {
    return this.notifications.preferences(userId);
  }

  /** `{ contract: { inApp: true, email: false } }` — send only the types that changed. */
  @Put()
  save(@Body() body: Record<string, { inApp?: unknown; email?: unknown }>, @CurrentUser('id') userId: string) {
    return this.notifications.savePreferences(userId, body ?? {});
  }
}
