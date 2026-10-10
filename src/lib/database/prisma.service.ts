import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import { AppConfigService } from '../config/app-config.service.js';

/** The one Prisma client of the app (PostgreSQL through the `pg` driver adapter). Inject it; never `new PrismaClient()`. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(private readonly appConfig: AppConfigService) {
    super({ adapter: new PrismaPg({ connectionString: appConfig.databaseUrl }) });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch (error) {
      // Production must not start without its database; in development keep the server up so /api/health can say what is wrong.
      if (this.appConfig.isProduction) throw error;
      this.logger.warn(`Database is not reachable — check DATABASE_URL and that PostgreSQL is running (${(error as Error).message.split('\n')[0]})`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** `true` when a trivial query succeeds. */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
