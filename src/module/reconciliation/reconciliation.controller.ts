import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import { ReconciliationExportQuery, ReconciliationQuery } from './dto/reconciliation.dto.js';
import { ReconciliationService } from './reconciliation.service.js';

/** Hours = salary = invoices: per worker and period, what is registered, what is paid and what is invoiced — and what does not match. */
@Controller('reconciliation')
@RequirePermission('invoices.view')
export class ReconciliationController {
  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly exports: ExportsService,
  ) {}

  /** `month=YYYY-MM` (or `from` / `to`), `clientId`, `status=all|ok|differences`, `kind`, `search`, `page`, `pageSize`. What is paid is only included for people who may see salary statements. */
  @Get()
  report(@Query() query: ReconciliationQuery, @CurrentUser() user: AuthenticatedUser) {
    return this.reconciliation.report(query, matrixAllows(user.matrix, 'salary_statements.view'));
  }

  @RequirePermission('invoices.export')
  @Get('export')
  async export(@Query() query: ReconciliationExportQuery, @Query('format') format: string | undefined, @Locale() locale: AppLocale, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: Response) {
    const chosen = this.exports.parseFormat(format);
    return this.exports.download(response, await this.reconciliation.table(query, matrixAllows(user.matrix, 'salary_statements.view'), locale), chosen, user.name);
  }
}
