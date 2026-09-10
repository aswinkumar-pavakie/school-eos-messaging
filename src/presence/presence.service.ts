// Presence is ephemeral -- Redis only, TTL'd, never a PostgreSQL write (LLD
// §26/§41). The WebSocket gateway marks a person online on connect and
// refreshes on every heartbeat; a natural TTL expiry (no explicit "mark
// offline" required on an ungraceful disconnect) is what makes this correct
// even if a connection just silently drops.
//
// Every method here is best-effort by design, never throwing -- confirmed
// live: an unavailable Redis made markOnline() throw uncaught from inside
// the WebSocket connection handler, rejecting a perfectly legitimate,
// correctly-authenticated connection just because a SECONDARY, ephemeral
// concern (presence) couldn't be recorded. A real connection must succeed
// even if presence tracking can't currently happen (LLD §57's own
// principle, applied here too: a secondary system's failure degrades that
// system, never the primary flow depending on it).

import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';

const PRESENCE_TTL_SECONDS = 60;

function presenceKey(personId: string): string {
  return `presence:user:${personId}`;
}

@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);

  constructor(private readonly redis: RedisService) {}

  async markOnline(personId: string): Promise<void> {
    try {
      await this.redis.client.set(
        presenceKey(personId),
        '1',
        'EX',
        PRESENCE_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(
        `markOnline failed for ${personId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Called on every heartbeat -- refreshes the TTL so a genuinely-connected
   * person never falls out of ONLINE just because the last check happened to
   * land near the previous TTL's expiry. */
  async refresh(personId: string): Promise<void> {
    try {
      await this.redis.client.expire(
        presenceKey(personId),
        PRESENCE_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(
        `refresh failed for ${personId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  async markOffline(personId: string): Promise<void> {
    try {
      await this.redis.client.del(presenceKey(personId));
    } catch (err) {
      this.logger.warn(
        `markOffline failed for ${personId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Fails toward "offline" on any Redis error, deliberately -- the outbox
   * worker uses this to decide whether to also send a push notification.
   * Assuming ONLINE when Redis is actually unreachable would silently drop
   * a real notification the recipient would never otherwise see; assuming
   * OFFLINE in that same situation costs, at worst, one redundant push to
   * someone who happened to genuinely be online. The safer failure
   * direction is the one that still delivers the notification. */
  async isOnline(personId: string): Promise<boolean> {
    try {
      return (await this.redis.client.exists(presenceKey(personId))) === 1;
    } catch (err) {
      this.logger.warn(
        `isOnline check failed for ${personId}, assuming offline: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }
}
