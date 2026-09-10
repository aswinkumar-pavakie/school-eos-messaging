// The real delivery processor for outbox events (LLD §16/§27/§43/§51/§57-58).
// Deliberately outside every business transaction — the message insert itself
// only ever writes the outbox row; everything here (realtime fan-out, push
// notifications) happens afterward, on its own schedule, with its own retry.
//
// Runs every 5 seconds (a message should feel realtime, not "checked once a
// minute" — Media Room's own once-a-minute auto-publish cadence would feel
// broken here). Guards against overlapping runs piling up if the database or
// Redis is ever genuinely slow for longer than one tick — the exact same
// class of bug caught and fixed in school-eos-backend's own
// PushDeliveryScheduler earlier this session: a stalled tick under a real
// outage let successive ticks accumulate and exhaust the connection pool,
// starving unrelated real requests.

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../common/redis/redis.service';
import { CoreIntegrationService } from '../core-integration/core-integration.service';
import {
  isPlausibleExpoPushToken,
  sendExpoPush,
} from '../notifications/expo-push.util';
import { PresenceService } from '../presence/presence.service';
import {
  OutboxEventRow,
  OutboxEventsRepository,
} from './repositories/outbox-events.repository';

const BATCH_SIZE = 50;

interface MessageCreatedPayload {
  conversationId: string;
  messageId: string;
  sequenceNo: number;
  senderPersonId: string;
  recipientPersonId: string;
}

@Injectable()
export class OutboxWorkerService {
  private readonly logger = new Logger(OutboxWorkerService.name);
  private isRunning = false;

  constructor(
    private readonly outboxRepo: OutboxEventsRepository,
    private readonly presence: PresenceService,
    private readonly core: CoreIntegrationService,
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
  ) {}

  @Cron('*/5 * * * * *')
  async dispatchPending(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn(
        'Previous outbox run still in flight, skipping this tick.',
      );
      return;
    }
    this.isRunning = true;
    try {
      await this.runOnce();
    } catch (err) {
      // Confirmed live: an unreachable database made findDueBatch() itself
      // throw, uncaught, from inside a @Cron tick -- crashing the entire
      // process every 5 seconds. A scheduled background tick failing for
      // ANY reason (DB down, bug, network blip) must degrade to "try again
      // next tick," never take the whole service down with it.
      this.logger.error(
        `Outbox tick failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      this.isRunning = false;
    }
  }

  private async runOnce(): Promise<void> {
    const maxAttempts = this.configService.get<number>('outbox.maxAttempts')!;
    const batch = await this.outboxRepo.findDueBatch(BATCH_SIZE);
    for (const event of batch) {
      try {
        await this.processEvent(event);
        await this.outboxRepo.markPublished(event.id);
      } catch (err) {
        this.logger.error(
          `Outbox event ${event.id} (${event.eventType}) failed: ${err instanceof Error ? err.message : err}`,
        );
        await this.outboxRepo.markFailed(
          event.id,
          event.attemptCount,
          maxAttempts,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  private async processEvent(event: OutboxEventRow): Promise<void> {
    if (event.eventType === 'message.created') {
      await this.processMessageCreated(
        event.payload as unknown as MessageCreatedPayload,
      );
      return;
    }
    // Future event types (request.created, request.accepted, etc.) get their
    // own branch here — never silently ignored, so an unrecognized event
    // type is a real bug surfaced via markFailed, not a silent no-op.
    throw new Error(`Unrecognized outbox event type: ${event.eventType}`);
  }

  private async processMessageCreated(
    payload: MessageCreatedPayload,
  ): Promise<void> {
    // 1. Always publish for cross-instance realtime fan-out (LLD §29/§43) --
    //    whichever WebSocket-gateway instance actually holds this recipient's
    //    live connection (if any) picks this up and forwards message.new.
    await this.redis.client.publish(
      `ws:user:${payload.recipientPersonId}`,
      JSON.stringify({
        type: 'message.new',
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        sequenceNo: payload.sequenceNo,
        senderPersonId: payload.senderPersonId,
      }),
    );

    // 2. Push only if genuinely offline right now (LLD §51: "check recipient
    //    online? YES -> realtime only, NO -> push notification").
    const online = await this.presence.isOnline(payload.recipientPersonId);
    if (online) return;

    const tokens = await this.core.getPushTokens(payload.recipientPersonId);
    const validTokens = tokens.filter(isPlausibleExpoPushToken);
    if (validTokens.length === 0) return;

    const sender = await this.core.getUserProjection(payload.senderPersonId);
    const senderName = sender?.displayName ?? 'Someone';

    for (const token of validTokens) {
      try {
        // Generic content only (LLD §51) -- this service never has plaintext
        // to include even if it wanted to (E2EE), but the sender's own name
        // is still safe, non-content metadata (the same convention real
        // E2EE messengers like Signal use).
        await sendExpoPush({
          to: token,
          title: 'New message',
          body: `${senderName} sent you a message`,
          data: { type: 'message.new', conversationId: payload.conversationId },
          sound: 'default',
        });
      } catch (err) {
        this.logger.error(
          `Push notification failed for ${payload.recipientPersonId}: ${err instanceof Error ? err.message : err}`,
        );
        // One failed token must never abort delivery to the person's other
        // devices — continue the loop rather than rethrow.
      }
    }
  }
}
