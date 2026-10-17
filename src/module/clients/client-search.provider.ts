import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { fuzzyIds } from '../search/fuzzy.js';
import { SearchService } from '../search/search.service.js';
import type { SearchHit } from '../search/search.types.js';

/** The clients, by number, name, KvK number, VAT number, the people of the client and every field the client form marks "search". */
@Injectable()
export class ClientSearchProvider implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
  ) {}

  onModuleInit(): void {
    this.search.register({ key: 'clients', area: 'clients', order: 10, find: (query, limit) => this.find(query.terms, limit) });
  }

  private async find(terms: string[], limit: number): Promise<SearchHit[]> {
    const insensitive = 'insensitive' as const;
    const select = { id: true, number: true, name: true, isActive: true, data: true } as const;
    const found = await this.prisma.client.findMany({
      where: {
        AND: terms.map(term => ({
          OR: [{ searchText: { contains: term } }, { number: { contains: term, mode: insensitive } }, { name: { contains: term, mode: insensitive } }, { kvk: { contains: term } }, { vatNumber: { contains: term, mode: insensitive } }],
        })),
      },
      orderBy: [{ isActive: 'desc' }, { number: 'asc' }],
      take: limit,
      select,
    });
    // Nothing (or not enough) found by the exact words: look for names that are spelled a little differently.
    const similar = found.length < limit ? await fuzzyIds(this.prisma, 'Client', terms.join(' '), limit) : [];
    const more = similar.filter(id => !found.some(row => row.id === id)).slice(0, limit - found.length);
    const extra = more.length ? await this.prisma.client.findMany({ where: { id: { in: more } }, select }) : [];
    const rows = [...found, ...more.map(id => extra.find(row => row.id === id)).filter((row): row is (typeof found)[number] => Boolean(row))];
    return rows.map(row => {
      const city = (row.data as Record<string, unknown>).city;
      return { id: row.id, title: `${row.number} – ${row.name}`, subtitle: [typeof city === 'string' ? city : '', row.isActive ? '' : '✕'].filter(Boolean).join(' · '), href: `/clients/${row.id}` };
    });
  }
}
