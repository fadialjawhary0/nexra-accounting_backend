import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { CreateTaskDto, TaskActiveDto, TaskExportQuery, TaskListQuery, UpdateTaskDto } from './dto/tasks.dto.js';
import { TasksService } from './tasks.service.js';

/** The office's to-do list. Everything is checked against the permission area `tasks`. */
@Controller('tasks')
@RequirePermission('tasks.view')
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly exports: ExportsService,
  ) {}

  /** Filters: `mine`, `assigneeId` (or `none`), `status`, `priority`, `linkedType` + `linkedId`, `clientId`, `tag`, `open`, `due`, `state`, `search`; `stats=true` adds the counters. */
  @Get()
  list(@Query() query: TaskListQuery, @CurrentUser() user: AuthenticatedUser) {
    return this.tasks.list(query, user);
  }

  @RequirePermission('tasks.export')
  @Get('export')
  async export(@Query() query: TaskExportQuery, @CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale, @Res({ passthrough: true }) response: Response) {
    return this.exports.download(response, await this.tasks.exportTable(query, user, locale), this.exports.parseFormat(query.format), user.name);
  }

  @Get(':id')
  one(@Param('id') id: string) {
    return this.tasks.one(id);
  }

  @RequirePermission('tasks.create')
  @Post()
  create(@Body() dto: CreateTaskDto, @CurrentUser() user: AuthenticatedUser) {
    return this.tasks.create(dto, user);
  }

  /** Changes what is sent and nothing else (`PUT` and `PATCH` do the same). */
  @RequirePermission('tasks.edit')
  @Put(':id')
  replace(@Param('id') id: string, @Body() dto: UpdateTaskDto, @CurrentUser() user: AuthenticatedUser) {
    return this.tasks.update(id, dto, user);
  }

  @RequirePermission('tasks.edit')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTaskDto, @CurrentUser() user: AuthenticatedUser) {
    return this.tasks.update(id, dto, user);
  }

  /** The round check button: done ↔ to do. */
  @RequirePermission('tasks.edit')
  @HttpCode(200)
  @Post(':id/toggle')
  toggle(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tasks.toggle(id, user);
  }

  /** `{ isActive }` — brings a task that was taken away back (or takes it away). */
  @RequirePermission('tasks.delete')
  @HttpCode(200)
  @Post(':id/active')
  active(@Param('id') id: string, @Body() dto: TaskActiveDto, @CurrentUser() user: AuthenticatedUser) {
    return this.tasks.setActive(id, dto.isActive, user);
  }

  /** Taking a task away switches it off; `POST /tasks/:id/active` brings it back. */
  @RequirePermission('tasks.delete')
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tasks.setActive(id, false, user);
  }
}
