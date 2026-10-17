import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto.js';

/** The list's own filters. Filters on form fields come as `f.<field key>`. */
export class ContractListQuery extends ListQueryDto {
  /** One or more codes of the `contract_status` list, comma-separated. */
  @IsOptional() @IsString() @MaxLength(100) status?: string;
  /** One or more codes of the `contract_type` list, comma-separated. */
  @IsOptional() @IsString() @MaxLength(100) type?: string;
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  @IsOptional() @IsString() @MaxLength(60) employeeId?: string;
  /** `true` = only active contracts (draft, sent, running); `false` = only the ones that are history. */
  @IsOptional() @IsString() @MaxLength(5) isActive?: string;
  /** `true` — running contracts that end within the warning period (Settings → Contracts). */
  @IsOptional() @IsString() @MaxLength(5) expiring?: string;
  /** `true` — running contracts that have no signed copy on file. */
  @IsOptional() @IsString() @MaxLength(5) unsigned?: string;
}

export class ContractExportQuery extends ContractListQuery {
  /** The grid's columns, in order: form-field keys plus `@client`, `@worker`, `@status`, `@duration` … */
  @IsOptional() @IsString() @MaxLength(3000) columns?: string;
}

export class CreateContractDto {
  @IsString() @MaxLength(60) clientId!: string;
  @IsString() @MaxLength(60) employeeId!: string;
  /** The template the contract is made from (optional: a contract that already exists on paper has none). */
  @IsOptional() @IsString() @MaxLength(60) templateId?: string;
  /** The contract this one continues. */
  @IsOptional() @IsString() @MaxLength(60) renewalOfId?: string;
  /** The contract form. */
  @IsObject() values!: Record<string, unknown>;
  /** Also make the Word and PDF document now (needs a template). */
  @IsOptional() @IsBoolean() generate?: boolean;
}

export class UpdateContractDto {
  @IsObject() values!: Record<string, unknown>;
}

/** The same input as creating, without saving anything: "what would you say about this contract?". */
export class CheckContractDto {
  @IsString() @MaxLength(60) clientId!: string;
  @IsString() @MaxLength(60) employeeId!: string;
  @IsObject() values!: Record<string, unknown>;
  /** The contract that is being edited. */
  @IsOptional() @IsString() @MaxLength(60) excludeId?: string;
}

export class GenerateContractDto {
  @IsOptional() @IsString() @MaxLength(60) templateId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) version?: number;
}

export class LetterDto {
  @IsString() @MaxLength(60) templateId!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) version?: number;
}

export class ContractPreviewQuery {
  @IsOptional() @IsString() @MaxLength(60) templateId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) version?: number;
  @IsOptional() @IsIn(['pdf', 'docx']) format?: 'pdf' | 'docx';
}

export class SendContractDto {
  /** The day it was given to the worker (`YYYY-MM-DD`), today when left out. */
  @IsOptional() @IsString() @MaxLength(10) date?: string;
}

export class SignContractDto {
  /** The day it was signed (`YYYY-MM-DD`), the signing date of the contract (or today) when left out. */
  @IsOptional() @IsString() @MaxLength(10) signedOn?: string;
  /** The signed copy, uploaded with `POST /files` (`purpose=contract_scan`). */
  @IsOptional() @IsString() @MaxLength(60) fileId?: string;
}

export class ScanDto {
  @IsString() @MaxLength(60) fileId!: string;
}

export class TerminateContractDto {
  /** The last day (`YYYY-MM-DD`). */
  @IsString() @MaxLength(10) date!: string;
  /** Code of the `termination_reason` list. */
  @IsString() @MaxLength(40) reason!: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  /** Also make the termination letter from this template. */
  @IsOptional() @IsString() @MaxLength(60) letterTemplateId?: string;
  /** Also mark the worker as left (when they have no other open contract). */
  @IsOptional() @IsBoolean() stopEmployee?: boolean;
}

export class CancelContractDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class RenewContractDto {
  /** The first day of the new contract; the day after the old one ends when left out. */
  @IsOptional() @IsString() @MaxLength(10) startDate?: string;
  @IsOptional() @IsString() @MaxLength(10) endDate?: string;
  /** Another template than the one of the old contract. */
  @IsOptional() @IsString() @MaxLength(60) templateId?: string;
  /** Also make the Word and PDF document now. */
  @IsOptional() @IsBoolean() generate?: boolean;
}
