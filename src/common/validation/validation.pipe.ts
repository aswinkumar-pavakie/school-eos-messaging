// Global ValidationPipe config: strips unknown fields, rejects requests carrying them,
// and coerces payloads to their DTO classes so class-validator decorators run.
// Copied verbatim from school-eos-backend's own convention for consistency.

import { ValidationPipe, ValidationPipeOptions } from '@nestjs/common';

export const validationPipeConfig: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
};

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe(validationPipeConfig);
}
