import type { ListQueryDto } from './dto/list-query.dto.js';
import type { PageMeta } from './api-result.js';

type Direction = 'asc' | 'desc';

/** Prisma `skip` / `take` for a list query. */
export const toSkipTake = (query: Pick<ListQueryDto, 'page' | 'pageSize'>) => ({ skip: (query.page - 1) * query.pageSize, take: query.pageSize });

/** `meta` of a list response — pass `extra` for `counts` and the like. */
export const pageMeta = (total: number, query: Pick<ListQueryDto, 'page' | 'pageSize'>, extra: Record<string, unknown> = {}): PageMeta => ({
  total,
  page: query.page,
  pageSize: query.pageSize,
  ...extra,
});

const nest = (path: string, direction: Direction): Record<string, unknown> =>
  path
    .split('.')
    .reverse()
    .reduce<Direction | Record<string, unknown>>((inner, key) => ({ [key]: inner }), direction) as Record<string, unknown>;

/**
 * `"name:asc,company.name:desc"` → Prisma `orderBy` — only fields the feature lists in `allowed`
 * (so nobody sorts by a column that is not indexed or not meant to be exposed).
 */
export function toOrderBy(sort: string | undefined, allowed: readonly string[], fallback: Record<string, unknown>[]): Record<string, unknown>[] {
  const order = (sort ?? '')
    .split(',')
    .map(part => part.split(':') as [string, Direction?])
    .filter(([field]) => allowed.includes(field))
    .map(([field, direction]) => nest(field, direction === 'desc' ? 'desc' : 'asc'));
  return order.length ? order : fallback;
}
