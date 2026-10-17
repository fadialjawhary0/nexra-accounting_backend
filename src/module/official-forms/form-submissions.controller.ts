import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { contentDisposition } from '../../common/content-disposition.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import type { LabelSize } from '../address-book/address-book.constants.js';
import { LabelQuery } from '../address-book/dto/address-book.dto.js';
import { SubmissionExportQuery, SubmissionListQuery, SubmissionStatusDto, UpdateSubmissionDto } from './dto/official-forms.dto.js';
import { FormSubmissionsService } from './form-submissions.service.js';

/**
 * The log of sent forms: what was filled in for which client, where it went and what has become of it. A form is added by filling it in
 * (`POST /official-forms/:id/submissions`); here it is followed — sent, dealt with, cancelled — and its envelope is made again when needed.
 */
@Controller('form-submissions')
@RequirePermission('official_forms.view')
export class FormSubmissionsController {
  constructor(
    private readonly submissions: FormSubmissionsService,
    private readonly exports: ExportsService,
  ) {}

  @Get()
  list(@Query() query: SubmissionListQuery, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.submissions.list(query, user, locale);
  }

  @RequirePermission('official_forms.export')
  @Get('export')
  async export(@Query() query: SubmissionExportQuery, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale, @Res({ passthrough: true }) response: Response) {
    return this.exports.download(response, await this.submissions.exportTable(query, user, locale), this.exports.parseFormat(query.format), user.name);
  }

  @Get(':id')
  one(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.submissions.one(id, user, locale);
  }

  /** `{ status?, sentOn?, doneOn?, followUpOn?, reference?, note?, recipientId? }` — a form is sent, dealt with, cancelled or opened again. */
  @RequirePermission('official_forms.create')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSubmissionDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.submissions.update(id, dto, user, locale);
  }

  /** `{ isActive, reason? }` — take an entry made by mistake out of the log (the PDF stays with the client's documents) or put it back. */
  @RequirePermission('official_forms.delete')
  @HttpCode(200)
  @Post(':id/status')
  status(@Param('id') id: string, @Body() dto: SubmissionStatusDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.submissions.setActive(id, dto, user, locale);
  }

  /** The envelope label of the address this form goes to (`size`: a5 · dl · c5). */
  @RequirePermission('official_forms.create')
  @Get(':id/label')
  async label(@Param('id') id: string, @Query() query: LabelQuery, @Locale() locale: AppLocale, @Res({ passthrough: true }) response: Response) {
    const label = await this.submissions.label(id, { size: query.size as LabelSize | undefined, sender: query.sender, locale });
    response.set({ 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "frame-ancestors 'self'", 'X-Content-Type-Options': 'nosniff' });
    return new StreamableFile(label.bytes, { type: 'application/pdf', disposition: contentDisposition(query.download ? 'attachment' : 'inline', label.name), length: label.bytes.length });
  }
}
