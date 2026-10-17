import { asRecord } from '../../common/record-values.js';

/** One tick of the tracker: when, and by whom. */
export interface Tick {
  at: string;
  by: string | null;
}

/** What was ticked on a period (`{ [stepCode]: { at, by } }`), read safely from the stored JSON. */
export function readTicks(value: unknown): Record<string, Tick> {
  const ticks: Record<string, Tick> = {};
  for (const [code, raw] of Object.entries(asRecord(value))) {
    const entry = asRecord(raw);
    if (typeof entry.at === 'string') ticks[code] = { at: entry.at, by: typeof entry.by === 'string' ? entry.by : null };
  }
  return ticks;
}

/** A period is filed when every step that means "filed" is ticked (the day is the latest of those ticks); without such a step it is filed when it is complete. */
export function filedOf(ticks: Record<string, Tick>, filingCodes: readonly string[], complete: boolean): { filed: boolean; at: string | null } {
  if (!filingCodes.length) return { filed: complete, at: complete ? latest(Object.values(ticks)) : null };
  if (!filingCodes.every(code => ticks[code])) return { filed: false, at: null };
  return { filed: true, at: latest(filingCodes.map(code => ticks[code]!)) };
}

const latest = (ticks: Tick[]): string | null => (ticks.length ? ticks.map(tick => tick.at).sort().at(-1)! : null);
