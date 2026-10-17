import { Injectable, type OnModuleInit } from '@nestjs/common';
import { formatDay, parseDay } from '../../common/dates.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ReminderItem } from '../reminders/reminder-types.js';
import { RemindersService } from '../reminders/reminders.service.js';
import { OPEN_TASK_STATUSES, TASK_DUE_TRIGGER, TASK_REMINDER_DEFAULTS } from './tasks.constants.js';

/**
 * What the reminder engine may watch about tasks: the due date of a task that is still to do. The person it is assigned to is told (the rule's "responsible person"), so
 * everybody hears about their own tasks and nobody about everybody else's.
 */
@Injectable()
export class TaskRemindersService implements OnModuleInit {
  constructor(
    private readonly reminders: RemindersService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.reminders.register({
      trigger: TASK_DUE_TRIGGER,
      type: 'task',
      textKey: 'task.due',
      requires: 'tasks.view',
      names: { nl: 'Taak: einddatum', en: 'Task: due date' },
      description: {
        nl: 'De einddatum van een taak die nog niet klaar is. De medewerker aan wie de taak is toegewezen krijgt de herinnering (kies daarom “de verantwoordelijke medewerker”).',
        en: 'The due date of a task that is not done yet. The member of staff the task is assigned to gets the reminder (so choose “the responsible staff member”).',
      },
      defaults: { offsets: [...TASK_REMINDER_DEFAULTS.offsets], dayType: TASK_REMINDER_DEFAULTS.dayType, channels: [...TASK_REMINDER_DEFAULTS.channels] },
      items: today => this.items(today),
    });
  }

  private async items(today: string): Promise<ReminderItem[]> {
    const rows = await this.prisma.task.findMany({
      where: { isActive: true, status: { in: [...OPEN_TASK_STATUSES] }, assigneeId: { not: null }, dueDate: { gte: parseDay(today) } },
      select: { id: true, title: true, dueDate: true, linkedLabel: true, clientId: true, assigneeId: true },
    });
    return rows.map(row => ({
      subjectType: 'task',
      subjectId: row.id,
      dueOn: formatDay(row.dueDate!),
      clientId: row.clientId,
      userIds: [row.assigneeId!],
      params: { task: row.title, detail: row.linkedLabel ? `${row.linkedLabel} · ` : '', date: formatDay(row.dueDate!) },
      link: `/tasks?task=${row.id}`,
    }));
  }
}
