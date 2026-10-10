import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { fold } from '../../common/text.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { CryptoService } from '../../lib/crypto/crypto.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { isEmptyValue, isEncryptedField, type FieldDef, type FormDoc } from './form-doc.js';

/** Stored values of encrypted fields start with this, then CryptoService's `v1:iv:tag:cipher`. */
export const ENCRYPTED_PREFIX = 'enc:';

/** Types whose values are also searchable without spaces ("1234AB" finds "1234 AB"). */
const COMPACT_TYPES = new Set(['phone', 'postcode', 'iban', 'kvk', 'vat', 'rsin', 'payrollTax']);

type Transaction = Pick<Prisma.TransactionClient, 'uniqueFieldValue'>;

export interface UniqueConflicts {
  /** `field key → validation message key` (`validation.alreadyExists`). */
  errors: Record<string, string>;
  /** `field key → id of the record that already holds the value`. */
  conflicts: Record<string, string>;
}

/**
 * What every module with admin-defined fields does with a record's values besides validating them: keep restricted values encrypted,
 * enforce the "unique" switch of a field, build the search text, and describe a change for the audit trail without leaking secrets.
 */
@Injectable()
export class FormRecordsService {
  constructor(
    private readonly crypto: CryptoService,
    private readonly prisma: PrismaService,
  ) {}

  /* ── Encrypted values ─────────────────────────────────────────────────────────────────────────────────────────── */

