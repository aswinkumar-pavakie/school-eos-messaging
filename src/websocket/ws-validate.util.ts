// WebSocket events have no NestJS ValidationPipe automatically applied the
// way REST controllers do -- this is the same real validation (class-
// validator against a real DTO class), just invoked explicitly per event
// handler (LLD §38: "payload schema" is one of the checks every single
// event must pass).

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

export interface WsValidationResult<T> {
  valid: true;
  value: T;
}
export interface WsValidationError {
  valid: false;
  errors: string[];
}

export function validateWsPayload<T extends object>(
  cls: new () => T,
  payload: unknown,
): WsValidationResult<T> | WsValidationError {
  const instance = plainToInstance(cls, payload ?? {});
  const errors = validateSync(instance as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  if (errors.length > 0) {
    return {
      valid: false,
      errors: errors.flatMap((e) => Object.values(e.constraints ?? {})),
    };
  }
  return { valid: true, value: instance };
}
