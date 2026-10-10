import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto.js';

/**
 * The list's own filters. Filters on form fields come as `f.<field key>=value` and are read from the raw query (see
 * `readFieldFilters`): the keys are admin-defined, so a DTO cannot name them.
 */
export class ClientListQuery extends ListQueryDto {
  /** `active`, `stopped`, or both (comma-separated). */
  @IsOptional() @IsString() @MaxLength(40) status?: string;
}

/** The values of the client form, by field key. On an update only what changed has to be sent: the rest of the record is kept. */
export class SaveClientDto {
  @IsObject() values!: Record<string, unknown>;
}

export class SetClientStatusDto {
  @IsIn(['active', 'stopped']) status!: 'active' | 'stopped';
  /** Why the client stopped (optional, shown on the client page). */
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  /** The day the client stopped (`YYYY-MM-DD`), today when left out. */
  @IsOptional() @IsString() @MaxLength(10) date?: string;
  /** Also stop the client's active workers (their last day is the day the client stopped). Needs the permission to stop workers. */
  @IsOptional() @IsBoolean() stopWorkers?: boolean;
}

/** The grid's own query plus the columns to export. */
export class ClientExportQuery extends ClientListQuery {
  /**
   * The grid's columns, in order: field keys, plus `@people`, `@status`, `@stoppedOn`. Left out, Excel gets every field the form marks
   * "export" and PDF / Word the fields the form marks "list" (a page cannot hold more).
   */
  @IsOptional() @IsString() @MaxLength(2000) columns?: string;
}

export class ClientLookupQuery {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) limit: number = 20;
  /** Ids that must be in the answer whatever the search says (the ones already chosen). */
  @IsOptional() @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.split(',').filter(Boolean).slice(0, 50) : value)) @IsString({ each: true }) ids?: string[];
}

/** Link a person to a client: an existing one (`personId`) or a new one made from `values` (the person form). */
export class AddPersonDto {
  @IsOptional() @IsString() @MaxLength(60) personId?: string;
  @IsOptional() @IsObject() values?: Record<string, unknown>;
  @IsString() @MaxLength(40) role!: string;
  @IsOptional() @IsString() @MaxLength(10) startedOn?: string;
}

export class UpdatePersonLinkDto {
  @IsOptional() @IsString() @MaxLength(40) role?: string;
  @IsOptional() @IsString() @MaxLength(10) startedOn?: string | null;
  /** The day the role ended; `null` makes it current again. */
  @IsOptional() @IsString() @MaxLength(10) endedOn?: string | null;
}

export class AddRelationDto {
  @IsString() @MaxLength(60) relatedId!: string;
  /** From the viewpoint of this client: the other one is its `parent` (holding), its `subsidiary`, or in the same `group`. */
  @IsIn(['parent', 'subsidiary', 'group']) kind!: 'parent' | 'subsidiary' | 'group';
}

export class CreateFolderDto {
  @IsOptional() @IsString() @MaxLength(60) parentId?: string;
  @IsString() @MaxLength(100) name!: string;
}

export class RenameFolderDto {
  @IsString() @MaxLength(100) name!: string;
}

export class DataQualityQuery extends ListQueryDto {
  @IsOptional() @IsString() @MaxLength(40) status?: string;
}
