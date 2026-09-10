// Thin ioredis wrapper — Redis is ephemeral/realtime coordination ONLY (LLD
// §28/§40): presence, typing, cross-instance WebSocket fan-out, rate limiting.
// It is never the authoritative store for anything durable; PostgreSQL is (LLD
// §21/§56). Every key this service's callers write must carry a TTL — nothing
// here is meant to live forever.

import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;
  /** A second connection is required for pub/sub — once a client calls
   * SUBSCRIBE it can no longer run normal commands on the same connection
   * (this is ioredis/Redis's own documented constraint, not a choice made
   * here). Used by websocket/'s cross-instance fan-out. */
  readonly subscriber: Redis;

  constructor(configService: ConfigService) {
    const url = configService.get<string>('redis.url')!;
    // Bounded connect/command timeouts -- confirmed live: ioredis's own
    // defaults (no connectTimeout override, unlimited command queueing while
    // reconnecting) let /health/ready hang indefinitely against an
    // unreachable Redis instead of failing fast, the same class of bug just
    // fixed on the Postgres pool above. retryStrategy keeps trying to
    // RECONNECT indefinitely with capped backoff (distinct from
    // maxRetriesPerRequest, which governs individual command retries while
    // disconnected) -- confirmed live: without this, an unreachable Redis at
    // boot crashed the entire process via an unhandled
    // MaxRetriesPerRequestError, not the graceful degradation LLD §40/§57
    // require ("if Redis fails... realtime functionality degrades safely" --
    // never "the whole service goes down").
    const retryStrategy = (attempt: number) => Math.min(attempt * 500, 10_000);
    const options = {
      lazyConnect: false,
      connectTimeout: 5_000,
      commandTimeout: 5_000,
      maxRetriesPerRequest: 3,
      retryStrategy,
    };
    this.client = new Redis(url, options);
    this.subscriber = new Redis(url, options);

    // Same reasoning as PostgresService's pool 'error' handler: an unhandled
    // 'error' event on a Node EventEmitter crashes the process. A transient
    // Redis blip must degrade realtime features, never take the whole service
    // down (LLD §40/§57: "if Redis fails... message remains persisted").
    this.client.on('error', (err) => {
      console.error(
        '[RedisService] client error (degrading, not crashing):',
        err.message,
      );
    });
    this.subscriber.on('error', (err) => {
      console.error(
        '[RedisService] subscriber error (degrading, not crashing):',
        err.message,
      );
    });
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
    this.subscriber.disconnect();
  }
}
