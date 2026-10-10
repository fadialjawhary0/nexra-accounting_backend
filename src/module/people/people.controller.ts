import { Body, Controller, Get, Param, Patch, Put, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireAnyPermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { PersonLookupQuery, SavePersonDto } from './dto/person.dto.js';
import { PeopleService } from './people.service.js';

/**
 * The people records themselves (owners, directors, partners, contact persons, workers). Their links to clients live under
 * `/clients/:id/people`, their employments under `/employees`. Whoever works with clients or with workers may read; whoever may change
 * either may change — what a person may see of a record is decided per field (`personal_data`).
 */
@Controller('people')
export class PeopleController {
  constructor(private readonly people: PeopleService) {}

  /** `?search=` — people matching a name, to use an existing person instead of typing them again. */
  @RequireAnyPermission('clients.edit', 'employees.create', 'employees.edit')
  @Get('lookup')
  lookup(@Query() query: PersonLookupQuery) {
    return this.people.lookup(query);
  }

  /** One person with every value this user may see; restricted values are decrypted — and the audit log says who looked. */
  @RequireAnyPermission('clients.view', 'employees.view')
  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.people.get(id, user);
  }

  @RequireAnyPermission('clients.edit', 'employees.edit')
  @Put(':id')
  replace(@Param('id') id: string, @Body() dto: SavePersonDto, @CurrentUser() user: AuthenticatedUser) {
    return this.people.update(id, dto, user);
  }

  @RequireAnyPermission('clients.edit', 'employees.edit')
  @Patch(':id')
  patch(@Param('id') id: string, @Body() dto: SavePersonDto, @CurrentUser() user: AuthenticatedUser) {
    return this.people.update(id, dto, user);
  }
}
