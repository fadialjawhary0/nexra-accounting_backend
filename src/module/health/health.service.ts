import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { AppConfigService } from '../../lib/config/app-config.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';

const startedAt = Date.now();

function readVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

@Injectable()
export class HealthService {
  private readonly version = readVersion();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  /** `{ status: 'ok', database: 'up', … }`, or 503 when the database cannot be reached (uptime monitors watch this). */
  async check() {
    const databaseUp = await this.prisma.ping();
    if (!databaseUp) {
      throw new ServiceUnavailableException({ code: 'database_unavailable', message: 'The database is not reachable', details: { database: 'down' } });
    }
    return {
      status: 'ok',
      database: 'up',
      environment: this.config.nodeEnv,
      version: this.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  }
}
