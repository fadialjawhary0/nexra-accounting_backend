import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { addMonths, todayInAmsterdam } from '../../common/dates.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { SECURITY_NAMESPACE } from '../security-settings/security-settings.definitions.js';

/**
 * Keeps the activity log to the time the office chose (Settings → Security policy → "keep the activity log for N months"; 0 = for ever, which is the default). Every night
 * what is older is removed, and one entry says how many — the log itself never changes silently.
 */
@Injectable()
export class ActivityRetentionService {
  private readonly logger = new Logger(ActivityRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Cron('40 3 * * *', { timeZone: 'Europe/Amsterdam' })
  async purge(): Promise<number> {
    try {
      const months = this.settings.get<number>(`${SECURITY_NAMESPACE}.auditRetentionMonths`);
      if (!months) return 0;
      const before = addMonths(todayInAmsterdam(), -months);
      const removed = await this.prisma.activityLog.deleteMany({ where: { createdAt: { lt: new Date(`${before}T00:00:00.000Z`) } } });
      if (removed.count) {
        await this.audit.log({ action: 'deleted', entityType: 'activity_log', entityLabel: before, meta: { removed: removed.count, olderThan: before, months } });
        this.logger.log(`Removed ${removed.count} activity entries older than ${before}.`);
      }
      return removed.count;
    } catch (error) {
      this.logger.warn(`Could not clean the activity log: ${(error as Error).message.split('\n')[0]}`);
      return 0;
    }
  }
}
