import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

const toBoolean = ({ value }: { value: unknown }) => (typeof value === 'string' ? ['true', '1', 'yes'].includes(value.toLowerCase()) : value);

/**
 * The query string every list endpoint understands. A feature extends it with its own filters:
 *   export class ClientListQuery extends ListQueryDto { @IsOptional() @IsString() status?: string }
 */
export class ListQueryDto {
  /** Free-text search (the feature decides which columns / `searchText` it looks at). */
  @IsOptional() @IsString() @MaxLength(200) search?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) pageSize: number = 10;

  /** `field:dir`, comma-separated for more than one — `name:asc`, `dueDate:desc,name:asc`. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z_][\w.]*(:(asc|desc))?(,[A-Za-z_][\w.]*(:(asc|desc))?)*$/)
  sort?: string;

  /** The period an overview is about; the feature parses it (`2026-Q1`, `2026-01-01..2026-03-31`). */
  @IsOptional() @IsString() @MaxLength(40) period?: string;

  /** Ask for the counters shown above the list (`meta.counts`). */
  @IsOptional() @Transform(toBoolean) @IsBoolean() stats?: boolean;
}
