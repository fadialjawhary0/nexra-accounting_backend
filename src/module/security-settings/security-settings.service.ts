import { ConflictException, Injectable } from '@nestjs/common';
import { validationFailed } from '../../common/validation/failure.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { SECURITY_DEFINITIONS, SECURITY_NAMESPACE, type SecurityValues } from './security-settings.definitions.js';

/** The security policy: typed access for the code, and the save operation behind Settings → Security policy. */
@Injectable()
export class SecuritySettingsService {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {
    settings.register(SECURITY_NAMESPACE, SECURITY_DEFINITIONS);
  }

  /** The current policy (cached, always within the allowed limits). */
  get values(): SecurityValues {
    return this.settings.group(SECURITY_NAMESPACE) as unknown as SecurityValues;
  }

  /** Values together with their limits — what the settings screen needs to draw the inputs. */
  describe() {
    return { values: this.values, definitions: this.settings.definitionsOf(SECURITY_NAMESPACE) };
  }

  async update(changes: Record<string, unknown>, actorId: string) {
    const before = this.values;
    // An activity log that is kept for less than a year cannot answer an inspector: 0 (for ever) or at least twelve months.
    const retention = changes.auditRetentionMonths;
    if (typeof retention === 'number' && retention > 0 && retention < 12) throw validationFailed({ auditRetentionMonths: 'settings.securityPolicy.auditRetentionMinimum' });
    // Making two-step verification mandatory for everybody locks out whoever has not set it up — never the person pressing the button.
    if (changes.twoFactorRequireForEveryone === true && !before.twoFactorRequireForEveryone) await this.assertHasTwoFactor(actorId);
    const after = (await this.settings.setGroup(SECURITY_NAMESPACE, changes, actorId)) as unknown as SecurityValues;
    const diff = Object.keys(after).filter(key => after[key as keyof SecurityValues] !== before[key as keyof SecurityValues]);
    if (diff.length) {
      await this.audit.log({
        action: 'updated',
        entityType: 'security_settings',
        entityLabel: 'Security policy',
        before: Object.fromEntries(diff.map(key => [key, before[key as keyof SecurityValues]])),
        after: Object.fromEntries(diff.map(key => [key, after[key as keyof SecurityValues]])),
      });
    }
    return this.describe();
  }

  /** Throws 409 when this person has not turned on two-step verification yet. */
  async assertHasTwoFactor(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { twoFactorEnabled: true } });
    if (!user?.twoFactorEnabled) {
      throw new ConflictException({ code: 'two_factor_required_first', message: 'Set up two-step verification for your own account first, otherwise you would lock yourself out.' });
    }
  }
}
