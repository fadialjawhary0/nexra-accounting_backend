import { Injectable, type OnModuleInit } from '@nestjs/common';
import { formatDay } from '../../common/dates.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SearchService } from '../search/search.service.js';
import type { SearchHit } from '../search/search.types.js';

const dutch = (day: string): string => day.split('-').reverse().join('-');

/** The inspections, by number, client and inspector. */
@Injectable()
export class InspectionSearchProvider implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
  ) {}

  onModuleInit(): void {
    this.search.register({ key: 'inspections', area: 'inspections', order: 70, find: (query, limit) => this.find(query.terms, limit) });
  }

  private async find(terms: string[], limit: number): Promise<SearchHit[]> {
    const insensitive = 'insensitive' as const;
    const rows = await this.prisma.inspection.findMany({
      where: {
        isActive: true,
        AND: terms.map(term => ({ OR: [{ searchText: { contains: term } }, { number: { contains: term, mode: insensitive } }, { client: { number: { contains: term, mode: insensitive } } }, { client: { name: { contains: term, mode: insensitive } } }] })),
      },
      orderBy: { date: 'desc' },
      take: limit,
      select: { id: true, number: true, date: true, client: { select: { number: true, name: true } } },
    });
    return rows.map(row => ({ id: row.id, title: `${row.number} · ${row.client.name}`, subtitle: `${row.client.number} · ${dutch(formatDay(row.date))}`, href: `/inspections/${row.id}` }));
  }
}
