import { Injectable, Logger, ServiceUnavailableException, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { PgBoss, type Job, type SendOptions } from 'pg-boss';
import { AppConfigService } from '../config/app-config.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { QueueProcessor, QueueWorker, type QueueJobContext, type QueueWorkerOptions } from './queue.decorator.js';

/** The queue keeps its tables in a schema of its own, apart from the application's. */
const QUEUE_SCHEMA = 'pgboss';
const DEFAULT_RETRY_LIMIT = 3;
const DEFAULT_RETRY_DELAY_SECONDS = 30;
const DEFAULT_EXPIRE_SECONDS = 600;
/** How often the concurrency settings are read again, and how long to wait before starting the queue again when it could not start. */
const RECHECK_MS = 15_000;
const START_AGAIN_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
/** Finished jobs are kept for a day (what happened is in the records themselves) and waiting ones for two weeks. */
const KEEP_FINISHED_SECONDS = 24 * 60 * 60;

interface RegisteredWorker {
  options: QueueWorkerOptions;
  retryLimit: number;
  concurrency: number;
  call: (data: object, job: QueueJobContext) => Promise<unknown>;
}

/** PostgreSQL's address as the queue wants it: Prisma's own `?schema=` part is not a connection setting. */
function connectionString(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete('schema');
  return parsed.toString();
}

/**
 * The background job queue (pg-boss on the same PostgreSQL database, in its own `pgboss` schema). A provider marked `@QueueProcessor()` with
 * `@QueueWorker({ queue })` methods gets its jobs from here; anything can `send` a job — with ids only, never the content of a record. When the queue
 * cannot start (no rights to create its schema, the database is away) the application still runs and tries again; `send` then says "unavailable".
 */
@Injectable()
export class QueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(QueueService.name);
  private boss: PgBoss | null = null;
  private ready = false;
  private stopping = false;
  private readonly workers = new Map<string, RegisteredWorker>();
  private readonly readyCallbacks: Array<() => Promise<void> | void> = [];
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfigService,
    private readonly settings: SettingsService,
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.collectWorkers();
    await this.startOrRetry();
    this.timer = setInterval(() => void this.recheckConcurrency(), RECHECK_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    const boss = this.boss;
    this.boss = null;
    this.ready = false;
    if (boss) await boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS }).catch(() => undefined);
  }

  /** True when jobs can be sent and are being worked on. */
  isReady(): boolean {
    return this.ready;
  }

  /** Runs `callback` once the queue is up (at once when it already is) — for work that must be picked up again after a restart. */
  onReady(callback: () => Promise<void> | void): void {
    this.readyCallbacks.push(callback);
    if (this.ready) void this.runCallback(callback);
  }

  /** Puts a job on a queue; `null` when the queue refused it (a job with the same key is waiting already). */
  async send(queue: string, data: object, options?: SendOptions): Promise<string | null> {
    return this.requireBoss().send(queue, data, options);
  }

  /** Jobs waiting and jobs being worked on, for screens that show progress; `null` while the queue is not up. */
  async counts(queue: string): Promise<{ waiting: number; active: number } | null> {
    if (!this.boss || !this.ready) return null;
    try {
      const info = await this.boss.getQueue(queue);
      return info ? { waiting: info.queuedCount, active: info.activeCount } : null;
    } catch {
      return null;
    }
  }

  private requireBoss(): PgBoss {
    if (!this.boss || !this.ready) {
      throw new ServiceUnavailableException({ code: 'queue_unavailable', message: 'The background queue is not running' });
    }
    return this.boss;
  }

  /* ── Finding the workers ──────────────────────────────────────────────────────────────────────────────────────── */

  private collectWorkers(): void {
    for (const wrapper of this.discovery.getProviders({ metadataKey: QueueProcessor.KEY })) {
      const instance = wrapper.instance as Record<string, (...args: unknown[]) => Promise<unknown>> | undefined;
      if (!instance) continue;
      for (const method of this.scanner.getAllMethodNames(Object.getPrototypeOf(instance))) {
        const options = this.discovery.getMetadataByDecorator(QueueWorker, wrapper, method);
        if (!options) continue;
        if (this.workers.has(options.queue)) throw new Error(`Queue "${options.queue}" has more than one worker`);
        this.workers.set(options.queue, {
          options,
          retryLimit: options.retryLimit ?? DEFAULT_RETRY_LIMIT,
          concurrency: this.concurrencyOf(options),
          call: (data, job) => instance[method]!(data, job),
        });
      }
    }
  }

  private concurrencyOf(options: QueueWorkerOptions): number {
    const wanted = typeof options.concurrency === 'object' ? this.settings.get<number>(options.concurrency.setting) : (options.concurrency ?? 1);
    return Math.max(1, Math.floor(wanted));
  }

  /* ── Starting ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  private async startOrRetry(): Promise<void> {
    if (this.stopping) return;
    try {
      await this.start();
    } catch (error) {
      this.logger.error(`The background queue could not start (${(error as Error).message.split('\n')[0]}). Imports run again once it is up; trying again in ${START_AGAIN_MS / 1000} seconds.`);
      const again = setTimeout(() => void this.startOrRetry(), START_AGAIN_MS);
      again.unref();
    }
  }

  private async start(): Promise<void> {
    const boss = new PgBoss({
      connectionString: connectionString(this.config.databaseUrl),
      schema: QUEUE_SCHEMA,
      application_name: 'nexra-queue',
      max: 8,
      // Scheduled work (reminders, the yearly holidays) runs through @nestjs/schedule; the queue only carries jobs that were sent.
      schedule: false,
    });
    boss.on('error', error => this.logger.error(`Queue: ${error.message}`));
    try {
      await boss.start();
      for (const [queue, worker] of this.workers) {
        const options = {
          retryLimit: worker.retryLimit,
          retryDelay: worker.options.retryDelaySeconds ?? DEFAULT_RETRY_DELAY_SECONDS,
          retryBackoff: true,
          expireInSeconds: worker.options.expireSeconds ?? DEFAULT_EXPIRE_SECONDS,
          deleteAfterSeconds: KEEP_FINISHED_SECONDS,
        };
        await boss.createQueue(queue, options);
        // An existing queue keeps the options it was made with, so a changed default is applied here.
        await boss.updateQueue(queue, options);
        await this.register(boss, queue, worker);
      }
    } catch (error) {
      await boss.stop({ graceful: false }).catch(() => undefined);
      throw error;
    }
    this.boss = boss;
    this.ready = true;
    this.logger.log(`Background queue ready (${[...this.workers.keys()].join(', ') || 'no workers'})`);
    for (const callback of this.readyCallbacks) await this.runCallback(callback);
  }

  private async register(boss: PgBoss, queue: string, worker: RegisteredWorker): Promise<void> {
    await boss.work(queue, { batchSize: 1, localConcurrency: worker.concurrency, pollingIntervalSeconds: 2 }, async (jobs: Job<object>[]) => {
      for (const job of jobs) {
        const context: QueueJobContext = { id: job.id, attempt: job.retryCount, isLastAttempt: job.retryCount >= worker.retryLimit, signal: job.signal };
        try {
          await worker.call(job.data, context);
        } catch (error) {
          this.logger.warn(`Job ${queue}/${job.id} failed (try ${job.retryCount + 1} of ${worker.retryLimit + 1}): ${(error as Error).message.split('\n')[0]}`);
          throw error;
        }
      }
    });
  }

  private async runCallback(callback: () => Promise<void> | void): Promise<void> {
    try {
      await callback();
    } catch (error) {
      this.logger.error(`Picking up work after the queue started failed: ${(error as Error).message}`);
    }
  }

  /** Settings → AI can change how many files are read side by side; the workers are started again with the new number (running jobs finish). */
  private async recheckConcurrency(): Promise<void> {
    const boss = this.boss;
    if (!boss || !this.ready) return;
    for (const [queue, worker] of this.workers) {
      const wanted = this.concurrencyOf(worker.options);
      if (wanted === worker.concurrency) continue;
      try {
        worker.concurrency = wanted;
        await boss.offWork(queue, { wait: false });
        await this.register(boss, queue, worker);
        this.logger.log(`Queue ${queue}: ${wanted} at a time`);
      } catch (error) {
        this.logger.error(`Queue ${queue}: could not change the number of workers (${(error as Error).message})`);
      }
    }
  }
}
