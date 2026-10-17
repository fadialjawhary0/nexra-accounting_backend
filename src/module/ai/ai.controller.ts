import { Controller, Get, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireAnyPermission, RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { AiService } from '../../lib/ai/ai.service.js';

/** What the AI is doing for the office: whether it is set up, what it costs, and a test of the connection (the settings themselves are `/settings/ai`). */
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  /** Is the AI set up and on, how much of this month's budget is used. People who import need it for their screens, so does Settings → AI, and so does the checklist of an inspection (reading the inspector's request). */
  @RequireAnyPermission('imports.view', 'settings.view', 'inspections.edit')
  @Get('status')
  status() {
    return this.ai.status();
  }

  /** This month's calls, tokens and cost per feature. */
  @RequirePermission('settings.view')
  @Get('usage')
  usage() {
    return this.ai.usage();
  }

  /** Asks each model a trivial question, so the screen can say whether the key and the model names work. */
  @RequirePermission('settings.edit')
  @Post('test')
  test(@CurrentUser('id') userId: string) {
    return this.ai.test(userId);
  }
}
