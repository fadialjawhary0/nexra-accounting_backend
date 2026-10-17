import { Module } from '@nestjs/common';
import { AgendaModule } from '../agenda/agenda.module.js';
import { ClientsModule } from '../clients/clients.module.js';
import { ContractsModule } from '../contracts/contracts.module.js';
import { CounterpartiesModule } from '../counterparties/counterparties.module.js';
import { DocumentSettingsModule } from '../document-settings/document-settings.module.js';
import { DocumentsFeatureModule } from '../documents/documents.module.js';
import { EmployeesModule } from '../employees/employees.module.js';
import { FilesModule } from '../files/files.module.js';
import { FormsModule } from '../forms/forms.module.js';
import { HoursModule } from '../hours/hours.module.js';
import { InvoicesModule } from '../invoices/invoices.module.js';
import { ListsModule } from '../lists/lists.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PeopleModule } from '../people/people.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { DocumentAcceptService } from './document-accept.service.js';
import { DocumentEvaluatorService } from './document-evaluator.service.js';
import { DocumentFilingService } from './document-filing.service.js';
import { DocumentMatcherService } from './document-matcher.service.js';
import { DocumentPipelineService } from './document-pipeline.service.js';
import { DocumentUploadService } from './document-upload.service.js';
import { ImportActorService } from './import-actor.service.js';
import { ImportLookupsService } from './import-lookups.service.js';
import { ImportReportService } from './import-report.service.js';
import { ImportFilesInterceptor, ImportZipInterceptor } from './import-upload.interceptor.js';
import { ImportsController } from './imports.controller.js';
import { ImportsService } from './imports.service.js';
import { InboxActionsService } from './inbox-actions.service.js';
import { InboxReaderService } from './inbox-reader.service.js';
import { ItemActionsService } from './item-actions.service.js';
import { ItemDataService } from './item-data.service.js';
import { MappingsController } from './mappings.controller.js';
import { MappingsService } from './mappings.service.js';
import { SheetImportService } from './sheet-import.service.js';
import { SheetProcessorService } from './sheet-processor.service.js';
import { SheetRowsService } from './sheet-rows.service.js';

/**
 * Bulk import (Import): a spreadsheet of clients, workers or hours read by code with a column mapping, and a batch of files (one, many, a folder or
 * a ZIP) sorted by their folders and names and — when the AI is on — read by it, file by file on the background queue. The AI inbox of the dashboard
 * is an import too: a message in a person's own words (with or without files) becomes tasks, appointments, workers, clients to confirm. Everything
 * lands in a review list first; nothing becomes a record until a person accepts it.
 */
@Module({
  imports: [
    FormsModule,
    ListsModule,
    FilesModule,
    PeopleModule,
    EmployeesModule,
    ClientsModule,
    ContractsModule,
    InvoicesModule,
    CounterpartiesModule,
    HoursModule,
    NotificationsModule,
    DocumentSettingsModule,
    DocumentsFeatureModule,
    TasksModule,
    AgendaModule,
  ],
  // The saved mappings are declared first: `/imports/mappings` must not be taken for `/imports/:id`.
  controllers: [MappingsController, ImportsController],
  providers: [
    ImportsService,
    ItemDataService,
    ImportActorService,
    ImportLookupsService,
    MappingsService,
    DocumentUploadService,
    DocumentMatcherService,
    DocumentEvaluatorService,
    DocumentFilingService,
    DocumentPipelineService,
    DocumentAcceptService,
    InboxActionsService,
    InboxReaderService,
    ItemActionsService,
    SheetImportService,
    SheetRowsService,
    SheetProcessorService,
    ImportReportService,
    ImportFilesInterceptor,
    ImportZipInterceptor,
  ],
  exports: [ImportsService],
})
export class ImportsModule {}
