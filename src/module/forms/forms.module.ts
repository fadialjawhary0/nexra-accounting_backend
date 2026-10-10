import { Module } from '@nestjs/common';
import { FormRecordsService } from './form-records.service.js';
import { FormValidationService } from './form-validation.service.js';
import { FormsController } from './forms.controller.js';
import { FormsService } from './forms.service.js';

/** The form definitions and what depends on them. Modules with records that have admin-defined fields import this and call FormValidationService (validation) and FormRecordsService (encryption, unique values, search text). */
@Module({
  controllers: [FormsController],
  providers: [FormsService, FormValidationService, FormRecordsService],
  exports: [FormsService, FormValidationService, FormRecordsService],
})
export class FormsModule {}
