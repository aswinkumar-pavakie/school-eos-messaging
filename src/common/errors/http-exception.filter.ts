// Global exception filter.
//
// Deliberately does NOT wrap responses in a custom envelope: Nest's default
// HttpException body ({ message, error, statusCode }) is passed through
// unchanged. This filter's job is safety, not reshaping — never let a token,
// private key, or message ciphertext/plaintext reach a log line, and never leak
// an internal stack trace or SQL detail to the client (LLD §39/§59).

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

const SENSITIVE_KEYS = new Set([
  'accessToken',
  'refreshToken',
  'password',
  'ciphertext',
  'plaintext',
  'privateKey',
  'identityPrivateKey',
  'signedPrekeyPrivate',
  'oneTimePrekeyPrivate',
]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.has(key) ? '[REDACTED]' : redact(val);
    }
    return out;
  }
  return value;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status >= 500) {
        this.logger.error(
          `${request.method} ${request.url} -> ${status}: ${exception.message}`,
        );
      }
      response.status(status).json(exception.getResponse());
      return;
    }

    this.logger.error(
      `${request.method} ${request.url} -> 500 unhandled: ${(exception as Error)?.message}`,
      { body: redact(request.body) },
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      message: 'Internal server error',
      error: 'Internal Server Error',
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    });
  }
}
