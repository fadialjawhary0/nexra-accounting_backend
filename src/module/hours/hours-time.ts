import { addDays, parseDay, weekdayOf } from '../../common/dates.js';

/*
 * Time and weeks for the hours module. Worked time is always whole minutes (never a fraction of an hour), clock times are `HH:MM` text,
 * and a week starts on Monday, the way the office counts. These are plain functions of their arguments.
 */

export const MINUTES_PER_DAY = 1440;

/** Index = `weekdayOf(day)` (0 = Sunday). */
export const WEEKDAY_CODES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type WeekdayCode = (typeof WEEKDAY_CODES)[number];

export const weekdayCode = (day: string): WeekdayCode => WEEKDAY_CODES[weekdayOf(day)]!;

/** The Monday of the week `day` is in. */
export const mondayOf = (day: string): string => addDays(day, -((weekdayOf(day) + 6) % 7));

/** The seven days of a week, Monday first. */
export const daysOfWeek = (monday: string): string[] => Array.from({ length: 7 }, (_, index) => addDays(monday, index));

/** `2026-10-05` → `2026-10`. */
export const monthOf = (day: string): string => day.slice(0, 7);

export const firstOfMonth = (month: string): string => `${month}-01`;

export const lastOfMonth = (month: string): string => {
  const date = parseDay(firstOfMonth(month));
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
};

export const isMonth = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

/** `08:30` → 510, `24:00` → 1440; anything else → `null`. */
export function parseClock(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^([0-1]?\d|2[0-4]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes <= MINUTES_PER_DAY ? minutes : null;
}

/** 510 → `08:30`. */
export const formatClock = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** The time between two clock times (the end may be after midnight: 22:00 → 06:00 is 8 hours). `null` when they are the same time. */
export function spanMinutes(start: number, end: number): number | null {
  if (start === end) return null;
  return end > start ? end - start : end + MINUTES_PER_DAY - start;
}

/**
 * Minutes of the stretch that begins at `start` and lasts `length` minutes that fall inside the window `from → to` (a window can run past
 * midnight: 22:00 → 06:00). The stretch may itself run past midnight.
 */
export function overlapMinutes(start: number, length: number, from: number, to: number): number {
  const end = start + length;
  const windowEnd = to <= from ? to + MINUTES_PER_DAY : to;
  let total = 0;
  for (const shift of [-MINUTES_PER_DAY, 0, MINUTES_PER_DAY]) {
    total += Math.max(0, Math.min(end, windowEnd + shift) - Math.max(start, from + shift));
  }
  return total;
}

/** Hours as the screens write them: 7,5 for 450 minutes — at most two decimals. Used in exports and documents (`1.234,5` is made by the caller's locale). */
export const minutesToHours = (minutes: number): number => Math.round((minutes / 60) * 100) / 100;

/** Integer division rounded half up — the one rounding rule for every amount in the app. */
export const roundDiv = (numerator: number, denominator: number): number => Math.floor((2 * numerator + denominator) / (2 * denominator));

export const toCents = (euros: number): number => Math.round(euros * 100);
export const fromCents = (cents: number): number => cents / 100;
