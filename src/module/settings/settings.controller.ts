import { Body, Controller, Get, Put } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { CALENDAR_NAMESPACE } from '../calendar/calendar.service.js';
import { DOCUMENTS_NAMESPACE, LOCALE_NAMESPACE, OFFICE_NAMESPACE } from './settings.definitions.js';
import { SettingsGroupsService } from './settings-groups.service.js';

/** Settings → Office and Settings → Language & formats. (Security has its own endpoint, calendar settings live with the calendar.) */
@Controller('settings')
export class SettingsController {
  constructor(private readonly groups: SettingsGroupsService) {}

  /** The office name and logo and the default languages — for the frame of the app, so open to every signed-in person. */
  @Get('public')
  publicProfile() {
    return this.groups.publicProfile();
  }

  @RequirePermission('settings.view')
  @Get('office')
  office() {
    return this.groups.describe(OFFICE_NAMESPACE);
  }

  @RequirePermission('settings.edit')
  @Put('office')
  updateOffice(@Body() body: Record<string, unknown>, @CurrentUser('id') actorId: string) {
    return this.groups.update(OFFICE_NAMESPACE, body ?? {}, actorId);
  }

  @RequirePermission('settings.view')
  @Get('locale')
  locale() {
    return this.groups.describe(LOCALE_NAMESPACE);
  }

  @RequirePermission('settings.edit')
  @Put('locale')
  updateLocale(@Body() body: Record<string, unknown>, @CurrentUser('id') actorId: string) {
    return this.groups.update(LOCALE_NAMESPACE, body ?? {}, actorId);
  }

  /** How soon an expiring document (ID card, residence permit …) is flagged. */
  @RequirePermission('settings.view')
  @Get('documents')
  documents() {
    return this.groups.describe(DOCUMENTS_NAMESPACE);
  }

  @RequirePermission('settings.edit')
  @Put('documents')
  updateDocuments(@Body() body: Record<string, unknown>, @CurrentUser('id') actorId: string) {
    return this.groups.update(DOCUMENTS_NAMESPACE, body ?? {}, actorId);
  }

  /** Weekend days and the date warnings (the holidays themselves are under /calendar/holidays). */
  @RequirePermission('settings.view')
  @Get('calendar')
  calendar() {
    return this.groups.describe(CALENDAR_NAMESPACE);
  }

  @RequirePermission('settings.edit')
  @Put('calendar')
  updateCalendar(@Body() body: Record<string, unknown>, @CurrentUser('id') actorId: string) {
    return this.groups.update(CALENDAR_NAMESPACE, body ?? {}, actorId);
  }
}
