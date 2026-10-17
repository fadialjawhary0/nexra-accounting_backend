import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { INVOICES_NAMESPACE } from './invoices.constants.js';

type Tx = Prisma.TransactionClient | PrismaService;

/**
 * The numbers of outgoing invoices. Every client (the issuer) numbers its own invoices, one after the other and without gaps; the format is a setting
 * (`2026-0001`, `20260001` or a plain `0001` that never restarts). A number that is already in use is never handed out — it may have been typed, or
 * come from an older system — and a number somebody types moves the series on.
 */
@Injectable()
export class InvoiceNumberingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  private get format(): 'year_dash' | 'year_plain' | 'plain' {
    return this.settings.get<string>(`${INVOICES_NAMESPACE}.numberFormat`) as 'year_dash' | 'year_plain' | 'plain';
  }

  private get padding(): number {
    return this.settings.get<number>(`${INVOICES_NAMESPACE}.numberPadding`);
  }

  /** The series an invoice dated `day` belongs to: the year, or 0 when the numbers do not restart. */
  private yearOf(day: string): number {
    return this.format === 'plain' ? 0 : Number(day.slice(0, 4));
  }

  /** `2026-0001` for the 1st invoice of 2026. */
  render(number: number, day: string): string {
    const padded = String(number).padStart(this.padding, '0');
    switch (this.format) {
      case 'year_dash':
        return `${day.slice(0, 4)}-${padded}`;
      case 'year_plain':
        return `${day.slice(0, 4)}${padded}`;
      default:
        return padded;
    }
  }

  /** The running number inside a number written in the current format for that series, or `null` when it does not follow it. */
  parse(text: string, day: string): number | null {
    const year = day.slice(0, 4);
    const match = this.format === 'year_dash' ? new RegExp(`^${year}-(\\d+)$`).exec(text) : this.format === 'year_plain' ? new RegExp(`^${year}(\\d+)$`).exec(text) : /^(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  }

  /** The highest running number a client's outgoing invoices already carry in the series of `day`. */
  private async highest(tx: Tx, clientId: string, day: string): Promise<number> {
    const rows = await tx.invoice.findMany({ where: { clientId, direction: 'outgoing', number: { not: null } }, select: { number: true } });
    return rows.reduce((max, row) => Math.max(max, this.parse(row.number as string, day) ?? 0), 0);
  }

  /** What the next number would be, without using it. */
  async peek(clientId: string, day: string): Promise<string> {
    const [counter, highest] = await Promise.all([this.prisma.invoiceCounter.findUnique({ where: { clientId_year: { clientId, year: this.yearOf(day) } } }), this.highest(this.prisma, clientId, day)]);
    return this.render(Math.max(counter?.next ?? 1, highest + 1), day);
  }

  /** Takes the next number (inside the transaction that saves the invoice). */
  async allocate(tx: Prisma.TransactionClient, clientId: string, day: string): Promise<string> {
    const year = this.yearOf(day);
    const floor = (await this.highest(tx, clientId, day)) + 1;
    await tx.$executeRaw`INSERT INTO "InvoiceCounter" ("clientId", "year", "next") VALUES (${clientId}, ${year}, ${floor})
      ON CONFLICT ("clientId", "year") DO UPDATE SET "next" = GREATEST("InvoiceCounter"."next", ${floor})`;
    const rows = await tx.$queryRaw<Array<{ number: number }>>`UPDATE "InvoiceCounter" SET "next" = "next" + 1 WHERE "clientId" = ${clientId} AND "year" = ${year} RETURNING "next" - 1 AS "number"`;
    return this.render(Number(rows[0]?.number ?? floor), day);
  }

  /** A number somebody typed for an outgoing invoice: it must be free, and the series continues after it. */
  async claim(tx: Prisma.TransactionClient, clientId: string, typed: string, day: string, exceptInvoiceId?: string): Promise<string> {
    const number = typed.trim();
    const taken = await tx.invoice.findFirst({ where: { clientId, direction: 'outgoing', number: { equals: number, mode: 'insensitive' }, ...(exceptInvoiceId && { id: { not: exceptInvoiceId } }) }, select: { id: true } });
    if (taken) throw new ConflictException({ code: 'invoice_number_taken', message: 'This client already has an invoice with that number.', fields: { number: 'validation.numberInUse' }, details: { id: taken.id } });
    const running = this.parse(number, day);
    if (running !== null) {
      const year = this.yearOf(day);
      await tx.$executeRaw`INSERT INTO "InvoiceCounter" ("clientId", "year", "next") VALUES (${clientId}, ${year}, ${running + 1})
        ON CONFLICT ("clientId", "year") DO UPDATE SET "next" = GREATEST("InvoiceCounter"."next", ${running + 1})`;
    }
    return number;
  }
}
