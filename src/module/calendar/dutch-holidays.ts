import { addDays, formatDay } from '../../common/dates.js';

export interface GeneratedHoliday {
  /** Stable code, so a year is generated once and Ahmad's renames stick. */
  code: string;
  /** `YYYY-MM-DD` */
  date: string;
  nameNl: string;
  nameEn: string;
  /** Default for "staff are off and paid": Good Friday and Liberation Day usually depend on the CAO, so they start switched off. */
  paid: boolean;
}

/** Easter Sunday of a year (Gregorian calendar, the "anonymous" Meeus / Jones / Butcher algorithm). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return formatDay(new Date(Date.UTC(year, month - 1, day)));
}

/**
 * The Dutch public holidays of a year: fixed dates, the Easter-based ones, and King's Day (27 April, or 26 April when the 27th is a
 * Sunday; before 2014 it was Queen's Day on 30 April). Whether staff are off and paid is a separate, editable choice.
 */
export function dutchHolidays(year: number): GeneratedHoliday[] {
  const easter = easterSunday(year);
  const fixed = (month: number, day: number) => formatDay(new Date(Date.UTC(year, month - 1, day)));
  const kingsDay = (() => {
    if (year < 2014) return fixed(4, 30);
    const twentySeventh = new Date(Date.UTC(year, 3, 27));
    return twentySeventh.getUTCDay() === 0 ? fixed(4, 26) : fixed(4, 27);
  })();

  return [
    { code: 'new_year', date: fixed(1, 1), nameNl: 'Nieuwjaarsdag', nameEn: 'New Year’s Day', paid: true },
    { code: 'good_friday', date: addDays(easter, -2), nameNl: 'Goede Vrijdag', nameEn: 'Good Friday', paid: false },
    { code: 'easter_sunday', date: easter, nameNl: 'Eerste paasdag', nameEn: 'Easter Sunday', paid: true },
    { code: 'easter_monday', date: addDays(easter, 1), nameNl: 'Tweede paasdag', nameEn: 'Easter Monday', paid: true },
    { code: 'kings_day', date: kingsDay, nameNl: year < 2014 ? 'Koninginnedag' : 'Koningsdag', nameEn: year < 2014 ? 'Queen’s Day' : 'King’s Day', paid: true },
    { code: 'liberation_day', date: fixed(5, 5), nameNl: 'Bevrijdingsdag', nameEn: 'Liberation Day', paid: false },
    { code: 'ascension_day', date: addDays(easter, 39), nameNl: 'Hemelvaartsdag', nameEn: 'Ascension Day', paid: true },
    { code: 'whit_sunday', date: addDays(easter, 49), nameNl: 'Eerste pinksterdag', nameEn: 'Whit Sunday', paid: true },
    { code: 'whit_monday', date: addDays(easter, 50), nameNl: 'Tweede pinksterdag', nameEn: 'Whit Monday', paid: true },
    { code: 'christmas_day', date: fixed(12, 25), nameNl: 'Eerste kerstdag', nameEn: 'Christmas Day', paid: true },
    { code: 'boxing_day', date: fixed(12, 26), nameNl: 'Tweede kerstdag', nameEn: 'Boxing Day', paid: true },
  ];
}
