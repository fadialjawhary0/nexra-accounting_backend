import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto.js';

/** `GET /activity?entityType=user&entityId=…&action=updated,deleted&actorId=…&from=2026-10-01&to=2026-10-31&search=…` */
export class ActivityListQuery extends ListQueryDto {
  /** One or more (comma-separated) record types: `user`, `role`, `client`, … */
  @IsOptional() @IsString() @MaxLength(200) entityType?: string;
  @IsOptional() @IsString() @MaxLength(60) entityId?: string;
  /** One or more (comma-separated) actions: `created`, `updated`, `signed_in`, … */
  @IsOptional() @IsString() @MaxLength(200) action?: string;
  @IsOptional() @IsString() @MaxLength(60) actorId?: string;
  /** First day (inclusive), `YYYY-MM-DD`. */
  @IsOptional() @IsDateString() from?: string;
  /** Last day (inclusive), `YYYY-MM-DD`. */
  @IsOptional() @IsDateString() to?: string;
}
