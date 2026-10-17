import type { WorkKind } from '../employees/employee-record.js';
import { roundDiv } from '../hours/hours-time.js';
import { allocate, type AllocEntry, type AllocLine, type Direction, type LineCoverage } from './allocation.js';

/*
 * Hours = salary = invoices. For one worker over a period this puts the three side by side and says what does not match and why:
 *   registered — the hour entries,
 *   paid       — the lines of the final salary statements (frozen when each statement was made),
 *   invoiced   — the hours the invoice lines cover (see allocation.ts), per direction.
 * What is *expected* depends on how the worker is used: an own employee is paid; one that is hired out to a hirer is paid and invoiced out; one that is
 * hired in through a staffing company is invoiced in and not paid by us. Any invoice line that exists for the worker is checked in any case (is it
 * backed by registered hours? does hours × rate give its amount?).
 * A pure function: the loader (ReconciliationService) hands in the rows, nothing here reads the database.
 */

export interface RecLine extends AllocLine {
  invoiceId: string;
  /** What the line says, in cents. */
  amountCents: number;
  /** The rate per hour on the line, in cents. */
  rateCents: number | null;
}

export interface RecStatementLine {
  date: string;
  minutes: number;
  amountCents: number;
  type: 'work' | 'surcharge';
}

export interface RecInput {
  kind: WorkKind;
  from: string;
  to: string;
  /** The worker's entries — at least those of the days any of the lines covers. */
  entries: readonly AllocEntry[];
  /** The invoice lines that count for this worker, in processing order. */
  lines: readonly RecLine[];
  statementLines: readonly RecStatementLine[];
}

export type CauseCode = 'not_paid' | 'paid_more' | 'not_invoiced' | 'over_invoiced' | 'line_math';

export interface Cause {
  code: CauseCode;
  direction?: Direction;
  minutes?: number;
  count?: number;
  /** The days it is about (at most a handful). */
  days?: string[];
}

export interface DayFigures {
  date: string;
  registered: number;
  paid: number;
  outgoing: number;
  incoming: number;
}

export interface Reconciliation {
  kind: WorkKind;
  from: string;
  to: string;
  registered: number;
  paid: number;
  paidCents: number;
  invoiced: Record<Direction, number>;
  expected: { paid: boolean; outgoing: boolean; incoming: boolean };
  causes: Cause[];
  /** `empty` — nothing registered, paid or invoiced in the period. */
  status: 'ok' | 'differences' | 'empty';
  days: DayFigures[];
  coverage: Map<string, LineCoverage>;
}

const MAX_DAYS = 8;

export function reconcile(input: RecInput): Reconciliation {
  const { from, to } = input;
  const inRange = (date: string) => date >= from && date <= to;
  const allocation = allocate(input.entries, input.lines);

  const days = new Map<string, DayFigures>();
  const figure = (date: string): DayFigures => {
    let row = days.get(date);
    if (!row) {
      row = { date, registered: 0, paid: 0, outgoing: 0, incoming: 0 };
      days.set(date, row);
    }
    return row;
  };
  const dateOf = new Map(input.entries.map(entry => [entry.id, entry.date]));

  for (const entry of input.entries) if (inRange(entry.date)) figure(entry.date).registered += entry.minutes;
  let paidCents = 0;
  for (const line of input.statementLines) {
    if (!inRange(line.date)) continue;
    paidCents += line.amountCents;
    if (line.type === 'work') figure(line.date).paid += line.minutes;
  }
  const invoiced: Record<Direction, number> = { incoming: 0, outgoing: 0 };
  const overlapping = input.lines.filter(line => line.from <= to && line.to >= from);
  const unbacked: Record<Direction, number> = { incoming: 0, outgoing: 0 };
  for (const line of overlapping) {
    const coverage = allocation.lines.get(line.id);
    if (!coverage) continue;
    unbacked[line.direction] += coverage.unbacked;
    for (const part of coverage.parts) {
      const date = dateOf.get(part.entryId) ?? part.date;
      if (!inRange(date)) continue;
      invoiced[line.direction] += part.minutes;
      figure(date)[line.direction] += part.minutes;
    }
  }
  // Lines that were not in `overlapping` cannot cover a day of the period, so the totals above are complete.

  const registered = [...days.values()].reduce((sum, row) => sum + row.registered, 0);
  const paid = [...days.values()].reduce((sum, row) => sum + row.paid, 0);
  // The kind decides what must be complete: every hour of an own employee is paid, every hour of a hired-out one is also invoiced out, every hour of a
  // hired-in worker is invoiced in. A line that exists is checked in any case (over_invoiced, line_math) — a worker may be hired out for part of the month only.
  const expected = { paid: input.kind !== 'hired_in', outgoing: input.kind === 'hired_out', incoming: input.kind === 'hired_in' };

  const sortedDays = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const dayList = (predicate: (row: DayFigures) => boolean) => sortedDays.filter(predicate).map(row => row.date).slice(0, MAX_DAYS);
  const causes: Cause[] = [];

  if (expected.paid) {
    if (registered > paid) causes.push({ code: 'not_paid', minutes: registered - paid, days: dayList(row => row.registered > row.paid) });
    else if (paid > registered) causes.push({ code: 'paid_more', minutes: paid - registered, days: dayList(row => row.paid > row.registered) });
  }
  for (const direction of ['outgoing', 'incoming'] as const) {
    if (expected[direction] && registered > invoiced[direction]) {
      causes.push({ code: 'not_invoiced', direction, minutes: registered - invoiced[direction], days: dayList(row => row.registered > row[direction]) });
    }
    if (unbacked[direction] > 0) causes.push({ code: 'over_invoiced', direction, minutes: unbacked[direction] });
  }
  const wrongMath = overlapping.filter(line => line.rateCents !== null && line.amountCents !== roundDiv(line.minutes * line.rateCents, 60));
  if (wrongMath.length) causes.push({ code: 'line_math', count: wrongMath.length });

  const nothing = registered === 0 && paid === 0 && invoiced.incoming === 0 && invoiced.outgoing === 0 && overlapping.length === 0;
  return {
    kind: input.kind,
    from,
    to,
    registered,
    paid,
    paidCents,
    invoiced,
    expected,
    causes,
    status: nothing ? 'empty' : causes.length ? 'differences' : 'ok',
    days: sortedDays,
    coverage: allocation.lines,
  };
}
