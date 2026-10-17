import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { SearchQuery } from './dto/search.dto.js';
import { SearchService } from './search.service.js';

@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  /** `?q=` (two characters or more) → `{ clients: [...], employees: [...], … }`: the hits per group, only from the parts of the app the person may open. */
  @Get()
  find(@Query() query: SearchQuery, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.search.search(query.q, user, locale, query.limit ?? 5);
  }
}
