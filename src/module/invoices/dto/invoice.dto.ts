import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto.js';
import type { InvoiceDirection, LineKind } from '../invoices.constants.js';

const toBoolean = ({ value }: { value: unknown }) => (typeof value === 'string' ? ['true', '1', 'yes'].includes(value.toLowerCase()) : value);

/* ── Lines ───────────────────────────────────────────────────────────────────────────────────────────────────────── */

export class InvoiceLineDto {
  @IsOptional() @IsIn(['hours', 'markup', 'other']) kind?: LineKind;
  /** The worker the line is about; without one, `rawName` says who (as written on the document). */
  @IsOptional() @IsString() @MaxLength(60) employeeId?: string | null;
  @IsOptional() @IsString() @MaxLength(200) rawName?: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsOptional() @IsString() @MaxLength(10) from?: string;
  @IsOptional() @IsString() @MaxLength(10) to?: string;
  /** Billed time in minutes (positive — a credit note is made by crediting an invoice). */
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) minutes?: number;
  /** Euros per hour. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100_000) rate?: number | null;
  /** What the line says in euros; worked out from hours × rate when left out. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(-10_000_000) @Max(10_000_000) amount?: number | null;
}

/* ── Create and change ───────────────────────────────────────────────────────────────────────────────────────────── */

export class CreateInvoiceDto {
  @IsIn(['incoming', 'outgoing']) direction!: InvoiceDirection;
  /** The client the invoice belongs to (the one that received it, or issues it). */
  @MaxLength(60) @IsString() clientId!: string;
  /** The other party: a company that is not a client … */
  @IsOptional() @IsString() @MaxLength(60) counterpartyId?: string;
  /** … or another client of the office. Exactly one of the two. */
  @IsOptional() @IsString() @MaxLength(60) otherClientId?: string;
  /** Incoming: the number on the document. Outgoing: given when the invoice is issued. */
  @IsOptional() @IsString() @MaxLength(60) number?: string;
  @IsOptional() @IsString() @MaxLength(10) invoiceDate?: string;
  @IsOptional() @IsString() @MaxLength(10) dueDate?: string;
  @MaxLength(10) @IsString() periodFrom!: string;
  @MaxLength(10) @IsString() periodTo!: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) vatPercent?: number;
  @IsOptional() @IsBoolean() vatShifted?: boolean;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) gAccountPercent?: number;
  /** The G-account part by hand (euros); the percentage is used when it is left out. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000_000) gAccountAmount?: number | null;
  @IsOptional() @IsIn(['nl', 'en']) locale?: 'nl' | 'en';
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  /** The `invoice` form (reference, assignment, remark …). */
  @IsOptional() @IsObject() values?: Record<string, unknown>;
  /** An uploaded file (purpose `invoice_document`): the PDF of an incoming invoice. */
  @IsOptional() @IsString() @MaxLength(60) fileId?: string | null;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => InvoiceLineDto) lines!: InvoiceLineDto[];
}

export class UpdateInvoiceDto {
  @IsOptional() @IsString() @MaxLength(60) counterpartyId?: string | null;
  @IsOptional() @IsString() @MaxLength(60) otherClientId?: string | null;
  @IsOptional() @IsString() @MaxLength(60) number?: string;
  @IsOptional() @IsString() @MaxLength(10) invoiceDate?: string;
  @IsOptional() @IsString() @MaxLength(10) dueDate?: string;
  @IsOptional() @IsString() @MaxLength(10) periodFrom?: string;
  @IsOptional() @IsString() @MaxLength(10) periodTo?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) vatPercent?: number;
  @IsOptional() @IsBoolean() vatShifted?: boolean;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) gAccountPercent?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000_000) gAccountAmount?: number | null;
  @IsOptional() @IsIn(['nl', 'en']) locale?: 'nl' | 'en';
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @IsObject() values?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(60) fileId?: string | null;
  /** When given, the lines are replaced by these. */
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => InvoiceLineDto) lines?: InvoiceLineDto[];
}

