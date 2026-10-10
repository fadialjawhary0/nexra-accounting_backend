import { ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { isValidPhone } from '../../common/validation/phone.js';
import type { AuthTokenType } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { AppConfigService } from '../../lib/config/app-config.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { resetMail, type MailLocale } from '../../lib/mail/mail-templates.js';
import { MailService } from '../../lib/mail/mail.service.js';
import { SecuritySettingsService } from '../security-settings/security-settings.service.js';
import { serializeUser, type UserWithRole } from '../users/user.serializer.js';
import { AccountTokenService, RESET_TTL_MS } from './account-token.service.js';
import { AuthContextService } from './auth-context.service.js';
import type { ChangePasswordDto, LoginDto, SetPasswordDto, TwoFactorLoginDto, UpdateProfileDto } from './dto/auth.dto.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { PasswordService } from './password.service.js';
import { TokenService, type IssuedTokens, type RequestMeta } from './token.service.js';
import { TwoFactorService } from './two-factor.service.js';

/** Asking for a reset link again within this time sends nothing (so nobody's mailbox can be flooded). */
const RESET_COOLDOWN_MS = 60_000;

export type LoginOutcome = { status: 'two_factor_required'; challenge: string } | { status: 'ok'; tokens: IssuedTokens; user: UserWithRole };

const validationFailed = (fields: Record<string, string>) => new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields });

