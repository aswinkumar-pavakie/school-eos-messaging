// Redis-backed, multi-dimension rate limiting (LLD §34/§38). A simple
// fixed-window counter -- cheap, correct enough for this scale (LLD §48:
// "do not optimize prematurely... first build correct, secure domain
// behavior"); a sliding-window/token-bucket refinement is a documented later
// option if real traffic ever shows fixed-window's edge burst behavior is a
// problem, not something to build speculatively now.
//
// Server-side only, always -- the mobile UI hiding a button is never this
// service's enforcement mechanism (LLD §34: "do not rely on mobile UI
// restrictions").

import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(private readonly redis: RedisService) {}

  /** True if this action is still within its limit (and counts it toward the
   * window); false if the caller should be rejected. `dimension` and `key`
   * together form the real Redis key (e.g. dimension="message",
   * key=personId, or dimension="connection", key=deviceId) -- callers choose
   * their own dimension/key granularity per LLD §34's "IP / account / device
   * / conversation" list.
   *
   * Fails OPEN (allows the request) if Redis is unreachable -- a deliberate,
   * different choice from authorization's own fail-closed rule. Rate
   * limiting is defense-in-depth against abuse, not the boundary deciding
   * who may act at all (authentication/authorization enforce that
   * regardless of Redis's availability); refusing every real request during
   * a Redis outage would be a worse failure than temporarily losing one
   * layer of abuse protection. */
  async consume(
    dimension: string,
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<boolean> {
    const redisKey = `ratelimit:${dimension}:${key}`;
    try {
      const count = await this.redis.client.incr(redisKey);
      if (count === 1) {
        await this.redis.client.expire(redisKey, windowSeconds);
      }
      return count <= limit;
    } catch (err) {
      this.logger.warn(
        `Rate limit check failed for ${redisKey}, failing open: ${err instanceof Error ? err.message : err}`,
      );
      return true;
    }
  }
}
