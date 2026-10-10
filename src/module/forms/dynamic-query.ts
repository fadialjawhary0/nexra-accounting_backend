import { escapeLike, fold } from '../../common/text.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { FieldDef } from './form-doc.js';

/*
 * SQL building blocks for lists of records with admin-defined fields. Prisma cannot sort by a value inside a JSON column and its JSON
 * filters do not use an index, so a list builds its WHERE / ORDER BY here. Field keys are only ever sent as bound parameters
 * (`data ->> $1`), column names come from the module's own code (never from the request), so nothing typed by a person reaches the SQL text.
 */

export interface QueryContext {
  /** The table alias used in the query (`c`). */
  alias: string;
  /** Fields that live in a real column of the table instead of `data`: `field key → column name`. Written in code, never from a request. */
  columns: Readonly<Record<string, string>>;
  locale: 'nl' | 'en';
}

const dataRef = (context: QueryContext): Prisma.Sql => Prisma.raw(`${context.alias}."data"`);

/** The field's stored value as text (`NULL` when empty). */
export function valueExpr(context: QueryContext, key: string): Prisma.Sql {
  const column = context.columns[key];
  return column ? Prisma.raw(`${context.alias}."${column}"`) : Prisma.sql`${dataRef(context)} ->> ${key}`;
}

/** `a OR b OR c` in brackets. */
const anyOf = (parts: Prisma.Sql[]): Prisma.Sql => Prisma.sql`(${Prisma.join(parts, ' OR ')})`;

/** A WHERE condition for a field filter. `raw` is what the URL carries: `a,b` (any of), `from..to` for dates and numbers. Unsupported types answer `null`. */
export function fieldFilter(context: QueryContext, field: FieldDef, raw: string): Prisma.Sql | null {
  const parts = raw
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .slice(0, 50);
  if (!parts.length) return null;
  const expr = valueExpr(context, field.key);

  switch (field.type) {
    case 'select':
    case 'user':
      return Prisma.sql`${expr} IN (${Prisma.join(parts)})`;
    case 'multiselect':
      return Prisma.sql`jsonb_exists_any(${dataRef(context)} -> ${field.key}, ARRAY[${Prisma.join(parts)}]::text[])`;
    case 'boolean': {
      const yes = parts.includes('true');
      const no = parts.includes('false');
      if (yes === no) return null;
      return yes ? Prisma.sql`${expr} = 'true'` : Prisma.sql`${expr} IS DISTINCT FROM 'true'`;
    }
    case 'date': {
      const [from = '', to = ''] = raw.split('..');
      const conditions = [from && Prisma.sql`${expr} >= ${from.trim()}`, to && Prisma.sql`${expr} <= ${to.trim()}`].filter(Boolean) as Prisma.Sql[];
      return conditions.length ? Prisma.sql`(${Prisma.join(conditions, ' AND ')})` : null;
    }
    case 'number':
    case 'money': {
      const [from = '', to = ''] = raw.split('..');
      const conditions = [from, to].map((bound, index) => {
        const value = Number(bound);
        return bound.trim() !== '' && Number.isFinite(value) ? (index === 0 ? Prisma.sql`(${expr})::numeric >= ${value}` : Prisma.sql`(${expr})::numeric <= ${value}`) : null;
      });
      const used = conditions.filter(Boolean) as Prisma.Sql[];
      return used.length ? Prisma.sql`(${Prisma.join(used, ' AND ')})` : null;
    }
    case 'file':
      return null;
    default:
      return anyOf(parts.map(part => Prisma.sql`lower(unaccent(${expr})) LIKE ${`%${escapeLike(fold(part))}%`}`));
  }
}

/** Every word of a quick search must appear in the record's search text. */
export function searchCondition(context: QueryContext, search: string | undefined): Prisma.Sql | null {
  const words = fold(search ?? '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 6);
  if (!words.length) return null;
  const column = Prisma.raw(`${context.alias}."searchText"`);
  return Prisma.join(
    words.map(word => Prisma.sql`${column} LIKE ${`%${escapeLike(word)}%`}`),
    ' AND ',
  );
}

export interface OrderPlan {
  /** A JOIN the ORDER BY needs (empty when none). */
  join: Prisma.Sql;
  /** `<expression> ASC|DESC NULLS LAST` */
  order: Prisma.Sql;
}

const direction = (dir: 'asc' | 'desc'): Prisma.Sql => Prisma.raw(dir === 'desc' ? 'DESC' : 'ASC');

/** How to sort by a field; `null` for types that have no sensible order (files, multi-choice). */
export function fieldOrder(context: QueryContext, field: FieldDef, dir: 'asc' | 'desc'): OrderPlan | null {
  const expr = valueExpr(context, field.key);
  const empty = Prisma.empty;
  switch (field.type) {
    case 'multiselect':
    case 'file':
      return null;
    case 'select': {
      if (!field.list) return { join: empty, order: Prisma.sql`lower(unaccent(${expr})) ${direction(dir)} NULLS LAST` };
      const name = Prisma.raw(`so."${context.locale === 'nl' ? 'nameNl' : 'nameEn'}"`);
      return {
        join: Prisma.sql`LEFT JOIN "ListItem" so ON so."code" = ${expr} AND so."listId" = (SELECT "id" FROM "List" WHERE "key" = ${field.list})`,
        order: Prisma.sql`lower(unaccent(${name})) ${direction(dir)} NULLS LAST`,
      };
    }
    case 'user':
      return { join: Prisma.sql`LEFT JOIN "User" su ON su."id" = ${expr}`, order: Prisma.sql`lower(unaccent(su."name")) ${direction(dir)} NULLS LAST` };
    case 'number':
    case 'money':
      return { join: empty, order: Prisma.sql`(${expr})::numeric ${direction(dir)} NULLS LAST` };
    case 'boolean':
    case 'date':
      return { join: empty, order: Prisma.sql`${expr} ${direction(dir)} NULLS LAST` };
    default:
      return { join: empty, order: Prisma.sql`lower(unaccent(${expr})) ${direction(dir)} NULLS LAST` };
  }
}

/** `sort=name:desc` → `{ key, dir }` (only the first key; lists sort by one column). */
export function parseSort(sort: string | undefined): { key: string; dir: 'asc' | 'desc' } | null {
  const first = (sort ?? '').split(',')[0]?.trim();
  if (!first) return null;
  const [key = '', dir] = first.split(':');
  return key ? { key, dir: dir === 'desc' ? 'desc' : 'asc' } : null;
}

/** Reads `f.<field key>=value` pairs from a raw query object (the DTO's whitelist would strip them). */
export function readFieldFilters(query: Record<string, unknown>): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const [name, value] of Object.entries(query)) {
    if (!name.startsWith('f.')) continue;
    const text = Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : '';
    if (text) filters[name.slice(2)] = text.slice(0, 500);
  }
  return filters;
}
