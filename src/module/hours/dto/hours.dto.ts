import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto.js';

const toBoolean = ({ value }: { value: unknown }) => (typeof value === 'string' ? ['true', '1', 'yes'].includes(value.toLowerCase()) : value);

/* ── The week grid ───────────────────────────────────────────────────────────────────────────────────────────────── */

export class WeekQuery extends ListQueryDto {
  /** Any day of the week to show (the grid starts on its Monday); this week when left out. */
  @IsOptional() @IsString() @MaxLength(10) from?: string;
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  /** Only the workers who have hours this week. */
  @IsOptional() @Transform(toBoolean) @IsBoolean() withHours?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) override pageSize: number = 50;
}

export class CellDto {
  @MaxLength(60) @IsString() employeeId!: string;
  @MaxLength(10) @IsString() date!: string;
  /** Worked minutes of that day; `null` or 0 clears the day. */
  @IsOptional() @IsInt() @Min(0) @Max(1440) minutes?: number | null;
}

export class SaveCellsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => CellDto) cells!: CellDto[];
  /** Why closed days are changed (needed when a cell lies in a closed period). */
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class CopyWeekDto {
  /** Any day of the week to copy from / to. */
  @MaxLength(10) @IsString() from!: string;
  @MaxLength(10) @IsString() to!: string;
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) employeeIds?: string[];
}

/* ── Entries (the details of a day) ──────────────────────────────────────────────────────────────────────────────── */

export class EntryListQuery extends ListQueryDto {
  @IsOptional() @IsString() @MaxLength(60) employeeId?: string;
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  @IsOptional() @IsString() @MaxLength(10) from?: string;
  @IsOptional() @IsString() @MaxLength(10) to?: string;
}

export class EntryExportQuery extends EntryListQuery {
  @IsOptional() @IsString() @MaxLength(10) format?: string;
}

export class CreateEntryDto {
  @MaxLength(60) @IsString() employeeId!: string;
  @MaxLength(10) @IsString() date!: string;
  /** Worked minutes (break already taken off) — or give `startTime` and `endTime` and they are calculated. */
  @IsOptional() @IsInt() @Min(1) @Max(1440) minutes?: number;
  @IsOptional() @IsString() @MaxLength(5) startTime?: string;
  @IsOptional() @IsString() @MaxLength(5) endTime?: string;
  @IsOptional() @IsInt() @Min(0) @Max(720) breakMinutes?: number;
  /** The `hour_entry` form: where, for which hirer, a note … */
  @IsOptional() @IsObject() values?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class UpdateEntryDto {
  @IsOptional() @IsInt() @Min(1) @Max(1440) minutes?: number;
  /** `null` clears the clock times. */
  @IsOptional() @IsString() @MaxLength(5) startTime?: string | null;
  @IsOptional() @IsString() @MaxLength(5) endTime?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(720) breakMinutes?: number;
  @IsOptional() @IsObject() values?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class MonthQuery {
  @MaxLength(60) @IsString() employeeId!: string;
  /** `YYYY-MM`. */
  @MaxLength(7) @IsString() month!: string;
}

export class RepriceDto {
  @MaxLength(60) @IsString() employeeId!: string;
  @IsOptional() @IsString() @MaxLength(10) from?: string;
}

/* ── Closing periods ─────────────────────────────────────────────────────────────────────────────────────────────── */

export class LockListQuery {
  @IsOptional() @IsString() @MaxLength(60) employeeId?: string;
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  @IsOptional() @IsString() @MaxLength(10) from?: string;
  @IsOptional() @IsString() @MaxLength(10) to?: string;
}

export class ClosePeriodDto {
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @IsString({ each: true }) employeeIds?: string[];
  /** Every worker of this client who was employed in the period. */
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  /** `YYYY-MM` — or give `from` and `to`. */
  @IsOptional() @IsString() @MaxLength(7) month?: string;
  @IsOptional() @IsString() @MaxLength(10) from?: string;
  @IsOptional() @IsString() @MaxLength(10) to?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  /** Why the period is closed although hours, pay and invoices do not match (needed when they do not). */
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class ReleaseLockDto {
  @MaxLength(500) @IsString() reason!: string;
}

/* ── Surcharge rules ─────────────────────────────────────────────────────────────────────────────────────────────── */

export class SurchargeRuleDto {
  @MaxLength(120) @IsString() name!: string;
  @IsIn(['weekend', 'holiday', 'overtime', 'evening']) kind!: 'weekend' | 'holiday' | 'overtime' | 'evening';
  /** weekend — `{ days: ['sat'] }` · overtime — `{ per: 'day' | 'week', afterMinutes: 480 }` · evening — `{ from: '20:00', to: '24:00' }`. */
  @IsOptional() @IsObject() conditions?: Record<string, unknown>;
  /** Added to the hourly rate: 25 = + 25 %. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1000) percent?: number | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1000) amountPerHour?: number | null;
  @IsOptional() @IsString() @MaxLength(60) clientId?: string | null;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateSurchargeRuleDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsIn(['weekend', 'holiday', 'overtime', 'evening']) kind?: 'weekend' | 'holiday' | 'overtime' | 'evening';
  @IsOptional() @IsObject() conditions?: Record<string, unknown>;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1000) percent?: number | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1000) amountPerHour?: number | null;
  @IsOptional() @IsString() @MaxLength(60) clientId?: string | null;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
