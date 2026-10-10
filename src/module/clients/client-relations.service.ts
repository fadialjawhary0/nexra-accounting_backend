import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { displayLabel } from './client-record.js';
import { ClientsService } from './clients.service.js';
import type { AddRelationDto } from './dto/client.dto.js';

const SUMMARY = { id: true, number: true, name: true, isActive: true } as const;
const invalid = (fields: Record<string, string>) => new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields });
/** How many levels of holdings are followed when looking for a circle (a real group is a handful of levels deep). */
const MAX_DEPTH = 25;

/**
 * How clients belong together: a holding (parent company) and its subsidiaries, or companies in the same group. The inspections ask
 * for exactly this ("parent company, group companies"). A holding never sits below its own subsidiary.
 */
@Injectable()
export class ClientRelationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clients: ClientsService,
  ) {}

  /** The parent companies, subsidiaries and group companies of a client. */
  async list(clientId: string) {
    await this.clients.findOrThrow(clientId);
    const rows = await this.prisma.clientRelation.findMany({
      where: { OR: [{ fromId: clientId }, { toId: clientId }] },
      include: { from: { select: SUMMARY }, to: { select: SUMMARY } },
      orderBy: { createdAt: 'asc' },
    });
    const entry = (row: (typeof rows)[number], other: (typeof rows)[number]['from']) => ({ relationId: row.id, client: other });
    return {
      parents: rows.filter(row => row.kind === 'parent' && row.toId === clientId).map(row => entry(row, row.from)),
      subsidiaries: rows.filter(row => row.kind === 'parent' && row.fromId === clientId).map(row => entry(row, row.to)),
      group: rows.filter(row => row.kind === 'group').map(row => entry(row, row.fromId === clientId ? row.to : row.from)),
    };
  }

  async add(clientId: string, dto: AddRelationDto) {
    const client = await this.clients.findOrThrow(clientId);
    if (dto.relatedId === clientId) throw invalid({ relatedId: 'clients.relationSelf' });
    const related = await this.prisma.client.findUnique({ where: { id: dto.relatedId }, select: SUMMARY });
    if (!related) throw invalid({ relatedId: 'validation.selectOption' });

    // Stored as "from is the holding of to" (`parent`), or once, in id order, for a group (symmetric).
    const [fromId, toId, kind] =
      dto.kind === 'parent' ? [related.id, clientId, 'parent'] : dto.kind === 'subsidiary' ? [clientId, related.id, 'parent'] : ([clientId, related.id].sort() as [string, string]).concat('group');
    if (await this.prisma.clientRelation.findUnique({ where: { fromId_toId_kind: { fromId, toId, kind } } })) throw invalid({ relatedId: 'validation.alreadyExists' });
    if (kind === 'parent' && (await this.isBelow(toId, fromId))) throw invalid({ relatedId: 'clients.relationCycle' });

    const relation = await this.prisma.clientRelation.create({ data: { fromId, toId, kind } });
    await this.audit.log({ action: 'linked', entityType: 'client', entityId: clientId, entityLabel: displayLabel(client), meta: { related: displayLabel(related), relation: dto.kind } });
    return { relationId: relation.id };
  }

  async remove(clientId: string, relationId: string) {
    const client = await this.clients.findOrThrow(clientId);
    const relation = await this.prisma.clientRelation.findFirst({ where: { id: relationId, OR: [{ fromId: clientId }, { toId: clientId }] }, include: { from: { select: SUMMARY }, to: { select: SUMMARY } } });
    if (!relation) throw new NotFoundException({ code: 'not_found', message: 'Link not found' });
    await this.prisma.clientRelation.delete({ where: { id: relationId } });
    const other = relation.fromId === clientId ? relation.to : relation.from;
    await this.audit.log({ action: 'unlinked', entityType: 'client', entityId: clientId, entityLabel: displayLabel(client), meta: { related: displayLabel(other), relation: relation.kind } });
    return { relationId };
  }

  /** Is `nodeId` somewhere below `ancestorId` in the holding structure (or the very same client)? */
  private async isBelow(ancestorId: string, nodeId: string): Promise<boolean> {
    if (ancestorId === nodeId) return true;
    const seen = new Set<string>([ancestorId]);
    let frontier = [ancestorId];
    for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth += 1) {
      const children = await this.prisma.clientRelation.findMany({ where: { kind: 'parent', fromId: { in: frontier } }, select: { toId: true } });
      frontier = [];
      for (const { toId } of children) {
        if (toId === nodeId) return true;
        if (!seen.has(toId)) {
          seen.add(toId);
          frontier.push(toId);
        }
      }
    }
    return false;
  }
}
