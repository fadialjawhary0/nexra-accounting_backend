import { Controller, ForbiddenException, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import { ActivityService } from './activity.service.js';
import { ActivityListQuery } from './dto/activity-query.dto.js';

/** What it takes to read the history of ONE record of these kinds (anything else needs the activity log permission). */
const RECORD_HISTORY_PERMISSION: Record<string, string> = { user: 'users.view', role: 'users.view', security_settings: 'settings.view' };
const FULL_LOG_PERMISSION = 'activity.view';

@Controller('activity')
export class ActivityController {
  constructor(
    private readonly activity: ActivityService,
    private readonly exports: ExportsService,
  ) {}

  /** Options for the log's filters: the people, actions and kinds of record that appear in it. */
  @RequirePermission('activity.view')
  @Get('filters')
  filters() {
    return this.activity.filters();
  }

  /** `GET /activity/export?format=xlsx|pdf|docx` + the list's filters: the whole log (not one record's history) as a download. */
  @RequirePermission('activity.export')
  @Get('export')
  async export(@Query() query: ActivityListQuery, @Query('format') format: string | undefined, @Locale() locale: AppLocale, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: Response) {
    const chosen = this.exports.parseFormat(format);
    const { table, count } = await this.activity.exportTable(query, locale);
    this.exports.assertSize(count);
    return this.exports.download(response, table, chosen, user.name);
  }

  /**
   * The audit log, newest first. Filter by record, action, person and period. The whole log needs `activity.view`; the history of
   * a single record (`entityType` + `entityId`, shown on detail pages) needs whatever it takes to see that record.
   */
  @Get()
  list(@Query() query: ActivityListQuery, @CurrentUser() user: AuthenticatedUser) {
    const needed = query.entityType && query.entityId ? (RECORD_HISTORY_PERMISSION[query.entityType] ?? FULL_LOG_PERMISSION) : FULL_LOG_PERMISSION;
    if (!matrixAllows(user.matrix, needed)) throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this.', details: { missing: [needed] } });
    return this.activity.list(query);
  }
}
