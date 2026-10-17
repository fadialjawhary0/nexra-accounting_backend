import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { contentDisposition } from '../../common/content-disposition.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import type { LabelSize } from './address-book.constants.js';
import { AddressBookService } from './address-book.service.js';
import { AddressLabelsService } from './address-labels.service.js';
import { AddressExportQuery, AddressListQuery, AddressStatusDto, LabelQuery, SaveAddressDto } from './dto/address-book.dto.js';

/** The address book: where post goes (the tax office, banks …) and the envelope labels made from it. Part of the official forms area. */
@Controller('address-book')
@RequirePermission('official_forms.view')
export class AddressBookController {
  constructor(
    private readonly addresses: AddressBookService,
    private readonly labels: AddressLabelsService,
    private readonly exports: ExportsService,
  ) {}

  @Get()
  list(@Query() query: AddressListQuery, @Locale() locale: AppLocale) {
    return this.addresses.list(query, locale);
  }

  @RequirePermission('official_forms.export')
  @Get('export')
  async export(@Query() query: AddressExportQuery, @Locale() locale: AppLocale, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: Response) {
    return this.exports.download(response, await this.addresses.exportTable(query, locale), this.exports.parseFormat(query.format), user.name);
  }

  /** The size and the sender line a label gets unless somebody chooses otherwise (Settings → Post). */
  @Get('label-settings')
  labelSettings() {
    return this.labels.defaults();
  }

  @Get(':id')
  one(@Param('id') id: string, @Locale() locale: AppLocale) {
    return this.addresses.one(id, locale);
  }

  /** The envelope label of an address, as a PDF to print (`size`: a5 · dl · c5). */
  @Get(':id/label')
  async label(@Param('id') id: string, @Query() query: LabelQuery, @Locale() locale: AppLocale, @Res({ passthrough: true }) response: Response) {
    const label = await this.labels.forAddress(id, { size: query.size as LabelSize | undefined, sender: query.sender, locale });
    response.set({ 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "frame-ancestors 'self'", 'X-Content-Type-Options': 'nosniff' });
    return new StreamableFile(label.bytes, { type: 'application/pdf', disposition: contentDisposition(query.download ? 'attachment' : 'inline', label.name), length: label.bytes.length });
  }

  @RequirePermission('official_forms.edit')
  @Post()
  create(@Body() dto: SaveAddressDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.addresses.create(dto, user, locale);
  }

  @RequirePermission('official_forms.edit')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: SaveAddressDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.addresses.update(id, dto, user, locale);
  }

  /** `{ isActive, reason? }` — switch an address off (it stays for the forms and the log that point at it) or on again. */
  @RequirePermission('official_forms.delete')
  @HttpCode(200)
  @Post(':id/status')
  status(@Param('id') id: string, @Body() dto: AddressStatusDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.addresses.setStatus(id, dto, user, locale);
  }
}
