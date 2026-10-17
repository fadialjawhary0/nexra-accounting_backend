import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto.js';

export class StatementListQuery extends ListQueryDto {
  @IsOptional() @IsString() @MaxLength(60) employeeId?: string;
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  /** `final` (default), `cancelled` or `all`. */
  @IsOptional() @IsIn(['final', 'cancelled', 'all']) status?: 'final' | 'cancelled' | 'all';
  /** `YYYY-MM`: statements that cover a day of that month. */
  @IsOptional() @IsString() @MaxLength(7) month?: string;
  @IsOptional() @IsString() @MaxLength(10) from?: string;
  @IsOptional() @IsString() @MaxLength(10) to?: string;
}

export class StatementExportQuery extends StatementListQuery {
  @IsOptional() @IsString() @MaxLength(10) format?: string;
}

export class StatementPreviewQuery {
  @MaxLength(60) @IsString() employeeId!: string;
  @MaxLength(10) @IsString() from!: string;
  @MaxLength(10) @IsString() to!: string;
}

export class CandidatesQuery {
  @MaxLength(60) @IsString() clientId!: string;
  @MaxLength(10) @IsString() from!: string;
  @MaxLength(10) @IsString() to!: string;
}

export class CreateStatementDto {
  @MaxLength(60) @IsString() employeeId!: string;
  @MaxLength(10) @IsString() from!: string;
  @MaxLength(10) @IsString() to!: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class CancelStatementDto {
  @MaxLength(500) @IsString() reason!: string;
}
