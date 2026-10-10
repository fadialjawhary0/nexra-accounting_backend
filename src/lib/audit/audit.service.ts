import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { isDeepStrictEqual } from 'node:util';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import type { AppClsStore } from './cls-store.js';

export interface AuditEntry {
  /** created · updated · deleted · activated · deactivated · signed_in · … */
  action: string;
  entityType: string;
  entityId?: string | null;
  /** Readable name of the record at that moment, e.g. "1042 – Bakkerij Jansen". */
  entityLabel?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
  /** Who did it, when the request has no signed-in user (sign-in, password reset, accepting an invitation). */
  actor?: { id: string; label: string } | null;
}

/** Keys that never go into the log (passwords, tokens, restricted personal data). */
const SENSITIVE = /pass(word)?|token|secret|bsn|iban|nationalid|otp|recovery/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, SENSITIVE.test(key) ? '[redacted]' : redact(inner)]));
  }
  return value;
}

const toJson = (value: unknown): Prisma.InputJsonValue | undefined =>
  value === undefined || value === null ? undefined : (JSON.parse(JSON.stringify(redact(value))) as Prisma.InputJsonValue);

/**
 * The audit trail: every create / update / delete / activate / deactivate / sign-in writes one entry. The actor, IP and
 * browser come from the request context, so services just call `audit.log({ … })`.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  async log(entry: AuditEntry): Promise<void> {
    const actor = entry.actor ?? (this.cls.isActive() ? this.cls.get('actor') : undefined);
    await this.prisma.activityLog.create({
      data: {
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        entityLabel: entry.entityLabel ?? null,
        before: toJson(entry.before),
        after: toJson(entry.after),
        meta: toJson(entry.meta),
        actorId: actor?.id ?? null,
        actorLabel: actor?.label ?? null,
        ip: this.cls.isActive() ? (this.cls.get('ip') ?? null) : null,
        userAgent: this.cls.isActive() ? (this.cls.get('userAgent') ?? null) : null,
      },
    });
  }

  /** Only the fields that differ — keeps `before` / `after` small and readable. */
  static changes(before: Record<string, unknown>, after: Record<string, unknown>): { before: Record<string, unknown>; after: Record<string, unknown> } {
    const changed = { before: {} as Record<string, unknown>, after: {} as Record<string, unknown> };
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (isDeepStrictEqual(before[key], after[key])) continue;
      changed.before[key] = before[key];
      changed.after[key] = after[key];
    }
    return changed;
  }
}
