import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module.js';
import { FormsModule } from '../forms/forms.module.js';
import { HoursModule } from '../hours/hours.module.js';
import { ReconciliationModule } from '../reconciliation/reconciliation.module.js';
import { RemindersModule } from '../reminders/reminders.module.js';
import { SearchModule } from '../search/search.module.js';
import { InvoiceRemindersService } from './invoice-reminders.service.js';
import { InvoiceSearchProvider } from './invoice-search.provider.js';
import { TemplatesModule } from '../templates/templates.module.js';
import { InvoiceDocumentsService } from './invoice-documents.service.js';
import { InvoiceNumberingService } from './invoice-numbering.service.js';
import { InvoicesController } from './invoices.controller.js';
import { InvoicesService } from './invoices.service.js';
import { MarkupReportService } from './markup-report.service.js';

/** Invoices about hours (incoming from staffing companies, outgoing to the companies that used the workers) and the markup report. */
@Module({
  imports: [FormsModule, FilesModule, HoursModule, ReconciliationModule, RemindersModule, TemplatesModule, SearchModule],
  controllers: [InvoicesController],
  providers: [InvoicesService, InvoiceDocumentsService, InvoiceNumberingService, InvoiceRemindersService, MarkupReportService, InvoiceSearchProvider],
  exports: [InvoicesService, MarkupReportService],
})
export class InvoicesModule {}
