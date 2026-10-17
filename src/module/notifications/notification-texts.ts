/*
 * The words of the notifications the system writes itself (reminders, warnings). A notification is stored as a key and a few values and written in
 * the language of the person who reads it, so the same reminder is Dutch for one colleague and English for another. `{name}` is replaced by a value;
 * `{when}` is made from `days` ("over 14 dagen", "vandaag").
 */

export type TextLocale = 'nl' | 'en';

export interface NotificationText {
  nl: { title: string; body?: string };
  en: { title: string; body?: string };
  /** The WhatsApp message (a `MessageTemplate` code) that goes with the notification: the bell then offers an "Open WhatsApp" button. */
  whatsapp?: string;
}

export const NOTIFICATION_TEXTS: Record<string, NotificationText> = {
  'contract.ending': {
    nl: { title: 'Het contract van {worker} loopt af {when}', body: '{client} · laatste dag {date}. Verlengen of beëindigen?' },
    en: { title: '{worker}’s contract ends {when}', body: '{client} · last day {date}. Renew or end it?' },
    whatsapp: 'contract_ending',
  },
  'contract.notice': {
    nl: { title: 'Zeg het contract van {worker} aan — uiterlijk {deadline}', body: '{client} · het contract eindigt op {date}. Laat de werknemer schriftelijk weten of het wordt voortgezet (aanzegverplichting).' },
    en: { title: 'Give notice for {worker}’s contract — by {deadline}', body: '{client} · the contract ends on {date}. Tell the employee in writing whether it continues (notice of non-renewal).' },
    whatsapp: 'contract_notice',
  },
  'contract.probation': {
    nl: { title: 'De proeftijd van {worker} eindigt {when}', body: '{client} · laatste dag van de proeftijd: {date}.' },
    en: { title: '{worker}’s probation ends {when}', body: '{client} · last day of probation: {date}.' },
  },
  'contract.on_call_year': {
    nl: { title: '{worker} werkt {when} een jaar als oproepkracht', body: '{client} · bied binnen een maand een vast aantal uren aan (minstens het gemiddelde van de afgelopen twaalf maanden).' },
    en: { title: '{worker} will have been on call for a year {when}', body: '{client} · offer a fixed number of hours within a month (at least the average of the past twelve months).' },
    whatsapp: 'contract_on_call_year',
  },
  'document.expiring': {
    nl: { title: 'Het document “{document}” verloopt {when}', body: '{client} · {type} · geldig tot {date}. Vraag een nieuw exemplaar aan.' },
    en: { title: 'The document “{document}” expires {when}', body: '{client} · {type} · valid until {date}. Ask for a new copy.' },
  },
  'document.age': {
    nl: { title: 'Vraag een nieuw {type} aan voor {client} — het is {when} te oud', body: '“{document}” is geldig tot {date}.' },
    en: { title: 'Get a new {type} for {client} — it will be too old {when}', body: '“{document}” is good until {date}.' },
  },
  'worker_document.expiring': {
    nl: { title: 'Het {document} van {worker} verloopt {when}', body: '{client} · geldig tot {date}. Vraag een nieuwe kopie aan.' },
    en: { title: '{worker}’s {document} expires {when}', body: '{client} · valid until {date}. Ask for a new copy.' },
  },
  'form.follow_up': {
    nl: { title: 'Opvolgen {when}: {form} voor {client}', body: 'Verstuurd op {sent}. Is er antwoord gekomen? Zet de status op afgehandeld of neem contact op.' },
    en: { title: 'Follow up {when}: {form} for {client}', body: 'Sent on {sent}. Has an answer come? Mark it as dealt with, or get in touch.' },
  },
  // `…Nl` / `…En` values are the same thing in both languages: each text uses its own.
  'inspection.upcoming': {
    nl: { title: 'Controle bij {client} {when}', body: '{typeNl} door {bodyNl} op {date}. {statusNl}' },
    en: { title: 'Inspection at {client} {when}', body: '{typeEn} by {bodyEn} on {date}. {statusEn}' },
  },
  'inspection.response_due': {
    nl: { title: 'Antwoord aan {bodyNl} voor {client}: uiterlijk {when}', body: 'Controle {number}. De gevraagde stukken moeten er {date} zijn.' },
    en: { title: 'Answer to {bodyEn} for {client}: due {when}', body: 'Inspection {number}. The documents asked for have to be there on {date}.' },
  },
  'inspection.follow_up': {
    nl: { title: 'Opvolging na de controle bij {client}: {when}', body: '{text} (controle {number}, uiterlijk {date}).' },
    en: { title: 'Follow-up after the inspection at {client}: {when}', body: '{text} (inspection {number}, due {date}).' },
  },
  'tax.vat_deadline': {
    nl: { title: 'Btw-aangifte {periodNl}: deadline {when}', body: '{openNl} Deadline: {date}.' },
    en: { title: 'VAT return {periodEn}: deadline {when}', body: '{openEn} Deadline: {date}.' },
  },
  'tax.return_deadline': {
    nl: { title: '{kindNl} {year}: deadline {when}', body: '{openNl} Deadline: {date}. Dien de aangifte in of vraag uitstel aan.' },
    en: { title: '{kindEn} {year}: deadline {when}', body: '{openEn} Deadline: {date}. File the return or ask for an extension.' },
  },
  'invoice.due': {
    nl: { title: 'Facturen: betaaltermijn {when}', body: '{countNl} Vervaldatum: {date}. Controleer of ze betaald zijn en markeer ze als betaald.' },
    en: { title: 'Invoices: payment due {when}', body: '{countEn} Due date: {date}. Check whether they were paid and mark them as paid.' },
  },
  'task.assigned': {
    nl: { title: '{person} heeft je een taak gegeven', body: '{detail}' },
    en: { title: '{person} assigned you a task', body: '{detail}' },
  },
  'task.completed': {
    nl: { title: '{person} heeft een taak afgerond die jij had gemaakt', body: '{detail}' },
    en: { title: '{person} completed a task you created', body: '{detail}' },
  },
  'task.due': {
    nl: { title: 'Taak “{task}”: einddatum {when}', body: '{detail}Einddatum: {date}.' },
    en: { title: 'Task “{task}”: due {when}', body: '{detail}Due: {date}.' },
  },
  'event.invited': {
    nl: { title: '{person} heeft je uitgenodigd voor “{title}”', body: '{detail}' },
    en: { title: '{person} invited you to “{title}”', body: '{detail}' },
  },
  'event.cancelled': {
    nl: { title: '“{title}” is geannuleerd', body: '{detail}' },
    en: { title: '“{title}” was cancelled', body: '{detail}' },
  },
  'event.reminder': {
    nl: { title: '“{title}” begint {inNl}', body: '{detail}' },
    en: { title: '“{title}” starts {inEn}', body: '{detail}' },
  },
  'import.review': {
    nl: { title: 'De import “{name}” is klaar om te controleren', body: '{count} bestanden wachten op jouw controle.' },
    en: { title: 'The import “{name}” is ready to review', body: '{count} files are waiting for you to check them.' },
  },
  'import.done': {
    nl: { title: 'De import “{name}” is klaar', body: '{done} verwerkt, {failed} met een fout.' },
    en: { title: 'The import “{name}” has finished', body: '{done} done, {failed} with an error.' },
  },
  'import.failed': {
    nl: { title: 'De import “{name}” kon niet worden afgerond', body: 'Kijk in de lijst wat er mis ging.' },
    en: { title: 'The import “{name}” could not be finished', body: 'Look in the list to see what went wrong.' },
  },
  'inbox.review': {
    nl: { title: 'De AI heeft je bericht gelezen', body: '“{name}”: {count} om te controleren en op te slaan.' },
    en: { title: 'The AI has read your message', body: '“{name}”: {count} to check and save.' },
  },
  'inbox.failed': {
    nl: { title: 'Je bericht aan de AI kon niet worden verwerkt', body: '“{name}”: kijk op de pagina wat er mis ging.' },
    en: { title: 'Your message to the AI could not be handled', body: '“{name}”: look at the page to see what went wrong.' },
  },
  'ai.budget_warning': {
    nl: { title: 'AI-budget: {percent}% van deze maand is gebruikt', body: '$ {spent} van het budget van $ {limit}. Je kunt het budget aanpassen in Instellingen → AI.' },
    en: { title: 'AI budget: {percent}% of this month is used', body: '$ {spent} of the $ {limit} budget. You can change the budget in Settings → AI.' },
  },
  'ai.budget_exceeded': {
    nl: { title: 'Het AI-budget van deze maand is op', body: 'Tot de volgende maand (of een hoger budget) worden bestanden alleen gesorteerd op hun map en bestandsnaam.' },
    en: { title: 'This month’s AI budget is used up', body: 'Until next month (or a higher budget) files are only sorted by their folder and file name.' },
  },
};

