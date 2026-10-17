/*
 * Which registered hours an invoice line covers. A line says "worker W, from – to, so many hours"; it covers W's hour entries between those days, day by
 * day from the first, until its hours are used up. Two lines of the same direction never cover the same minute of an entry (an hour cannot be billed
 * twice), and an hour that is on an incoming and on an outgoing invoice is fine: the two directions are separate pools.
 *
 * It is a pure function of its input, worked out whenever it is needed (never stored): change the hours, a line or the order, and the answer follows —
 * there is no link that can go stale. Lines must be handed over in processing order (earlier invoices first), which is what makes it deterministic.
 */

export type Direction = 'incoming' | 'outgoing';

export interface AllocEntry {
  id: string;
  /** `YYYY-MM-DD` */
  date: string;
  minutes: number;
  /** The employer client of that day. */
  clientId: string;
  /** Orders entries of the same day (the creation time in milliseconds). */
  order: number;
}

export interface AllocLine {
  id: string;
  direction: Direction;
  /** The client the invoice belongs to: an outgoing line only covers hours of that client's own workers. */
  clientId: string;
  from: string;
  to: string;
  /** Billed minutes. */
  minutes: number;
}

export interface CoveredPart {
  entryId: string;
  date: string;
  minutes: number;
}

export interface LineCoverage {
  lineId: string;
  billed: number;
  /** Billed minutes that are backed by registered hours. */
  covered: number;
  /** Billed minutes with no registered hour behind them. */
  unbacked: number;
  parts: CoveredPart[];
}

export interface Allocation {
  lines: Map<string, LineCoverage>;
  /** Registered minutes no line of that direction covers, per entry. */
  free: Record<Direction, Map<string, number>>;
}

const byDate = (a: AllocEntry, b: AllocEntry): number => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order || (a.id < b.id ? -1 : 1));

export function allocate(entries: readonly AllocEntry[], lines: readonly AllocLine[]): Allocation {
  const sorted = [...entries].sort(byDate);
  const free: Record<Direction, Map<string, number>> = {
    incoming: new Map(sorted.map(entry => [entry.id, entry.minutes])),
    outgoing: new Map(sorted.map(entry => [entry.id, entry.minutes])),
  };
  const result = new Map<string, LineCoverage>();
  for (const line of lines) {
    const pool = free[line.direction];
    let need = Math.max(0, line.minutes);
    const parts: CoveredPart[] = [];
    for (const entry of sorted) {
      if (need === 0) break;
      if (entry.date < line.from || entry.date > line.to) continue;
      if (line.direction === 'outgoing' && entry.clientId !== line.clientId) continue;
      const room = pool.get(entry.id) ?? 0;
      const take = Math.min(room, need);
      if (take <= 0) continue;
      pool.set(entry.id, room - take);
      need -= take;
      parts.push({ entryId: entry.id, date: entry.date, minutes: take });
    }
    const billed = Math.max(0, line.minutes);
    result.set(line.id, { lineId: line.id, billed, covered: billed - need, unbacked: need, parts });
  }
  return { lines: result, free };
}
