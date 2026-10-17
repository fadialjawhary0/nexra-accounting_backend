import { Body, Controller, Get, Put } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { AI_NAMESPACE } from '../../lib/ai/ai.settings.js';
import { POST_NAMESPACE } from '../address-book/address-book.constants.js';
import { CALENDAR_NAMESPACE } from '../calendar/calendar.service.js';
import { CONTRACTS_NAMESPACE } from '../contracts/contracts.settings.js';
import { HOURS_NAMESPACE } from '../hours/hours.constants.js';
import { IMPORTS_NAMESPACE } from '../imports/imports.constants.js';
import { INSPECTIONS_NAMESPACE } from '../inspections/inspections.constants.js';
import { INVOICES_NAMESPACE } from '../invoices/invoices.constants.js';
import { REMINDERS_NAMESPACE } from '../reminders/reminder-types.js';
import { TAXES_NAMESPACE } from '../taxes/taxes.constants.js';
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

  /** Settings → Contracts: which advice is shown, and what signing a contract does to the worker. */
  @RequirePermission('settings.view')
  @Get('contracts')
  contracts() {
    return this.groups.describe(CONTRACTS_NAMESPACE);
  }

  @RequirePermission('settings.edit')
  @Put('contracts')
  updateContracts(@Body() body: Record<string, unknown>, @CurrentUser('id') actorId: string) {
    return this.groups.update(CONTRACTS_NAMESPACE, body ?? {}, actorId);
  }

  /** Settings → Hours & pay: the advice around hours, the holiday allowance and the vacation build-up (the surcharge rules are under /hours/surcharges). */
  @RequirePermission('settings.view')
  @Get('hours')
  hours() {
    return this.groups.describe(HOURS_NAMESPACE);
  }

  @RequirePermission('settings.edit')
  @Put('hours')
  updateHours(@Body() body: Record<string, unknown>, @CurrentUser('id') actorId: string) {
    return this.groups.update(HOURS_NAMESPACE, body ?? {}, actorId);
  }

  /** Settings → Invoices: the VAT percentage, the payment term and the G-account percentage a new invoice starts with, and how the numbers of outgoing invoices look. */
  @RequirePermission('settings.view')
  @Get('invoices')
  invoices() {
    return this.groups.describe(INVOICES_NAMESPACE);
  }

  @RequirePermission('settings.edit')
  @Put('invoices')
  updateInvoices(@Body() body: Record<string, unknown>, @CurrentUser('id') actorId: string) {
    return this.groups.update(INVOICES_NAMESPACE, body ?? {}, actorId);
  }

  /** Settings → AI: on or off per feature, the models, the monthly budget, how sure the AI must be, how many files are read at once. */
  @RequirePermission('settings.view')
  @Get('ai')
  ai() {
    return this.groups.describe(AI_NAMESPACE);
  }

  @RequirePermission('settings.edit')
  @Put('ai')
  updateAi(@Body() body: Record<string, unknown>, @CurrentUser('id') actorId: string) {
    return this.groups.update(AI_NAMESPACE, body ?? {}, actorId);
  }

  /** Settings → Import: how many files an import may hold, how big a ZIP may be, what a row does with a record that exists already. */
  @RequirePermission('settings.view')
  @Get('imports')
  imports() {
    return this.groups.describe(IMPORTS_NAMESPACE);
  }

  @RequirePermission('settings.edit')
  @Put('imports')
  updateImports(@Body() body: Record<string, unknown>, @CurrentUser('id') actorId: string) {
    return this.groups.update(IMPORTS_NAMESPACE, body ?? {}, actorId);
  }

  /** Settings → Post: the size of an envelope label, whether the office's own address is printed on it, and how to move it for a printer that misses the spot. */
  @RequirePermission('settings.view')
  @Get('post')
  post() {
    return this.groups.describe(POST_NAMESPACE);
  }

  @RequirePermission('settings.edit')
  @Put('post')
  updatePost(@Body() body: Record<string, unknown>, @CurrentUser('id') actorId: string) {
    return this.groups.update(POST_NAMESPACE, body ?? {}, actorId);
  }

  /** Settings → Inspections: how often an inspection comes back, the dated folder, how many leavers the sample holds, and the check on citizen service numbers. */
  @RequirePermission('settings.view')
  @Get('inspections')
  inspections() {
    return this.groups.describe(INSPECTIONS_NAMESPACE);
  }

  @RequirePermission('settings.edit')
  @Put('inspections')
  updateInspections(@Body() body: Record<string, unknown>, @CurrentUser('id') actorId: string) {
    return this.groups.update(INSPECTIONS_NAMESPACE, body ?? {}, actorId);
  }

  /** Settings → Taxes: when the VAT, income-tax and corporate-tax returns are due, the usual extensions, and whether the rows of a new period are made by themselves. */
  @RequirePermission('settings.view')
  @Get('taxes')
  taxes() {
    return this.groups.describe(TAXES_NAMESPACE);
  }

  @RequirePermission('settings.edit')
  @Put('taxes')
  updateTaxes(@Body() body: Record<string, unknown>, @CurrentUser('id') actorId: string) {
    return this.groups.update(TAXES_NAMESPACE, body ?? {}, actorId);
  }

  /** Settings → Notifications & reminders: when the daily reminders are made. */
  @RequirePermission('settings.view')
  @Get('reminders')
  reminders() {
    return this.groups.describe(REMINDERS_NAMESPACE);
  }

  @RequirePermission('settings.edit')
  @Put('reminders')
  updateReminders(@Body() body: Record<string, unknown>, @CurrentUser('id') actorId: string) {
    return this.groups.update(REMINDERS_NAMESPACE, body ?? {}, actorId);
  }
}
