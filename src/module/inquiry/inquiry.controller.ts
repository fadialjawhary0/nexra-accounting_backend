import { Controller, Get, Param, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { contentDisposition } from '../../common/content-disposition.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { InquiryService } from './inquiry.service.js';

/** The worker inquiry: one worker, one month — hours, where, salary, invoices and what does not match. Salary and invoices appear only for people who may see them. */
@Controller('employees')
@RequirePermission('hours.view')
export class InquiryController {
  constructor(
    private readonly inquiry: InquiryService,
    private readonly exports: ExportsService,
  ) {}

  /** `month=YYYY-MM` */
  @Get(':id/inquiry')
  one(@Param('id') id: string, @Query('month') month: string, @CurrentUser() user: AuthenticatedUser) {
    return this.inquiry.inquiry(id, month, user);
  }

  /** The inquiry as a download: `format=xlsx|pdf|docx`. */
  @RequirePermission('hours.export')
  @Get(':id/inquiry/export')
  async export(@Param('id') id: string, @Query('month') month: string, @Query('format') format: string | undefined, @Locale() locale: AppLocale, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: Response) {
    const chosen = this.exports.parseFormat(format);
    return this.exports.download(response, await this.inquiry.table(id, month, user, locale), chosen, user.name);
  }

  /** One ZIP with the inquiry, the salary statements and the invoices of the month. */
  @RequirePermission('hours.export')
  @Get(':id/inquiry/bundle')
  async bundle(@Param('id') id: string, @Query('month') month: string, @Locale() locale: AppLocale, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: Response) {
    const file = await this.inquiry.bundle(id, month, user, locale);
    response.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    return new StreamableFile(file.buffer, { type: file.mimeType, disposition: contentDisposition('attachment', file.filename), length: file.buffer.length });
  }
}
