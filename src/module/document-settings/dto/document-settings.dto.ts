import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { DOCUMENT_SCOPES, REQUIREMENT_SCOPES, VALIDITY_KINDS } from '../document-settings.constants.js';

/** A stable code: lower-case letters, digits and `_`. */
const CODE = /^[a-z][a-z0-9_]{1,39}$/;

const toBoolean = ({ value }: { value: unknown }) => (typeof value === 'string' ? ['true', '1', 'yes'].includes(value.toLowerCase()) : value);

/* ── Document types ──────────────────────────────────────────────────────────────────────────────────────────────── */

export class DocumentTypeDto {
  /** Only when a type is made; it never changes afterwards. */
  @IsOptional() @IsString() @Matches(CODE) code?: string;
  @IsString() @MinLength(1) @MaxLength(80) nameNl!: string;
  @IsString() @MinLength(1) @MaxLength(80) nameEn!: string;
  @IsIn(DOCUMENT_SCOPES) scope!: string;
  @IsIn(VALIDITY_KINDS) validity!: string;
  /** `age`: how many months the document is good for. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(240) validityMonths?: number | null;
  /** `field`: the person-form field that holds the end date. */
  @IsOptional() @IsString() @MaxLength(40) validityField?: string | null;
  /** Days before the end the document counts as "expiring"; empty = the office-wide setting. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) warnDays?: number | null;
  @IsOptional() @IsBoolean() versioned?: boolean;
  @IsOptional() @IsBoolean() personal?: boolean;
  /** A code of the folder template. */
  @IsOptional() @IsString() @MaxLength(40) folderCode?: string | null;
  @IsOptional() @IsString() @MaxLength(120) namePattern?: string;
  @IsOptional() @IsString() @MaxLength(300) keywords?: string;
}

export class DocumentTypeListQuery {
  /** `true` = only types that are switched on (what the pick-lists of the screens use). */
  @IsOptional() @Transform(toBoolean) @IsBoolean() active?: boolean;
}

export class OrderDto {
  @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) ids!: string[];
}

export class NamePreviewDto {
  @IsString() @MaxLength(120) pattern!: string;
  /** The type whose name is used in the example. */
  @IsOptional() @IsString() @MaxLength(40) typeCode?: string;
}

/* ── Folder template ─────────────────────────────────────────────────────────────────────────────────────────────── */

export class FolderTemplateDto {
  @IsOptional() @IsString() @Matches(CODE) code?: string;
  @IsString() @MinLength(1) @MaxLength(80) nameNl!: string;
  @IsString() @MinLength(1) @MaxLength(80) nameEn!: string;
  /** The standard folder this one sits in; empty = directly in the client's folder. */
  @IsOptional() @IsString() @MaxLength(40) parentCode?: string | null;
}

export class ApplyTemplateDto {
  /** One client; without it every client that is not stopped. */
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
}

/* ── Required documents ──────────────────────────────────────────────────────────────────────────────────────────── */

export class RequiredDocumentDto {
  @IsString() @MaxLength(40) typeCode!: string;
  @IsIn(REQUIREMENT_SCOPES) scope!: string;
  /** Who it applies to, in the condition language of the form builder over `client.*`, `employee.*` and `person.*` fields; empty = everybody of the scope. */
  @IsOptional() @IsObject() condition?: Record<string, unknown> | null;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
