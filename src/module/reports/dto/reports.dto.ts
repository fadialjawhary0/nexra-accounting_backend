import { ArrayMaxSize, IsArray, IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { EXPORT_FORMATS } from '../../../lib/exports/export.types.js';
import { PERIOD_KEYS } from '../report-period.js';

/** A saved way of exporting a report. */
export class CreatePresetDto {
  @IsString() @MaxLength(80) name!: string;
  @IsString() @MaxLength(60) reportKey!: string;
  @IsOptional() @IsIn(EXPORT_FORMATS) format?: string;
  /** `none` (the period is not part of the preset) or one of the ready-made periods; `custom` keeps the dates in `params`. */
  @IsOptional() @IsIn(['none', ...PERIOD_KEYS]) period?: string;
  /** The other choices of the report page, by parameter key (`client`, `status` …). */
  @IsOptional() @IsObject() params?: Record<string, string>;
  /** The columns to keep (the ids of the table's columns); none = all of them. */
  @IsOptional() @IsArray() @ArrayMaxSize(60) @IsString({ each: true }) @MaxLength(60, { each: true }) columns?: string[];
}

export class UpdatePresetDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsIn(EXPORT_FORMATS) format?: string;
  @IsOptional() @IsIn(['none', ...PERIOD_KEYS]) period?: string;
  @IsOptional() @IsObject() params?: Record<string, string>;
  @IsOptional() @IsArray() @ArrayMaxSize(60) @IsString({ each: true }) @MaxLength(60, { each: true }) columns?: string[];
}
