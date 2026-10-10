import { Body, Controller, Get, Param, Patch, Put, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ClientPeopleService } from './client-people.service.js';
import { PersonLookupQuery, SavePersonDto } from './dto/client.dto.js';

/** The people records themselves (owners, directors, partners, contact persons). Their links to clients live under `/clients/:id/people`. */
@Controller('people')
@RequirePermission('clients.view')
export class PeopleController {
  constructor(private readonly people: ClientPeopleService) {}

  /** `?search=` — people matching a name, to link an existing person instead of typing them again. */
  @RequirePermission('clients.edit')
  @Get('lookup')
  lookup(@Query() query: PersonLookupQuery) {
    return this.people.lookup(query);
  }

  /** One person with every value this user may see; restricted values are decrypted — and the audit log says who looked. */
  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.people.get(id, user);
  }

  @RequirePermission('clients.edit')
  @Put(':id')
  replace(@Param('id') id: string, @Body() dto: SavePersonDto, @CurrentUser() user: AuthenticatedUser) {
    return this.people.update(id, dto, user);
  }

  @RequirePermission('clients.edit')
  @Patch(':id')
  patch(@Param('id') id: string, @Body() dto: SavePersonDto, @CurrentUser() user: AuthenticatedUser) {
    return this.people.update(id, dto, user);
  }
}
