import { Module } from '@nestjs/common';
import { DocumentSettingsModule } from '../document-settings/document-settings.module.js';
import { FilesModule } from '../files/files.module.js';
import { FormsModule } from '../forms/forms.module.js';
import { ListsModule } from '../lists/lists.module.js';
import { PeopleModule } from '../people/people.module.js';
import { SearchModule } from '../search/search.module.js';
import { EmployeeSearchProvider } from './employee-search.provider.js';
import { EmployeeFoldersService } from './employee-folders.service.js';
import { EmployeeRatesService } from './employee-rates.service.js';
import { EmployeesController } from './employees.controller.js';
import { EmployeesService } from './employees.service.js';

/** Workers (Werknemers): the grid across clients, the worker form together with the person's details, the hourly-rate history, the worker's folder and export. */
@Module({
  imports: [FormsModule, ListsModule, FilesModule, PeopleModule, DocumentSettingsModule, SearchModule],
  controllers: [EmployeesController],
  providers: [EmployeesService, EmployeeRatesService, EmployeeFoldersService, EmployeeSearchProvider],
  exports: [EmployeesService, EmployeeRatesService, EmployeeFoldersService],
})
export class EmployeesModule {}
