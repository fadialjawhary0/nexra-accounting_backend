import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { CancelStatementDto, CandidatesQuery, CreateStatementDto, StatementExportQuery, StatementListQuery, StatementPreviewQuery } from './dto/statement.dto.js';
import { SalaryStatementsService } from './salary-statements.service.js';

@Controller('salary-statements')
@RequirePermission('salary_statements.view')
export class SalaryStatementsController {
  constructor(
    private readonly statements: SalaryStatementsService,
    private readonly exports: ExportsService,
  ) {}

  /** The list: `employeeId`, `clientId`, `status=final|cancelled|all`, `month=YYYY-MM` (or `from` / `to`), `search`, `page`, `pageSize`, `stats=true`. */
  @Get()
  list(@Query() query: StatementListQuery) {
    return this.statements.list(query);
  }

  /** The list as a download: `format=xlsx|pdf|docx`. */
  @RequirePermission('salary_statements.export')
  @Get('export')
  async export(@Query() query: StatementExportQuery, @Query('format') format: string | undefined, @Locale() locale: AppLocale, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: Response) {
    const chosen = this.exports.parseFormat(format);
    return this.exports.download(response, await this.statements.listTable(query, locale), chosen, user.name);
  }

  /** What a statement for this worker and period would say, and what stops it. Nothing is saved. */
  @Get('preview')
  preview(@Query() query: StatementPreviewQuery) {
    return this.statements.preview(query);
  }

  /** The workers of a client with hours in the period, and whether a statement can be made for each. */
  @Get('candidates')
  candidates(@Query() query: CandidatesQuery) {
    return this.statements.candidates(query);
  }

  /** Makes the statement: `{ employeeId, from, to, note? }`. It closes the days it covers and files a Word and a PDF in the worker's folder. */
  @RequirePermission('salary_statements.create')
  @Post()
  create(@Body() dto: CreateStatementDto, @CurrentUser() user: AuthenticatedUser) {
    return this.statements.create(dto, user);
  }

  @Get(':id')
  one(@Param('id') id: string) {
    return this.statements.get(id);
  }

  /** One statement as a download: `format=xlsx|pdf|docx` (the lines and the totals as a table). */
  @RequirePermission('salary_statements.export')
  @Get(':id/export')
  async exportOne(@Param('id') id: string, @Query('format') format: string | undefined, @Locale() locale: AppLocale, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: Response) {
    const chosen = this.exports.parseFormat(format);
    return this.exports.download(response, await this.statements.tableFor(id, locale), chosen, user.name);
  }

  /** Makes the Word and the PDF again. */
  @RequirePermission('salary_statements.create')
  @HttpCode(200)
  @Post(':id/documents')
  documents(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.statements.makeDocuments(id, user);
  }

  /** `{ reason }` — the days are open again and a new statement can be made. */
  @RequirePermission('salary_statements.delete')
  @HttpCode(200)
  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Body() dto: CancelStatementDto, @CurrentUser() user: AuthenticatedUser) {
    return this.statements.cancel(id, dto, user);
  }
}
