import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto.js';

/** The list's own filters. Filters on form fields come as `f.<field key>` (employee form) or `f.person.<field key>` (person form). */
export class EmployeeListQuery extends ListQueryDto {
  /** `active`, `stopped`, or both (comma-separated). */
  @IsOptional() @IsString() @MaxLength(40) status?: string;
  /** `true` — only active workers with an ID document or permit that has expired or expires soon (for people who may see those dates). */
  @IsOptional() @IsString() @MaxLength(5) expiring?: string;
}

/** The grid's own query plus the columns to export. */
export class EmployeeExportQuery extends EmployeeListQuery {
  /**
   * The grid's columns, in order: employee-form keys, `person.<key>` for person-form keys, plus `@name`, `@client`, `@status`. Left out, Excel
   * gets every field the forms mark "export" and PDF / Word the fields the forms mark "list" (a page cannot hold more).
   */
  @IsOptional() @IsString() @MaxLength(3000) columns?: string;
}

/** Who the worker is: an existing person, or the values of the person form for a new one. */
export class PersonInputDto {
  @IsOptional() @IsString() @MaxLength(60) personId?: string;
  @IsOptional() @IsObject() values?: Record<string, unknown>;
}

export class CreateEmployeeDto {
  /** The employee form (client, function, dates, hourly rate …). */
  @IsObject() values!: Record<string, unknown>;
  @IsObject() person!: PersonInputDto;
}

export class UpdateEmployeeDto {
  /** What changed in the employee form. */
  @IsOptional() @IsObject() values?: Record<string, unknown>;
  /** What changed in the person's own details (the person form). */
  @IsOptional() @IsObject() person?: { values?: Record<string, unknown> };
}

export class SetEmployeeStatusDto {
  @IsIn(['active', 'stopped']) status!: 'active' | 'stopped';
  /** Why the worker left (optional, shown on the worker's page). */
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  /** The last day of the employment (`YYYY-MM-DD`), today when left out. */
  @IsOptional() @IsString() @MaxLength(10) date?: string;
}

export class AddRateDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100000) rate!: number;
  /** The first day the rate applies (`YYYY-MM-DD`). */
  @IsString() @MaxLength(10) validFrom!: string;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

export class EmployeeLookupQuery {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  /** Only the workers of this client. */
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  /** `true` also lists workers who left. */
  @IsOptional() @IsString() @MaxLength(5) includeStopped?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) limit: number = 30;
}
