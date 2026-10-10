import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export type AppLocale = 'nl' | 'en';

/** The UI language of this request: the `NEXT_LOCALE` cookie the frontend keeps, otherwise Dutch (the office default). */
export const localeOf = (request: Request): AppLocale => {
  const cookie = (request.cookies as Record<string, unknown> | undefined)?.NEXT_LOCALE;
  return cookie === 'en' ? 'en' : 'nl';
};

/** `list(@Locale() locale: AppLocale)` — answers with names in the language the person is using. */
export const Locale = createParamDecorator((_data: unknown, context: ExecutionContext): AppLocale => localeOf(context.switchToHttp().getRequest<Request>()));
