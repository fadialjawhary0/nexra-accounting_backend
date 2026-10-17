import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { QueueService } from './queue.service.js';

/** The background job queue (pg-boss). Imported once, in AppModule. */
@Global()
@Module({ imports: [DiscoveryModule], providers: [QueueService], exports: [QueueService] })
export class QueueModule {}
