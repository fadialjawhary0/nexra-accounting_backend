import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { CreateReminderRuleDto, UpcomingQuery, UpdateReminderRuleDto } from './dto/reminder.dto.js';
import { RemindersService } from './reminders.service.js';

/** Settings → Notifications & reminders: the rules, and a button to make today's reminders now. */
@Controller('reminders')
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  /** `{ rules, triggers, users, roles }` — the rules and what a new rule can watch and be sent to. */
  @RequirePermission('settings.view')
  @Get('rules')
  overview(@Locale() locale: AppLocale) {
    return this.reminders.overview(locale);
  }

  /** `{ trigger, name?, offsets: [30, 14], dayType: 'calendar' | 'working', recipients: { roles?, users?, responsible? }, channels: ['in_app', 'email'] }` */
  @RequirePermission('settings.edit')
  @Post('rules')
  create(@Body() dto: CreateReminderRuleDto, @Locale() locale: AppLocale) {
    return this.reminders.create(dto, locale);
  }

  @RequirePermission('settings.edit')
  @Patch('rules/:id')
  update(@Param('id') id: string, @Body() dto: UpdateReminderRuleDto) {
    return this.reminders.update(id, dto);
  }

  @RequirePermission('settings.edit')
  @Delete('rules/:id')
  remove(@Param('id') id: string) {
    return this.reminders.remove(id);
  }

  /** Makes every reminder that is due today and was not made yet; the answer says how many. */
  @RequirePermission('settings.edit')
  @HttpCode(200)
  @Post('run')
  run() {
    return this.reminders.run();
  }

  /** The reminders still to come for one record: `?subjectType=contract&subjectId=…`. Only those the person may be told about. */
  @RequirePermission('notifications.view')
  @Get('upcoming')
  upcoming(@Query() query: UpcomingQuery, @Locale() locale: AppLocale, @CurrentUser() user: AuthenticatedUser) {
    return this.reminders.upcoming(query.subjectType, query.subjectId, locale, user.matrix);
  }
}
