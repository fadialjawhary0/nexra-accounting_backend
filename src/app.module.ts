import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import { ClsModule } from 'nestjs-cls';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { DynamicThrottlerGuard } from './common/guards/dynamic-throttler.guard.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from './common/guards/permissions.guard.js';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor.js';
import { createValidationPipe } from './common/pipes/create-validation-pipe.js';
import { AuditModule } from './lib/audit/audit.module.js';
import { AppConfigModule } from './lib/config/app-config.module.js';
import { CryptoModule } from './lib/crypto/crypto.module.js';
import { ExportsModule } from './lib/exports/exports.module.js';
import { PrismaModule } from './lib/database/prisma.module.js';
import { MailModule } from './lib/mail/mail.module.js';
import { SettingsModule } from './lib/settings/settings.module.js';
import { StorageModule } from './lib/storage/storage.module.js';
import { ActivityModule } from './module/activity/activity.module.js';
import { AuthModule } from './module/auth/auth.module.js';
import { CalendarModule } from './module/calendar/calendar.module.js';
import { FilesModule } from './module/files/files.module.js';
import { FormsModule } from './module/forms/forms.module.js';
import { HealthModule } from './module/health/health.module.js';
import { ListsModule } from './module/lists/lists.module.js';
import { NumberingModule } from './module/numbering/numbering.module.js';
import { RolesModule } from './module/roles/roles.module.js';
import { SecuritySettingsModule } from './module/security-settings/security-settings.module.js';
import { SettingsFeatureModule } from './module/settings/settings.module.js';
import { SecuritySettingsService } from './module/security-settings/security-settings.service.js';
import { UsersModule } from './module/users/users.module.js';

@Module({
  imports: [
    // Infrastructure — each one is @Global() and imported here, once.
    AppConfigModule,
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        setup: (cls, request: Request) => {
          cls.set('ip', request.ip);
          cls.set('userAgent', request.headers['user-agent']);
        },
      },
    }),
    PrismaModule,
    CryptoModule,
    MailModule,
    StorageModule,
    ExportsModule,
    SettingsModule,
    AuditModule,
    ScheduleModule.forRoot(),
    // Rate limits come from Settings → Security (read from the settings cache on every request), so a change applies at once.
    ThrottlerModule.forRootAsync({
      imports: [SecuritySettingsModule],
      inject: [SecuritySettingsService],
      useFactory: (security: SecuritySettingsService) => ({
        throttlers: [
          { name: 'default', ttl: 60_000, limit: () => security.values.rateRequestsPerMinute },
          { name: 'auth', ttl: 60_000, limit: () => security.values.rateAuthPerMinute },
        ],
      }),
    }),
    // Features
    HealthModule,
    SecuritySettingsModule,
    SettingsFeatureModule,
    NumberingModule,
    ListsModule,
    CalendarModule,
    FilesModule,
    FormsModule,
    AuthModule,
    UsersModule,
    RolesModule,
    ActivityModule,
  ],
  providers: [
    { provide: APP_PIPE, useFactory: createValidationPipe },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    // Guards run in this order: rate limit → signed in → allowed to do this.
    { provide: APP_GUARD, useClass: DynamicThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
