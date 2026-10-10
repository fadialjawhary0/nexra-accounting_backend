import { Module } from '@nestjs/common';
import { SecuritySettingsController } from './security-settings.controller.js';
import { SecuritySettingsService } from './security-settings.service.js';

@Module({
  controllers: [SecuritySettingsController],
  providers: [SecuritySettingsService],
  exports: [SecuritySettingsService],
})
export class SecuritySettingsModule {}
