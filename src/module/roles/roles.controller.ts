import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto.js';
import { RolesService } from './roles.service.js';

@Controller('roles')
@RequirePermission('users.view')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  /** Every role (not paged) with how many people hold it. */
  @Get()
  list() {
    return this.roles.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.roles.get(id);
  }

  @RequirePermission('users.create')
  @Post()
  create(@Body() dto: CreateRoleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.roles.create(dto, actor);
  }

  @RequirePermission('users.edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.roles.update(id, dto, actor);
  }

  @RequirePermission('users.delete')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.roles.remove(id);
  }
}

@Controller('permissions')
export class PermissionsController {
  constructor(private readonly roles: RolesService) {}

  /** The areas × actions every role is built from. Not secret, so any signed-in person may read it. */
  @Get('catalog')
  catalog() {
    return this.roles.catalog();
  }
}