/** Signing in and out, the sessions behind it, passwords, e-mailed links, the person's own profile and two-step verification. */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly security: SecuritySettingsService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly accountTokens: AccountTokenService,
    private readonly throttle: LoginThrottleService,
    private readonly twoFactor: TwoFactorService,
    private readonly context: AuthContextService,
  ) {}

  /* ── Signing in and out ───────────────────────────────────────────────────────────────────────────────────────── */

  async login(dto: LoginDto, meta: RequestMeta): Promise<LoginOutcome> {
    const email = dto.email.trim().toLowerCase();
    await this.throttle.assertAllowed(email, meta.ip);
    const user = await this.prisma.user.findUnique({ where: { email }, include: { role: true } });

    let passwordOk = false;
    if (user?.passwordHash) passwordOk = await this.passwords.verify(user.passwordHash, dto.password);
    else await this.passwords.verifyDummy(dto.password);

    if (!user || !passwordOk) {
      await this.throttle.recordFailure(email, meta.ip);
      await this.audit.log({ action: 'login_failed', entityType: 'user', entityId: user?.id, entityLabel: email });
      throw new UnauthorizedException({ code: 'invalid_credentials', message: 'Incorrect email or password.' });
    }
    // The state of the account is only revealed to somebody who knows the password.
    if (user.status !== 'active') throw new ForbiddenException({ code: 'account_disabled', message: 'This account has been disabled. Please contact your administrator.' });

    if (user.twoFactorEnabled) return { status: 'two_factor_required', challenge: await this.tokens.signChallenge(user.id) };
    await this.throttle.recordSuccess(email, meta.ip);
    return this.completeLogin(user, meta);
  }

  /** Second step: the code from the app (or a recovery code) together with the challenge from the first step. */
  async verifyTwoFactor(dto: TwoFactorLoginDto, meta: RequestMeta): Promise<LoginOutcome> {
    if (!dto.code && !dto.recoveryCode) throw validationFailed({ code: 'validation.required' });
    const userId = await this.tokens.verifyChallenge(dto.challenge);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
    if (!user || user.status !== 'active' || !user.twoFactorEnabled) throw new UnauthorizedException({ code: 'challenge_expired', message: 'This sign-in step has expired. Start again.' });

    await this.throttle.assertAllowed(user.email, meta.ip);
    try {
      await this.twoFactor.verifyLogin(user, { code: dto.code, recoveryCode: dto.recoveryCode });
    } catch (error) {
      await this.throttle.recordFailure(user.email, meta.ip);
      await this.audit.log({ action: 'login_failed', entityType: 'user', entityId: user.id, entityLabel: user.email, meta: { step: 'two_factor' } });
      throw error;
    }
    await this.throttle.recordSuccess(user.email, meta.ip);
    return this.completeLogin(user, meta);
  }

  refresh(rawToken: string, meta: RequestMeta): Promise<IssuedTokens> {
    return this.tokens.refresh(rawToken, meta);
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    const ended = await this.tokens.revokeByRefreshToken(rawToken, 'signed_out');
    if (ended) await this.audit.log({ action: 'signed_out', entityType: 'user', entityId: ended.user.id, entityLabel: ended.user.name, actor: { id: ended.user.id, label: ended.user.name } });
  }

  /** What the app needs right after signing in: the person, what they may do, and what they must do first. */
  async sessionPayload(user: UserWithRole, sessionId: string) {
    const principal = await this.context.principal(user, sessionId);
    return { status: 'ok' as const, user: serializeUser(user), permissions: await this.context.permissionsOf(principal), restriction: principal.restriction };
  }

  async me(principal: AuthenticatedUser) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: principal.id }, include: { role: true } });
    const recoveryCodesLeft = user.twoFactorEnabled ? await this.prisma.recoveryCode.count({ where: { userId: user.id, usedAt: null } }) : 0;
    return {
      user: { ...serializeUser(user), twoFactorRequiredByPolicy: this.context.requiresTwoFactor(user), recoveryCodesLeft },
      permissions: await this.context.permissionsOf(principal),
      restriction: principal.restriction,
    };
  }

  permissions(principal: AuthenticatedUser) {
    return this.context.permissionsOf(principal);
  }

  /* ── Profile and password ─────────────────────────────────────────────────────────────────────────────────────── */

  async updateProfile(principal: AuthenticatedUser, dto: UpdateProfileDto) {
    const fields: Record<string, string> = {};
    const patch: { name?: string; title?: string; phone?: string; locale?: string } = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name) patch.name = name;
      else fields.name = 'validation.required';
    }
    if (dto.title !== undefined) patch.title = dto.title.trim();
    if (dto.phone !== undefined) {
      const phone = dto.phone.trim();
      if (isValidPhone(phone)) patch.phone = phone;
      else fields.phone = 'validation.invalidPhone';
    }
    if (dto.locale !== undefined) patch.locale = dto.locale;
    if (Object.keys(fields).length) throw validationFailed(fields);

    const before = await this.prisma.user.findUniqueOrThrow({ where: { id: principal.id } });
    const updated = await this.prisma.user.update({ where: { id: principal.id }, data: patch, include: { role: true } });
    const changes = AuditService.changes(before as unknown as Record<string, unknown>, updated as unknown as Record<string, unknown>);
    const changed = Object.keys(changes.after).filter(key => key in patch);
    if (changed.length) {
      await this.audit.log({
        action: 'updated',
        entityType: 'user',
        entityId: updated.id,
        entityLabel: updated.name,
        before: Object.fromEntries(changed.map(key => [key, changes.before[key]])),
        after: Object.fromEntries(changed.map(key => [key, changes.after[key]])),
      });
    }
    return serializeUser(updated);
  }

  /** Choosing a new password while signed in — needs the current one; every other device is signed out. */
  async changePassword(principal: AuthenticatedUser, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: principal.id } });
    const fields: Record<string, string> = {};
    if (!user.passwordHash || !(await this.passwords.verify(user.passwordHash, dto.current))) fields.current = 'validation.passwordCurrentWrong';
    const problem = this.passwords.problem(dto.next, { email: user.email });
    if (problem) fields.next = problem;
    else if (dto.next === dto.current) fields.next = 'validation.passwordSame';
    if (dto.confirm !== undefined && dto.confirm !== dto.next) fields.confirm = 'validation.passwordMismatch';
    if (Object.keys(fields).length) throw validationFailed(fields);

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await this.passwords.hash(dto.next), passwordChangedAt: new Date(), mustChangePassword: false },
    });
    const ended = await this.tokens.revokeAllForUser(user.id, 'password_changed', principal.sessionId);
    await this.audit.log({ action: 'password_changed', entityType: 'user', entityId: user.id, entityLabel: user.name, meta: { otherSessionsEnded: ended } });
    return { ok: true, passwordChangedAt: updated.passwordChangedAt };
  }

  passwordPolicy() {
    return this.passwords.policy();
  }

  /* ── Forgot password, invitations ─────────────────────────────────────────────────────────────────────────────── */

  /** Always looks the same to the caller — whether the address exists or not — and sends the mail in the background. */
  requestPasswordReset(emailInput: string): void {
    void this.sendResetLink(emailInput.trim().toLowerCase()).catch(error => this.logger.error(`Could not send a password reset mail: ${(error as Error).message}`));
  }

  private async sendResetLink(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'active') return;
    const recent = await this.prisma.authToken.findFirst({ where: { userId: user.id, type: 'reset', createdAt: { gt: new Date(Date.now() - RESET_COOLDOWN_MS) } } });
    if (recent) return;
    const { token } = await this.accountTokens.issue(user.id, 'reset');
    const message = resetMail(this.localeOf(user.locale), { name: user.name, link: `${this.config.frontendUrl}/reset-password?token=${token}`, minutes: RESET_TTL_MS / 60_000 });
    await this.mail.send({ to: user.email, ...message });
    await this.audit.log({ action: 'password_reset_requested', entityType: 'user', entityId: user.id, entityLabel: user.name, actor: { id: user.id, label: user.name } });
  }

  /** Does this e-mailed link still work? (The page shows "choose a password for …" or "this link has expired".) */
  async checkLink(rawToken: string, type: AuthTokenType) {
    const record = await this.accountTokens.find(rawToken, type);
    if (!record || !this.linkUsable(record.user, type)) throw this.invalidLink();
    return { email: record.user.email, name: record.user.name, passwordPolicy: this.passwords.policy() };
  }

  /** Reset: sets the new password and signs the person out everywhere. They sign in with it afterwards. */
  async resetPassword(dto: SetPasswordDto): Promise<void> {
    const user = await this.setPasswordFromLink(dto, 'reset');
    await this.tokens.revokeAllForUser(user.id, 'password_reset');
    await this.audit.log({ action: 'password_reset', entityType: 'user', entityId: user.id, entityLabel: user.name, actor: { id: user.id, label: user.name } });
  }

  /** Invitation: the person's first password. They are signed in straight away. */
  async acceptInvite(dto: SetPasswordDto, meta: RequestMeta): Promise<{ tokens: IssuedTokens; user: UserWithRole }> {
    const user = await this.setPasswordFromLink(dto, 'invite');
    await this.audit.log({ action: 'invite_accepted', entityType: 'user', entityId: user.id, entityLabel: user.name, actor: { id: user.id, label: user.name } });
    const outcome = await this.completeLogin(user, meta);
    if (outcome.status !== 'ok') throw new Error('unreachable');
    return outcome;
  }

  private async setPasswordFromLink(dto: SetPasswordDto, type: AuthTokenType): Promise<UserWithRole> {
    const record = await this.accountTokens.find(dto.token, type);
    if (!record || !this.linkUsable(record.user, type)) throw this.invalidLink();
    const fields: Record<string, string> = {};
    const problem = this.passwords.problem(dto.password, { email: record.user.email });
    if (problem) fields.password = problem;
    if (dto.confirm !== undefined && dto.confirm !== dto.password) fields.confirm = 'validation.passwordMismatch';
    if (Object.keys(fields).length) throw validationFailed(fields);

    if (!(await this.accountTokens.consume(record.id))) throw this.invalidLink();
    return this.prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash: await this.passwords.hash(dto.password), passwordChangedAt: new Date(), mustChangePassword: false, status: 'active', disabledAt: null },
      include: { role: true },
    });
  }

  private linkUsable(user: { status: string }, type: AuthTokenType): boolean {
    return type === 'invite' ? user.status === 'invited' : user.status === 'active';
  }

  private invalidLink() {
    return new HttpException({ code: 'invalid_link', message: 'This link has expired or was already used.' }, HttpStatus.GONE);
  }

  /* ── Sessions ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  async listSessions(principal: AuthenticatedUser) {
    const idleSince = new Date(Date.now() - this.security.values.sessionIdleMinutes * 60_000);
    const sessions = await this.prisma.session.findMany({
      where: { userId: principal.id, revokedAt: null, expiresAt: { gt: new Date() }, lastUsedAt: { gt: idleSince } },
      orderBy: { lastUsedAt: 'desc' },
    });
    return sessions.map(session => ({
      id: session.id,
      device: session.device,
      kind: session.kind,
      ip: session.ip,
      location: null,
      current: session.id === principal.sessionId,
      lastActiveAt: session.lastUsedAt,
      signedInAt: session.createdAt,
    }));
  }

  async revokeSession(principal: AuthenticatedUser, sessionId: string) {
    if (sessionId === principal.sessionId) throw new ConflictException({ code: 'cannot_revoke_current_session', message: 'Use “Sign out” in the account menu to end the session on this device.' });
    const session = await this.prisma.session.findFirst({ where: { id: sessionId, userId: principal.id, revokedAt: null } });
    if (!session) throw new NotFoundException({ code: 'not_found', message: 'Session not found' });
    await this.tokens.revokeSession(sessionId, 'revoked_by_user');
    await this.audit.log({ action: 'session_revoked', entityType: 'user', entityId: principal.id, entityLabel: principal.name, meta: { device: session.device } });
    return { id: sessionId };
  }

  async revokeOtherSessions(principal: AuthenticatedUser) {
    const revoked = await this.tokens.revokeAllForUser(principal.id, 'revoked_by_user', principal.sessionId);
    if (revoked) await this.audit.log({ action: 'session_revoked', entityType: 'user', entityId: principal.id, entityLabel: principal.name, meta: { count: revoked } });
    return { revoked };
  }

  /* ── Two-step verification ────────────────────────────────────────────────────────────────────────────────────── */

  async startTwoFactorSetup(principal: AuthenticatedUser) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: principal.id } });
    if (user.twoFactorEnabled) throw new ConflictException({ code: 'two_factor_already_enabled', message: 'Two-step verification is already on. Turn it off first to set it up again.' });
    return this.twoFactor.startSetup(user);
  }

  async enableTwoFactor(principal: AuthenticatedUser, code: string) {
    const recoveryCodes = await this.twoFactor.confirmSetup(principal.id, code);
    await this.audit.log({ action: 'two_factor_enabled', entityType: 'user', entityId: principal.id, entityLabel: principal.name });
    return { recoveryCodes };
  }

  async disableTwoFactor(principal: AuthenticatedUser, password: string) {
    const user = await this.confirmPassword(principal, password);
    if (this.context.requiresTwoFactor(user)) throw new ConflictException({ code: 'two_factor_required', message: 'Your office requires two-step verification, so it cannot be turned off.' });
    await this.twoFactor.disable(user.id);
    await this.audit.log({ action: 'two_factor_disabled', entityType: 'user', entityId: user.id, entityLabel: user.name });
    return { ok: true };
  }

  async newRecoveryCodes(principal: AuthenticatedUser, password: string) {
    const user = await this.confirmPassword(principal, password);
    if (!user.twoFactorEnabled) throw new ConflictException({ code: 'two_factor_not_enabled', message: 'Two-step verification is not turned on.' });
    const recoveryCodes = await this.twoFactor.regenerateRecoveryCodes(user.id);
    await this.audit.log({ action: 'recovery_codes_created', entityType: 'user', entityId: user.id, entityLabel: user.name });
    return { recoveryCodes };
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  private async completeLogin(user: UserWithRole, meta: RequestMeta): Promise<LoginOutcome> {
    const tokens = await this.tokens.startSession(user.id, meta);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
    await this.audit.log({ action: 'signed_in', entityType: 'user', entityId: user.id, entityLabel: user.name, actor: { id: user.id, label: user.name } });
    return { status: 'ok', tokens, user };
  }

  /** Re-checks the password for sensitive changes; a wrong one is a field error, not a sign-out. */
  private async confirmPassword(principal: AuthenticatedUser, password: string): Promise<UserWithRole> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: principal.id }, include: { role: true } });
    if (!user.passwordHash || !(await this.passwords.verify(user.passwordHash, password))) throw validationFailed({ password: 'validation.passwordCurrentWrong' });
    return user;
  }

  private localeOf(locale: string): MailLocale {
    return locale === 'en' ? 'en' : 'nl';
  }
}
