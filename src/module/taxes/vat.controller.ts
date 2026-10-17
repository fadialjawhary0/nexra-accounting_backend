import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { ActiveDto, VatBulkDto, VatExportQuery, VatGenerateDto, VatListQuery, VatOverviewQuery, VatPeriodUpdateDto, VatStepTickDto } from './dto/taxes.dto.js';
import { VatPeriodsService } from './vat-periods.service.js';

/**
 * The VAT tracker: the grid of a quarter (one row per client, one checkbox per step), the tabs above it, ticking one step or many, the notes and the rows that are switched off.
 * Everything is checked against the permission area `taxes`.
 */
@Controller('taxes/vat')
@RequirePermission('taxes.view')
export class VatController {
  constructor(
    private readonly periods: VatPeriodsService,
    private readonly exports: ExportsService,
  ) {}

  /** The grid. `period=2026-Q3` for a period; without it the history of a client (`clientId`) — newest period first. */
  @Get()
  list(@Query() query: VatListQuery, @Locale() locale: AppLocale) {
    return this.periods.list(query, locale);
  }

  /** The tabs: the periods of a year with how far each is, the years that exist, which period to open first. */
  @Get('overview')
  overview(@Query() query: VatOverviewQuery, @Locale() locale: AppLocale) {
    return this.periods.overview(query, locale);
  }

  @RequirePermission('taxes.export')
  @Get('export')
  async export(@Query() query: VatExportQuery, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale, @Res({ passthrough: true }) response: Response) {
    return this.exports.download(response, await this.periods.exportTable(query, locale), this.exports.parseFormat(query.format), user.name);
  }

  /** `{ period }` — makes the rows a period does not have yet (an older one, or the next). */
  @RequirePermission('taxes.create')
  @HttpCode(200)
  @Post('generate')
  generate(@Body() dto: VatGenerateDto) {
    return this.periods.generate(dto.period);
  }

  /** `{ ids, steps, done }` — ticks (or takes away) the same steps for many rows. */
  @RequirePermission('taxes.edit')
  @HttpCode(200)
  @Post('bulk')
  bulk(@Body() dto: VatBulkDto, @CurrentUser() user: AuthenticatedUser) {
    return this.periods.bulk(dto, user);
  }

  @Get(':id')
  one(@Param('id') id: string) {
    return this.periods.one(id);
  }

  /** `{ note }` */
  @RequirePermission('taxes.edit')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: VatPeriodUpdateDto) {
    return this.periods.update(id, dto);
  }

  /** `{ done }` — ticks one step of a row, or takes the tick away. */
  @RequirePermission('taxes.edit')
  @Put(':id/steps/:code')
  step(@Param('id') id: string, @Param('code') code: string, @Body() dto: VatStepTickDto, @CurrentUser() user: AuthenticatedUser) {
    return this.periods.setStep(id, code, dto.done, user);
  }

  /** `{ isActive, reason? }` — switches a row off (it stays for history) or on again. */
  @RequirePermission('taxes.delete')
  @HttpCode(200)
  @Post(':id/active')
  active(@Param('id') id: string, @Body() dto: ActiveDto, @CurrentUser() user: AuthenticatedUser) {
    return this.periods.setActive(id, dto, user);
  }
}
