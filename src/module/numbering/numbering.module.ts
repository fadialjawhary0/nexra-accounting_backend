import { Module } from '@nestjs/common';
import { NumberingController } from './numbering.controller.js';
import { NumberingService } from './numbering.service.js';

@Module({
  controllers: [NumberingController],
  providers: [NumberingService],
  exports: [NumberingService],
})
export class NumberingModule {}
