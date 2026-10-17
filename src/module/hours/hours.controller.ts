import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequireAnyPermission, RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import {
  ClosePeriodDto,
  CopyWeekDto,
  CreateEntryDto,
  EntryExportQuery,
  EntryListQuery,
  LockListQuery,
  MonthQuery,
  ReleaseLockDto,
  RepriceDto,
  SaveCellsDto,
  SurchargeRuleDto,
  UpdateEntryDto,
  UpdateSurchargeRuleDto,
  WeekQuery,
} from './dto/hours.dto.js';
import { HoursService } from './hours.service.js';
import { PeriodLocksService } from './period-locks.service.js';
import { SurchargeRulesService } from './surcharge-rules.service.js';

@Controller('hours')
@RequirePermission('hours.view')
export class HoursController {
  constructor(
    private readonly hours: HoursService,
    private readonly locks: PeriodLocksService,
    private readonly surcharges: SurchargeRulesService,
    private readonly exports: ExportsService,
  ) {}

  /**
   * The week grid: `from` (any day of the week; this week without it), `clientId`, `search` (name, client number or name), `withHours=true`, `page`,
   * `pageSize`. One row per worker with seven cells (minutes, how many entries, closed, outside employment / contract), the day headings
   * (weekend, holiday) and the totals per day across everything that matches.
   */
  @Get('week')
  week(@Query() query: WeekQuery, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.hours.week(query, user, locale);
  }

  /** Saves cells of the grid: `{ cells: [{ employeeId, date, minutes }], reason? }` → one result per cell. What a cell may do (add, change, clear) is checked per cell. */
  @RequireAnyPermission('hours.create', 'hours.edit', 'hours.delete')
  @Put('cells')
  saveCells(@Body() dto: SaveCellsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.hours.saveCells(dto, user);
  }

  /** `{ from, to, clientId?, employeeIds? }` — the days of one week into another (only empty, open days of workers who are employed then). */
  @RequirePermission('hours.create')
  @HttpCode(200)
  @Post('copy-week')
  copyWeek(@Body() dto: CopyWeekDto, @CurrentUser() user: AuthenticatedUser) {
    return this.hours.copyWeek(dto, user);
  }

  /** `employeeId` + `month=YYYY-MM`: every day of the month of one worker, totals, closed periods, statements and (with the right) what it pays. */
  @Get('month')
  month(@Query() query: MonthQuery, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.hours.month(query, user, locale);
  }

  /** Gives the open days of a worker the rate the history says they had (also done by itself whenever the history changes). */
  @RequirePermission('hours.edit')
  @HttpCode(200)
  @Post('reprice')
  reprice(@Body() dto: RepriceDto, @CurrentUser() user: AuthenticatedUser) {
    return this.hours.reprice(dto, user);
  }

  /* ── Entries ──────────────────────────────────────────────────────────────────────────────────────────────── */

  @Get('entries')
  entries(@Query() query: EntryListQuery, @CurrentUser() user: AuthenticatedUser) {
    return this.hours.list(query, user);
  }

  /** The entries a list shows as a download: `format=xlsx|pdf|docx`. */
  @RequirePermission('hours.export')
  @Get('entries/export')
  async export(@Query() query: EntryExportQuery, @Query('format') format: string | undefined, @Locale() locale: AppLocale, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: Response) {
    const chosen = this.exports.parseFormat(format);
    return this.exports.download(response, await this.hours.exportTable(query, user, locale), chosen, user.name);
  }

  @RequirePermission('hours.create')
  @Post('entries')
  create(@Body() dto: CreateEntryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.hours.create(dto, user);
  }

  @Get('entries/:id')
  one(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.hours.one(id, user);
  }

  @RequirePermission('hours.edit')
  @Patch('entries/:id')
  update(@Param('id') id: string, @Body() dto: UpdateEntryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.hours.update(id, dto, user);
  }

  /** `?reason=` — needed when the day is closed. */
  @RequirePermission('hours.delete')
  @Delete('entries/:id')
  remove(@Param('id') id: string, @Query('reason') reason: string | undefined, @CurrentUser() user: AuthenticatedUser) {
    return this.hours.remove(id, reason, user);
  }

  /* ── Closed periods ───────────────────────────────────────────────────────────────────────────────────────── */

  @Get('locks')
  locksList(@Query() query: LockListQuery) {
    return this.locks.list(query);
  }

  /** Closes a period (a month, or `from` – `to`) for some workers, or for every worker of a client. */
  @RequirePermission('hours.approve')
  @HttpCode(200)
  @Post('locks')
  close(@Body() dto: ClosePeriodDto, @CurrentUser() user: AuthenticatedUser) {
    return this.locks.close(dto, user);
  }

  @RequirePermission('hours.approve')
  @HttpCode(200)
  @Post('locks/:id/release')
  release(@Param('id') id: string, @Body() dto: ReleaseLockDto, @CurrentUser() user: AuthenticatedUser) {
    return this.locks.release(id, dto, user);
  }

  /* ── Surcharge rules (Settings → Hours & pay) ─────────────────────────────────────────────────────────────── */

  @RequirePermission('settings.view')
  @Get('surcharges')
  surchargeList() {
    return this.surcharges.list();
  }

  @RequirePermission('settings.edit')
  @Post('surcharges')
  surchargeCreate(@Body() dto: SurchargeRuleDto, @CurrentUser() user: AuthenticatedUser) {
    return this.surcharges.create(dto, user);
  }

  @RequirePermission('settings.edit')
  @Patch('surcharges/:id')
  surchargeUpdate(@Param('id') id: string, @Body() dto: UpdateSurchargeRuleDto) {
    return this.surcharges.update(id, dto);
  }

  @RequirePermission('settings.edit')
  @Delete('surcharges/:id')
  surchargeRemove(@Param('id') id: string) {
    return this.surcharges.remove(id);
  }
}
