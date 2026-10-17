import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto.js';

export class TemplateListQuery extends ListQueryDto {
  /** `template_kind` code. */
  @IsOptional() @IsString() @MaxLength(40) kind?: string;
  @IsOptional() @IsString() @MaxLength(40) contractType?: string;
  @IsOptional() @IsIn(['office', 'client']) scope?: 'office' | 'client';
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  @IsOptional() @IsIn(['nl', 'en']) language?: 'nl' | 'en';
  /** `active` (default), `inactive`, or `all`. */
  @IsOptional() @IsIn(['active', 'inactive', 'all']) status?: 'active' | 'inactive' | 'all';
}

/** For pickers (the contract wizard, the letter dialogs): the active templates that fit. */
export class TemplateLookupQuery {
  @IsOptional() @IsString() @MaxLength(40) kind?: string;
  @IsOptional() @IsString() @MaxLength(40) contractType?: string;
  /** Office templates plus the ones made for this client. */
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  @IsOptional() @IsIn(['nl', 'en']) language?: 'nl' | 'en';
}

export class CreateTemplateDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsString() @MaxLength(40) kind!: string;
  @IsOptional() @IsIn(['office', 'client']) scope?: 'office' | 'client';
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  @IsOptional() @IsIn(['nl', 'en']) language?: 'nl' | 'en';
  @IsOptional() @IsString() @MaxLength(40) contractType?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  /** The uploaded Word file (`POST /files` with `purpose=template`). */
  @IsString() @MaxLength(60) fileId!: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class UpdateTemplateDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(40) kind?: string;
  @IsOptional() @IsIn(['office', 'client']) scope?: 'office' | 'client';
  @IsOptional() @IsString() @MaxLength(60) clientId?: string | null;
  @IsOptional() @IsIn(['nl', 'en']) language?: 'nl' | 'en';
  @IsOptional() @IsString() @MaxLength(40) contractType?: string | null;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}

export class AddTemplateVersionDto {
  @IsString() @MaxLength(60) fileId!: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class InspectTemplateDto {
  @IsString() @MaxLength(60) fileId!: string;
  /** The kind the file is for: a salary-statement template has other merge fields than a contract. */
  @IsOptional() @IsString() @MaxLength(40) kind?: string;
}

export class SetTemplateStatusDto {
  @IsIn(['active', 'inactive']) status!: 'active' | 'inactive';
}

export class TemplatePreviewQuery {
  @IsOptional() @IsIn(['pdf', 'docx']) format?: 'pdf' | 'docx';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) version?: number;
}
