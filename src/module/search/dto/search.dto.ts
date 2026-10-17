import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class SearchQuery {
  /** What to look for: at least two characters. */
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  /** The most hits per group. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) limit?: number;
}
