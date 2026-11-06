import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { SoftDeleteModel } from '../../lib/database/soft-delete.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import { DELETION_SPECS, TOMBSTONES, UNIQUE_ENTITIES, delegateName, type DeletionSpec, type DeletionTarget, type Refusal, type Row } from './deletion.specs.js';

/** What a deletion keeps to undo itself. */
interface Snapshot {
  /** `{ Model: { id: { field: original value } } }` — the unique values that were freed. */
  tombstones: Record<string, Record<string, Record<string, unknown>>>;
  /** The unique form values that were released. */
  unique: Array<{ entity: string; fieldKey: string; value: string; recordId: string }>;
  /** The period locks that were released (an invoice, a statement). */
  locks: Array<Record<string, unknown>>;
}

interface RowDelegate {
  findUnique(args: unknown): Promise<Row | null>;
  findMany(args: unknown): Promise<Row[]>;
  findFirst(args: unknown): Promise<Row | null>;
  updateMany(args: unknown): Promise<{ count: number }>;
  update(args: unknown): Promise<Row>;
}

/** The suffix a freed text value gets: it can never be typed, and it ends in `~` (so a number at the end of it is no longer read as a client number). */
const freed = (value: string, deletionId: string) => `${value}~deleted~${deletionId}~`;

/**
 * Deleting (soft) and bringing back. One deletion marks a record and everything that goes with it (`deletion.specs.ts`) with the same `deletionId`, frees the values that must be
 * unique, releases what the record held (period locks) and writes it in the activity log; a restore undoes exactly that — refused when a freed value was taken in the meantime.
 */
