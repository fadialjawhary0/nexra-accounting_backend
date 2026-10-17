import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { ActiveDto, CreateReturnDto, ExtensionDto, GenerateReturnsDto, ReturnExportQuery, ReturnListQuery, UpdateReturnDto } from './dto/taxes.dto.js';
import { TaxReturnsService } from './tax-returns.service.js';

/**
 * The yearly returns: income tax of an owner or partner and corporate income tax of a company — the list per year, making the rows of a year, the status, the day of filing, the filed
 * return and the extension. Everything is checked against the permission area `taxes`.
 */
@Controller('taxes/returns')
@RequirePermission('taxes.view')
export class TaxReturnsController {
  constructor(
    private readonly returns: TaxReturnsService,
    private readonly exports: ExportsService,
  ) {}

  @Get()
  list(@Query() query: ReturnListQuery, @Locale() locale: AppLocale) {
    return this.returns.list(query, locale);
  }

  @RequirePermission('taxes.export')
  @Get('export')
  async export(@Query() query: ReturnExportQuery, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale, @Res({ passthrough: true }) response: Response) {
    return this.exports.download(response, await this.returns.exportTable(query, locale), this.exports.parseFormat(query.format), user.name);
  }

  /** `{ kind, taxYear }` — makes the returns of a year for every client that has income tax / corporate tax switched on. */
  @RequirePermission('taxes.create')
  @HttpCode(200)
  @Post('generate')
  generate(@Body() dto: GenerateReturnsDto) {
    return this.returns.generate(dto, 'manual');
  }

  @RequirePermission('taxes.create')
  @Post()
  create(@Body() dto: CreateReturnDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.returns.create(dto, user, locale);
  }

  @Get(':id')
  one(@Param('id') id: string, @Locale() locale: AppLocale) {
    return this.returns.one(id, locale);
  }

  /** `{ status?, filedOn?, fileId?, assigneeId?, note?, periodStart?, periodEnd? }` */
  @RequirePermission('taxes.edit')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateReturnDto, @Locale() locale: AppLocale) {
    return this.returns.update(id, dto, locale);
  }

  /** `{ status: 'requested' | 'granted' | 'refused' | null, requestedOn?, until?, submissionId? }` — the extension of the deadline. */
  @RequirePermission('taxes.edit')
  @Put(':id/extension')
  extension(@Param('id') id: string, @Body() dto: ExtensionDto, @Locale() locale: AppLocale) {
    return this.returns.setExtension(id, dto, locale);
  }

  /** `{ isActive, reason? }` — switches a return off (it stays for history) or on again. */
  @RequirePermission('taxes.delete')
  @HttpCode(200)
  @Post(':id/active')
  active(@Param('id') id: string, @Body() dto: ActiveDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.returns.setActive(id, dto, user, locale);
  }
}
