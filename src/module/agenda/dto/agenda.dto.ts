import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { DAY_PATTERN } from '../../../common/dates.js';
import { MAX_GUESTS, MAX_REMINDER_MINUTES, STORED_EVENT_TYPES } from '../agenda.constants.js';

/** What the calendar page asks for: the days on screen, optionally narrowed to some kinds of entry or one client. */
export class FeedQuery {
  @IsOptional() @Matches(DAY_PATTERN) from?: string;
  @IsOptional() @Matches(DAY_PATTERN) to?: string;
  /** Kinds of entry to show (`meeting,deadline`), comma separated; the counts in `meta.counts` ignore this filter. */
  @IsOptional() @IsString() @MaxLength(200) types?: string;
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
}

export class PeopleQuery {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
}

/** A guest: a colleague (found by e-mail address) or somebody outside the office. */
export class GuestDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(200) email?: string;
}

export class CreateEventDto {
  @IsString() @MaxLength(140) title!: string;
  @IsOptional() @IsIn(STORED_EVENT_TYPES) type?: string;
  @IsOptional() @IsBoolean() allDay?: boolean;
  /** All day: `2026-10-06`. With a time: `2026-10-06T09:30`. */
  @IsString() @MaxLength(25) start!: string;
  @IsOptional() @IsString() @MaxLength(25) end?: string;
  @IsOptional() @IsString() @MaxLength(200) location?: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsString() @MaxLength(500) meetingLink?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_GUESTS) @ValidateNested({ each: true }) @Type(() => GuestDto) attendees?: GuestDto[];
  @IsOptional() @IsString() @MaxLength(60) clientId?: string | null;
  /** Minutes before the start; `null` = no reminder. */
  @IsOptional() @IsInt() @Min(0) @Max(MAX_REMINDER_MINUTES) reminderMinutes?: number | null;
}

export class UpdateEventDto {
  @IsOptional() @IsString() @MaxLength(140) title?: string;
  @IsOptional() @IsIn(STORED_EVENT_TYPES) type?: string;
  @IsOptional() @IsBoolean() allDay?: boolean;
  @IsOptional() @IsString() @MaxLength(25) start?: string;
  @IsOptional() @IsString() @MaxLength(25) end?: string;
  @IsOptional() @IsString() @MaxLength(200) location?: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsString() @MaxLength(500) meetingLink?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_GUESTS) @ValidateNested({ each: true }) @Type(() => GuestDto) attendees?: GuestDto[];
  @IsOptional() @IsString() @MaxLength(60) clientId?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_REMINDER_MINUTES) reminderMinutes?: number | null;
}

/** Cancels an appointment (it stays for history) or brings it back. */
export class EventActiveDto {
  @IsBoolean() isActive!: boolean;
}
