import { Injectable } from '@nestjs/common';
import { QueueProcessor, QueueWorker } from '../../lib/queue/queue.decorator.js';
import { QUEUE_SHEET } from './imports.constants.js';
import { SheetRowsService } from './sheet-rows.service.js';

/**
 * Checks and saves the rows of a spreadsheet, one spreadsheet at a time: a big sheet is a long job, and two sheets at once could create the same
 * client twice. A job that stops halfway (the server restarted) is put on the queue again when the server is back; checking starts over, saving
 * carries on with the rows that are still waiting.
 */
@QueueProcessor()
@Injectable()
export class SheetProcessorService {
  constructor(private readonly rows: SheetRowsService) {}

  @QueueWorker({ queue: QUEUE_SHEET, retryLimit: 1, retryDelaySeconds: 30, expireSeconds: 3600, concurrency: 1 })
  async handle(payload: { jobId?: string; step?: 'check' | 'commit' }): Promise<void> {
    if (!payload.jobId) return;
    if (payload.step === 'commit') await this.rows.runCommit(payload.jobId);
    else await this.rows.runCheck(payload.jobId);
  }
}
