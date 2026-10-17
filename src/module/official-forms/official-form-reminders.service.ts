import { Injectable, type OnModuleInit } from '@nestjs/common';
import { formatDay } from '../../common/dates.js';
import type { ReminderItem } from '../reminders/reminder-types.js';
import { RemindersService } from '../reminders/reminders.service.js';
import { FormSubmissionsService } from './form-submissions.service.js';
import { FORM_FOLLOW_UP_DEFAULTS, FORM_FOLLOW_UP_TRIGGER } from './official-forms.constants.js';

/**
 * What the reminder engine may watch about forms: a form that was sent and has a follow-up day ("about two weeks for a G-account release"). On that day — or the days
 * before it that the rule asks for — the people of the rule hear "no answer yet?". Marking the form as dealt with ends it.
 */
@Injectable()
export class OfficialFormRemindersService implements OnModuleInit {
  constructor(
    private readonly reminders: RemindersService,
    private readonly submissions: FormSubmissionsService,
  ) {}

  onModuleInit(): void {
    this.reminders.register({
      trigger: FORM_FOLLOW_UP_TRIGGER,
      type: 'form',
      textKey: 'form.follow_up',
      requires: 'official_forms.view',
      names: { nl: 'Verstuurd formulier: nog geen reactie', en: 'Sent form: no answer yet' },
      description: {
        nl: 'Een formulier dat is verstuurd en waarop een antwoord wordt verwacht (bijvoorbeeld een verzoek tot deblokkering van een G-rekening). De dag waarop je het opnieuw bekijkt, stel je per formulier in.',
        en: 'A form that was sent and is waiting for an answer (for example a request to release a G-account). The day to look at it again is set per form.',
      },
      defaults: { offsets: [...FORM_FOLLOW_UP_DEFAULTS.offsets], dayType: FORM_FOLLOW_UP_DEFAULTS.dayType, channels: [...FORM_FOLLOW_UP_DEFAULTS.channels] },
      items: today => this.items(today),
    });
  }

  private async items(today: string): Promise<ReminderItem[]> {
    const rows = await this.submissions.followUps(today);
    return rows.flatMap(row =>
      row.followUpOn
        ? [
            {
              subjectType: 'form_submission',
              subjectId: row.id,
              dueOn: formatDay(row.followUpOn),
              clientId: row.clientId,
              params: { form: row.form.nameNl, client: `${row.client.number} – ${row.client.name}`, sent: row.sentOn ? formatDay(row.sentOn) : '' },
              link: `/official-forms/sent?open=${row.id}`,
            } satisfies ReminderItem,
          ]
        : [],
    );
  }
}
