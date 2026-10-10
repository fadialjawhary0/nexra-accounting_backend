import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module.js';
import { SettingsGroupsService } from './settings-groups.service.js';
import { SettingsController } from './settings.controller.js';

@Module({
  imports: [FilesModule],
  controllers: [SettingsController],
  providers: [SettingsGroupsService],
  exports: [SettingsGroupsService],
})
export class SettingsFeatureModule {}
