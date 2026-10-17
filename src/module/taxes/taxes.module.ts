import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module.js';
import { RemindersModule } from '../reminders/reminders.module.js';
import { EmployerRegistrationsController } from './employer-registrations.controller.js';
import { EmployerRegistrationsService } from './employer-registrations.service.js';
import { TaxCalendarService } from './tax-calendar.service.js';
import { TaxDeadlinesService } from './tax-deadlines.service.js';
import { TaxListsService } from './tax-lists.service.js';
import { TaxRemindersService } from './tax-reminders.service.js';
import { TaxReturnsController } from './tax-returns.controller.js';
import { TaxReturnsService } from './tax-returns.service.js';
import { TaxesAttentionService } from './taxes-attention.service.js';
import { TaxesController } from './taxes.controller.js';
import { TaxesGenerationService } from './taxes-generation.service.js';
import { VatController } from './vat.controller.js';
import { VatPeriodsService } from './vat-periods.service.js';
import { VatStepsController } from './vat-steps.controller.js';
import { VatStepsService } from './vat-steps.service.js';

/**
 * Taxes: the VAT tracker (a row per client per quarter, with the steps of the office's own sheet and the deadline from the Dutch calendar), the yearly returns (income tax,
 * corporate income tax) with their extensions, the employer registrations, the rows made every night, and the reminders about the deadlines.
 */
@Module({
  imports: [CalendarModule, RemindersModule],
  controllers: [TaxesController, VatController, VatStepsController, TaxReturnsController, EmployerRegistrationsController],
  providers: [TaxListsService, TaxDeadlinesService, VatStepsService, VatPeriodsService, TaxReturnsService, EmployerRegistrationsService, TaxesGenerationService, TaxesAttentionService, TaxRemindersService, TaxCalendarService],
  exports: [VatPeriodsService, TaxReturnsService, VatStepsService, TaxDeadlinesService, TaxCalendarService, TaxesAttentionService],
})
export class TaxesModule {}
