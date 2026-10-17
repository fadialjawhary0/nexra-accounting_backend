import { Module } from '@nestjs/common';
import { AiController } from './ai.controller.js';

/** The endpoints of the AI (status, usage, connection test). The AI itself is the global `AiModule` in `src/lib/ai`. */
@Module({ controllers: [AiController] })
export class AiFeatureModule {}
