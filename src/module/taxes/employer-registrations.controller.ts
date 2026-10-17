import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { EmployerExportQuery, EmployerListQuery } from './dto/taxes.dto.js';
import { EmployerRegistrationsService } from './employer-registrations.service.js';

/** Employer registrations: which clients are registered as an employer, which asked for it, and which have workers but nothing yet. Worked out from records that exist already. */
@Controller('taxes/employers')
@RequirePermission('taxes.view')
export class EmployerRegistrationsController {
  constructor(
    private readonly employers: EmployerRegistrationsService,
    private readonly exports: ExportsService,
  ) {}

  @Get()
  list(@Query() query: EmployerListQuery, @Locale() locale: AppLocale) {
    return this.employers.list(query, locale);
  }

  @RequirePermission('taxes.export')
  @Get('export')
  async export(@Query() query: EmployerExportQuery, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale, @Res({ passthrough: true }) response: Response) {
    return this.exports.download(response, await this.employers.exportTable(query, locale), this.exports.parseFormat(query.format), user.name);
  }
}
