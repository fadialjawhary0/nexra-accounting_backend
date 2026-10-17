/**
 * What a new reminder rule for each contract trigger starts with — also what the seed creates (Ahmad: contract end 30 + 14 days, notice a month before
 * the end …). Plain data, so the seed can read it without starting the app.
 */
export const CONTRACT_REMINDER_DEFAULTS = {
  contract_end: { offsets: [30, 14], dayType: 'calendar', channels: ['in_app', 'email'] },
  contract_notice: { offsets: [7, 0], dayType: 'working', channels: ['in_app', 'email'] },
  probation_end: { offsets: [7], dayType: 'calendar', channels: ['in_app', 'email'] },
  on_call_year: { offsets: [30], dayType: 'calendar', channels: ['in_app', 'email'] },
} as const satisfies Record<string, { offsets: readonly number[]; dayType: 'calendar' | 'working'; channels: ReadonlyArray<'in_app' | 'email'> }>;

/** The names of the seeded rules (Dutch: the office's language). */
export const CONTRACT_REMINDER_NAMES: Record<keyof typeof CONTRACT_REMINDER_DEFAULTS, string> = {
  contract_end: 'Contract loopt af',
  contract_notice: 'Contract aanzeggen',
  probation_end: 'Proeftijd loopt af',
  on_call_year: 'Oproepkracht na 12 maanden',
};
