// App configuration loader — typed accessor over process.env, consumed via
// ConfigService. Mirrors school-eos-backend's own src/config/configuration.ts
// convention (a single typed factory, never a scattered process.env read).

export interface AppConfig {
  port: number;
  database: {
    /** The EXISTING Supabase PostgreSQL project's connection string — see
     * .env.example. Never a second/local database. */
    url: string;
  };
  redis: {
    url: string;
  };
  jwt: {
    /** Must equal Core's own JWT_ACCESS_SECRET — Messaging verifies Core's
     * tokens, it never issues its own (see auth/README.md). */
    accessSecret: string;
    accessExpiresIn: string;
  };
  coreIntegration: {
    baseUrl: string;
    /** Sent as X-Internal-Service-Key on every call to Core's new internal
     * /internal/v1/messaging/* endpoints — must match Core's own
     * MESSAGING_INTERNAL_KEY. */
    internalKey: string;
  };
  rateLimit: {
    messagesPerMinute: number;
    requestsPerHour: number;
    directorySearchPerMinute: number;
  };
  outbox: {
    pollIntervalMs: number;
    maxAttempts: number;
  };
}

export default (): AppConfig => ({
  port: parseInt(process.env.PORT ?? '3001', 10),
  database: {
    url: process.env.DATABASE_URL ?? '',
  },
  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET ?? '',
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
  },
  coreIntegration: {
    baseUrl:
      process.env.CORE_INTERNAL_BASE_URL ??
      'http://localhost:3000/internal/v1/messaging',
    internalKey: process.env.MESSAGING_INTERNAL_KEY ?? '',
  },
  rateLimit: {
    messagesPerMinute: parseInt(
      process.env.RATE_LIMIT_MESSAGE_PER_MINUTE ?? '60',
      10,
    ),
    requestsPerHour: parseInt(
      process.env.RATE_LIMIT_REQUEST_PER_HOUR ?? '10',
      10,
    ),
    directorySearchPerMinute: parseInt(
      process.env.RATE_LIMIT_DIRECTORY_SEARCH_PER_MINUTE ?? '30',
      10,
    ),
  },
  outbox: {
    pollIntervalMs: parseInt(process.env.OUTBOX_POLL_INTERVAL_MS ?? '2000', 10),
    maxAttempts: parseInt(process.env.OUTBOX_MAX_ATTEMPTS ?? '8', 10),
  },
});
