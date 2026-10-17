import { roundDiv } from '../hours/hours-time.js';

/*
 * What an invoice adds up to. Amounts are whole cents and every division rounds half up (the one rule of the app, `roundDiv`); credit notes carry negative
 * amounts and are rounded from their absolute value, so a credit note is always exactly the opposite of its invoice.
 */

/** What an hours line is worth: billed minutes × the rate per hour. */
export function hoursAmountCents(minutes: number, rateCents: number): number {
  return minutes < 0 ? -roundDiv(-minutes * rateCents, 60) : roundDiv(minutes * rateCents, 60);
}

/** `part` × `basisPoints` / 10 000 (21 % = 2100), rounded half up from the absolute value. */
export function percentOf(cents: number, basisPoints: number): number {
  return cents < 0 ? -roundDiv(-cents * basisPoints, 10_000) : roundDiv(cents * basisPoints, 10_000);
}

export interface TotalsInput {
  lines: ReadonlyArray<{ kind: string; minutes: number; amountCents: number }>;
  vatBasisPoints: number;
  vatShifted: boolean;
  gAccountBasisPoints: number;
  /** An amount for the G-account typed by hand; wins over the percentage. */
  gAccountCents?: number | null;
}

export interface Totals {
  minutes: number;
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
  gAccountCents: number;
}

export function invoiceTotals(input: TotalsInput): Totals {
  const subtotalCents = input.lines.reduce((sum, line) => sum + line.amountCents, 0);
  const vatCents = input.vatShifted ? 0 : percentOf(subtotalCents, input.vatBasisPoints);
  const totalCents = subtotalCents + vatCents;
  return {
    minutes: input.lines.filter(line => line.kind === 'hours').reduce((sum, line) => sum + line.minutes, 0),
    subtotalCents,
    vatCents,
    totalCents,
    gAccountCents: input.gAccountCents ?? percentOf(totalCents, input.gAccountBasisPoints),
  };
}
