import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SearchService } from '../search/search.service.js';
import type { SearchHit } from '../search/search.types.js';
import { DONE_STATUS } from './tasks.constants.js';

/** The tasks, by what they say, the record they are about and the client. Open tasks come first. */
@Injectable()
export class TaskSearchProvider implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
  ) {}

  onModuleInit(): void {
    this.search.register({ key: 'tasks', area: 'tasks', order: 80, find: (query, limit) => this.find(query.terms, limit) });
  }

  private async find(terms: string[], limit: number): Promise<SearchHit[]> {
    const insensitive = 'insensitive' as const;
    const rows = await this.prisma.task.findMany({
      where: { isActive: true, AND: terms.map(term => ({ OR: [{ searchText: { contains: term } }, { client: { number: { contains: term, mode: insensitive } } }, { client: { name: { contains: term, mode: insensitive } } }] })) },
      orderBy: [{ completedAt: { sort: 'asc', nulls: 'first' } }, { dueDate: { sort: 'asc', nulls: 'last' } }],
      take: limit,
      select: { id: true, title: true, status: true, linkedLabel: true, client: { select: { number: true, name: true } } },
    });
    return rows.map(row => ({
      id: row.id,
      title: row.title,
      subtitle: [row.linkedLabel || (row.client ? `${row.client.number} – ${row.client.name}` : ''), row.status === DONE_STATUS ? '✓' : ''].filter(Boolean).join(' · '),
      href: `/tasks?task=${row.id}`,
    }));
  }
}
