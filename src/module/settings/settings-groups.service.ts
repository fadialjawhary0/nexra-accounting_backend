import { Injectable } from '@nestjs/common';
import { AuditService } from '../../lib/audit/audit.service.js';
import { SettingsService, type SettingValue } from '../../lib/settings/settings.service.js';
import { FilesService } from '../files/files.service.js';
import { DOCUMENTS_DEFINITIONS, DOCUMENTS_NAMESPACE, LOCALE_DEFINITIONS, LOCALE_NAMESPACE, OFFICE_DEFINITIONS, OFFICE_NAMESPACE } from './settings.definitions.js';

/** Reads and saves a settings group (office, language …) for the settings screens, and audits what changed. */
@Injectable()
export class SettingsGroupsService {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
  ) {
    settings.register(OFFICE_NAMESPACE, OFFICE_DEFINITIONS, { exposed: true });
    settings.register(LOCALE_NAMESPACE, LOCALE_DEFINITIONS, { exposed: true });
    settings.register(DOCUMENTS_NAMESPACE, DOCUMENTS_DEFINITIONS, { exposed: true });
  }

  /** `{ values, definitions }` — the definitions carry type, default and limits so the screen can draw the inputs. */
  describe(namespace: string) {
    return { values: this.settings.group(namespace), definitions: this.settings.definitionsOf(namespace) };
  }

  /** What every signed-in person may know of the office: the name and logo in the app's frame, the default languages and how soon expiring documents are flagged. */
  publicProfile() {
    const office = this.settings.group(OFFICE_NAMESPACE);
    return {
      office: { name: office.name, tradeName: office.tradeName, logoFileId: office.logoFileId },
      locale: this.settings.group(LOCALE_NAMESPACE),
      documents: this.settings.group(DOCUMENTS_NAMESPACE),
    };
  }

  async update(namespace: string, changes: Record<string, unknown>, actorId: string) {
    const before = this.settings.group(namespace);
    // A new logo must be an uploaded office logo; the one it replaces is switched off (its file stays for history).
    const logo = namespace === OFFICE_NAMESPACE && typeof changes.logoFileId === 'string' ? changes.logoFileId.trim() : undefined;
    if (logo && logo !== before.logoFileId) await this.files.assertUsable(logo, 'office_logo');
    const after = await this.settings.setGroup(namespace, changes, actorId);
    if (logo !== undefined && before.logoFileId && before.logoFileId !== after.logoFileId) await this.files.retire(before.logoFileId as string);
    const changed = Object.keys(after).filter(key => JSON.stringify(after[key]) !== JSON.stringify(before[key]));
    if (changed.length) {
      const pick = (source: Record<string, SettingValue>) => Object.fromEntries(changed.map(key => [key, source[key]]));
      await this.audit.log({ action: 'updated', entityType: 'settings', entityId: namespace, entityLabel: namespace, before: pick(before), after: pick(after) });
    }
    return this.describe(namespace);
  }
}
