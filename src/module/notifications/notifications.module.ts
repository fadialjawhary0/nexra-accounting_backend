import { Module } from '@nestjs/common';
import { ListsModule } from '../lists/lists.module.js';
import { NotificationPreferencesController, NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

/** The inbox (Meldingen): the bell, the Notifications page, each person's preferences, and delivery by e-mail. */
@Module({
  imports: [ListsModule],
  controllers: [NotificationsController, NotificationPreferencesController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
