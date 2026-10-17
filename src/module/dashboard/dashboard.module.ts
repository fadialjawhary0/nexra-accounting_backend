import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module.js';
import { AgendaModule } from '../agenda/agenda.module.js';
import { CalendarModule } from '../calendar/calendar.module.js';
import { ContractsModule } from '../contracts/contracts.module.js';
import { DocumentsFeatureModule } from '../documents/documents.module.js';
import { InspectionsModule } from '../inspections/inspections.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ReconciliationModule } from '../reconciliation/reconciliation.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { TaxesModule } from '../taxes/taxes.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

/** The dashboard (Overzicht): what needs attention right now, gathered from the other parts of the app. */
@Module({
  imports: [ActivityModule, AgendaModule, CalendarModule, ContractsModule, DocumentsFeatureModule, InspectionsModule, NotificationsModule, ReconciliationModule, TasksModule, TaxesModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
