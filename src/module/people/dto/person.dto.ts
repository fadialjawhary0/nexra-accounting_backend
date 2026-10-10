import { Type } from 'class-transformer';
import { IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** The values of the person form, by field key. On an update only what changed has to be sent: the rest of the record is kept. */
export class SavePersonDto {
  @IsObject() values!: Record<string, unknown>;
}

export class PersonLookupQuery {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit: number = 15;
}
