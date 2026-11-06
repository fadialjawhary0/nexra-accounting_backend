import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import { AppConfigService } from '../config/app-config.service.js';
import { softDeleteExtension } from './soft-delete.js';

/**
 * The one Prisma client of the app (PostgreSQL through the `pg` driver adapter). Inject it; never `new PrismaClient()`.
 *
 * What is injected is the client with the soft-delete extension (`soft-delete.ts`): deleted rows of the tables listed there are never read, in plain queries as in
 * transactions. The methods of this class itself (`ping`, the lifecycle hooks, `withDeleted`) run on the plain client underneath.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /** The client that also reads deleted rows — only for deleting and restoring (`module/deletion`). Answered by the proxy the constructor returns. */
  declare readonly withDeleted: PrismaClient;

  constructor(private readonly appConfig: AppConfigService) {
    super({ adapter: new PrismaPg({ connectionString: appConfig.databaseUrl }) });
    // `this` is Prisma's own client object (the models included): it reads every row, deleted ones too.
    const plain = this as unknown as PrismaClient;
    const extended = plain.$extends(softDeleteExtension);
    const own = new Set(Object.getOwnPropertyNames(PrismaService.prototype).filter(name => name !== 'constructor'));
    // The models, `$transaction`, `$queryRaw` … come from the extended client; what this class adds itself runs on the plain one (`this` here).
    return new Proxy(extended, {
      get: (target, property, receiver) => {
        if (property === 'withDeleted') return plain;
        if (typeof property === 'string' && own.has(property)) {
          const value: unknown = Reflect.get(this, property, this);
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(this) : value;
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as this;
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
