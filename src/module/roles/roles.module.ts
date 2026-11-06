import { Module } from '@nestjs/common';
import { SecuritySettingsModule } from '../security-settings/security-settings.module.js';
import { PermissionsController, RolesController } from './roles.controller.js';
import { RolesService } from './roles.service.js';
import { DeletionModule } from '../deletion/deletion.module.js';

@Module({
  imports: [DeletionModule, SecuritySettingsModule],
  controllers: [RolesController, PermissionsController],
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}
