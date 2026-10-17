import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { RemindersController } from './reminders.controller.js';
import { RemindersService } from './reminders.service.js';

/** Reminders (Herinneringen): rules that tell people N days before a date, the engine that makes them, and the list of what features let it watch. */
@Module({
  imports: [CalendarModule, NotificationsModule],
  controllers: [RemindersController],
  providers: [RemindersService],
  exports: [RemindersService],
})
export class RemindersModule {}
