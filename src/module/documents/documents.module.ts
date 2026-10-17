import { Module } from '@nestjs/common';
import { DocumentSettingsModule } from '../document-settings/document-settings.module.js';
import { EmployeesModule } from '../employees/employees.module.js';
import { FilesModule } from '../files/files.module.js';
import { RemindersModule } from '../reminders/reminders.module.js';
import { SearchModule } from '../search/search.module.js';
import { DocumentSearchProvider } from './document-search.provider.js';
import { DocumentIntakeService } from './document-intake.service.js';
import { DocumentPreviewService } from './document-preview.service.js';
import { DocumentRemindersService } from './document-reminders.service.js';
import { DocumentRequirementsService } from './document-requirements.service.js';
import { DocumentTextService } from './document-text.service.js';
import { DocumentVersionsService } from './document-versions.service.js';
import { DocumentViewService } from './document-view.service.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';

/**
 * The Documents page (Documenten): every document with its type, validity and versions, what is missing, adding documents, previews, the content search
 * and the reminders about documents that expire. (The settings — types, folders, required documents — are in `document-settings`.)
 */
@Module({
  imports: [DocumentSettingsModule, FilesModule, EmployeesModule, RemindersModule, SearchModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentViewService, DocumentIntakeService, DocumentVersionsService, DocumentRequirementsService, DocumentPreviewService, DocumentTextService, DocumentRemindersService, DocumentSearchProvider],
  exports: [DocumentsService, DocumentVersionsService, DocumentViewService, DocumentPreviewService, DocumentRequirementsService],
})
export class DocumentsFeatureModule {}
