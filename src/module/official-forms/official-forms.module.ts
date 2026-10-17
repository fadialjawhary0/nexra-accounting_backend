import { Module } from '@nestjs/common';
import { AddressBookModule } from '../address-book/address-book.module.js';
import { CalendarModule } from '../calendar/calendar.module.js';
import { DocumentSettingsModule } from '../document-settings/document-settings.module.js';
import { FilesModule } from '../files/files.module.js';
import { FormsModule } from '../forms/forms.module.js';
import { ImportLookupsService } from '../imports/import-lookups.service.js';
import { ListsModule } from '../lists/lists.module.js';
import { RemindersModule } from '../reminders/reminders.module.js';
import { SearchModule } from '../search/search.module.js';
import { OfficialFormSearchProvider } from './official-form-search.provider.js';
import { FormAiService } from './form-ai.service.js';
import { FormFillService } from './form-fill.service.js';
import { FormSourcesService } from './form-sources.service.js';
import { FormSubmissionsController } from './form-submissions.controller.js';
import { FormSubmissionsService } from './form-submissions.service.js';
import { OfficialFormRemindersService } from './official-form-reminders.service.js';
import { OfficialFormVersionsService } from './official-form-versions.service.js';
import { OfficialFormsController } from './official-forms.controller.js';
import { OfficialFormsService } from './official-forms.service.js';

/**
 * Official forms and post: the library of the tax office's PDF forms (Melding loonheffingen, Verzoek deblokkering G-rekening …) with a mapping from the records onto the
 * fields of each PDF, filling a form in for a client and filing it, the log of what was sent and what became of it, reading a photo or scan to fill gaps, and the
 * reminder that says "no answer yet". (The address book and the envelope labels are in `address-book`.)
 */
@Module({
  imports: [AddressBookModule, CalendarModule, DocumentSettingsModule, FilesModule, FormsModule, ListsModule, RemindersModule, SearchModule],
  controllers: [OfficialFormsController, FormSubmissionsController],
  providers: [OfficialFormsService, OfficialFormVersionsService, FormSourcesService, FormFillService, FormSubmissionsService, FormAiService, OfficialFormRemindersService, ImportLookupsService, OfficialFormSearchProvider],
  exports: [OfficialFormsService, FormSubmissionsService],
})
export class OfficialFormsModule {}
