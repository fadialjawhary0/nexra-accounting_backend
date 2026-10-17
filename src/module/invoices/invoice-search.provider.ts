import { Injectable, type OnModuleInit } from '@nestjs/common';
import { formatDay } from '../../common/dates.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SearchService } from '../search/search.service.js';
import type { SearchHit } from '../search/search.types.js';

const dutch = (day: string): string => day.split('-').reverse().join('-');

/** The invoices (incoming and outgoing), by invoice number, the client and the company on the other side. */
@Injectable()
export class InvoiceSearchProvider implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
  ) {}

  onModuleInit(): void {
    this.search.register({ key: 'invoices', area: 'invoices', order: 40, find: (query, limit) => this.find(query.terms, limit) });
  }

  private async find(terms: string[], limit: number): Promise<SearchHit[]> {
    const insensitive = 'insensitive' as const;
    const rows = await this.prisma.invoice.findMany({
      where: {
        AND: terms.map(term => ({
          OR: [
            { searchText: { contains: term } },
            { number: { contains: term, mode: insensitive } },
            { client: { number: { contains: term, mode: insensitive } } },
            { client: { name: { contains: term, mode: insensitive } } },
            { counterparty: { name: { contains: term, mode: insensitive } } },
          ],
        })),
      },
      orderBy: [{ periodTo: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      select: { id: true, number: true, periodFrom: true, periodTo: true, client: { select: { number: true, name: true } } },
    });
    return rows.map(row => ({
      id: row.id,
      title: row.number || `${row.client.number} – ${row.client.name}`,
      subtitle: `${row.client.number} – ${row.client.name} · ${dutch(formatDay(row.periodFrom))} – ${dutch(formatDay(row.periodTo))}`,
      href: `/invoices/${row.id}`,
    }));
  }
}
