import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { CreateVatStepDto, ReorderStepsDto, UpdateVatStepDto } from './dto/taxes.dto.js';
import { VatStepsService } from './vat-steps.service.js';

/** The steps of the VAT tracker (Settings → Taxes). Reading them belongs to working with the tracker; changing them is part of the settings. */
@Controller('taxes/vat-steps')
@RequirePermission('taxes.view')
export class VatStepsController {
  constructor(private readonly steps: VatStepsService) {}

  /** Every step, the ones that are switched off included. */
  @Get()
  list(@Locale() locale: AppLocale) {
    return this.steps.list(locale);
  }

  @RequirePermission('settings.edit')
  @Post()
  create(@Body() dto: CreateVatStepDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.steps.create(dto, user, locale);
  }

  /** `{ ids }` — the new order (steps that are not named keep their order after the named ones). */
  @RequirePermission('settings.edit')
  @HttpCode(200)
  @Put('order')
  reorder(@Body() dto: ReorderStepsDto, @Locale() locale: AppLocale) {
    return this.steps.reorder(dto.ids, locale);
  }

  @RequirePermission('settings.edit')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateVatStepDto, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.steps.update(id, dto, user, locale);
  }
}
