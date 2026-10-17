import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Request, Response } from 'express';
import { contentDisposition } from '../../common/content-disposition.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequireAnyPermission, RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { readFieldFilters } from '../forms/dynamic-query.js';
import { ContractDocumentsService } from './contract-documents.service.js';
import { ContractLifecycleService } from './contract-lifecycle.service.js';
import { ContractsService } from './contracts.service.js';
import {
  CancelContractDto,
  CheckContractDto,
  ContractExportQuery,
  ContractListQuery,
  ContractPreviewQuery,
  CreateContractDto,
  GenerateContractDto,
  LetterDto,
  RenewContractDto,
  ScanDto,
  SendContractDto,
  SignContractDto,
  TerminateContractDto,
  UpdateContractDto,
} from './dto/contract.dto.js';

/** The raw query as an object — the admin-defined filters (`f.<field key>`) are not known to the DTO. */
const rawQuery = (request: Request): Record<string, unknown> => request.query as Record<string, unknown>;

@Controller('contracts')
@RequirePermission('contracts.view')
export class ContractsController {
  constructor(
    private readonly contracts: ContractsService,
    private readonly lifecycle: ContractLifecycleService,
    private readonly documents: ContractDocumentsService,
    private readonly exports: ExportsService,
  ) {}

  /**
   * The list. `search` (client number and name, the worker's name, everything the form marks "search"), `status=active,sent`, `type=on_call`,
   * `clientId`, `employeeId`, `isActive=true|false`, `expiring=true` (running contracts that end soon), `f.<field key>=a,b`,
   * `sort=<key>:asc|desc` (`client`, `worker`, `status`, `type`, `startDate`, `endDate`, `duration`, a field key), `page`, `pageSize`, `stats=true`.
   */
  @Get()
  list(@Query() query: ContractListQuery, @Req() request: Request, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.contracts.list(query, readFieldFilters(rawQuery(request)), user, locale);
  }

  /** `GET /contracts/export?format=xlsx|pdf|docx` + the list's search, filters, sorting and `columns`: everything that matches, as a download. */
  @RequirePermission('contracts.export')
  @Get('export')
  async export(
    @Query() query: ContractExportQuery,
    @Query('format') format: string | undefined,
    @Req() request: Request,
    @Locale() locale: AppLocale,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    const chosen = this.exports.parseFormat(format);
    const { table, count } = await this.contracts.exportTable(query, readFieldFilters(rawQuery(request)), user, locale, chosen);
    this.exports.assertSize(count);
    return this.exports.download(response, table, chosen, user.name);
  }

  /** The advice for a contract that is not saved yet (the wizard and the form call it while the dates and the wage are filled in). */
  @RequireAnyPermission('contracts.create', 'contracts.edit')
  @HttpCode(200)
  @Post('check')
  check(@Body() dto: CheckContractDto, @CurrentUser() user: AuthenticatedUser) {
    return this.contracts.check(dto, user);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.contracts.get(id, user);
  }

  /**
   * `{ clientId, employeeId, templateId?, renewalOfId?, values, generate? }` — saves a draft (the client and the worker are chosen first) and, with
   * `generate`, makes the Word and PDF document. The answer is the contract plus `generation` (what happened to the document).
   */
  @RequirePermission('contracts.create')
  @Post()
  create(@Body() dto: CreateContractDto, @CurrentUser() user: AuthenticatedUser) {
    return this.lifecycle.create(dto, user);
  }

  @RequirePermission('contracts.edit')
  @Put(':id')
  replace(@Param('id') id: string, @Body() dto: UpdateContractDto, @CurrentUser() user: AuthenticatedUser) {
    return this.contracts.update(id, dto, user);
  }

  @RequirePermission('contracts.edit')
  @Patch(':id')
  patch(@Param('id') id: string, @Body() dto: UpdateContractDto, @CurrentUser() user: AuthenticatedUser) {
    return this.contracts.update(id, dto, user);
  }

  /* ── Documents ────────────────────────────────────────────────────────────────────────────────────────────────── */

  @Get(':id/documents')
  async listDocuments(@Param('id') id: string) {
    await this.contracts.findOrThrow(id);
    return this.documents.list(id);
  }

