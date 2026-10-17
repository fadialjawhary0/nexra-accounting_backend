import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { AgendaEventsService } from './agenda-events.service.js';
import { AgendaFeedService } from './agenda-feed.service.js';
import { CreateEventDto, EventActiveDto, FeedQuery, PeopleQuery, UpdateEventDto } from './dto/agenda.dto.js';

/**
 * The calendar page: appointments and the dates that come from other records. (The public holidays, the weekend and the working-day arithmetic are in `CalendarController`.)
 * Everything is checked against the permission area `calendar`; dates from other records are only shown to people who may open them.
 */
@Controller('calendar')
export class AgendaController {
  constructor(
    private readonly events: AgendaEventsService,
    private readonly feed: AgendaFeedService,
  ) {}

  /** `from`, `to` (days, at most 400 apart), `types` (comma separated), `clientId`. `meta.counts` has the number per kind. */
  @RequirePermission('calendar.view')
  @Get('events')
  list(@Query() query: FeedQuery, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.feed.feed(query, user, locale);
  }

  /** Colleagues and (for people who may open clients) the clients' contacts, for the guest list. */
  @RequirePermission('calendar.view')
  @Get('people')
  people(@Query() query: PeopleQuery, @CurrentUser() user: AuthenticatedUser) {
    return this.events.people(query.search, user.matrix);
  }

  /** An appointment (`id`) or a date from another record (`derived:contract:<id>`, `derived:task:<id>`, `derived:inspection:<id>`). */
  @RequirePermission('calendar.view')
  @Get('events/:id')
  one(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.feed.one(id, user, locale);
  }

  @RequirePermission('calendar.create')
  @Post('events')
  create(@Body() dto: CreateEventDto, @CurrentUser() user: AuthenticatedUser) {
    return this.events.create(dto, user);
  }

  /** Changes what is sent and nothing else (`PUT` and `PATCH` do the same). Dates from other records are changed on their own record. */
  @RequirePermission('calendar.edit')
  @Put('events/:id')
  replace(@Param('id') id: string, @Body() dto: UpdateEventDto, @CurrentUser() user: AuthenticatedUser) {
    return this.events.update(id, dto, user);
  }

  @RequirePermission('calendar.edit')
  @Patch('events/:id')
  update(@Param('id') id: string, @Body() dto: UpdateEventDto, @CurrentUser() user: AuthenticatedUser) {
    return this.events.update(id, dto, user);
  }

  /** `{ isActive }` — cancels an appointment (it stays for history) or brings it back. */
  @RequirePermission('calendar.delete')
  @HttpCode(200)
  @Post('events/:id/active')
  active(@Param('id') id: string, @Body() dto: EventActiveDto, @CurrentUser() user: AuthenticatedUser) {
    return this.events.setActive(id, dto.isActive, user);
  }

  /** Cancelling an appointment switches it off; `POST /calendar/events/:id/active` brings it back. */
  @RequirePermission('calendar.delete')
  @Delete('events/:id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.events.setActive(id, false, user);
  }
}
