import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { CounterpartiesService } from './counterparties.service.js';
import { CounterpartyExportQuery, CounterpartyListQuery, CounterpartyStatusDto, SaveCounterpartyDto } from './dto/counterparty.dto.js';

/** The companies that are not clients but are part of the staffing chain (staffing agencies, hirers). They belong to the invoices area. */
@Controller('counterparties')
@RequirePermission('invoices.view')
export class CounterpartiesController {
  constructor(
    private readonly companies: CounterpartiesService,
    private readonly exports: ExportsService,
  ) {}

  @Get()
  list(@Query() query: CounterpartyListQuery) {
    return this.companies.list(query);
  }

  @RequirePermission('invoices.export')
  @Get('export')
  async export(@Query() query: CounterpartyExportQuery, @Query('format') format: string | undefined, @Locale() locale: AppLocale, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: Response) {
    const chosen = this.exports.parseFormat(format);
    return this.exports.download(response, await this.companies.listTable(query, locale), chosen, user.name);
  }

  @Get(':id')
  one(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.companies.one(id, user);
  }

  /** `{ values }` — the company form. */
  @RequirePermission('invoices.create')
  @Post()
  create(@Body() dto: SaveCounterpartyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.companies.create(dto, user);
  }

  @RequirePermission('invoices.edit')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: SaveCounterpartyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.companies.update(id, dto, user);
  }

  /** `{ isActive, reason? }` — switch a company off (it stays on the invoices it is on) or on again. */
  @RequirePermission('invoices.delete')
  @HttpCode(200)
  @Post(':id/status')
  status(@Param('id') id: string, @Body() dto: CounterpartyStatusDto, @CurrentUser() user: AuthenticatedUser) {
    return this.companies.setStatus(id, dto, user);
  }
}