  /** The contract filled in with the real data, for looking at — nothing is saved (`?templateId=&version=&format=pdf|docx`). */
  @Get(':id/preview')
  async preview(@Param('id') id: string, @Query() query: ContractPreviewQuery, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: Response) {
    const format = query.format ?? 'pdf';
    const result = await this.documents.preview(id, { templateId: query.templateId, version: query.version, format }, user);
    response.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Unknown-Fields': encodeURIComponent(result.unknown.join(',')), 'X-Empty-Fields': encodeURIComponent(result.empty.join(',')) });
    return new StreamableFile(result.buffer, { type: result.mime, disposition: contentDisposition(format === 'docx' ? 'attachment' : 'inline', result.name), length: result.buffer.length });
  }

  /** (Re)makes the contract's Word and PDF document (`{ templateId?, version? }` to use another template). */
  @RequirePermission('contracts.edit')
  @HttpCode(200)
  @Post(':id/generate')
  async generate(@Param('id') id: string, @Body() dto: GenerateContractDto, @CurrentUser() user: AuthenticatedUser) {
    const made = await this.documents.generate(id, dto, user);
    return { ...(await this.contracts.get(id, user)), generation: { ok: true, pdf: made.pdf, unknown: made.unknown, empty: made.empty } };
  }

  /** A letter from a template (termination letter, notice of non-renewal …) with this contract's data. */
  @RequirePermission('contracts.edit')
  @HttpCode(200)
  @Post(':id/letters')
  async letter(@Param('id') id: string, @Body() dto: LetterDto, @CurrentUser() user: AuthenticatedUser) {
    const made = await this.documents.letter(id, dto.templateId, dto.version, user);
    return { ...(await this.contracts.get(id, user)), letter: { ok: true, pdf: made.pdf, unknown: made.unknown, empty: made.empty } };
  }

  /** The signed copy (`{ fileId }`, uploaded with `purpose=contract_scan`); a new one replaces the earlier. */
  @RequirePermission('contracts.edit')
  @HttpCode(200)
  @Post(':id/scan')
  async scan(@Param('id') id: string, @Body() dto: ScanDto, @CurrentUser() user: AuthenticatedUser) {
    await this.documents.attachScan(id, dto.fileId, user);
    return this.contracts.get(id, user);
  }

  /** Switches a document off; nothing is deleted. */
  @RequirePermission('contracts.edit')
  @Delete(':id/documents/:documentId')
  async removeDocument(@Param('id') id: string, @Param('documentId') documentId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.documents.remove(id, documentId);
    return this.contracts.get(id, user);
  }

  /* ── Status ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** Handed to the worker to be signed. */
  @RequirePermission('contracts.edit')
  @HttpCode(200)
  @Post(':id/send')
  send(@Param('id') id: string, @Body() dto: SendContractDto, @CurrentUser() user: AuthenticatedUser) {
    return this.lifecycle.send(id, dto, user);
  }

  /** Signed: the contract is running. `{ signedOn?, fileId? }` — the signed copy can come along. Needs the approve permission. */
  @RequirePermission('contracts.approve')
  @HttpCode(200)
  @Post(':id/sign')
  sign(@Param('id') id: string, @Body() dto: SignContractDto, @CurrentUser() user: AuthenticatedUser) {
    return this.lifecycle.sign(id, dto, user);
  }

  /** `{ date, reason, note?, letterTemplateId?, stopEmployee? }` — the contract ends early on `date`. */
  @RequirePermission('contracts.delete')
  @HttpCode(200)
  @Post(':id/terminate')
  terminate(@Param('id') id: string, @Body() dto: TerminateContractDto, @CurrentUser() user: AuthenticatedUser) {
    return this.lifecycle.terminate(id, dto, user);
  }

  /** A draft or sent contract that never took effect. */
  @RequirePermission('contracts.delete')
  @HttpCode(200)
  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Body() dto: CancelContractDto, @CurrentUser() user: AuthenticatedUser) {
    return this.lifecycle.cancel(id, dto, user);
  }

  /** Takes back a termination, cancellation or ending that was a mistake. */
  @RequirePermission('contracts.delete')
  @HttpCode(200)
  @Post(':id/reopen')
  reopen(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.lifecycle.reopen(id, user);
  }

  /** A new draft that continues this contract (`{ startDate?, endDate?, templateId?, generate? }`). */
  @RequirePermission('contracts.create')
  @Post(':id/renew')
  renew(@Param('id') id: string, @Body() dto: RenewContractDto, @CurrentUser() user: AuthenticatedUser) {
    return this.lifecycle.renew(id, dto, user);
  }
}
