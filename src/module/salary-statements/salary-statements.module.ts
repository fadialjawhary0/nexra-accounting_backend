import { Module } from '@nestjs/common';
import { EmployeesModule } from '../employees/employees.module.js';
import { FilesModule } from '../files/files.module.js';
import { HoursModule } from '../hours/hours.module.js';
import { TemplatesModule } from '../templates/templates.module.js';
import { SalaryStatementsController } from './salary-statements.controller.js';
import { SalaryStatementsService } from './salary-statements.service.js';
import { StatementDocumentsService } from './statement-documents.service.js';

/** Salary statements (Loonstaten): what was paid to a worker for a period, frozen, with its Word and PDF filed in the worker's folder. */
@Module({
  imports: [HoursModule, FilesModule, TemplatesModule, EmployeesModule],
  controllers: [SalaryStatementsController],
  providers: [SalaryStatementsService, StatementDocumentsService],
  exports: [SalaryStatementsService],
})
export class SalaryStatementsModule {}
