import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfigService } from './app-config.service.js';
import { validate } from './env.validation.js';

@Global()
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, cache: true, validate })],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
