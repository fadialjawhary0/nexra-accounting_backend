import { UnprocessableEntityException } from '@nestjs/common';

/**
 * A 422 the frontend maps onto the fields of a form: `fields` are message keys per field (`validation.required`), `details.conflicts`
 * names the record that already holds a value that has to be unique.
 */
export const validationFailed = (fields: Record<string, string>, details?: Record<string, unknown>) =>
  new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields, ...(details && { details }) });

/** The `details` of a 422 about values that are already taken. */
export const conflictDetails = (conflicts: Record<string, { id: string; label: string }>): Record<string, unknown> | undefined =>
  Object.keys(conflicts).length ? { conflicts } : undefined;
