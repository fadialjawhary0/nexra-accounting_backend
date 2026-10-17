import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module.js';
import { EmployeesModule } from '../employees/employees.module.js';
import { FilesModule } from '../files/files.module.js';
import { FormsModule } from '../forms/forms.module.js';
import { ListsModule } from '../lists/lists.module.js';
import { MergeFieldsService } from './merge-fields.service.js';
import { TemplatesController } from './templates.controller.js';
import { TemplatesService } from './templates.service.js';

/** Word templates with merge fields (Sjablonen): the list, versions, upload, preview and the data a template is filled with. */
@Module({
  imports: [FormsModule, ListsModule, FilesModule, CalendarModule, EmployeesModule],
  controllers: [TemplatesController],
  providers: [TemplatesService, MergeFieldsService],
  exports: [TemplatesService, MergeFieldsService],
})
export class TemplatesModule {}
