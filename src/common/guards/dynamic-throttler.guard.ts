import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerRequest } from '@nestjs/throttler';
import { AUTH_THROTTLE_KEY } from '../constants.js';

/**
 * Rate limiting per IP address. The limits themselves are functions in AppModule that read the security settings, so a
 * change in Settings → Security applies at once, without a restart. Two throttlers run: `default` on every route, and
 * `auth` (much stricter) only on routes marked `@AuthThrottle()` — sign-in, password reset, two-step codes.
 */
@Injectable()
export class DynamicThrottlerGuard extends ThrottlerGuard {
  protected override async handleRequest(request: ThrottlerRequest): Promise<boolean> {
    if (request.throttler.name === 'auth') {
      const marked = this.reflector.getAllAndOverride<boolean>(AUTH_THROTTLE_KEY, [request.context.getHandler(), request.context.getClass()]);
      if (!marked) return true;
    }
    return super.handleRequest(request);
  }
}
