import { Module } from '@nestjs/common';
import { ListsController, LookupsController } from './lists.controller.js';
import { ListsService } from './lists.service.js';
import { DeletionModule } from '../deletion/deletion.module.js';

@Module({
  imports: [DeletionModule],
  controllers: [ListsController, LookupsController],
  providers: [ListsService],
  exports: [ListsService],
})
export class ListsModule {}
