import { addDays } from '../../common/dates.js';

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/;

/** The wall clock in the Netherlands right now, as a day and the minutes since midnight. */
export function amsterdamNow(now = new Date()): { day: string; time: string; stamp: number } {
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  const [day = '', time = '00:00'] = parts.split(' ');
  return { day, time, stamp: naiveStamp(day, time) };
}

/** A wall-clock moment as a number of milliseconds, comparable with others of the same kind (office time throughout, so no time zone arithmetic is needed). */
export const naiveStamp = (day: string, time: string | null | undefined): number => Date.parse(`${day}T${time && /^\d{2}:\d{2}$/.test(time) ? time : '00:00'}:00Z`);

/** `2026-10-06T09:30(:00)` → `{ day, time }`; null when it is not a timestamp. */
export function splitTimestamp(value: string): { day: string; time: string } | null {
  const match = TIMESTAMP.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) return null;
  return { day: match[1]!, time: `${match[2]}:${match[3]}` };
}

/** The last day an appointment occupies: a timed one that ends exactly at midnight stays on its start day. */
export function lastDayOf(startsOn: string, endsOn: string, allDay: boolean, endTime: string | null): string {
  let end = endsOn < startsOn ? startsOn : endsOn;
  if (!allDay && end > startsOn && endTime === '00:00') end = addDays(end, -1);
  return end < startsOn ? startsOn : end;
}