/* ── What happens to an invoice ──────────────────────────────────────────────────────────────────────────────────── */

/** Issuing an outgoing invoice: it gets its number, its documents, and closes the days it bills. */
export class IssueInvoiceDto {
  /** Left out: the next number of the client. */
  @IsOptional() @IsString() @MaxLength(60) number?: string;
  @IsOptional() @IsString() @MaxLength(10) invoiceDate?: string;
  @IsOptional() @IsString() @MaxLength(10) dueDate?: string;
  /** Needed when a line bills hours that are not (all) registered, or names no worker. */
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class InvoiceStatusDto {
  @IsIn(['sent', 'received', 'checked', 'paid']) status!: 'sent' | 'received' | 'checked' | 'paid';
  @IsOptional() @IsString() @MaxLength(10) paidOn?: string;
  /** Needed to mark an incoming invoice as checked when its hours do not (all) match. */
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class CancelInvoiceDto {
  @MaxLength(500) @IsString() reason!: string;
}

export class CreditInvoiceDto {
  @MaxLength(500) @IsString() reason!: string;
  /** The number of the credit note: typed for an incoming one (it is on their document), the next number for an outgoing one when left out. */
  @IsOptional() @IsString() @MaxLength(60) number?: string;
  @IsOptional() @IsString() @MaxLength(10) invoiceDate?: string;
}

/* ── Questions ───────────────────────────────────────────────────────────────────────────────────────────────────── */

export class InvoiceListQuery extends ListQueryDto {
  @IsOptional() @IsIn(['incoming', 'outgoing']) direction?: InvoiceDirection;
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  /** The other party: a company id or a client id. */
  @IsOptional() @IsString() @MaxLength(60) partyId?: string;
  /** Invoices with a line for this worker. */
  @IsOptional() @IsString() @MaxLength(60) employeeId?: string;
  @IsOptional() @IsIn(['draft', 'sent', 'received', 'checked', 'paid', 'cancelled', 'all']) status?: string;
  /** `YYYY-MM`: invoices whose period touches that month. */
  @IsOptional() @IsString() @MaxLength(7) month?: string;
  @IsOptional() @IsString() @MaxLength(10) from?: string;
  @IsOptional() @IsString() @MaxLength(10) to?: string;
  /** Not paid yet (and not cancelled). */
  @IsOptional() @Transform(toBoolean) @IsBoolean() open?: boolean;
  /** Not paid and past the due date. */
  @IsOptional() @Transform(toBoolean) @IsBoolean() overdue?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) override pageSize: number = 25;
}

export class InvoiceExportQuery extends InvoiceListQuery {
  @IsOptional() @IsString() @MaxLength(10) format?: string;
}

/** The workers whose hours an invoice could bill: registered, not yet on an invoice of that direction. */
export class InvoiceWorkersQuery {
  @MaxLength(60) @IsString() clientId!: string;
  @IsIn(['incoming', 'outgoing']) direction!: InvoiceDirection;
  @MaxLength(10) @IsString() from!: string;
  @MaxLength(10) @IsString() to!: string;
  /** Only workers of this client's hirers; ignored for now (hours do not name a company). */
  @IsOptional() @IsString() @MaxLength(60) partyId?: string;
}

export class PartiesQuery {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
  /** A client the party may not be (the invoice's own client). */
  @IsOptional() @IsString() @MaxLength(60) exceptClientId?: string;
}

export class MarkupQuery {
  /** `YYYY-MM` — or `from` and `to`. */
  @IsOptional() @IsString() @MaxLength(7) month?: string;
  @IsOptional() @IsString() @MaxLength(10) from?: string;
  @IsOptional() @IsString() @MaxLength(10) to?: string;
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  @IsOptional() @IsString() @MaxLength(60) partyId?: string;
  @IsOptional() @IsIn(['incoming', 'outgoing']) direction?: InvoiceDirection;
  @IsOptional() @IsString() @MaxLength(10) format?: string;
}
