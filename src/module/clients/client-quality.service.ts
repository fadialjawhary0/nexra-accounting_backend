import { Injectable } from '@nestjs/common';
import { paged, type ApiResult } from '../../common/api-result.js';
import { pageMeta } from '../../common/pagination.js';
import { fold } from '../../common/text.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { visibleFields } from '../forms/form-values.js';
import { isEmptyValue } from '../forms/form-doc.js';
import { FormsService } from '../forms/forms.service.js';
import { CLIENT_COLUMNS, CLIENT_ENTITY, columnValues } from './client-record.js';
import type { DataQualityQuery } from './dto/client.dto.js';

/** The marker for "no owner / director / partner is linked although the legal form needs one" next to the form's own field keys. */
export const MISSING_PEOPLE = 'people';

interface QualityRow {
  id: string;
  number: string;
  name: string;
  isActive: boolean;
  /** Keys of the form fields that are empty although the form says a complete client has them — plus `people`. */
  missing: string[];
}

/**
 * The data-quality view: which clients still lack details. What counts as "complete" is the form's business — every field with the
 * "complete" switch (Settings → Forms) must be filled when its rules show it — plus the people a legal form needs (an eenmanszaak has
 * an owner, a B.V. a director …, from the `person_role` list).
 */
@Injectable()
export class ClientQualityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly forms: FormsService,
  ) {}

  /** The clients with something missing (one row each), how many clients were looked at, and how often each field is missing. */
  private async scan(statuses: Array<'active' | 'stopped'>) {
    const { doc } = await this.forms.live(CLIENT_ENTITY);
    const expected = doc.fields.filter(field => field.active && field.flags.complete);
    const roleItems = await this.prisma.listItem.findMany({ where: { isActive: true, list: { key: 'person_role' } }, select: { code: true, meta: true } });
    const rolesFor = (legalForm: string | null): string[] =>
      legalForm
        ? roleItems.filter(item => String((item.meta as Record<string, unknown>).legalForms ?? '').split(',').includes(legalForm)).map(item => item.code)
        : [];

    const [clients, links] = await Promise.all([
      this.prisma.client.findMany({
        where: statuses.length === 1 ? { isActive: statuses[0] === 'active' } : {},
        select: { id: true, number: true, name: true, isActive: true, legalForm: true, kvk: true, vatNumber: true, responsibleUserId: true, data: true },
      }),
      this.prisma.clientPerson.findMany({ where: { endedOn: null }, select: { clientId: true, role: true } }),
    ]);
    const rolesOf = new Map<string, Set<string>>();
    for (const link of links) rolesOf.set(link.clientId, (rolesOf.get(link.clientId) ?? new Set()).add(link.role));

    const rows: QualityRow[] = [];
    const counts = new Map<string, number>();
    for (const client of clients) {
      // Emptiness is checked on the stored value (an encrypted one is a non-empty string): nothing needs decrypting here.
      const values = { ...((client.data ?? {}) as Record<string, unknown>), ...columnValues(CLIENT_COLUMNS, client) };
      const shown = new Set(visibleFields(doc, values).map(field => field.key));
      const missing = expected.filter(field => shown.has(field.key) && isEmptyValue(values[field.key])).map(field => field.key);

      const needed = rolesFor(client.legalForm);
      if (needed.length && !needed.some(role => rolesOf.get(client.id)?.has(role))) missing.push(MISSING_PEOPLE);

      if (!missing.length) continue;
      for (const key of missing) counts.set(key, (counts.get(key) ?? 0) + 1);
      rows.push({ id: client.id, number: client.number, name: client.name, isActive: client.isActive, missing });
    }
    return { rows, scanned: clients.length, counts };
  }

  async incompleteCount(): Promise<number> {
    return (await this.scan(['active'])).rows.length;
  }

  async report(query: DataQualityQuery): Promise<ApiResult> {
    const statuses = (query.status ?? 'active')
      .split(',')
      .map(status => status.trim())
      .filter((status): status is 'active' | 'stopped' => status === 'active' || status === 'stopped');
    const { rows, scanned, counts } = await this.scan(statuses.length ? statuses : ['active']);

    const needle = fold(query.search ?? '');
    const found = (needle ? rows.filter(row => fold(`${row.number} ${row.name}`).includes(needle)) : rows).sort(
      (a, b) => b.missing.length - a.missing.length || a.number.padStart(12, '0').localeCompare(b.number.padStart(12, '0')),
    );
    const start = (query.page - 1) * query.pageSize;
    return paged(
      found.slice(start, start + query.pageSize),
      pageMeta(found.length, query, {
        stats: { clients: scanned, incomplete: rows.length, complete: scanned - rows.length, missingTotal: [...counts.values()].reduce((sum, count) => sum + count, 0) },
        fields: [...counts].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
      }),
    );
  }
}
