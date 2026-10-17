import { Module } from '@nestjs/common';
import { FormsModule } from '../forms/forms.module.js';
import { CounterpartiesController } from './counterparties.controller.js';
import { CounterpartiesService } from './counterparties.service.js';

@Module({
  imports: [FormsModule],
  controllers: [CounterpartiesController],
  providers: [CounterpartiesService],
  exports: [CounterpartiesService],
})
export class CounterpartiesModule {}
