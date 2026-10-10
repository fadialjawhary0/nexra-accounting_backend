import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { InviteUserDto, SetUserStatusDto, UpdateUserDto, UserListQuery } from './dto/user.dto.js';
import { UsersService } from './users.service.js';

@Controller('users')
@RequirePermission('users.view')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly exports: ExportsService,
  ) {}

  /** `meta.stats` (with `?stats=true`) are the counters above the list: total, active, invited, disabled, two-step, active this week. */
  @Get()
  list(@Query() query: UserListQuery) {
    return this.users.list(query);
  }

  /** `GET /users/export?format=xlsx|pdf|docx` + the list's filters (`search`, `role`, `status`, `twoFactor`, `sort`): everything that matches, as a download. */
  @RequirePermission('users.export')
  @Get('export')
  async export(@Query() query: UserListQuery, @Query('format') format: string | undefined, @Locale() locale: AppLocale, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: Response) {
    const chosen = this.exports.parseFormat(format);
    const { table, count } = await this.users.exportTable(query, locale);
    this.exports.assertSize(count);
    return this.exports.download(response, table, chosen, user.name);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.users.get(id);
  }

  @RequirePermission('users.create')
  @Post()
  invite(@Body() dto: InviteUserDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.users.invite(dto, actor);
  }

  @RequirePermission('users.edit')
  @Put(':id')
  replace(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.users.update(id, dto, actor);
  }

  @RequirePermission('users.edit')
  @Patch(':id')
  patch(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.users.update(id, dto, actor);
  }

  /** `{ status: 'active' | 'disabled' }` — people are never deleted, they are switched off. */
  @RequirePermission('users.edit')
  @HttpCode(200)
  @Post(':id/status')
  setStatus(@Param('id') id: string, @Body() dto: SetUserStatusDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.users.setStatus(id, dto.status, actor);
  }

  @RequirePermission('users.edit')
  @HttpCode(200)
  @Post(':id/resend-invite')
  resendInvite(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.users.resendInvite(id, actor);
  }

  @RequirePermission('users.edit')
  @HttpCode(200)
  @Post(':id/reset-password')
  resetPassword(@Param('id') id: string) {
    return this.users.resetPassword(id);
  }

  @RequirePermission('users.edit')
  @HttpCode(200)
  @Post(':id/two-factor/reset')
  resetTwoFactor(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.users.resetTwoFactor(id, actor);
  }

  @RequirePermission('users.delete')
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.users.remove(id, actor);
  }
}
