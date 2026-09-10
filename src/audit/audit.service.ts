// Thin, named facade over SecurityEventsRepository -- one real, documented
// event type per significant operation (LLD §41/§59-61), never a free-text
// event name invented ad hoc at each call site. Never called with anything
// derived from message plaintext/ciphertext, tokens, or private keys — the
// TypeScript input shape here structurally can't carry those (only IDs,
// hashes, and small enums), which is the real enforcement, not just a
// comment.

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  SecurityEventInput,
  SecurityEventsRepository,
} from './repositories/security-events.repository';

export type SecurityEventType =
  | 'AUTH_FAILURE'
  | 'WEBSOCKET_AUTH_FAILURE'
  | 'AUTHORIZATION_DENIED'
  | 'CONVERSATION_CREATED'
  | 'REQUEST_CREATED'
  | 'REQUEST_ACCEPTED'
  | 'REQUEST_DECLINED'
  | 'DEVICE_REGISTERED'
  | 'DEVICE_REVOKED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'SUSPICIOUS_DIRECTORY_ACTIVITY'
  | 'ATTACHMENT_SECURITY_FAILURE';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly repo: SecurityEventsRepository) {}

  /** Best-effort, by design -- confirmed live: an unavailable database made
   * this throw uncaught from inside a WebSocket connection handler's own
   * error path, crashing the ENTIRE process over a failure to write a log
   * line. Audit logging is a secondary, observability concern; it must never
   * become a single point of failure for the primary business flow it's
   * merely recording (the same reasoning LLD §57 applies to push/Redis: a
   * secondary system failing degrades that secondary concern, never takes
   * the whole service down). Every call site benefits from this fix at
   * once, rather than needing its own try/catch. */
  async record(
    eventType: SecurityEventType,
    input: Omit<SecurityEventInput, 'eventType' | 'correlationId'> & {
      correlationId?: string;
    },
  ): Promise<void> {
    try {
      await this.repo.record({
        eventType,
        correlationId: input.correlationId ?? randomUUID(),
        actorPersonId: input.actorPersonId,
        deviceId: input.deviceId,
        conversationId: input.conversationId,
        ipHash: input.ipHash,
        userAgentHash: input.userAgentHash,
        metadata: input.metadata,
      });
    } catch (err) {
      this.logger.error(
        `Failed to record security event ${eventType}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
