import { Injectable, NotFoundException, UnprocessableEntityException, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';

export interface SequenceDefinition {
  key: string;
  label: { nl: string; en: string };
  defaults?: { prefix?: string; padding?: number; next?: number };
}

interface SequenceRow {
  prefix: string;
  padding: number;
  next: number;
}

const MAX_NUMBER = 2_000_000_000;

export const formatNumber = (row: SequenceRow, number: number): string => `${row.prefix}${row.padding > 0 ? String(number).padStart(row.padding, '0') : String(number)}`;

/**
 * Running numbers: the client number today, invoice and contract numbers later. A feature registers its sequence once and asks
 * for the next number inside the transaction that creates the record, so two people never get the same number. Ahmad's own
 * numbers stay as they are (import / typing a number never touches the sequence) — Settings → Numbering only decides the format
 * and where the next automatic number continues.
 */
@Injectable()
export class NumberingService implements OnModuleInit {
  private readonly definitions = new Map<string, SequenceDefinition>();
  /** A feature that has numbers in use reports its highest one, so the sequence can never be set back below it. */
  private readonly floors = new Map<string, () => Promise<number>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    // Ahmad's client numbers are three digits wide (007, 042, 146); 290 clients so far.
    this.register({ key: 'client', label: { nl: 'Klantnummer', en: 'Client number' }, defaults: { padding: 3 } });
  }

  register(definition: SequenceDefinition): void {
    this.definitions.set(definition.key, definition);
  }

  /** `highest()` returns the highest number a record already uses (0 when none). */
  registerFloor(key: string, highest: () => Promise<number>): void {
    this.floors.set(key, highest);
  }

  async onModuleInit(): Promise<void> {
    await this.prisma.numberSequence.createMany({
      data: [...this.definitions.values()].map(definition => ({ key: definition.key, prefix: definition.defaults?.prefix ?? '', padding: definition.defaults?.padding ?? 0, next: definition.defaults?.next ?? 1 })),
      skipDuplicates: true,
    });
  }

  async list() {
    const rows = await this.prisma.numberSequence.findMany({ orderBy: { key: 'asc' } });
    return rows
      .filter(row => this.definitions.has(row.key))
      .map(row => ({ key: row.key, label: this.definitions.get(row.key)!.label, prefix: row.prefix, padding: row.padding, next: row.next, example: formatNumber(row, row.next) }));
  }

  /**
   * A number somebody typed, the way it is stored: trimmed and upper-case, and a plain number written in the sequence's format
   * (padding and prefix: "7" → "007"). Anything with letters or other characters is kept as typed.
   */
  async normalize(key: string, typed: string): Promise<string> {
    const text = typed.trim().toUpperCase();
    if (!/^\d{1,9}$/.test(text)) return text;
    const row = await this.prisma.numberSequence.findUnique({ where: { key } });
    return row ? formatNumber(row, Number(text)) : text;
  }

  /** What the next number would look like, without using it (the "suggested number" on a new record). */
  async peek(key: string): Promise<{ number: number; formatted: string }> {
    const row = await this.prisma.numberSequence.findUnique({ where: { key } });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Unknown number sequence' });
    const floor = (await this.floors.get(key)?.()) ?? 0;
    const number = Math.max(row.next, floor + 1);
    return { number, formatted: formatNumber(row, number) };
  }

  /** Takes the next number. Pass the transaction client of the surrounding `$transaction` so the number is only used when the record is saved. */
  async allocate(key: string, client: Pick<Prisma.TransactionClient, '$queryRaw'> = this.prisma): Promise<{ number: number; formatted: string }> {
    const floor = (await this.floors.get(key)?.()) ?? 0;
    if (floor > 0) {
      // Never hand out a number a record already carries (it may have been typed or imported by hand).
      await this.prisma.$executeRaw`UPDATE "NumberSequence" SET "next" = ${floor + 1} WHERE "key" = ${key} AND "next" <= ${floor}`;
    }
    const rows = await client.$queryRaw<Array<{ number: number; prefix: string; padding: number }>>`
      UPDATE "NumberSequence" SET "next" = "next" + 1 WHERE "key" = ${key} RETURNING "next" - 1 AS "number", "prefix", "padding"`;
    const row = rows[0];
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Unknown number sequence' });
    return { number: Number(row.number), formatted: formatNumber({ prefix: row.prefix, padding: row.padding, next: 0 }, Number(row.number)) };
  }

  async configure(key: string, changes: { prefix?: string; padding?: number; next?: number }, actorId: string) {
    const current = await this.prisma.numberSequence.findUnique({ where: { key } });
    if (!current || !this.definitions.has(key)) throw new NotFoundException({ code: 'not_found', message: 'Unknown number sequence' });

    const fields: Record<string, string> = {};
    const data: { prefix?: string; padding?: number; next?: number } = {};
    if (changes.prefix !== undefined) {
      const prefix = changes.prefix.trim();
      if (prefix.length > 12) fields.prefix = `validation.maxLength|${JSON.stringify({ max: 12 })}`;
      else if (!/^[A-Za-z0-9._/-]*$/.test(prefix)) fields.prefix = 'validation.invalid';
      else data.prefix = prefix;
    }
    if (changes.padding !== undefined) {
      if (!Number.isInteger(changes.padding) || changes.padding < 0 || changes.padding > 10) fields.padding = `validation.max|${JSON.stringify({ max: 10 })}`;
      else data.padding = changes.padding;
    }
    if (changes.next !== undefined) {
      const floor = (await this.floors.get(key)?.()) ?? 0;
      if (!Number.isInteger(changes.next) || changes.next < 1) fields.next = `validation.min|${JSON.stringify({ min: 1 })}`;
      else if (changes.next > MAX_NUMBER) fields.next = `validation.max|${JSON.stringify({ max: MAX_NUMBER })}`;
      else if (changes.next <= floor) fields.next = `validation.numberInUse|${JSON.stringify({ min: floor + 1 })}`;
      else data.next = changes.next;
    }
    if (Object.keys(fields).length) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields });

    const updated = await this.prisma.numberSequence.update({ where: { key }, data: { ...data, updatedById: actorId } });
    const before = { prefix: current.prefix, padding: current.padding, next: current.next };
    const after = { prefix: updated.prefix, padding: updated.padding, next: updated.next };
    const diff = AuditService.changes(before, after);
    if (Object.keys(diff.after).length) await this.audit.log({ action: 'updated', entityType: 'numbering', entityId: key, entityLabel: this.definitions.get(key)!.label.en, before: diff.before, after: diff.after });
    return (await this.list()).find(entry => entry.key === key);
  }
}
