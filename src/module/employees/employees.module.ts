import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module.js';
import { FormsModule } from '../forms/forms.module.js';
import { ListsModule } from '../lists/lists.module.js';
import { PeopleModule } from '../people/people.module.js';
import { EmployeeFoldersService } from './employee-folders.service.js';
import { EmployeeRatesService } from './employee-rates.service.js';
import { EmployeesController } from './employees.controller.js';
import { EmployeesService } from './employees.service.js';

/** Workers (Werknemers): the grid across clients, the worker form together with the person's details, the hourly-rate history, the worker's folder and export. */
@Module({
  imports: [FormsModule, ListsModule, FilesModule, PeopleModule],
  controllers: [EmployeesController],
  providers: [EmployeesService, EmployeeRatesService, EmployeeFoldersService],
  exports: [EmployeesService, EmployeeRatesService],
})
export class EmployeesModule {}
