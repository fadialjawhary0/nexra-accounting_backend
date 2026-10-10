import { UnprocessableEntityException, ValidationPipe } from '@nestjs/common';
import { flattenValidationErrors } from '../validation/validation-messages.js';

/**
 * The global ValidationPipe: strips unknown properties, converts types, and answers 422
 * `{ code: 'validation_failed', message, fields: { 'path.to.field': 'validation.required' } }`.
 */
export const createValidationPipe = () =>
  new ValidationPipe({
    whitelist: true,
    transform: true,
    exceptionFactory: errors =>
      new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: flattenValidationErrors(errors) }),
  });
