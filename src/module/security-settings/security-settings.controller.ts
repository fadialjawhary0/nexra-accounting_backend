import { Body, Controller, Get, Put } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { SecuritySettingsService } from './security-settings.service.js';

/** Settings → Security policy: rate limits, lockout, session lengths, password rules, two-step verification, upload limit. */
@Controller('settings/security')
export class SecuritySettingsController {
  constructor(private readonly security: SecuritySettingsService) {}

  /** `{ values, definitions }` — the definitions carry the allowed minimum / maximum of every setting. */
  @RequirePermission('settings.view')
  @Get()
  get() {
    return this.security.describe();
  }

  /** Only the keys in the body change. A value outside its limits is a 422 with a message on that field. */
  @RequirePermission('settings.edit')
  @Put()
  update(@Body() body: Record<string, unknown>, @CurrentUser('id') actorId: string) {
    return this.security.update(body ?? {}, actorId);
  }
}
