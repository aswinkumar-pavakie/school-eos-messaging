// Env-var validation, run once at bootstrap via ConfigModule.forRoot({ validate }).
// Fails fast on a missing/malformed secret instead of limping into a broken
// auth or Core-integration path (LLD §54: "validate environment configuration
// at application startup... fail fast for invalid required configuration").

import { plainToInstance } from 'class-transformer';
import { IsNotEmpty, IsString, validateSync } from 'class-validator';

class EnvironmentVariables {
  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsString()
  @IsNotEmpty()
  REDIS_URL!: string;

  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  MESSAGING_INTERNAL_KEY!: string;

  @IsString()
  @IsNotEmpty()
  CORE_INTERNAL_BASE_URL!: string;
}

export function validate(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    const missing = errors.map((e) => e.property).join(', ');
    throw new Error(
      `Missing/invalid required environment variables: ${missing}`,
    );
  }

  return config;
}
