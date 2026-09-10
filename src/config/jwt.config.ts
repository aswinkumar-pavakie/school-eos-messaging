// Shared JwtModule.registerAsync options. Messaging only ever VERIFIES tokens
// here (see auth/jwt-auth.guard.ts) — it never signs one, since it never issues
// its own sessions (LLD §8/decision: "Messaging verifies the same JWT Core
// issues, directly, using the same shared secret").

import { ConfigService } from '@nestjs/config';
import type { JwtModuleOptions } from '@nestjs/jwt';

export const jwtModuleFactory = {
  inject: [ConfigService],
  useFactory: (configService: ConfigService): JwtModuleOptions => ({
    secret: configService.get<string>('jwt.accessSecret'),
  }),
};
