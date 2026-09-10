// Cross-instance realtime fan-out (LLD §29/§40/§43/§65): OutboxWorkerService
// publishes to ws:user:{personId} after a real, already-authorized business
// operation commits; THIS instance's subscriber picks it up and hands it to
// the gateway, which forwards it only to sockets actually connected here.
// Every other instance's own subscriber does the same independently --
// whichever instance actually holds the recipient's live connection is the
// one that ends up delivering it, and if none currently do, the event is
// simply not delivered in realtime (the durable message itself is still
// safe in PostgreSQL either way -- LLD §57: "if Redis fails... message
// remains persisted... recipient can synchronize later").

import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import { MessagingGateway } from './messaging.gateway';

@Injectable()
export class RedisSubscriberService implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly redis: RedisService,
    private readonly gateway: MessagingGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    this.redis.subscriber.on('pmessage', (_pattern, channel, message) => {
      const personId = channel.slice('ws:user:'.length);
      try {
        const event = JSON.parse(message) as Record<string, unknown>;
        this.gateway.deliverToLocalSockets(personId, event);
      } catch {
        // A malformed message on this internal channel is a bug worth
        // knowing about, but must never crash the subscriber loop for
        // every other real event still queued behind it.
      }
    });

    // Confirmed live: if Redis is unreachable at boot, an unhandled rejection
    // here previously crashed the entire process -- realtime fan-out must
    // degrade instead (LLD §40/§57). Subscribing again on every 'ready'
    // event (fired on the initial connect AND every reconnect) both
    // recovers from a Redis-down-at-boot start and covers the case
    // ioredis's own autoResubscribe wouldn't (a subscribe call that never
    // succeeded in the first place has nothing for autoResubscribe to
    // remember).
    this.redis.subscriber.on('ready', () => {
      this.redis.subscriber.psubscribe('ws:user:*').catch((err) => {
        console.error(
          '[RedisSubscriberService] psubscribe failed:',
          err instanceof Error ? err.message : err,
        );
      });
    });

    await this.redis.subscriber.psubscribe('ws:user:*').catch((err) => {
      console.error(
        '[RedisSubscriberService] initial psubscribe failed (will retry once Redis is reachable):',
        err instanceof Error ? err.message : err,
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.subscriber.punsubscribe('ws:user:*');
  }
}
