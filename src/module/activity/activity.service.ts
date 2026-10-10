import { Injectable } from '@nestjs/common';
import { paged } from '../../common/api-result.js';
import { pageMeta, toOrderBy, toSkipTake } from '../../common/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { MAX_EXPORT_ROWS, type ExportTable } from '../../lib/exports/export.types.js';
import { actionName, entityName } from './activity-words.js';
import type { ActivityListQuery } from './dto/activity-query.dto.js';

const SORTABLE = ['createdAt', 'action', 'entityType', 'actorLabel'] as const;

const splitList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

/** Reads the audit trail that AuditService writes. Nothing here can change an entry. */
@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ActivityListQuery) {
    const where = this.where(query);
    const [rows, total] = await Promise.all([
      this.prisma.activityLog.findMany({ where, orderBy: toOrderBy(query.sort, SORTABLE, [{ createdAt: 'desc' }]) as Prisma.ActivityLogOrderByWithRelationInput[], ...toSkipTake(query) }),
      this.prisma.activityLog.count({ where }),
    ]);
    // `actor` is how the screens show who did it ({ id, name }); `null` means the system itself.
    return paged(
      rows.map(row => ({ ...row, actor: row.actorLabel ? { id: row.actorId, name: row.actorLabel } : null })),
      pageMeta(total, query)
    );
  }

  /** What the log filters can offer: the people who appear in it, and the actions and kinds of record it holds. */
  async filters() {
    const [actors, actions, entityTypes] = await Promise.all([
      this.prisma.activityLog.groupBy({ by: ['actorId'], where: { actorId: { not: null } }, _max: { actorLabel: true } }),
      this.prisma.activityLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } }),
      this.prisma.activityLog.findMany({ distinct: ['entityType'], select: { entityType: true }, orderBy: { entityType: 'asc' } }),
    ]);
    return {
      actors: actors.map(actor => ({ id: actor.actorId as string, name: actor._max.actorLabel ?? '' })).sort((a, b) => a.name.localeCompare(b.name)),
      actions: actions.map(row => row.action),
      entityTypes: entityTypes.map(row => row.entityType),
    };
  }

  /** The log (with the same filters as the list, newest first) as a table for Excel / PDF / Word. */
  async exportTable(query: ActivityListQuery, locale: AppLocale): Promise<{ table: ExportTable; count: number }> {
    const where = this.where(query);
    const rows = await this.prisma.activityLog.findMany({ where, orderBy: toOrderBy(query.sort, SORTABLE, [{ createdAt: 'desc' }]) as Prisma.ActivityLogOrderByWithRelationInput[], take: MAX_EXPORT_ROWS + 1 });
    const nl = locale === 'nl';
    const filters = [
      query.from || query.to ? `${nl ? 'Periode' : 'Period'}: ${query.from?.slice(0, 10) ?? '…'} – ${query.to?.slice(0, 10) ?? '…'}` : null,
      query.action ? `${nl ? 'Actie' : 'Action'}: ${splitList(query.action).map(code => actionName(code, locale)).join(', ')}` : null,
      query.entityType ? `${nl ? 'Soort' : 'Type'}: ${splitList(query.entityType).map(code => entityName(code, locale)).join(', ')}` : null,
      query.search?.trim() ? `${nl ? 'Zoekterm' : 'Search'}: ${query.search.trim()}` : null,
    ].filter(Boolean);
    return {
      count: rows.length,
      table: {
        title: nl ? 'Activiteitenlogboek' : 'Activity log',
        subtitle: filters.join(' · ') || undefined,
        locale,
        columns: [
          { key: 'createdAt', header: nl ? 'Wanneer' : 'When', type: 'datetime' },
          { key: 'actor', header: nl ? 'Wie' : 'Who', width: 22 },
          { key: 'action', header: nl ? 'Actie' : 'Action', width: 28 },
          { key: 'entityType', header: nl ? 'Soort' : 'Type', width: 18 },
          { key: 'entityLabel', header: nl ? 'Naam' : 'Name', width: 34 },
        ],
        rows: rows.slice(0, MAX_EXPORT_ROWS).map(row => ({
          createdAt: row.createdAt,
          actor: row.actorLabel ?? (nl ? 'Het systeem' : 'The system'),
          action: actionName(row.action, locale),
          entityType: entityName(row.entityType, locale),
          entityLabel: row.entityLabel ?? '',
        })),
      },
    };
  }

  private where(query: ActivityListQuery): Prisma.ActivityLogWhereInput {
    const entityTypes = splitList(query.entityType);
    const actions = splitList(query.action);
    const search = query.search?.trim();
    const createdAt: Prisma.DateTimeFilter = {};
    if (query.from) createdAt.gte = new Date(`${query.from.slice(0, 10)}T00:00:00.000`);
    if (query.to) createdAt.lt = new Date(new Date(`${query.to.slice(0, 10)}T00:00:00.000`).getTime() + 86_400_000);
    return {
      ...(entityTypes.length && { entityType: { in: entityTypes } }),
      ...(query.entityId && { entityId: query.entityId }),
      ...(actions.length && { action: { in: actions } }),
      ...(query.actorId && { actorId: query.actorId }),
      ...(Object.keys(createdAt).length && { createdAt }),
      ...(search && { OR: [{ entityLabel: { contains: search, mode: 'insensitive' as const } }, { actorLabel: { contains: search, mode: 'insensitive' as const } }, { action: { contains: search, mode: 'insensitive' as const } }] }),
    };
  }
}
