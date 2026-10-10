import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { CreateListDto, CreateListItemDto, ReorderItemsDto, UpdateListDto, UpdateListItemDto } from './dto/list.dto.js';
import { ListsService } from './lists.service.js';

/** Settings → Lists. */
@Controller('lists')
export class ListsController {
  constructor(private readonly lists: ListsService) {}

  @RequirePermission('settings.view')
  @Get()
  overview(@Locale() locale: AppLocale) {
    return this.lists.overview(locale);
  }

  @RequirePermission('settings.view')
  @Get(':key')
  detail(@Param('key') key: string, @Locale() locale: AppLocale) {
    return this.lists.detail(key, locale);
  }

  @RequirePermission('settings.edit')
  @Post()
  create(@Body() dto: CreateListDto, @Locale() locale: AppLocale) {
    return this.lists.createList(dto, locale);
  }

  @RequirePermission('settings.edit')
  @Put(':key')
  update(@Param('key') key: string, @Body() dto: UpdateListDto, @Locale() locale: AppLocale) {
    return this.lists.updateList(key, dto, locale);
  }

  @RequirePermission('settings.edit')
  @Delete(':key')
  remove(@Param('key') key: string) {
    return this.lists.deleteList(key);
  }

  @RequirePermission('settings.edit')
  @Post(':key/items')
  addItem(@Param('key') key: string, @Body() dto: CreateListItemDto, @Locale() locale: AppLocale) {
    return this.lists.addItem(key, dto, locale);
  }

  @RequirePermission('settings.edit')
  @Put(':key/items/:code')
  updateItem(@Param('key') key: string, @Param('code') code: string, @Body() dto: UpdateListItemDto, @Locale() locale: AppLocale) {
    return this.lists.updateItem(key, code, dto, locale);
  }

  @RequirePermission('settings.edit')
  @HttpCode(200)
  @Post(':key/order')
  reorder(@Param('key') key: string, @Body() dto: ReorderItemsDto, @Locale() locale: AppLocale) {
    return this.lists.reorder(key, dto.codes, locale);
  }
}

/** The names forms, filters and badges need. Open to every signed-in person (no list holds anything private). */
@Controller('lookups')
export class LookupsController {
  constructor(private readonly lists: ListsService) {}

  /** `GET /lookups?keys=legal_form,bank` → `{ legal_form: { kind, items: [{ code, name, names, order, active, system, meta }] } }` */
  @Get()
  lookups(@Query('keys') keys: string | undefined, @Locale() locale: AppLocale) {
    const wanted = (keys ?? '')
      .split(',')
      .map(key => key.trim())
      .filter(Boolean)
      .slice(0, 40);
    return this.lists.lookups(wanted, locale);
  }
}
