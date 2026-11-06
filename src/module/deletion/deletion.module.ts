import { Module } from '@nestjs/common';
import { DeletionController } from './deletion.controller.js';
import { DeletionService } from './deletion.service.js';

/**
 * Deleting (soft) — Ahmad's notes, 06-11-2026. A deleted record and everything that goes with it stay in the database, marked with one `Deletion`; the Prisma client of the
 * app (`lib/database/soft-delete.ts`) never reads them again, so they are gone from every screen. Other modules use `DeletionService` for their own delete routes.
 */
@Module({
  controllers: [DeletionController],
  providers: [DeletionService],
  exports: [DeletionService],
})
export class DeletionModule {}
