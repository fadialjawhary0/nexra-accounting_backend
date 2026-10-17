import { Module } from '@nestjs/common';
import { ActivityController } from './activity.controller.js';
import { ActivityRetentionService } from './activity-retention.service.js';
import { ActivityService } from './activity.service.js';

@Module({
  controllers: [ActivityController],
  providers: [ActivityService, ActivityRetentionService],
  exports: [ActivityService],
})
export class ActivityModule {}
