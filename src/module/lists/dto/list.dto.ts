import { IsArray, IsBoolean, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/** Badge colours the screens know (see the frontend's tones). */
export const TONES = ['neutral', 'brand', 'info', 'success', 'warning', 'clay', 'danger', 'plum'] as const;

export class CreateListDto {
  @IsString() @IsNotEmpty() @MaxLength(80) nameNl!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) nameEn!: string;
  @IsOptional() @IsString() @MaxLength(300) descriptionNl?: string;
  @IsOptional() @IsString() @MaxLength(300) descriptionEn?: string;
}

export class UpdateListDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) nameNl?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) nameEn?: string;
  @IsOptional() @IsString() @MaxLength(300) descriptionNl?: string;
  @IsOptional() @IsString() @MaxLength(300) descriptionEn?: string;
}

export class CreateListItemDto {
  @IsString() @IsNotEmpty() @MaxLength(80) nameNl!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) nameEn!: string;
  @IsOptional() @IsIn(TONES) tone?: string;
}

export class UpdateListItemDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) nameNl?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) nameEn?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsIn(TONES) tone?: string;
  /** Extra flags the program logic or screens use; unknown keys are ignored. */
  @IsOptional() @IsObject() meta?: Record<string, unknown>;
}

export class ReorderItemsDto {
  /** Every code of the list, in the new order. */
  @IsArray() @IsString({ each: true }) codes!: string[];
}
