import { OPERATORS, type Condition } from './form-doc.js';

const MAX_DEPTH = 4;
const MAX_MEMBERS = 10;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * A rule in the form builder's condition language (`{ field, op, value }`, `{ all: [...] }`, `{ any: [...] }`, `{ not: ... }`) as it may be saved: only fields in `known`,
 * only known operators, a value where the operator needs one. Returns the cleaned rule, or `null` when anything in it is not acceptable. Shared by the required documents
 * (Settings → Documents) and the lines of an inspection checklist (Settings → Inspections).
 */
export function checkCondition(input: unknown, known: ReadonlySet<string>, depth = 0): Condition | null {
  if (!isRecord(input) || depth > MAX_DEPTH) return null;
  for (const group of ['all', 'any'] as const) {
    const members = input[group];
    if (members === undefined) continue;
    if (!Array.isArray(members) || members.length === 0 || members.length > MAX_MEMBERS) return null;
    const checked = members.map(member => checkCondition(member, known, depth + 1));
    return checked.every(member => member !== null) ? ({ [group]: checked } as Condition) : null;
  }
  if (input.not !== undefined) {
    const inner = checkCondition(input.not, known, depth + 1);
    return inner ? { not: inner } : null;
  }
  const field = typeof input.field === 'string' ? input.field : '';
  const op = input.op as (typeof OPERATORS)[number];
  if (!known.has(field) || !OPERATORS.includes(op)) return null;
  if (op === 'filled' || op === 'empty') return { field, op };
  if (op === 'in' || op === 'nin') return Array.isArray(input.value) && input.value.length > 0 ? { field, op, value: input.value } : null;
  return input.value === undefined || input.value === null || input.value === '' ? null : { field, op, value: input.value };
}
