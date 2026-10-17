/*
 * The surcharge rules that ship with the system: examples, all switched off. They show what a rule looks like (weekend, public holiday, overtime,
 * evening) so the office can switch one on and change the percentage to what it has agreed — a collective agreement may say something else. Nobody
 * is paid a surcharge until the office switches a rule on.
 */
export interface SeedSurchargeRule {
  name: string;
  kind: 'weekend' | 'holiday' | 'overtime' | 'evening';
  conditions: Record<string, unknown>;
  percent: number;
  note: string;
}

export const SEED_SURCHARGE_RULES: SeedSurchargeRule[] = [
  { name: 'Zaterdag (voorbeeld)', kind: 'weekend', conditions: { days: ['sat'] }, percent: 25, note: 'Voorbeeld: 25% erbij voor uren op zaterdag. Pas het percentage aan en zet de regel aan als dit is afgesproken.' },
  { name: 'Zondag (voorbeeld)', kind: 'weekend', conditions: { days: ['sun'] }, percent: 50, note: 'Voorbeeld: 50% erbij voor uren op zondag.' },
  { name: 'Feestdag (voorbeeld)', kind: 'holiday', conditions: {}, percent: 100, note: 'Voorbeeld: 100% erbij voor uren op een officiële feestdag (volgens Instellingen → Agenda en feestdagen). Een feestdag op zaterdag of zondag telt alleen als feestdag.' },
  { name: 'Overwerk per dag (voorbeeld)', kind: 'overtime', conditions: { per: 'day', afterMinutes: 480 }, percent: 25, note: 'Voorbeeld: 25% erbij voor de uren na 8 uur op één dag.' },
  { name: 'Avonduren (voorbeeld)', kind: 'evening', conditions: { from: '20:00', to: '24:00' }, percent: 10, note: 'Voorbeeld: 10% erbij voor uren tussen 20:00 en 24:00. Werkt alleen voor uren met een begin- en eindtijd.' },
];
