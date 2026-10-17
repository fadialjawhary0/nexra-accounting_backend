import { DiscoveryService } from '@nestjs/core';

/** Marks a provider that has `@QueueWorker` methods, so the queue finds it when the application starts. */
export const QueueProcessor = DiscoveryService.createDecorator<void>();

export interface QueueWorkerOptions {
  /** The name of the queue (`import-file`); one method per queue. */
  queue: string;
  /** How many times a job that failed is tried again, each time after a longer wait (default 3). */
  retryLimit?: number;
  /** The wait before the first new try, in seconds; it doubles every time (default 30). */
  retryDelaySeconds?: number;
  /** A job that is still running after this many seconds is taken for lost (the server stopped) and tried again (default 600). */
  expireSeconds?: number;
  /** How many jobs run side by side — a number, or the name of the setting that holds it (`ai.concurrency`; read again every 15 seconds). */
  concurrency?: number | { setting: string };
}

/** What a worker method gets next to the job's data. */
export interface QueueJobContext {
  id: string;
  /** 0 for the first try. */
  attempt: number;
  /** True when a failure now is final: the job will not be tried again. */
  isLastAttempt: boolean;
  /** Fires when the server is shutting down and cannot wait for this job. */
  signal: AbortSignal;
}

/**
 * A method that handles the jobs of one queue: `async importFile(data: { itemId: string }, job: QueueJobContext)`. The data is what was sent with
 * `QueueService.send` — only ids, never the content of a record. When the method throws, the job is tried again (after a growing wait); after the
 * last try it stays failed in the queue's own table.
 */
export const QueueWorker = DiscoveryService.createDecorator<QueueWorkerOptions>();
