import { IsArray, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { EXPORT_FORMATS } from '../../../lib/exports/export.types.js';

/** A new checklist: its names and the kinds of inspection it is the starting point for. It begins as an empty first edition (a draft). */
export class CreateTemplateDto {
  /** A short name for the program (`nen4400_1`); made from the English name when empty. */
  @IsOptional() @IsString() @Matches(/^[a-z0-9_]{2,40}$/) code?: string;
  @IsString() @MaxLength(100) nameNl!: string;
  @IsString() @MaxLength(100) nameEn!: string;
  @IsOptional() @IsString() @MaxLength(500) descriptionNl?: string;
  @IsOptional() @IsString() @MaxLength(500) descriptionEn?: string;
  /** Codes of the `inspection_type` list. */
  @IsOptional() @IsArray() @IsString({ each: true }) inspectionTypes?: string[];
}

export class UpdateTemplateDto {
  @IsOptional() @IsString() @MaxLength(100) nameNl?: string;
  @IsOptional() @IsString() @MaxLength(100) nameEn?: string;
  @IsOptional() @IsString() @MaxLength(500) descriptionNl?: string;
  @IsOptional() @IsString() @MaxLength(500) descriptionEn?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) inspectionTypes?: string[];
}

/** Starts a new edition as a copy of the latest published one (or of `fromVersionId`). */
export class NewDraftDto {
  @IsOptional() @IsString() @MaxLength(60) fromVersionId?: string;
}

/** The draft as the editor sends it: the texts of the edition and its parts and lines (checked in `sanitizeDoc`, which names every problem under its own key). */
export class SaveVersionDto {
  @IsOptional() @IsString() @MaxLength(120) label?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsArray() sections?: unknown[];
  @IsOptional() @IsArray() items?: unknown[];
}

export class TemplateExportQuery {
  @IsOptional() @IsIn(EXPORT_FORMATS) format?: string;
}
