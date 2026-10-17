import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto.js';

export class NotificationListQuery extends ListQueryDto {
  /** `true` = read ones only, `false` = unread only. */
  @IsOptional() @IsString() @MaxLength(5) read?: string;
  /** One or more codes of the `notification_type` list, comma-separated. */
  @IsOptional() @IsString() @MaxLength(200) type?: string;
  @IsOptional() @IsString() @MaxLength(100) severity?: string;
}

export class MarkAllReadDto {
  /** Only these types (comma-separated); everything when left out. */
  @IsOptional() @IsString() @MaxLength(200) type?: string;
}
