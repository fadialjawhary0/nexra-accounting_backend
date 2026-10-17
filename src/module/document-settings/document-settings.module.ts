import { Module } from '@nestjs/common';
import { FormsModule } from '../forms/forms.module.js';
import { DocumentTypesController } from './document-types.controller.js';
import { DocumentTypesService } from './document-types.service.js';
import { FolderTemplatesController } from './folder-templates.controller.js';
import { FolderTemplatesService } from './folder-templates.service.js';
import { RequiredDocumentsController } from './required-documents.controller.js';
import { RequiredDocumentsService } from './required-documents.service.js';

/**
 * How the office wants its documents kept (Settings → Documents): the types of document and their rules, the standard folders of a client and the
 * documents a client or worker must have. Plain configuration, read by the upload, the import, the reminders and the check for what is missing.
 */
@Module({
  imports: [FormsModule],
  controllers: [DocumentTypesController, FolderTemplatesController, RequiredDocumentsController],
  providers: [DocumentTypesService, FolderTemplatesService, RequiredDocumentsService],
  exports: [DocumentTypesService, FolderTemplatesService, RequiredDocumentsService],
})
export class DocumentSettingsModule {}
