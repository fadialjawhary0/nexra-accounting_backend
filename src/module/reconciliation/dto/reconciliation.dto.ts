import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto.js';
import type { WorkKind } from '../../employees/employee-record.js';

export class ReconciliationQuery extends ListQueryDto {
  /** `YYYY-MM` — or `from` and `to`. */
  @IsOptional() @IsString() @MaxLength(7) month?: string;
  @IsOptional() @IsString() @MaxLength(10) from?: string;
  @IsOptional() @IsString() @MaxLength(10) to?: string;
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  /** `differences` shows only what does not match. */
  @IsOptional() @IsIn(['all', 'ok', 'differences']) status?: 'all' | 'ok' | 'differences';
  @IsOptional() @IsIn(['own', 'hired_out', 'hired_in']) kind?: WorkKind;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) override pageSize: number = 50;
}

export class ReconciliationExportQuery extends ReconciliationQuery {
  @IsOptional() @IsString() @MaxLength(10) format?: string;
}
