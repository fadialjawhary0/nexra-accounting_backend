import { Injectable, StreamableFile, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { ApiResult } from '../api-result.js';

/** Every successful response is `{ data }` or `{ data, meta }` — the shape the frontend's API client reads. */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((result: unknown) => {
        if (result === undefined || result instanceof StreamableFile) return result;
        if (result instanceof ApiResult) return result.meta ? { data: result.data, meta: result.meta } : { data: result.data };
        return { data: result };
      }),
    );
  }
}
