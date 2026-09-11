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

interface RequestCreatedPayload {
  conversationId: string;
  requestId: string;
  recipientPersonId: string;
  requesterPersonId: string;
}

interface RequestDecidedPayload {
  conversationId: string;
  requestId: string;
  requesterPersonId: string;
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
    switch (event.eventType) {
      case 'message.created':
        return this.processMessageCreated(
          event.payload as unknown as MessageCreatedPayload,
        );
      case 'request.created':
        return this.processRequestCreated(
          event.payload as unknown as RequestCreatedPayload,
        );
      case 'request.accepted':
        return this.processRequestDecided(
          event.payload as unknown as RequestDecidedPayload,
          'request.accepted',
        );
      case 'request.declined':
        return this.processRequestDecided(
          event.payload as unknown as RequestDecidedPayload,
          'request.declined',
        );
      default:
        // A genuinely new event type nobody wired a handler for yet is a
        // real bug surfaced via markFailed, not a silent no-op -- confirmed
        // live: request.created/request.accepted were enqueued by
        // RequestsService from the very first build but this switch never
        // actually grew a branch for them, so real recipients got zero
        // realtime/push notification for a new or decided request until
        // this was caught by reading the service's own live logs.
        throw new Error(`Unrecognized outbox event type: ${event.eventType}`);
    }
  }

  private async processMessageCreated(
    payload: MessageCreatedPayload,
  ): Promise<void> {
    // Always publish for cross-instance realtime fan-out (LLD §29/§43) --
    // whichever WebSocket-gateway instance actually holds this recipient's
    // live connection (if any) picks this up and forwards message.new.
    await this.publish(payload.recipientPersonId, {
      type: 'message.new',
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      sequenceNo: payload.sequenceNo,
      senderPersonId: payload.senderPersonId,
    });

    await this.notifyIfOffline(payload.recipientPersonId, payload.senderPersonId, {
      title: 'New message',
      bodyTemplate: (name) => `${name} sent you a message`,
      data: { type: 'message.new', conversationId: payload.conversationId },
    });
  }

  /** The recipient of a brand-new request -- LLD §16's own request flow
   * literally cannot be acted on if the recipient never learns it exists;
   * this is the "someone wants to message you" notification. */
  private async processRequestCreated(
    payload: RequestCreatedPayload,
  ): Promise<void> {
    await this.publish(payload.recipientPersonId, {
      type: 'request.new',
      conversationId: payload.conversationId,
      requestId: payload.requestId,
      requesterPersonId: payload.requesterPersonId,
    });

    await this.notifyIfOffline(payload.recipientPersonId, payload.requesterPersonId, {
      title: 'New message request',
      bodyTemplate: (name) => `${name} wants to send you a message`,
      data: { type: 'request.new', conversationId: payload.conversationId, requestId: payload.requestId },
    });
  }

  /** Notifies the ORIGINAL REQUESTER once their request has been decided --
   * without this, the person who reached out never learns whether they were
   * accepted or declined except by manually checking again. */
  private async processRequestDecided(
    payload: RequestDecidedPayload,
    eventName: 'request.accepted' | 'request.declined',
  ): Promise<void> {
    await this.publish(payload.requesterPersonId, {
      type: eventName,
      conversationId: payload.conversationId,
      requestId: payload.requestId,
    });

    const accepted = eventName === 'request.accepted';
    await this.notifyIfOffline(payload.requesterPersonId, null, {
      title: accepted ? 'Request accepted' : 'Request declined',
      bodyTemplate: () =>
        accepted ? 'Your message request was accepted.' : 'Your message request was declined.',
      data: { type: eventName, conversationId: payload.conversationId, requestId: payload.requestId },
    });
  }

  /** Cross-instance realtime fan-out -- whichever instance holds this
   * person's live WebSocket connection (if any) forwards the event. */
  private async publish(targetPersonId: string, event: Record<string, unknown>): Promise<void> {
    await this.redis.client.publish(`ws:user:${targetPersonId}`, JSON.stringify(event));
  }

  /** Shared by every event type: push only if the target is genuinely
   * offline right now (LLD §51), generic content only (this service never
   * has plaintext to leak even if it wanted to). `otherPersonId` is who to
   * name in the push body (the message sender, the requester) -- null when
   * the event isn't "from" anyone in particular (a request decision). */
  private async notifyIfOffline(
    targetPersonId: string,
    otherPersonId: string | null,
    push: { title: string; bodyTemplate: (otherDisplayName: string) => string; data: Record<string, unknown> },
  ): Promise<void> {
    const online = await this.presence.isOnline(targetPersonId);
    if (online) return;

    const tokens = await this.core.getPushTokens(targetPersonId);
    const validTokens = tokens.filter(isPlausibleExpoPushToken);
    if (validTokens.length === 0) return;

    let otherName = 'Someone';
    if (otherPersonId) {
      const other = await this.core.getUserProjection(otherPersonId);
      otherName = other?.displayName ?? 'Someone';
    }

    for (const token of validTokens) {
      try {
        await sendExpoPush({
          to: token,
          title: push.title,
          body: push.bodyTemplate(otherName),
          data: push.data,
          sound: 'default',
        });
      } catch (err) {
        this.logger.error(
          `Push notification failed for ${targetPersonId}: ${err instanceof Error ? err.message : err}`,
        );
        // One failed token must never abort delivery to the person's other
        // devices — continue the loop rather than rethrow.
      }
    }
  }
}