  /** Stored → readable. A value that cannot be decrypted (the key changed) is left out rather than shown as gibberish. */
  decode(stored: Record<string, unknown>): Record<string, unknown> {
    const plain: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(stored)) {
      if (typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX)) {
        try {
          plain[key] = this.crypto.decrypt(value.slice(ENCRYPTED_PREFIX.length));
        } catch {
          // unreadable: not shown
        }
      } else {
        plain[key] = value;
      }
    }
    return plain;
  }

  /** A cleaned patch → what is stored: the values of encrypted fields are encrypted, `null` (clear) stays `null`. */
  encode(doc: FormDoc, values: Record<string, unknown>): Record<string, unknown> {
    const encrypted = new Set(doc.fields.filter(isEncryptedField).map(field => field.key));
    return Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, encrypted.has(key) && typeof value === 'string' ? ENCRYPTED_PREFIX + this.crypto.encrypt(value) : value]),
    );
  }

  /** Keys of the fields whose values are encrypted. */
  encryptedKeys(doc: FormDoc): Set<string> {
    return new Set(doc.fields.filter(isEncryptedField).map(field => field.key));
  }

  /** `data` with a patch applied: a `null` removes the key. */
  static merge(data: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
    const merged = { ...data };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) delete merged[key];
      else merged[key] = value;
    }
    return merged;
  }

  /* ── Unique values ────────────────────────────────────────────────────────────────────────────────────────────── */

  private uniqueToken(field: FieldDef, value: unknown): string | null {
    if (isEmptyValue(value)) return null;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return isEncryptedField(field) ? this.crypto.blindIndex(text.trim().toLowerCase()) : fold(text);
  }

  /** Says which "unique" fields of a submitted patch collide with another record. `existing` = the record's plain values so far. */
  async checkUnique(entity: string, recordId: string | null, doc: FormDoc, patch: Record<string, unknown>, existing: Record<string, unknown>): Promise<UniqueConflicts> {
    const result: UniqueConflicts = { errors: {}, conflicts: {} };
    for (const field of doc.fields) {
      if (!field.active || !field.flags.unique || !(field.key in patch)) continue;
      const token = this.uniqueToken(field, patch[field.key]);
      if (!token) continue;
      if (recordId && this.uniqueToken(field, existing[field.key]) === token) continue;
      const holder = await this.prisma.uniqueFieldValue.findFirst({ where: { entity, fieldKey: field.key, value: token, ...(recordId && { NOT: { recordId } }) }, select: { recordId: true } });
      if (holder) {
        result.errors[field.key] = 'validation.alreadyExists';
        result.conflicts[field.key] = holder.recordId;
      }
    }
    return result;
  }

  /** The rows the unique table should hold for a record with these values. */
  uniqueClaims(entity: string, recordId: string, doc: FormDoc, values: Record<string, unknown>): Array<{ entity: string; fieldKey: string; value: string; recordId: string }> {
    const claims: Array<{ entity: string; fieldKey: string; value: string; recordId: string }> = [];
    for (const field of doc.fields) {
      if (!field.flags.unique) continue;
      const token = this.uniqueToken(field, values[field.key]);
      if (token) claims.push({ entity, fieldKey: field.key, value: token, recordId });
    }
    return claims;
  }

  /** Makes the record's unique values the ones held in the table — call inside the transaction that saves the record. */
  async claim(tx: Transaction, entity: string, recordId: string, doc: FormDoc, values: Record<string, unknown>): Promise<void> {
    const wanted = new Map(this.uniqueClaims(entity, recordId, doc, values).map(claim => [claim.fieldKey, claim.value]));
    const current = await tx.uniqueFieldValue.findMany({ where: { entity, recordId } });
    const stale = current.filter(row => wanted.get(row.fieldKey) !== row.value).map(row => row.id);
    if (stale.length) await tx.uniqueFieldValue.deleteMany({ where: { id: { in: stale } } });
    const have = new Set(current.filter(row => wanted.get(row.fieldKey) === row.value).map(row => row.fieldKey));
    const missing = [...wanted].filter(([key]) => !have.has(key)).map(([fieldKey, value]) => ({ entity, fieldKey, value, recordId }));
    if (missing.length) await tx.uniqueFieldValue.createMany({ data: missing });
  }

  /* ── Search text ──────────────────────────────────────────────────────────────────────────────────────────────── */

  /**
   * The text quick search looks in: the values of the fields marked "search" (never encrypted ones), plus `extra` pieces the record
   * adds itself (the number, people's names …). Pick-list values contribute their names, not just their codes.
   */
  async searchText(doc: FormDoc, values: Record<string, unknown>, extra: string[] = []): Promise<string> {
    const searchable = doc.fields.filter(field => field.active && field.flags.search && !isEncryptedField(field) && !isEmptyValue(values[field.key]));
    const listKeys = [...new Set(searchable.filter(field => (field.type === 'select' || field.type === 'multiselect') && field.list).map(field => field.list as string))];
    const items = listKeys.length ? await this.prisma.listItem.findMany({ where: { list: { key: { in: listKeys } } }, select: { code: true, nameNl: true, nameEn: true, list: { select: { key: true } } } }) : [];
    const names = new Map(items.map(item => [`${item.list.key}:${item.code}`, [item.nameNl, item.nameEn]]));

    const pieces: string[] = [...extra];
    for (const field of searchable) {
      const raw = values[field.key];
      for (const value of Array.isArray(raw) ? raw : [raw]) {
        if (typeof value !== 'string' && typeof value !== 'number') continue;
        const text = String(value);
        pieces.push(text);
        if (COMPACT_TYPES.has(field.type)) pieces.push(text.replace(/\s+/g, ''));
        if (field.type === 'select' || field.type === 'multiselect') {
          pieces.push(...(names.get(`${field.list}:${text}`) ?? []));
          for (const choice of field.choices) if (choice.code === text) pieces.push(choice.names.nl, choice.names.en);
        }
      }
    }
    return [...new Set(pieces.map(fold).filter(Boolean))].join(' ').slice(0, 4000);
  }

  /* ── Audit ────────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** What changed between two sets of plain values, for the audit trail. Encrypted fields only show that they changed. */
  auditChange(doc: FormDoc, before: Record<string, unknown>, after: Record<string, unknown>): { before: Record<string, unknown>; after: Record<string, unknown> } {
    const secret = this.encryptedKeys(doc);
    const open = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).filter(([key]) => !secret.has(key)));
    const diff = AuditService.changes(open(before), open(after));
    for (const key of secret) {
      const changed = JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null);
      if (changed) {
        diff.before[key] = before[key] ? '[redacted]' : null;
        diff.after[key] = after[key] ? '[redacted]' : null;
      }
    }
    return diff;
  }

  /** The values safe to put in an audit entry about a new record (encrypted fields reduced to "[redacted]"). */
  auditSnapshot(doc: FormDoc, values: Record<string, unknown>): Record<string, unknown> {
    const secret = this.encryptedKeys(doc);
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, secret.has(key) ? '[redacted]' : value]));
  }
}
