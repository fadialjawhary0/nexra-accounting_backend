import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '../../generated/prisma/client.js';

interface ErrorBody {
  code: string;
  message: string;
  fields?: Record<string, string>;
  details?: unknown;
}

const DEFAULT_CODE: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'validation_failed',
  429: 'too_many_requests',
  503: 'unavailable',
};

/**
 * Every error leaves the API as `{ code, message, fields?, details? }` — what the frontend's `toApiError` reads.
 * Prisma's "already exists" / "not found" / "still in use" become 409 / 404 / 409; anything unexpected is a 500 that is
 * logged here and never explained to the caller.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.normalize(exception);
    if (status >= 500) this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    response.status(status).json(body);
  }

  private normalize(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const payload = typeof raw === 'string' ? { message: raw } : (raw as Record<string, unknown>);
      const message = Array.isArray(payload.message) ? payload.message.join('; ') : String(payload.message ?? exception.message);
      const body: ErrorBody = { code: String(payload.code ?? DEFAULT_CODE[status] ?? `http_${status}`), message };
      if (payload.fields) body.fields = payload.fields as Record<string, string>;
      if (payload.details !== undefined) body.details = payload.details;
      return { status, body };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002': {
          const target = (exception.meta?.target as string[] | undefined) ?? [];
          return {
            status: HttpStatus.CONFLICT,
            body: { code: 'conflict', message: 'A record with these values already exists', fields: Object.fromEntries(target.map(field => [field, 'validation.alreadyExists'])) },
          };
        }
        case 'P2025':
          return { status: HttpStatus.NOT_FOUND, body: { code: 'not_found', message: 'Record not found' } };
        case 'P2003':
          return { status: HttpStatus.CONFLICT, body: { code: 'conflict', message: 'This record is still in use by other records' } };
        default:
      }
    }

    return { status: HttpStatus.INTERNAL_SERVER_ERROR, body: { code: 'internal_error', message: 'Something went wrong on our side' } };
  }
}
