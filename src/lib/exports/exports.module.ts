import { Global, Module } from '@nestjs/common';
import { ExportsService } from './exports.service.js';

/** Excel, PDF and Word for every list and report. Imported once, in AppModule. */
@Global()
@Module({ providers: [ExportsService], exports: [ExportsService] })
export class ExportsModule {}
