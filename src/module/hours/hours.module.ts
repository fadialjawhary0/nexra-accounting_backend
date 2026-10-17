import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module.js';
import { EmployeesModule } from '../employees/employees.module.js';
import { FormsModule } from '../forms/forms.module.js';
import { ReconciliationModule } from '../reconciliation/reconciliation.module.js';
import { HoursController } from './hours.controller.js';
import { HoursPayService } from './hours-pay.service.js';
import { HoursService } from './hours.service.js';
import { PeriodLocksService } from './period-locks.service.js';
import { SurchargeRulesService } from './surcharge-rules.service.js';

/** Hours (Uren): the week grid, the details of a day, closed periods, surcharge rules and what the hours are worth. */
@Module({
  imports: [FormsModule, CalendarModule, EmployeesModule, ReconciliationModule],
  controllers: [HoursController],
  providers: [HoursService, HoursPayService, PeriodLocksService, SurchargeRulesService],
  exports: [HoursService, HoursPayService, PeriodLocksService, SurchargeRulesService],
})
export class HoursModule {}
