import { Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { DeletionService } from './deletion.service.js';

/**
 * Deleting anything (soft) and bringing it back:
 *   GET    /deletions/:type/:id/preview   what would go with it, or why it cannot be deleted (nothing changes)
 *   DELETE /deletions/:type/:id           deletes it and what goes with it → { deletionId, label, counts }
 *   POST   /deletions/:deletionId/restore brings that deletion back (the "Undo" right after deleting)
 * `type` is `client`, `employee`, `contract` … (deletion.specs.ts). Every call needs `<area>.remove` of that type — checked by the service, because the area follows the type.
 */
@Controller('deletions')
export class DeletionController {
  constructor(private readonly deletions: DeletionService) {}

  @Get(':type/:id/preview')
  preview(@Param('type') type: string, @Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.deletions.preview(type, id, user);
  }

  @Delete(':type/:id')
  remove(@Param('type') type: string, @Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.deletions.delete(type, id, user);
  }

  @HttpCode(200)
  @Post(':deletionId/restore')
  restore(@Param('deletionId') deletionId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.deletions.restore(deletionId, user);
  }
}
