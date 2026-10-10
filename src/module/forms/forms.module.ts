import { Module } from '@nestjs/common';
import { FormValidationService } from './form-validation.service.js';
import { FormsController } from './forms.controller.js';
import { FormsService } from './forms.service.js';

/** The form definitions and what depends on them. Modules with records that have admin-defined fields import this and call FormValidationService. */
@Module({
  controllers: [FormsController],
  providers: [FormsService, FormValidationService],
  exports: [FormsService, FormValidationService],
})
export class FormsModule {}
