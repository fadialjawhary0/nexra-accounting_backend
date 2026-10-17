import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module.js';
import { EmployeesModule } from '../employees/employees.module.js';
import { FilesModule } from '../files/files.module.js';
import { FormsModule } from '../forms/forms.module.js';
import { ListsModule } from '../lists/lists.module.js';
import { RemindersModule } from '../reminders/reminders.module.js';
import { SearchModule } from '../search/search.module.js';
import { ContractSearchProvider } from './contract-search.provider.js';
import { TemplatesModule } from '../templates/templates.module.js';
import { ContractDocumentsService } from './contract-documents.service.js';
import { ContractRemindersService } from './contract-reminders.js';
import { ContractLifecycleService } from './contract-lifecycle.service.js';
import { ContractWarningsService } from './contract-warnings.service.js';
import { ContractsController } from './contracts.controller.js';
import { ContractsService } from './contracts.service.js';

/** Contracts (Contracten): the list across clients, the contract form, documents made from Word templates, signing, termination, renewal and the advice around them. */
@Module({
  imports: [FormsModule, ListsModule, FilesModule, CalendarModule, EmployeesModule, TemplatesModule, RemindersModule, SearchModule],
  controllers: [ContractsController],
  providers: [ContractsService, ContractWarningsService, ContractDocumentsService, ContractLifecycleService, ContractRemindersService, ContractSearchProvider],
  exports: [ContractsService, ContractDocumentsService, ContractLifecycleService],
})
export class ContractsModule {}
