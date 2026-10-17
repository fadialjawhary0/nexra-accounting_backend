import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { CancelInvoiceDto, CreateInvoiceDto, CreditInvoiceDto, InvoiceExportQuery, InvoiceListQuery, InvoiceStatusDto, InvoiceWorkersQuery, IssueInvoiceDto, MarkupQuery, PartiesQuery, UpdateInvoiceDto } from './dto/invoice.dto.js';
import { InvoicesService } from './invoices.service.js';
import { MarkupReportService } from './markup-report.service.js';

@Controller('invoices')
@RequirePermission('invoices.view')
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly markup: MarkupReportService,
    private readonly exports: ExportsService,
  ) {}

  /** The list: `direction`, `clientId`, `partyId` (the other company), `status` (default: all but cancelled; `all`), `month` or `from` / `to`, `open`, `overdue`, `search`, `page`, `pageSize`, `stats=true`. */
  @Get()
  list(@Query() query: InvoiceListQuery) {
    return this.invoices.list(query);
  }

  @RequirePermission('invoices.export')
  @Get('export')
  async export(@Query() query: InvoiceExportQuery, @Query('format') format: string | undefined, @Locale() locale: AppLocale, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: Response) {
    const chosen = this.exports.parseFormat(format);
    return this.exports.download(response, await this.invoices.listTable(query, locale), chosen, user.name);
  }

  /** Clients of the office and companies that are not clients: who an invoice can be with (`search`, `limit`). */
  @Get('parties')
  parties(@Query() query: PartiesQuery) {
    return this.invoices.parties(query);
  }

  /** The workers of a client with hours in the period, what is already invoiced and what is left — to fill the lines of an invoice. */
  @Get('workers')
  workers(@Query() query: InvoiceWorkersQuery, @CurrentUser() user: AuthenticatedUser) {
    return this.invoices.workers(query, user);
  }

  /** What a new invoice starts with: VAT percentage, payment term, G-account percentage, language. */
  @Get('defaults')
  defaults() {
    return this.invoices.defaults();
  }

  /** The number the client's next outgoing invoice would get. */
  @Get('next-number')
  nextNumber(@Query('clientId') clientId: string, @Query('date') date: string | undefined) {
    return this.invoices.nextNumber(clientId, date);
  }

  /** The markup report: per company and worker, what is billed, what the hours are paid and the difference. It shows wages, so it needs the right to see them. */
  @RequirePermission('invoices.view', 'salary_statements.view')
  @Get('markup')
  markupReport(@Query() query: MarkupQuery) {
    return this.markup.report(query);
  }

  @RequirePermission('invoices.export', 'salary_statements.view')
  @Get('markup/export')
  async markupExport(@Query() query: MarkupQuery, @Query('format') format: string | undefined, @Locale() locale: AppLocale, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: Response) {
    const chosen = this.exports.parseFormat(format);
    return this.exports.download(response, await this.markup.table(query, locale), chosen, user.name);
  }

  @RequirePermission('invoices.create')
  @Post()
  create(@Body() dto: CreateInvoiceDto, @CurrentUser() user: AuthenticatedUser) {
    return this.invoices.create(dto, user);
  }

  @Get(':id')
  one(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.invoices.one(id, user);
  }

  /** One invoice as a download: `format=xlsx|pdf|docx` (the lines and the totals as a table). */
  @RequirePermission('invoices.export')
  @Get(':id/export')
  async exportOne(@Param('id') id: string, @Query('format') format: string | undefined, @Locale() locale: AppLocale, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: Response) {
    const chosen = this.exports.parseFormat(format);
    return this.exports.download(response, await this.invoices.tableOf(id, locale), chosen, user.name);
  }

  @RequirePermission('invoices.edit')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateInvoiceDto, @CurrentUser() user: AuthenticatedUser) {
    return this.invoices.update(id, dto, user);
  }

  /** Only a draft can be deleted. */
  @RequirePermission('invoices.delete')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.invoices.remove(id);
  }

  /** `{ number?, invoiceDate?, dueDate?, reason? }` — gives an outgoing draft its number, makes the documents and closes the days it bills. */
  @RequirePermission('invoices.approve')
  @HttpCode(200)
  @Post(':id/issue')
  issue(@Param('id') id: string, @Body() dto: IssueInvoiceDto, @CurrentUser() user: AuthenticatedUser) {
    return this.invoices.issue(id, dto, user);
  }

  /** `{ status, paidOn?, reason? }` — received → checked → paid, sent → paid, and back. Checking needs the right to approve. */
  @RequirePermission('invoices.edit')
  @HttpCode(200)
  @Post(':id/status')
  status(@Param('id') id: string, @Body() dto: InvoiceStatusDto, @CurrentUser() user: AuthenticatedUser) {
    return this.invoices.transition(id, dto, user);
  }

  /** `{ reason }` — an incoming invoice that came in by mistake. */
  @RequirePermission('invoices.delete')
  @HttpCode(200)
  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Body() dto: CancelInvoiceDto, @CurrentUser() user: AuthenticatedUser) {
    return this.invoices.cancel(id, dto, user);
  }

  /** `{ reason, number?, invoiceDate? }` — a credit note that takes the whole invoice back. */
  @RequirePermission('invoices.delete')
  @HttpCode(200)
  @Post(':id/credit')
  credit(@Param('id') id: string, @Body() dto: CreditInvoiceDto, @CurrentUser() user: AuthenticatedUser) {
    return this.invoices.credit(id, dto, user);
  }

  /** Makes the Word and the PDF of an issued invoice again. */
  @RequirePermission('invoices.edit')
  @HttpCode(200)
  @Post(':id/documents')
  documents(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.invoices.makeDocuments(id, user);
  }
}
