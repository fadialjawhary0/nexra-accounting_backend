import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto.js';
import { EXPORT_FORMATS } from '../../../lib/exports/export.types.js';
import { EXTENSION_STATUSES, MAX_BULK_ROWS, RETURN_KINDS, RETURN_STATUSES, VAT_KINDS } from '../taxes.constants.js';

const toBoolean = ({ value }: { value: unknown }) => (typeof value === 'string' ? ['true', '1', 'yes'].includes(value.toLowerCase()) : value);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/* ── VAT ──────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** What the VAT grid can be narrowed by. `period` (`2026-Q3`, `2026-09`, `2026`) says which period; without it every period of the client(s) is listed. */
export class VatListQuery extends ListQueryDto {
  /** Without a `period`: only this kind of period (`quarter`, `month`, `year`). */
  @IsOptional() @IsIn(VAT_KINDS) kind?: string;
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  /** The staff member responsible for the client, or `none` for clients nobody is responsible for. */
  @IsOptional() @IsString() @MaxLength(60) responsibleUserId?: string;
  /** Only rows that are not complete yet. */
  @IsOptional() @Transform(toBoolean) @IsBoolean() open?: boolean;
  /** Only rows that are past their deadline and not filed. */
  @IsOptional() @Transform(toBoolean) @IsBoolean() overdue?: boolean;
  /** `active` (default), `inactive` (switched off) or `all`. */
  @IsOptional() @IsIn(['active', 'inactive', 'all']) state?: string;
}

export class VatExportQuery extends VatListQuery {
  @IsOptional() @IsIn(EXPORT_FORMATS) format?: string;
}

/** The tabs of the tracker: which periods of a year exist and how far each is. */
export class VatOverviewQuery {
  @IsOptional() @IsIn(VAT_KINDS) kind?: string;
  @IsOptional() @Matches(/^\d{4}$/) year?: string;
}

/** Makes the rows of a period that does not have them yet (`2026-Q3`). */
export class VatGenerateDto {
  @IsString() @MaxLength(20) period!: string;
}

export class VatStepTickDto {
  @IsBoolean() done!: boolean;
}

/** Ticks (or takes away) the same steps for many rows at once. */
export class VatBulkDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_BULK_ROWS) @IsString({ each: true }) ids!: string[];
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @IsString({ each: true }) steps!: string[];
  @IsBoolean() done!: boolean;
}

export class VatPeriodUpdateDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

/** Switches a row off (it stays for history) or on again. */
export class ActiveDto {
  @IsBoolean() isActive!: boolean;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class CreateVatStepDto {
  @IsString() @MaxLength(80) nameNl!: string;
  @IsString() @MaxLength(80) nameEn!: string;
  @IsOptional() @IsString() @MaxLength(80) groupNl?: string;
  @IsOptional() @IsString() @MaxLength(80) groupEn?: string;
  @IsOptional() @IsBoolean() isFiling?: boolean;
}

export class UpdateVatStepDto {
  @IsOptional() @IsString() @MaxLength(80) nameNl?: string;
  @IsOptional() @IsString() @MaxLength(80) nameEn?: string;
  @IsOptional() @IsString() @MaxLength(80) groupNl?: string;
  @IsOptional() @IsString() @MaxLength(80) groupEn?: string;
  @IsOptional() @IsBoolean() isFiling?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ReorderStepsDto {
  @IsArray() @ArrayMaxSize(60) @IsString({ each: true }) ids!: string[];
}

/* ── Yearly returns ───────────────────────────────────────────────────────────────────────────────────────────────── */

export class ReturnListQuery extends ListQueryDto {
  @IsOptional() @IsIn(RETURN_KINDS) kind?: string;
  /** The year the return is about. */
  @IsOptional() @Matches(/^\d{4}$/) taxYear?: string;
  /** Codes of the `tax_return_status` list, comma separated. */
  @IsOptional() @IsString() @MaxLength(200) status?: string;
  /** Only returns that still have to be filed. */
  @IsOptional() @Transform(toBoolean) @IsBoolean() open?: boolean;
  /** `overdue` (past the deadline, not filed) or `soon` (due within 30 days). */
  @IsOptional() @IsIn(['overdue', 'soon']) due?: string;
  /** `any` (an extension was asked for), `none` (no extension) or one status of the `tax_extension_status` list. */
  @IsOptional() @IsIn([...EXTENSION_STATUSES, 'any', 'none']) extension?: string;
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  @IsOptional() @IsString() @MaxLength(60) personId?: string;
  @IsOptional() @IsString() @MaxLength(60) assigneeId?: string;
  @IsOptional() @IsIn(['active', 'inactive', 'all']) state?: string;
}

export class ReturnExportQuery extends ReturnListQuery {
  @IsOptional() @IsIn(EXPORT_FORMATS) format?: string;
}

export class CreateReturnDto {
  @IsIn(RETURN_KINDS) kind!: string;
  @IsString() @MaxLength(60) clientId!: string;
  /** Income tax: the owner or partner the return is for. */
  @IsOptional() @IsString() @MaxLength(60) personId?: string | null;
  @IsInt() @Min(2000) @Max(2100) taxYear!: number;
  /** A financial year that is not the calendar year (corporate tax). */
  @IsOptional() @Matches(DAY) periodStart?: string;
  @IsOptional() @Matches(DAY) periodEnd?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

/** Makes the returns of one tax year for every client that has income tax / corporate tax switched on. */
export class GenerateReturnsDto {
  @IsIn(RETURN_KINDS) kind!: string;
  @IsInt() @Min(2000) @Max(2100) taxYear!: number;
}

export class UpdateReturnDto {
  @IsOptional() @IsIn(RETURN_STATUSES) status?: string;
  @IsOptional() @IsString() @MaxLength(60) assigneeId?: string | null;
  @IsOptional() @Matches(DAY) filedOn?: string | null;
  /** The filed return: a document of the client. */
  @IsOptional() @IsString() @MaxLength(60) fileId?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @Matches(DAY) periodStart?: string;
  @IsOptional() @Matches(DAY) periodEnd?: string;
}

/** An extension: asked for, granted, refused — or taken away (`status: null`). */
export class ExtensionDto {
  @IsIn([...EXTENSION_STATUSES, null]) status!: string | null;
  @IsOptional() @Matches(DAY) requestedOn?: string | null;
  @IsOptional() @Matches(DAY) until?: string | null;
  /** The form that asked for it (a submission of the extension form of this client). */
  @IsOptional() @IsString() @MaxLength(60) submissionId?: string | null;
}

/* ── Employer registrations ───────────────────────────────────────────────────────────────────────────────────────── */

export class EmployerListQuery extends ListQueryDto {
  /** Codes of the `employer_registration_status` list, comma separated; by default everything that needs attention or is registered. */
  @IsOptional() @IsString() @MaxLength(200) state?: string;
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
}

export class EmployerExportQuery extends EmployerListQuery {
  @IsOptional() @IsIn(EXPORT_FORMATS) format?: string;
}
