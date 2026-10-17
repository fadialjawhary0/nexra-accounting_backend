import { Module } from '@nestjs/common';
import { ListsModule } from '../lists/lists.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { RemindersModule } from '../reminders/reminders.module.js';
import { SearchModule } from '../search/search.module.js';
import { TaskSearchProvider } from './task-search.provider.js';
import { TaskLinksService } from './task-links.service.js';
import { TaskRemindersService } from './task-reminders.service.js';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';

/** Tasks (Taken): the office's to-do list — who does what by when, optionally about a client, a worker, a contract, an invoice, an inspection or a document. */
@Module({
  imports: [ListsModule, NotificationsModule, RemindersModule, SearchModule],
  controllers: [TasksController],
  providers: [TasksService, TaskLinksService, TaskRemindersService, TaskSearchProvider],
  exports: [TasksService, TaskLinksService],
})
export class TasksModule {}