@Injectable()
export class DeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private spec(type: string): DeletionSpec {
    const spec = DELETION_SPECS[type];
    if (!spec) throw new NotFoundException({ code: 'not_found', message: 'This cannot be deleted.' });
    return spec;
  }

  private assertAllowed(spec: DeletionSpec, user: AuthenticatedUser, row?: Row): void {
    if (!matrixAllows(user.matrix, `${spec.area}.remove`) || (row && spec.permits && !spec.permits(row, user))) throw new ForbiddenException({ code: 'forbidden', message: 'You may not delete this.' });
  }

  private rows(model: SoftDeleteModel, client: unknown = this.prisma): RowDelegate {
    return (client as Record<string, RowDelegate>)[delegateName(model)]!;
  }

  private async root(spec: DeletionSpec, id: string): Promise<Row> {
    const row = await this.rows(spec.model).findUnique({ where: { id }, ...(spec.include && { include: spec.include }) });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Not found' });
    return row;
  }

  /** The record and what goes with it, per table, each id once. */
  private async targets(spec: DeletionSpec, row: Row): Promise<Map<SoftDeleteModel, string[]>> {
    const list: DeletionTarget[] = [{ model: spec.model, ids: [String(row.id)] }, ...((await spec.children?.(row, this.prisma)) ?? [])];
    const map = new Map<SoftDeleteModel, string[]>();
    for (const target of list) {
      if (!target.ids.length) continue;
      const known = new Set(map.get(target.model) ?? []);
      for (const id of target.ids) known.add(id);
      map.set(target.model, [...known]);
    }
    return map;
  }

  /** Why this one cannot be deleted, as `{ code, details }` (the details always name it). */
  private async refusal(spec: DeletionSpec, row: Row, user: AuthenticatedUser): Promise<Refusal | null> {
    const found = await spec.guard?.(row, { prisma: this.prisma, user });
    if (!found) return null;
    const refusal = typeof found === 'string' ? { code: found } : found;
    return { code: refusal.code, details: { name: spec.label(row), ...refusal.details } };
  }

  private static counts(targets: Map<SoftDeleteModel, string[]>): Record<string, number> {
    return Object.fromEntries([...targets].map(([model, list]) => [model, list.length]));
  }

  /* ── Asking first ─────────────────────────────────────────────────────────────────────────────────────────────── */

  /** What deleting this one would do: its name, what goes with it, or why it cannot be deleted. Nothing is changed. */
  async preview(type: string, id: string, user: AuthenticatedUser) {
    const spec = this.spec(type);
    this.assertAllowed(spec, user);
    const row = await this.root(spec, id);
    this.assertAllowed(spec, user, row);
    const blocked = await this.refusal(spec, row, user);
    const counts = DeletionService.counts(await this.targets(spec, row));
    return { type, id, label: spec.label(row), model: spec.model, counts, blocked };
  }

  /* ── Deleting ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  async delete(type: string, id: string, user: AuthenticatedUser) {
    const spec = this.spec(type);
    this.assertAllowed(spec, user);
    const row = await this.root(spec, id);
    this.assertAllowed(spec, user, row);
    const blocked = await this.refusal(spec, row, user);
    if (blocked) throw new ConflictException({ code: blocked.code, message: 'This cannot be deleted.', details: blocked.details });
    const targets = await this.targets(spec, row);
    const counts = DeletionService.counts(targets);
    const label = spec.label(row);
    const now = new Date();

    const deletionId = await this.prisma.$transaction(
      async tx => {
        const deletion = await tx.deletion.create({ data: { entityType: type, entityId: id, label, counts, deletedById: user.id } });
        const snapshot: Snapshot = { tombstones: {}, unique: [], locks: [] };
        for (const [model, list] of targets) {
          // Freed unique values are read before the rows are marked (afterwards they are hidden).
          const tombstones = TOMBSTONES[model];
          const before = tombstones ? await this.rows(model, tx).findMany({ where: { id: { in: list } } }) : [];
          await this.rows(model, tx).updateMany({ where: { id: { in: list } }, data: { deletedAt: now, deletedById: user.id, deletionId: deletion.id } });
          for (const original of before) {
            const changes: Record<string, unknown> = {};
            const kept: Record<string, unknown> = {};
            for (const tombstone of tombstones ?? []) {
              const value = original[tombstone.field];
              if (value === null || value === undefined || (tombstone.when && !tombstone.when(original))) continue;
              kept[tombstone.field] = value;
              changes[tombstone.field] = tombstone.kind === 'int' ? -1 - Math.floor(Math.random() * 2_000_000_000) : freed(String(value), deletion.id);
            }
            if (!Object.keys(changes).length) continue;
            await this.rows(model, tx).update({ where: { id: original.id }, data: changes });
            ((snapshot.tombstones[model] ??= {})[String(original.id)] = kept);
          }
          const entity = UNIQUE_ENTITIES[model];
          if (entity) {
            const values = await tx.uniqueFieldValue.findMany({ where: { entity, recordId: { in: list } }, select: { entity: true, fieldKey: true, value: true, recordId: true } });
            snapshot.unique.push(...values);
            if (values.length) await tx.uniqueFieldValue.deleteMany({ where: { entity, recordId: { in: list } } });
          }
        }
        await spec.afterDelete?.(row, tx);
        if (spec.locks) {
          const locks = await tx.periodLock.findMany({ where: { [spec.locks]: id } });
          snapshot.locks = locks.map(lock => ({ ...lock }));
          if (locks.length) await tx.periodLock.deleteMany({ where: { id: { in: locks.map(lock => lock.id) } } });
        }
        await tx.deletion.update({ where: { id: deletion.id }, data: { snapshot: snapshot as unknown as Prisma.InputJsonObject } });
        return deletion.id;
      },
      { timeout: 60_000 },
    );
    await this.audit.log({ action: 'deleted', entityType: type, entityId: id, entityLabel: label, meta: { counts, deletionId } });
    return { deletionId, type, id, label, counts };
  }

  /* ── Bringing back ────────────────────────────────────────────────────────────────────────────────────────────── */

  async restore(deletionId: string, user: AuthenticatedUser) {
    const deletion = await this.prisma.deletion.findUnique({ where: { id: deletionId } });
    if (!deletion) throw new NotFoundException({ code: 'not_found', message: 'Not found' });
    const spec = this.spec(deletion.entityType);
    const deleted = await this.rows(spec.model, this.prisma.withDeleted).findUnique({ where: { id: deletion.entityId } });
    this.assertAllowed(spec, user, deleted ?? undefined);
    if (deletion.restoredAt) throw new ConflictException({ code: 'already_restored', message: 'This was brought back already.' });
    const snapshot = (deletion.snapshot ?? {}) as unknown as Partial<Snapshot>;
    const models = Object.keys((deletion.counts ?? {}) as Record<string, number>) as SoftDeleteModel[];

    // A freed value somebody has used since cannot be given back: say which one.
    const taken: string[] = [];
    for (const [model, byId] of Object.entries(snapshot.tombstones ?? {})) {
      for (const kept of Object.values(byId)) {
        for (const [field, value] of Object.entries(kept)) {
          if (await this.rows(model as SoftDeleteModel).findFirst({ where: { [field]: value }, select: { id: true } })) taken.push(`${model}.${field}=${String(value)}`);
        }
      }
    }
    for (const value of snapshot.unique ?? []) {
      if (await this.prisma.uniqueFieldValue.findFirst({ where: { entity: value.entity, fieldKey: value.fieldKey, value: value.value }, select: { id: true } })) taken.push(`${value.entity}.${value.fieldKey}=${value.value}`);
    }
    if (taken.length) throw new ConflictException({ code: 'restore_taken', message: 'Something was given the same number or name in the meantime.', details: { taken } });

    await this.prisma.$transaction(
      async tx => {
        for (const model of models) {
          await this.rows(model, tx).updateMany({ where: { deletionId, deletedAt: { not: null } }, data: { deletedAt: null, deletedById: null, deletionId: null } });
        }
        for (const [model, byId] of Object.entries(snapshot.tombstones ?? {})) {
          for (const [rowId, kept] of Object.entries(byId)) await this.rows(model as SoftDeleteModel, tx).update({ where: { id: rowId }, data: kept });
        }
        if (snapshot.unique?.length) await tx.uniqueFieldValue.createMany({ data: snapshot.unique, skipDuplicates: true });
        if (snapshot.locks?.length) await tx.periodLock.createMany({ data: snapshot.locks as unknown as Prisma.PeriodLockCreateManyInput[], skipDuplicates: true });
        if (spec.afterRestore) {
          const back = await this.rows(spec.model, tx).findUnique({ where: { id: deletion.entityId } });
          if (back) await spec.afterRestore(back, tx);
        }
        await tx.deletion.update({ where: { id: deletionId }, data: { restoredAt: new Date(), restoredById: user.id } });
      },
      { timeout: 60_000 },
    );
    await this.audit.log({ action: 'restored', entityType: deletion.entityType, entityId: deletion.entityId, entityLabel: deletion.label, meta: { counts: deletion.counts, deletionId } });
    return { deletionId, type: deletion.entityType, id: deletion.entityId, label: deletion.label };
  }
}
