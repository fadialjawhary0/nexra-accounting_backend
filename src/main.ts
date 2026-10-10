import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { AppConfigService } from './lib/config/app-config.service.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(AppConfigService);

  // The browser calls /api/* on the Next.js origin and Next proxies it here, so there is no CORS and cookies stay same-site.
  app.setGlobalPrefix('api');
  app.set('trust proxy', config.trustProxyHops);
  app.use(helmet());
  app.use(cookieParser());
  app.enableShutdownHooks();

  await app.listen(config.port);
  new Logger('Bootstrap').log(`Nexra API listening on http://localhost:${config.port}/api (${config.nodeEnv})`);
}

await bootstrap();
