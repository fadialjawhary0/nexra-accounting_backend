import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { CreatePresetDto, UpdatePresetDto } from './dto/reports.dto.js';
import { ReportsService } from './reports.service.js';

/** The reports centre. A report needs `reports.view` and the permission area it is about; files need `reports.export`. */
@Controller('reports')
@RequirePermission('reports.view')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly exports: ExportsService,
  ) {}

  /** The reports this person may open, with the inputs each one asks for. */
  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.reports.list(user, locale);
  }

  /** The saved export presets (`?reportKey=` for one report). */
  @Get('presets')
  presets(@CurrentUser() user: AuthenticatedUser, @Query('reportKey') reportKey?: string) {
    return this.reports.presets(user, reportKey);
  }

  @RequirePermission('reports.export')
  @Post('presets')
  createPreset(@Body() dto: CreatePresetDto, @CurrentUser() user: AuthenticatedUser) {
    return this.reports.createPreset(dto, user);
  }

  @RequirePermission('reports.export')
  @Patch('presets/:id')
  updatePreset(@Param('id') id: string, @Body() dto: UpdatePresetDto, @CurrentUser() user: AuthenticatedUser) {
    return this.reports.updatePreset(id, dto, user);
  }

  @RequirePermission('reports.export')
  @HttpCode(200)
  @Delete('presets/:id')
  removePreset(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.reports.removePreset(id, user);
  }

  /** The report as a file: `?format=xlsx|pdf|docx`, the report's inputs, `columns=a,b` to keep some columns, `preset=<id>` to start from a saved preset. */
  @RequirePermission('reports.export')
  @Get(':key/export')
  async export(@Param('key') key: string, @Query() query: Record<string, string>, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale, @Res({ passthrough: true }) response: Response) {
    const { table, format } = await this.reports.fileTable(key, query, user, locale);
    return this.exports.download(response, table, this.exports.parseFormat(format), user.name);
  }

  /** The report for the screen with the inputs in the query string. */
  @Get(':key')
  run(@Param('key') key: string, @Query() query: Record<string, string>, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.reports.run(key, query, user, locale);
  }
}
