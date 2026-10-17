import { Module } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module.js';
import { ContractsModule } from '../contracts/contracts.module.js';
import { DocumentsFeatureModule } from '../documents/documents.module.js';
import { EmployeesModule } from '../employees/employees.module.js';
import { HoursModule } from '../hours/hours.module.js';
import { InspectionsModule } from '../inspections/inspections.module.js';
import { InvoicesModule } from '../invoices/invoices.module.js';
import { OfficialFormsModule } from '../official-forms/official-forms.module.js';
import { ReconciliationModule } from '../reconciliation/reconciliation.module.js';
import { SalaryStatementsModule } from '../salary-statements/salary-statements.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { TaxesModule } from '../taxes/taxes.module.js';
import { ReportsCatalogService } from './reports-catalog.service.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

/** The reports centre (Rapporten): every list and overview in one place, with a period, filters, and Excel / PDF / Word files — and saved export presets. */
@Module({
  imports: [ClientsModule, ContractsModule, DocumentsFeatureModule, EmployeesModule, HoursModule, InspectionsModule, InvoicesModule, OfficialFormsModule, ReconciliationModule, SalaryStatementsModule, TasksModule, TaxesModule],
  controllers: [ReportsController],
  providers: [ReportsCatalogService, ReportsService],
})
export class ReportsModule {}
