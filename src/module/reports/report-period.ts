import { addDays, addMonths, isValidDay, todayInAmsterdam } from '../../common/dates.js';
import type { Named } from './reports.types.js';

/** The ready-made periods of the report page. The ones that look ahead (`next_*`) are for dates that are still to come (contracts that end). */
export const PERIOD_KEYS = ['this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_year', 'last_year', 'next_30', 'next_60', 'next_90', 'next_180', 'next_365', 'all', 'custom'] as const;
export type PeriodKey = (typeof PERIOD_KEYS)[number];

export const PERIOD_NAMES: Record<PeriodKey, Named> = {
  this_month: { nl: 'Deze maand', en: 'This month' },
  last_month: { nl: 'Vorige maand', en: 'Last month' },
  this_quarter: { nl: 'Dit kwartaal', en: 'This quarter' },
  last_quarter: { nl: 'Vorig kwartaal', en: 'Last quarter' },
  this_year: { nl: 'Dit jaar', en: 'This year' },
  last_year: { nl: 'Vorig jaar', en: 'Last year' },
  next_30: { nl: 'Komende 30 dagen', en: 'Next 30 days' },
  next_60: { nl: 'Komende 60 dagen', en: 'Next 60 days' },
  next_90: { nl: 'Komende 90 dagen', en: 'Next 90 days' },
  next_180: { nl: 'Komende 6 maanden', en: 'Next 6 months' },
  next_365: { nl: 'Komende 12 maanden', en: 'Next 12 months' },
  all: { nl: 'Alle perioden', en: 'All time' },
  custom: { nl: 'Zelf kiezen…', en: 'Choose dates…' },
};

const pad = (value: number): string => String(value).padStart(2, '0');
const lastOfMonth = (year: number, month: number): string => `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;

/** The days a period covers (`null` = no limit). Relative periods move with the calendar: "last month" is always the month before today. */
export function resolvePeriod(key: string | undefined, custom: { from?: string; to?: string }, today = todayInAmsterdam()): { from: string; to: string } | null {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const quarterStart = Math.floor((month - 1) / 3) * 3 + 1;
  switch (key) {
    case 'this_month':
      return { from: `${year}-${pad(month)}-01`, to: lastOfMonth(year, month) };
    case 'last_month': {
      const before = addMonths(`${year}-${pad(month)}-01`, -1);
      return { from: `${before.slice(0, 7)}-01`, to: lastOfMonth(Number(before.slice(0, 4)), Number(before.slice(5, 7))) };
    }
    case 'this_quarter':
      return { from: `${year}-${pad(quarterStart)}-01`, to: lastOfMonth(year, quarterStart + 2) };
    case 'last_quarter': {
      const before = addMonths(`${year}-${pad(quarterStart)}-01`, -3);
      const start = Number(before.slice(5, 7));
      return { from: `${before.slice(0, 7)}-01`, to: lastOfMonth(Number(before.slice(0, 4)), start + 2) };
    }
    case 'this_year':
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    case 'last_year':
      return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
    case 'next_30':
    case 'next_60':
    case 'next_90':
    case 'next_180':
    case 'next_365':
      return { from: today, to: addDays(today, Number(key.slice(5))) };
    case 'custom': {
      const from = isValidDay(custom.from) ? custom.from : undefined;
      const to = isValidDay(custom.to) ? custom.to : undefined;
      if (!from && !to) return null;
      return { from: from ?? '1990-01-01', to: to ?? '2200-12-31' };
    }
    default:
      return null;
  }
}

/** "01-10-2026 – 31-10-2026" for a subtitle. */
export const periodText = (period: { from: string; to: string } | null, locale: 'nl' | 'en'): string => {
  if (!period) return locale === 'nl' ? 'alle perioden' : 'all time';
  const dutch = (day: string) => day.split('-').reverse().join('-');
  return `${period.from === '1990-01-01' ? '…' : dutch(period.from)} – ${period.to === '2200-12-31' ? '…' : dutch(period.to)}`;
};