/** "over 14 dagen" · "vandaag" · "morgen" · "14 dagen geleden". */
export function whenText(days: number, locale: TextLocale): string {
  if (locale === 'nl') {
    if (days === 0) return 'vandaag';
    if (days === 1) return 'morgen';
    if (days === -1) return 'gisteren';
    return days > 0 ? `over ${days} dagen` : `${-days} dagen geleden`;
  }
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

/** Dates inside values (`date`, `deadline`, `start`) are shown as `31-12-2026`. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const asText = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : String(value);
  return DAY.test(text) ? `${text.slice(8, 10)}-${text.slice(5, 7)}-${text.slice(0, 4)}` : text;
};

/** The notification as a person reads it. An unknown key (a text that was removed from the code) falls back to the key itself. */
export function renderText(key: string, params: Record<string, unknown>, locale: TextLocale): { title: string; body: string } {
  const entry = NOTIFICATION_TEXTS[key];
  if (!entry) return { title: key, body: '' };
  const values: Record<string, string> = Object.fromEntries(Object.entries(params).map(([name, value]) => [name, asText(value)]));
  if (typeof params.days === 'number') values.when = whenText(params.days, locale);
  const fill = (text: string | undefined) => (text ?? '').replace(/\{(\w+)\}/g, (_match, name: string) => values[name] ?? '');
  return { title: fill(entry[locale].title), body: fill(entry[locale].body) };
}

/** What the message of a notification says in a sentence for an e-mail digest. */
export const digestHeading = (count: number, locale: TextLocale): string =>
  locale === 'nl' ? (count === 1 ? 'Er is 1 herinnering voor je' : `Er zijn ${count} herinneringen voor je`) : count === 1 ? 'You have 1 reminder' : `You have ${count} reminders`;
