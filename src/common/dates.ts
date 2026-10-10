/**
 * Calendar days as `YYYY-MM-DD` strings (the format the API and the database date columns use). Working with the string, not a
 * `Date`, keeps a day the same day in every time zone — the office works in Europe/Amsterdam and never in "midnight UTC".
 */
const MS_PER_DAY = 86_400_000;

export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `2026-10-10` → a Date at 00:00 UTC of that day. */
export const parseDay = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

export const formatDay = (date: Date): string => date.toISOString().slice(0, 10);

export const isValidDay = (value: unknown): value is string => typeof value === 'string' && DAY_PATTERN.test(value) && formatDay(parseDay(value)) === value;

export const addDays = (day: string, days: number): string => formatDay(new Date(parseDay(day).getTime() + days * MS_PER_DAY));

/** 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (day: string): number => parseDay(day).getUTCDay();

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number => Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / MS_PER_DAY);

/** Today in the office's time zone. */
export const todayInAmsterdam = (): string => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
