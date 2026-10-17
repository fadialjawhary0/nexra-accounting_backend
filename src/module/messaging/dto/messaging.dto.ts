import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class MessageTemplateQuery {
  @IsOptional() @IsIn(['contract']) scope?: 'contract';
  @IsOptional() @IsIn(['worker', 'client']) audience?: 'worker' | 'client';
  /** `true` also lists the ones that are switched off (Settings). */
  @IsOptional() @IsString() @MaxLength(5) all?: string;
}

export class CreateMessageTemplateDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsString() @MinLength(1) @MaxLength(1500) bodyNl!: string;
  @IsString() @MinLength(1) @MaxLength(1500) bodyEn!: string;
  @IsOptional() @IsIn(['worker', 'client']) audience?: 'worker' | 'client';
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100000) sortOrder?: number;
}

export class UpdateMessageTemplateDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(1500) bodyNl?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(1500) bodyEn?: string;
  @IsOptional() @IsIn(['worker', 'client']) audience?: 'worker' | 'client';
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100000) sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/** "Open WhatsApp": the message from a template, filled in with a contract, and the link that opens the chat. */
export class WhatsAppLinkDto {
  /** A template id, or its code (`contract_ending`). */
  @IsOptional() @IsString() @MaxLength(60) templateId?: string;
  @IsOptional() @IsString() @MaxLength(60) templateCode?: string;
  @IsString() @MaxLength(60) contractId!: string;
  /** Who the chat is with; the template's own audience when left out. */
  @IsOptional() @IsIn(['worker', 'client']) to?: 'worker' | 'client';
  @IsOptional() @IsIn(['nl', 'en']) language?: 'nl' | 'en';
}
