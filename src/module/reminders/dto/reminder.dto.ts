import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class RecipientsDto {
  /** Everybody with one of these roles (`owner`, `medewerker` …). */
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(60, { each: true }) roles?: string[];
  /** These people (user ids). */
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(60, { each: true }) users?: string[];
  /** The staff member who is responsible for the client the reminder is about. */
  @IsOptional() @IsBoolean() responsible?: boolean;
}

export class CreateReminderRuleDto {
  /** A trigger a feature registered (`contract_end`, `contract_notice`, `probation_end`, `on_call_year`). */
  @IsString() @MaxLength(60) trigger!: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  /** Days before the date; several allowed (0 = on the day). */
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6) @IsInt({ each: true }) @Min(0, { each: true }) @Max(365, { each: true }) offsets!: number[];
  @IsIn(['calendar', 'working']) dayType!: 'calendar' | 'working';
  @ValidateNested() @Type(() => RecipientsDto) recipients!: RecipientsDto;
  @IsArray() @ArrayMinSize(1) @IsIn(['in_app', 'email'], { each: true }) channels!: Array<'in_app' | 'email'>;
}

export class UpdateReminderRuleDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6) @IsInt({ each: true }) @Min(0, { each: true }) @Max(365, { each: true }) offsets?: number[];
  @IsOptional() @IsIn(['calendar', 'working']) dayType?: 'calendar' | 'working';
  @IsOptional() @ValidateNested() @Type(() => RecipientsDto) recipients?: RecipientsDto;
  @IsOptional() @IsArray() @ArrayMinSize(1) @IsIn(['in_app', 'email'], { each: true }) channels?: Array<'in_app' | 'email'>;
}

export class UpcomingQuery {
  @IsString() @MaxLength(40) subjectType!: string;
  @IsString() @MaxLength(60) subjectId!: string;
}
