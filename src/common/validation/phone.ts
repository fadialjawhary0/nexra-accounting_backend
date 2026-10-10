/** A phone number as people type it: digits, spaces, `+`, `-`, `.` and brackets (6–24 characters). Empty is fine (optional field). */
const PHONE_PATTERN = /^[+()\d\s.-]{6,24}$/;

export const isValidPhone = (value: string): boolean => value === '' || PHONE_PATTERN.test(value);
