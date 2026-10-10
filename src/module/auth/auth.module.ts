import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { SecuritySettingsModule } from '../security-settings/security-settings.module.js';
import { AccountTokenService } from './account-token.service.js';
import { AuthContextService } from './auth-context.service.js';
import { AuthCookiesService } from './auth-cookies.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtStrategy } from './jwt.strategy.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import { TwoFactorService } from './two-factor.service.js';

@Module({
  imports: [PassportModule, JwtModule.register({}), SecuritySettingsModule],
  controllers: [AuthController],
  providers: [AuthService, AuthContextService, AuthCookiesService, TokenService, PasswordService, LoginThrottleService, TwoFactorService, AccountTokenService, JwtStrategy],
  exports: [AuthContextService, TokenService, PasswordService, AccountTokenService, TwoFactorService],
})
export class AuthModule {}
