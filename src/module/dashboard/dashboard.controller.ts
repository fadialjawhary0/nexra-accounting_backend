import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Locale, type AppLocale } from '../../common/decorators/locale.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { DashboardService } from './dashboard.service.js';

/** The dashboard and the small numbers in the sidebar. */
@Controller()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** Everything on the dashboard in one request; sections the person may not open are left out. */
  @RequirePermission('dashboard.view')
  @Get('dashboard')
  overview(@CurrentUser() user: AuthenticatedUser, @Locale() locale: AppLocale) {
    return this.dashboard.overview(user, locale);
  }

  /** `{ tasks, notifications }` — for every signed-in person (a number is 0 for a page the person may not open). */
  @Get('nav/badges')
  badges(@CurrentUser() user: AuthenticatedUser) {
    return this.dashboard.badges(user);
  }
}
