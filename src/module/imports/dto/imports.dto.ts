import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto.js';
import { DUPLICATE_POLICIES, MAX_INSTRUCTION_LENGTH, SHEET_TARGETS, type DuplicatePolicy, type SheetTarget } from '../imports.constants.js';

const toBoolean = ({ value }: { value: unknown }) => (typeof value === 'string' ? ['true', '1', 'yes'].includes(value.toLowerCase()) : value);

/* ── Imports (jobs) ──────────────────────────────────────────────────────────────────────────────────────────────── */

export class JobListQuery extends ListQueryDto {
  /** `spreadsheet`, `documents` or `inbox` (comma-separated for more than one). */
  @IsOptional() @IsString() @MaxLength(40) kind?: string;
  /** One or more job statuses, comma-separated. */
  @IsOptional() @IsString() @MaxLength(100) status?: string;
  /** Only what the signed-in person started (the inbox on the dashboard shows one's own messages). */
  @IsOptional() @Transform(toBoolean) @IsBoolean() mine?: boolean;
}

/** A new import of files (one, many, a folder or a ZIP — the files themselves follow in batches). */
export class CreateDocumentsJobDto {
  @IsOptional() @IsString() @MaxLength(150) name?: string;
  /** Every file belongs to this client (otherwise the folder names and the files themselves say which). */
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  /** Leave out files that are in the system already (same content). Default: the setting of Settings → Import. */
  @IsOptional() @IsBoolean() skipKnownFiles?: boolean;
  /** Let the AI read the files. Default: on when the AI is set up. */
  @IsOptional() @IsBoolean() readWithAi?: boolean;
}

/** A message to the AI inbox: what the person wants done, in their own words. Files follow with `POST :id/files`, then `POST :id/start`. */
export class CreateInboxDto {
  @IsString() @MaxLength(MAX_INSTRUCTION_LENGTH) instruction!: string;
}

export class ItemListQuery extends ListQueryDto {
  /** One or more item statuses, comma-separated. */
  @IsOptional() @IsString() @MaxLength(120) status?: string;
  @IsOptional() @IsString() @MaxLength(60) docType?: string;
  /** `true` — only items with problems (errors or warnings). */
  @IsOptional() @Transform(toBoolean) @IsBoolean() attention?: boolean;
}

/** What a person changes on an item in the review list; every part is optional. */
export class PatchItemDto {
  /** Values per record: `{ person: { last_name: 'Jansen' } }`; `null` clears a value. */
  @IsOptional() @IsObject() data?: Record<string, Record<string, unknown>>;
  @IsOptional() @IsString() @MaxLength(60) docType?: string;
  /** The client the document belongs to (`null` = none yet). */
  @IsOptional() @IsString() @MaxLength(60) clientId?: string | null;
  @IsOptional() @IsString() @MaxLength(60) employeeId?: string | null;
  @IsOptional() @IsString() @MaxLength(60) personId?: string | null;
  /** `create` · `update` · `attach` (only file the document) · `skip`. */
  @IsOptional() @IsIn(['create', 'update', 'attach', 'skip']) action?: string;
}

export class AcceptAllDto {
  /** Only these items; left out: every item that is safe to accept (no problems, confident enough). */
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @IsString({ each: true }) itemIds?: string[];
}

/* ── Spreadsheets ────────────────────────────────────────────────────────────────────────────────────────────────── */

export class SheetQuery {
  @IsOptional() @IsString() @MaxLength(100) sheet?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(200) headerRow?: number;
  @IsOptional() @IsIn(SHEET_TARGETS) target?: SheetTarget;
  /** Read the columns with this saved layout instead of the one that looks most like the sheet. */
  @IsOptional() @IsString() @MaxLength(60) mappingId?: string;
}

export class MappingColumnDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(200) index!: number;
  @IsString() @MaxLength(200) header!: string;
  /** `client.name`, `person.first_name`, `client.@address` … or `null` to leave the column out. */
  @IsOptional() @IsString() @MaxLength(80) field!: string | null;
}

export class SheetSetupDto {
  @IsIn(SHEET_TARGETS) target!: SheetTarget;
  @IsString() @MaxLength(100) sheet!: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(200) headerRow!: number;
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => MappingColumnDto) mapping!: MappingColumnDto[];
  /** What a row does when the record exists already. Default: the setting of Settings → Import. */
  @IsOptional() @IsIn(DUPLICATE_POLICIES) duplicates?: DuplicatePolicy;
  /** The rows are stopped (inactive) clients or workers. */
  @IsOptional() @IsBoolean() stopped?: boolean;
  /** Employees and hours: every row belongs to this client. */
  @IsOptional() @IsString() @MaxLength(60) clientId?: string | null;
  /** A value for every row where the column is empty: `{ 'client.legal_form': 'eenmanszaak' }`. */
  @IsOptional() @IsObject() defaults?: Record<string, unknown>;
  /** Hours: `list` (a row per day) or `grid` (a row per worker, a column per day). */
  @IsOptional() @IsIn(['list', 'grid']) layout?: 'list' | 'grid';
  /** Hours in a grid with weekday headings: the Monday of the week the sheet is about (`YYYY-MM-DD`). */
  @IsOptional() @IsString() @MaxLength(10) weekStart?: string | null;
  /** Client rows: the role of the person in the row (a code of the `person_role` list); the legal form decides when left out. */
  @IsOptional() @IsString() @MaxLength(40) personRole?: string | null;
  /** Remember this mapping under this name: the next sheet with the same headings gets it suggested. */
  @IsOptional() @IsString() @MaxLength(100) saveAs?: string | null;
}

/* ── Saved mappings ──────────────────────────────────────────────────────────────────────────────────────────────── */

export class SavedColumnDto {
  @IsString() @MaxLength(200) header!: string;
  @IsOptional() @IsString() @MaxLength(80) field!: string | null;
}

export class SaveMappingDto {
  @IsString() @MaxLength(100) name!: string;
  @IsIn(SHEET_TARGETS) target!: SheetTarget;
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => SavedColumnDto) columns!: SavedColumnDto[];
  @IsOptional() @IsObject() options?: Record<string, unknown>;
}

export class UpdateMappingDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => SavedColumnDto) columns?: SavedColumnDto[];
  @IsOptional() @IsObject() options?: Record<string, unknown>;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class MappingListQuery {
  @IsOptional() @IsIn(SHEET_TARGETS) target?: SheetTarget;
}

export type { DuplicatePolicy };
