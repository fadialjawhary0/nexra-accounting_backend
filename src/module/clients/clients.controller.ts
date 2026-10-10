import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequireAnyPermission, RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { readFieldFilters } from '../forms/dynamic-query.js';
import { ClientFoldersService } from './client-folders.service.js';
import { ClientPeopleService } from './client-people.service.js';
import { ClientQualityService } from './client-quality.service.js';
import { ClientRelationsService } from './client-relations.service.js';
import { ClientsService } from './clients.service.js';
import {
  AddPersonDto,
  AddRelationDto,
  ClientExportQuery,
  ClientListQuery,
  ClientLookupQuery,
  CreateFolderDto,
  DataQualityQuery,
  RenameFolderDto,
  SaveClientDto,
  SetClientStatusDto,
  UpdatePersonLinkDto,
} from './dto/client.dto.js';

/** The raw query as an object — the admin-defined filters (`f.<field key>`) are not known to the DTO. */
const rawQuery = (request: Request): Record<string, unknown> => request.query as Record<string, unknown>;

@Controller('clients')
@RequirePermission('clients.view')
export class ClientsController {
  constructor(
    private readonly clients: ClientsService,
    private readonly people: ClientPeopleService,
    private readonly relations: ClientRelationsService,
    private readonly folders: ClientFoldersService,
    private readonly quality: ClientQualityService,
    private readonly exports: ExportsService,
  ) {}

  /**
   * The grid. `search` (number, name and everything the form marks "search"), `status=active|stopped`, `f.<field key>=a,b` for the
   * fields the form marks "filter", `sort=<field key>:asc|desc`, `page`, `pageSize`, `stats=true` for the counters in `meta.stats`.
   */
  @Get()
  list(@Query() query: ClientListQuery, @Req() request: Request, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.clients.list(query, readFieldFilters(rawQuery(request)), user, locale);
  }

  /** `GET /clients/export?format=xlsx|pdf|docx` + the grid's search, filters, sorting and `columns`: everything that matches, as a download. */
  @RequirePermission('clients.export')
  @Get('export')
  async export(
    @Query() query: ClientExportQuery,
    @Query('format') format: string | undefined,
    @Req() request: Request,
    @Locale() locale: AppLocale,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    const chosen = this.exports.parseFormat(format);
    const { table, count } = await this.clients.exportTable(query, readFieldFilters(rawQuery(request)), user, locale, chosen);
    this.exports.assertSize(count);
    return this.exports.download(response, table, chosen, user.name);
  }

  /** The number a new client gets by default: `{ number, formatted }`. */
  @Get('next-number')
  nextNumber() {
    return this.clients.nextNumber();
  }

  /** Pickers: `?search=` best matches, `?ids=a,b` the ones already chosen. Whoever works with workers needs it too (the client of a worker). */
  @RequireAnyPermission('clients.view', 'employees.view')
  @Get('lookup')
  lookup(@Query() query: ClientLookupQuery) {
    return this.clients.lookup(query);
  }

  /** Which clients lack details: `meta.stats`, `meta.fields` (how often each field is missing) and one row per client with its `missing` keys. */
  @Get('data-quality')
  dataQuality(@Query() query: DataQualityQuery) {
    return this.quality.report(query);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.clients.get(id, user);
  }

  @RequirePermission('clients.create')
  @Post()
  create(@Body() dto: SaveClientDto, @CurrentUser() user: AuthenticatedUser) {
    return this.clients.create(dto, user);
  }

  @RequirePermission('clients.edit')
  @Put(':id')
  replace(@Param('id') id: string, @Body() dto: SaveClientDto, @CurrentUser() user: AuthenticatedUser) {
    return this.clients.update(id, dto, user);
  }

  @RequirePermission('clients.edit')
  @Patch(':id')
  patch(@Param('id') id: string, @Body() dto: SaveClientDto, @CurrentUser() user: AuthenticatedUser) {
    return this.clients.update(id, dto, user);
  }

  /** `{ status: 'stopped' | 'active', reason?, date? }` — clients are never deleted, they are stopped (and can be taken back). */
  @RequirePermission('clients.delete')
  @HttpCode(200)
  @Post(':id/status')
  setStatus(@Param('id') id: string, @Body() dto: SetClientStatusDto, @CurrentUser() user: AuthenticatedUser) {
    return this.clients.setStatus(id, dto, user);
  }

  /* ── People ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  @Get(':id/people')
  listPeople(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.people.list(id, user);
  }

  @RequirePermission('clients.edit')
  @Post(':id/people')
  addPerson(@Param('id') id: string, @Body() dto: AddPersonDto, @CurrentUser() user: AuthenticatedUser) {
    return this.people.add(id, dto, user);
  }

  @RequirePermission('clients.edit')
  @Put(':id/people/:linkId')
  updatePerson(@Param('id') id: string, @Param('linkId') linkId: string, @Body() dto: UpdatePersonLinkDto, @CurrentUser() user: AuthenticatedUser) {
    return this.people.updateLink(id, linkId, dto, user);
  }

  @RequirePermission('clients.delete')
  @Delete(':id/people/:linkId')
  removePerson(@Param('id') id: string, @Param('linkId') linkId: string) {
    return this.people.removeLink(id, linkId);
  }

  /* ── Relations ────────────────────────────────────────────────────────────────────────────────────────────────── */

  @Get(':id/relations')
  listRelations(@Param('id') id: string) {
    return this.relations.list(id);
  }

  @RequirePermission('clients.edit')
  @Post(':id/relations')
  addRelation(@Param('id') id: string, @Body() dto: AddRelationDto) {
    return this.relations.add(id, dto);
  }

  @RequirePermission('clients.edit')
  @Delete(':id/relations/:relationId')
  removeRelation(@Param('id') id: string, @Param('relationId') relationId: string) {
    return this.relations.remove(id, relationId);
  }

  /* ── Documents ────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The client's folders and files (upload with `POST /files`: `purpose=attachment`, `area=clients`, `entityType=client`, `entityId`, `folderId`). */
  @Get(':id/documents')
  async documents(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.clients.findOrThrow(id);
    return this.folders.documents(id, user.matrix);
  }

  @RequirePermission('clients.edit')
  @Post(':id/folders')
  async createFolder(@Param('id') id: string, @Body() dto: CreateFolderDto) {
    return this.folders.create(await this.clients.findOrThrow(id), dto);
  }

  @RequirePermission('clients.edit')
  @Put(':id/folders/:folderId')
  async renameFolder(@Param('id') id: string, @Param('folderId') folderId: string, @Body() dto: RenameFolderDto) {
    return this.folders.rename(await this.clients.findOrThrow(id), folderId, dto.name);
  }

  @RequirePermission('clients.edit')
  @Delete(':id/folders/:folderId')
  async removeFolder(@Param('id') id: string, @Param('folderId') folderId: string) {
    return this.folders.remove(await this.clients.findOrThrow(id), folderId);
  }
}
