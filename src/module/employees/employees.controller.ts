import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { readFieldFilters } from '../forms/dynamic-query.js';
import { AddRateDto, CreateEmployeeDto, EmployeeExportQuery, EmployeeListQuery, EmployeeLookupQuery, SetEmployeeStatusDto, UpdateEmployeeDto } from './dto/employee.dto.js';
import { EmployeeRatesService } from './employee-rates.service.js';
import { EmployeesService } from './employees.service.js';

/** The raw query as an object — the admin-defined filters (`f.<field key>`) are not known to the DTO. */
const rawQuery = (request: Request): Record<string, unknown> => request.query as Record<string, unknown>;

@Controller('employees')
@RequirePermission('employees.view')
export class EmployeesController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly rates: EmployeeRatesService,
    private readonly exports: ExportsService,
  ) {}

  /**
   * The grid. `search` (client number and name, the worker's name and everything the forms mark "search"), `status=active|stopped`,
   * `f.<field key>=a,b` for the fields of the employee form and `f.person.<field key>=a,b` for the person form's, `sort=<key>:asc|desc`
   * (`name`, `client`, `status`, `updatedAt`, a field key or `person.<field key>`), `page`, `pageSize`, `stats=true` for the counters.
   */
  @Get()
  list(@Query() query: EmployeeListQuery, @Req() request: Request, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.employees.list(query, readFieldFilters(rawQuery(request)), user, locale);
  }

  /** `GET /employees/export?format=xlsx|pdf|docx` + the grid's search, filters, sorting and `columns`: everything that matches, as a download. */
  @RequirePermission('employees.export')
  @Get('export')
  async export(
    @Query() query: EmployeeExportQuery,
    @Query('format') format: string | undefined,
    @Req() request: Request,
    @Locale() locale: AppLocale,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    const chosen = this.exports.parseFormat(format);
    const { table, count } = await this.employees.exportTable(query, readFieldFilters(rawQuery(request)), user, locale, chosen);
    this.exports.assertSize(count);
    return this.exports.download(response, table, chosen, user.name);
  }

  /** Pickers (contracts, hours …): `?search=`, `?clientId=` the workers of one client, `?includeStopped=true`. */
  @Get('lookup')
  lookup(@Query() query: EmployeeLookupQuery) {
    return this.employees.lookup(query);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.employees.get(id, user);
  }

  /** `{ values, person: { personId } | { values } }` — the employee form, and who the worker is (somebody known, or the person form for a new one). */
  @RequirePermission('employees.create')
  @Post()
  create(@Body() dto: CreateEmployeeDto, @CurrentUser() user: AuthenticatedUser) {
    return this.employees.create(dto, user);
  }

  @RequirePermission('employees.edit')
  @Put(':id')
  replace(@Param('id') id: string, @Body() dto: UpdateEmployeeDto, @CurrentUser() user: AuthenticatedUser) {
    return this.employees.update(id, dto, user);
  }

  @RequirePermission('employees.edit')
  @Patch(':id')
  patch(@Param('id') id: string, @Body() dto: UpdateEmployeeDto, @CurrentUser() user: AuthenticatedUser) {
    return this.employees.update(id, dto, user);
  }

  /** `{ status: 'stopped' | 'active', reason?, date? }` — workers are never deleted, they are stopped (and can be taken back). */
  @RequirePermission('employees.delete')
  @HttpCode(200)
  @Post(':id/status')
  setStatus(@Param('id') id: string, @Body() dto: SetEmployeeStatusDto, @CurrentUser() user: AuthenticatedUser) {
    return this.employees.setStatus(id, dto, user);
  }

  /* ── Hourly rate history ──────────────────────────────────────────────────────────────────────────────────────── */

  @Get(':id/rates')
  async listRates(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.employees.assertRateAccess(user, 'view');
    await this.employees.findOrThrow(id);
    return this.rates.list(id);
  }

  /** `{ rate, validFrom, note? }` — the new hourly rate applies from that day; earlier hours keep the rate they had. */
  @RequirePermission('employees.edit')
  @Post(':id/rates')
  async addRate(@Param('id') id: string, @Body() dto: AddRateDto, @CurrentUser() user: AuthenticatedUser) {
    await this.employees.assertRateAccess(user, 'edit');
    return this.rates.add(id, dto, user);
  }

  @RequirePermission('employees.edit')
  @Delete(':id/rates/:rateId')
  async removeRate(@Param('id') id: string, @Param('rateId') rateId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.employees.assertRateAccess(user, 'edit');
    return this.rates.remove(id, rateId, user);
  }
}
