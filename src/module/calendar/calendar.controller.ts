import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { DAY_PATTERN } from '../../common/dates.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import { CalendarService } from './calendar.service.js';

class HolidayQuery {
  @IsOptional() @Matches(DAY_PATTERN) from?: string;
  @IsOptional() @Matches(DAY_PATTERN) to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1990) @Max(2200) year?: number;
  /** Include switched-off holidays (Settings → Calendar & holidays only). */
  @IsOptional() @Transform(({ value }: { value: unknown }) => value === true || value === 'true') @IsBoolean() all?: boolean;
}

class CreateHolidayDto {
  @Matches(DAY_PATTERN) date!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) nameNl!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) nameEn!: string;
  @IsOptional() @IsBoolean() paid?: boolean;
}

class UpdateHolidayDto {
  @IsOptional() @Matches(DAY_PATTERN) date?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) nameNl?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) nameEn?: string;
  @IsOptional() @IsBoolean() paid?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}

class CheckQuery {
  @Matches(DAY_PATTERN) date!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(-366) @Max(366) add?: number;
}

class GenerateYearDto {
  @IsInt() @Min(1990) @Max(2200) year!: number;
}

@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  /** What every date picker needs: which weekdays are weekend, and whether to warn. Open to every signed-in person. */
  @Get('config')
  config() {
    return this.calendar.config();
  }

  /** Working-day arithmetic for one date (see Settings → Calendar & holidays → "Try it"). */
  @Get('check')
  check(@Query() query: CheckQuery, @Locale() locale: AppLocale) {
    return this.calendar.check(query.date, query.add ?? 5, locale);
  }

  /** Holidays in a period (active ones — what pickers and the calendar page show). Settings readers may ask for switched-off ones too (`all=true`). */
  @Get('holidays')
  holidays(@Query() query: HolidayQuery, @Locale() locale: AppLocale, @CurrentUser() user: AuthenticatedUser) {
    const includeInactive = Boolean(query.all) && matrixAllows(user.matrix, 'settings.view');
    return this.calendar.list({ from: query.from, to: query.to, year: query.year, includeInactive, locale });
  }

  @RequirePermission('settings.edit')
  @Post('holidays')
  create(@Body() dto: CreateHolidayDto, @Locale() locale: AppLocale) {
    return this.calendar.create(dto, locale);
  }

  @RequirePermission('settings.edit')
  @HttpCode(200)
  @Post('holidays/generate')
  generate(@Body() dto: GenerateYearDto) {
    return this.calendar.generateYear(dto.year);
  }

  @RequirePermission('settings.edit')
  @Put('holidays/:id')
  update(@Param('id') id: string, @Body() dto: UpdateHolidayDto, @Locale() locale: AppLocale) {
    return this.calendar.update(id, dto, locale);
  }

  @RequirePermission('settings.edit')
  @Delete('holidays/:id')
  remove(@Param('id') id: string) {
    return this.calendar.remove(id);
  }
}
