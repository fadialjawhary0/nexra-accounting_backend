import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AllowWhileRestricted, AuthThrottle } from '../../common/decorators/auth-route.decorators.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { AuthCookiesService } from './auth-cookies.service.js';
import { AuthService } from './auth.service.js';
import { ChangePasswordDto, ForgotPasswordDto, LoginDto, PasswordConfirmDto, SetPasswordDto, TokenDto, TwoFactorCodeDto, TwoFactorLoginDto, UpdateProfileDto } from './dto/auth.dto.js';
import type { RequestMeta } from './token.service.js';

const metaOf = (request: Request): RequestMeta => ({ ip: request.ip ?? 'unknown', userAgent: request.headers['user-agent'] });

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cookies: AuthCookiesService,
  ) {}

  /** Password step. Answers `{ status: 'ok', user, permissions, restriction }` (cookies set) or `{ status: 'two_factor_required', challenge }`. */
  @Public()
  @AuthThrottle()
  @HttpCode(200)
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const outcome = await this.auth.login(dto, metaOf(request));
    if (outcome.status === 'two_factor_required') return outcome;
    this.cookies.set(response, outcome.tokens);
    return this.auth.sessionPayload(outcome.user, outcome.tokens.sessionId);
  }

  /** Second step: the code from the authenticator app (or a recovery code) plus the `challenge` of the first step. */
  @Public()
  @AuthThrottle()
  @HttpCode(200)
  @Post('login/two-factor')
  async loginTwoFactor(@Body() dto: TwoFactorLoginDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const outcome = await this.auth.verifyTwoFactor(dto, metaOf(request));
    if (outcome.status !== 'ok') return outcome;
    this.cookies.set(response, outcome.tokens);
    return this.auth.sessionPayload(outcome.user, outcome.tokens.sessionId);
  }

  /** Exchanges the refresh cookie for new cookies (the refresh token rotates). A bad or reused token signs the browser out. */
  @Public()
  @HttpCode(200)
  @Post('refresh')
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    try {
      const token = this.cookies.refreshTokenOf(request);
      if (!token) throw new UnauthorizedException({ code: 'unauthorized', message: 'Sign in again' });
      this.cookies.set(response, await this.auth.refresh(token, metaOf(request)));
      return { ok: true };
    } catch (error) {
      // Only a refusal ends the browser's session; a server hiccup must not sign anybody out.
      if (error instanceof UnauthorizedException) this.cookies.clear(response);
      throw error;
    }
  }

  @Public()
  @HttpCode(200)
  @Post('logout')
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(this.cookies.refreshTokenOf(request));
    this.cookies.clear(response);
    return { ok: true };
  }

  /* ── Passwords and e-mailed links ─────────────────────────────────────────────────────────────────────────────── */

  @Public()
  @AuthThrottle()
  @HttpCode(200)
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    this.auth.requestPasswordReset(dto.email);
    return { ok: true };
  }

  /** The password rules, for the "choose a password" screens. */
  @Public()
  @Get('password-policy')
  passwordPolicy() {
    return this.auth.passwordPolicy();
  }

  @Public()
  @AuthThrottle()
  @HttpCode(200)
  @Post('reset-password/check')
  checkReset(@Body() dto: TokenDto) {
    return this.auth.checkLink(dto.token, 'reset');
  }

  @Public()
  @AuthThrottle()
  @HttpCode(200)
  @Post('reset-password')
  async resetPassword(@Body() dto: SetPasswordDto) {
    await this.auth.resetPassword(dto);
    return { ok: true };
  }

  @Public()
  @AuthThrottle()
  @HttpCode(200)
  @Post('invite/check')
  checkInvite(@Body() dto: TokenDto) {
    return this.auth.checkLink(dto.token, 'invite');
  }

  /** Accepts an invitation: sets the first password and signs the person in. */
  @Public()
  @AuthThrottle()
  @HttpCode(200)
  @Post('accept-invite')
  async acceptInvite(@Body() dto: SetPasswordDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { tokens, user } = await this.auth.acceptInvite(dto, metaOf(request));
    this.cookies.set(response, tokens);
    return this.auth.sessionPayload(user, tokens.sessionId);
  }

  /* ── The signed-in person ─────────────────────────────────────────────────────────────────────────────────────── */

  @AllowWhileRestricted()
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.me(user);
  }

  @AllowWhileRestricted()
  @Get('permissions')
  permissions(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.permissions(user);
  }

  @Put('me')
  updateProfile(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    return this.auth.updateProfile(user, dto);
  }

  @AllowWhileRestricted()
  @AuthThrottle()
  @HttpCode(200)
  @Post('password')
  changePassword(@CurrentUser() user: AuthenticatedUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user, dto);
  }

  @Get('sessions')
  sessions(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.listSessions(user);
  }

  @HttpCode(200)
  @Post('sessions/revoke-others')
  revokeOthers(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.revokeOtherSessions(user);
  }

  @Delete('sessions/:id')
  revokeSession(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.auth.revokeSession(user, id);
  }

  /* ── Two-step verification ────────────────────────────────────────────────────────────────────────────────────── */

  /** Step 1: a new secret and its QR code. Nothing is switched on until the first code is confirmed. */
  @AllowWhileRestricted()
  @HttpCode(200)
  @Post('two-factor/setup')
  startTwoFactor(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.startTwoFactorSetup(user);
  }

  /** Step 2: the first code from the app switches it on and returns the recovery codes (shown only now). */
  @AllowWhileRestricted()
  @AuthThrottle()
  @HttpCode(200)
  @Post('two-factor/enable')
  enableTwoFactor(@CurrentUser() user: AuthenticatedUser, @Body() dto: TwoFactorCodeDto) {
    return this.auth.enableTwoFactor(user, dto.code);
  }

  @AuthThrottle()
  @HttpCode(200)
  @Post('two-factor/disable')
  disableTwoFactor(@CurrentUser() user: AuthenticatedUser, @Body() dto: PasswordConfirmDto) {
    return this.auth.disableTwoFactor(user, dto.password);
  }

  @AuthThrottle()
  @HttpCode(200)
  @Post('two-factor/recovery-codes')
  recoveryCodes(@CurrentUser() user: AuthenticatedUser, @Body() dto: PasswordConfirmDto) {
    return this.auth.newRecoveryCodes(user, dto.password);
  }
}
