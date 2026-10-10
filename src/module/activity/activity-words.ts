import type { AppLocale } from '../../common/decorators/locale.decorator.js';

type Named = Record<AppLocale, string>;

/** Plain-language names of what the audit log records, for exports (the screens build their own sentences). Unknown codes show as they are. */
const ACTIONS: Record<string, Named> = {
  created: { nl: 'Aangemaakt', en: 'Created' },
  updated: { nl: 'Gewijzigd', en: 'Updated' },
  deleted: { nl: 'Verwijderd', en: 'Deleted' },
  activated: { nl: 'Geactiveerd', en: 'Activated' },
  deactivated: { nl: 'Gedeactiveerd', en: 'Deactivated' },
  signed_in: { nl: 'Ingelogd', en: 'Signed in' },
  signed_out: { nl: 'Uitgelogd', en: 'Signed out' },
  login_failed: { nl: 'Mislukte inlogpoging', en: 'Failed sign-in' },
  session_revoked: { nl: 'Sessie beëindigd', en: 'Session ended' },
  password_changed: { nl: 'Wachtwoord gewijzigd', en: 'Password changed' },
  password_reset_requested: { nl: 'Nieuw wachtwoord aangevraagd', en: 'Password reset requested' },
  password_reset: { nl: 'Wachtwoord opnieuw ingesteld', en: 'Password reset' },
  two_factor_enabled: { nl: 'Tweestapsverificatie ingeschakeld', en: 'Two-step verification turned on' },
  two_factor_disabled: { nl: 'Tweestapsverificatie uitgeschakeld', en: 'Two-step verification turned off' },
  two_factor_reset: { nl: 'Tweestapsverificatie gereset', en: 'Two-step verification reset' },
  recovery_codes_created: { nl: 'Herstelcodes aangemaakt', en: 'Recovery codes created' },
  invite_resent: { nl: 'Uitnodiging opnieuw verstuurd', en: 'Invitation re-sent' },
  invite_accepted: { nl: 'Uitnodiging geaccepteerd', en: 'Invitation accepted' },
};

const ENTITIES: Record<string, Named> = {
  user: { nl: 'Gebruiker', en: 'User' },
  role: { nl: 'Rol', en: 'Role' },
  session: { nl: 'Sessie', en: 'Session' },
  settings: { nl: 'Instellingen', en: 'Settings' },
  security_settings: { nl: 'Beveiligingsbeleid', en: 'Security policy' },
  numbering: { nl: 'Nummering', en: 'Numbering' },
  list: { nl: 'Keuzelijst', en: 'List' },
  holiday: { nl: 'Feestdag', en: 'Holiday' },
  file: { nl: 'Bestand', en: 'File' },
  form: { nl: 'Formulier', en: 'Form' },
};

export const actionName = (code: string, locale: AppLocale): string => ACTIONS[code]?.[locale] ?? code;
export const entityName = (code: string, locale: AppLocale): string => ENTITIES[code]?.[locale] ?? code;
