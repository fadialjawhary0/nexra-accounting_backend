/**
 * What a controller returns when the response needs `meta` next to `data`. Anything else it returns is wrapped as
 * `{ data: <value> }` by the ResponseEnvelopeInterceptor. (An explicit class, so a record that happens to have a `data`
 * field — the admin-defined dynamic fields — is never mistaken for an envelope.)
 */
export class ApiResult<T = unknown, M extends object = Record<string, unknown>> {
  constructor(
    readonly data: T,
    readonly meta?: M,
  ) {}
}

export interface PageMeta {
  total: number;
  page: number;
  pageSize: number;
  [key: string]: unknown;
}

/** `{ data: rows, meta: { total, page, pageSize, …extra } }` — the shape every list endpoint answers with. */
export const paged = <T>(rows: T[], meta: PageMeta) => new ApiResult(rows, meta);

/** `{ data, meta }` for anything else that carries metadata (counts next to a record, …). */
export const withMeta = <T, M extends object>(data: T, meta: M) => new ApiResult(data, meta);
