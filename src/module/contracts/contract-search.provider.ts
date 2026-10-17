import { Injectable, type OnModuleInit } from '@nestjs/common';
import { formatDay } from '../../common/dates.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { personName } from '../people/person-record.js';
import { fuzzyIds } from '../search/fuzzy.js';
import { SearchService } from '../search/search.service.js';
import type { SearchHit } from '../search/search.types.js';

const dutch = (day: string): string => day.split('-').reverse().join('-');

/** The contracts, by worker, the number and name of the client and every field the contract form marks "search". */
@Injectable()
export class ContractSearchProvider implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
  ) {}

  onModuleInit(): void {
    this.search.register({ key: 'contracts', area: 'contracts', order: 30, find: (query, limit) => this.find(query.terms, limit) });
  }

  private async find(terms: string[], limit: number): Promise<SearchHit[]> {
    const insensitive = 'insensitive' as const;
    const select = { id: true, startDate: true, client: { select: { number: true, name: true } }, employee: { select: { person: { select: { firstName: true, lastName: true, data: true } } } } } as const;
    const found = await this.prisma.contract.findMany({
      where: {
        AND: terms.map(term => ({
          OR: [{ employee: { person: { searchText: { contains: term } } } }, { searchText: { contains: term } }, { client: { number: { contains: term, mode: insensitive } } }, { client: { name: { contains: term, mode: insensitive } } }],
        })),
      },
      orderBy: [{ startDate: 'desc' }],
      take: limit,
      select,
    });
    // The name of the worker spelled a little differently.
    const people = found.length < limit ? await fuzzyIds(this.prisma, 'Person', terms.join(' '), limit * 3) : [];
    const similar = people.length ? await this.prisma.contract.findMany({ where: { employee: { personId: { in: people } }, id: { notIn: found.map(row => row.id) } }, orderBy: [{ startDate: 'desc' }], take: limit - found.length, select }) : [];
    const rows = [...found, ...similar];
    return rows.map(row => ({ id: row.id, title: personName(row.employee.person), subtitle: `${row.client.number} – ${row.client.name} · ${dutch(formatDay(row.startDate))}`, href: `/contracts/${row.id}` }));
  }
}
