import type { ValidationError } from 'class-validator';

/*
 * Field errors are sent as translation keys the frontend already knows (`validation.required`, or
 * `validation.min|{"min":3}` with parameters) so the screen shows them in Dutch or English. A constraint without a key
 * keeps class-validator's own (English) message.
 */
const KEYS: Record<string, string> = {
  isNotEmpty: 'validation.required',
  isDefined: 'validation.required',
  isString: 'validation.required',
  isEmail: 'validation.invalidEmail',
  isUrl: 'validation.invalidUrl',
  isDateString: 'validation.invalidDate',
  isISO8601: 'validation.invalidDate',
  isNumber: 'validation.enterNumber',
  isNumberString: 'validation.enterNumber',
  isInt: 'validation.wholeNumber',
  isIn: 'validation.selectOption',
  isEnum: 'validation.selectOption',
  isUUID: 'validation.selectOption',
  isPhoneNumber: 'validation.invalidPhone',
  matches: 'validation.invalid',
};

const WITH_PARAMETER: Record<string, { key: string; parameter: string }> = {
  min: { key: 'validation.min', parameter: 'min' },
  max: { key: 'validation.max', parameter: 'max' },
  minLength: { key: 'validation.minLength', parameter: 'min' },
  maxLength: { key: 'validation.maxLength', parameter: 'max' },
};

function messageFor(constraint: string, defaultMessage: string): string {
  const withParameter = WITH_PARAMETER[constraint];
  if (withParameter) {
    const value = defaultMessage.match(/-?\d+(?:\.\d+)?/)?.[0];
    return value === undefined ? withParameter.key : `${withParameter.key}|${JSON.stringify({ [withParameter.parameter]: Number(value) })}`;
  }
  return KEYS[constraint] ?? defaultMessage;
}

/** `ValidationError[]` (nested objects and arrays included) → `{ 'address.city': 'validation.required' }`. */
export function flattenValidationErrors(errors: ValidationError[], prefix = ''): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const error of errors) {
    const path = prefix ? `${prefix}.${error.property}` : error.property;
    if (error.constraints) {
      const [constraint, message] = Object.entries(error.constraints)[0]!;
      fields[path] = messageFor(constraint, message);
    }
    if (error.children?.length) Object.assign(fields, flattenValidationErrors(error.children, path));
  }
  return fields;
}
