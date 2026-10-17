import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module.js';
import { ReconciliationModule } from '../reconciliation/reconciliation.module.js';
import { InquiryController } from './inquiry.controller.js';
import { InquiryService } from './inquiry.service.js';

/** The worker inquiry: hours, salary and invoices of one worker and month side by side, with an export and a ZIP of the documents. */
@Module({
  imports: [FilesModule, ReconciliationModule],
  controllers: [InquiryController],
  providers: [InquiryService],
})
export class InquiryModule {}
