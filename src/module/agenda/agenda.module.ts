import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { TaxesModule } from '../taxes/taxes.module.js';
import { AgendaController } from './agenda.controller.js';
import { AgendaEventsService } from './agenda-events.service.js';
import { AgendaFeedService } from './agenda-feed.service.js';

/** The calendar page (Agenda): appointments people make, plus the dates that come from contracts, tasks, taxes and inspections. */
@Module({
  imports: [NotificationsModule, TaxesModule],
  controllers: [AgendaController],
  providers: [AgendaEventsService, AgendaFeedService],
  exports: [AgendaFeedService, AgendaEventsService],
})
export class AgendaModule {}
