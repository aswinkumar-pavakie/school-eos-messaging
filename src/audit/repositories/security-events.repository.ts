// messaging.security_events -- LLD §17/§59-61. Never store plaintext message
// contents or any raw sensitive payload here — metadata only, and the caller
// (SecurityEventsService below) is the one place responsible for redaction
// before anything reaches this repository.

import { Injectable } from '@nestjs/common';
import {
  PostgresService,
  Queryable,
} from '../../common/postgres/postgres.service';

export interface SecurityEventInput {
  eventType: string;
  actorPersonId?: string | null;
  deviceId?: string | null;
  conversationId?: string | null;
  ipHash?: string | null;
  userAgentHash?: string | null;
  correlationId: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class SecurityEventsRepository {
  constructor(private readonly postgres: PostgresService) {}

  async record(
    input: SecurityEventInput,
    executor: Queryable = this.postgres,
  ): Promise<void> {
    await executor.query(
      `INSERT INTO messaging.security_events
         (event_type, actor_person_id, device_id, conversation_id, ip_hash, user_agent_hash, correlation_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.eventType,
        input.actorPersonId ?? null,
        input.deviceId ?? null,
        input.conversationId ?? null,
        input.ipHash ?? null,
        input.userAgentHash ?? null,
        input.correlationId,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }
}
