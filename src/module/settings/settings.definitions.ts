import type { SettingDefinitions } from '../../lib/settings/settings.service.js';

/*
 * Office details and language settings Ahmad edits in Settings → Office / Language & formats. Every value has a sensible default
 * (shipped with the system) and is only stored when he changes it; screens read them through SettingsService.
 */

export const OFFICE_NAMESPACE = 'office';

/** Nexra's own details: the sender on letters and mails, and the authorised representative (*gemachtigde*) on official forms. */
export const OFFICE_DEFINITIONS = {
  name: { type: 'string', default: 'Nexra B.V.', required: true, maxLength: 120, group: 'company' },
  tradeName: { type: 'string', default: '', maxLength: 120, group: 'company' },
  street: { type: 'string', default: '', maxLength: 120, group: 'address' },
  houseNumber: { type: 'string', default: '', maxLength: 10, group: 'address' },
  houseNumberSuffix: { type: 'string', default: '', maxLength: 10, group: 'address' },
  postalCode: { type: 'string', default: '', format: 'postcode', group: 'address' },
  city: { type: 'string', default: '', maxLength: 80, group: 'address' },
  phone: { type: 'string', default: '', format: 'phone', group: 'contact' },
  email: { type: 'string', default: '', format: 'email', group: 'contact' },
  website: { type: 'string', default: '', format: 'url', group: 'contact' },
  kvk: { type: 'string', default: '', format: 'kvk', group: 'registration' },
  vatNumber: { type: 'string', default: '', format: 'vat', group: 'registration' },
  iban: { type: 'string', default: '', format: 'iban', group: 'registration' },
  /** The uploaded logo (a file id from /files); empty = the built-in Nexra logo. */
  logoFileId: { type: 'string', default: '', maxLength: 60, group: 'branding' },
} satisfies SettingDefinitions;

export const DOCUMENTS_NAMESPACE = 'documents';

/** How documents are watched: the lead time of "expires soon" (ID cards, residence permits, certificates). Phase 12 adds the rest (types, valid-until rules). */
export const DOCUMENTS_DEFINITIONS = {
  expiryWarningDays: { type: 'int', default: 90, min: 7, max: 365, group: 'expiry' },
} satisfies SettingDefinitions;

export const LOCALE_NAMESPACE = 'locale';

export const LOCALES = ['nl', 'en'] as const;

/** Language of the app for new people and of the documents and e-mails the system writes. */
export const LOCALE_DEFINITIONS = {
  defaultLocale: { type: 'enum', default: 'nl', options: LOCALES, group: 'language' },
  documentLocale: { type: 'enum', default: 'nl', options: LOCALES, group: 'language' },
} satisfies SettingDefinitions;
