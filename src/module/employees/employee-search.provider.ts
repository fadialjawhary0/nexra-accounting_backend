import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { personName } from '../people/person-record.js';
import { fuzzyIds } from '../search/fuzzy.js';
import { SearchService } from '../search/search.service.js';
import type { SearchHit } from '../search/search.types.js';

/** The workers, by name, the number and name of the client they work for and every field the worker form marks "search" (never a BSN or an IBAN). */
@Injectable()
export class EmployeeSearchProvider implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
  ) {}

  onModuleInit(): void {
    this.search.register({ key: 'employees', area: 'employees', order: 20, find: (query, limit) => this.find(query.terms, limit) });
  }

  private async find(terms: string[], limit: number): Promise<SearchHit[]> {
    const insensitive = 'insensitive' as const;
    const select = { id: true, isActive: true, person: { select: { firstName: true, lastName: true, data: true } }, client: { select: { number: true, name: true } } } as const;
    const found = await this.prisma.employee.findMany({
      where: {
        AND: terms.map(term => ({
          OR: [{ person: { searchText: { contains: term } } }, { searchText: { contains: term } }, { client: { number: { contains: term, mode: insensitive } } }, { client: { name: { contains: term, mode: insensitive } } }],
        })),
      },
      orderBy: [{ isActive: 'desc' }, { person: { lastName: 'asc' } }],
      take: limit,
      select,
    });
    // Names that are spelled a little differently ("Janssen" for "Jansen"): by the person, then what is left.
    const people = found.length < limit ? await fuzzyIds(this.prisma, 'Person', terms.join(' '), limit * 3) : [];
    const similar = people.length ? await this.prisma.employee.findMany({ where: { personId: { in: people }, id: { notIn: found.map(row => row.id) } }, orderBy: [{ isActive: 'desc' }], take: limit - found.length, select }) : [];
    const rows = [...found, ...similar];
    return rows.map(row => ({ id: row.id, title: personName(row.person), subtitle: `${row.client.number} – ${row.client.name}${row.isActive ? '' : ' · ✕'}`, href: `/employees/${row.id}` }));
  }
}
