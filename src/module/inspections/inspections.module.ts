import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module.js';
import { DocumentSettingsModule } from '../document-settings/document-settings.module.js';
import { DocumentsFeatureModule } from '../documents/documents.module.js';
import { FilesModule } from '../files/files.module.js';
import { NumberingModule } from '../numbering/numbering.module.js';
import { RemindersModule } from '../reminders/reminders.module.js';
import { SearchModule } from '../search/search.module.js';
import { InspectionSearchProvider } from './inspection-search.provider.js';
import { ChecklistTemplatesController } from './checklist-templates.controller.js';
import { ChecklistTemplatesService } from './checklist-templates.service.js';
import { InspectionBundleService } from './inspection-bundle.service.js';
import { InspectionChecklistService } from './inspection-checklist.service.js';
import { InspectionContextService } from './inspection-context.service.js';
import { InspectionFoldersService } from './inspection-folders.service.js';
import { InspectionListsService } from './inspection-lists.service.js';
import { InspectionReadinessService } from './inspection-readiness.service.js';
import { InspectionRemindersService } from './inspection-reminders.service.js';
import { InspectionRequestAiService } from './inspection-request-ai.service.js';
import { InspectionSampleService } from './inspection-sample.service.js';
import { InspectionsController } from './inspections.controller.js';
import { InspectionsService } from './inspections.service.js';

/**
 * Inspections (Control): the checklists of what an inspector asks for (versioned, editable), planning an inspection of a client, what is ready for it worked out from the
 * documents, the sample of leavers, the dated folder, the bundle for the inspector (ZIP or one PDF with an index, with a check for citizen service numbers), the log of what was
 * handed over, the follow-up, the next inspection of the series, reading an inspector's request with the AI, and the reminders.
 */
@Module({
  imports: [CalendarModule, DocumentSettingsModule, DocumentsFeatureModule, FilesModule, NumberingModule, RemindersModule, SearchModule],
  controllers: [ChecklistTemplatesController, InspectionsController],
  providers: [
    InspectionSearchProvider,
    ChecklistTemplatesService,
    InspectionListsService,
    InspectionContextService,
    InspectionChecklistService,
    InspectionFoldersService,
    InspectionsService,
    InspectionReadinessService,
    InspectionSampleService,
    InspectionBundleService,
    InspectionRequestAiService,
    InspectionRemindersService,
  ],
  exports: [InspectionsService, InspectionReadinessService, ChecklistTemplatesService],
})
export class InspectionsModule {}
