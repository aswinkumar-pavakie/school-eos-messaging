// messaging.outbox_events -- LLD §16/§27/§30/§56-58. enqueue() must always be
// called with the SAME transaction executor as whatever business write it
// accompanies (message insert, request creation, etc.) -- that's the entire
// point of the transactional outbox pattern: the event can never exist
// without its business row, or vice versa.

import { Injectable } from '@nestjs/common';
import {
  PostgresService,
  Queryable,
} from '../../common/postgres/postgres.service';

export type OutboxStatus =
  'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED' | 'DEAD_LETTER';

export interface OutboxEventRow {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attemptCount: number;
}

function mapRow(row: any): OutboxEventRow {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    attemptCount: Number(row.attempt_count),
  };
}

@Injectable()
export class OutboxEventsRepository {
  constructor(private readonly postgres: PostgresService) {}

  async enqueue(
    input: {
      aggregateType: string;
      aggregateId: string;
      eventType: string;
      payload: Record<string, unknown>;
    },
    executor: Queryable,
  ): Promise<void> {
    await executor.query(
      `INSERT INTO messaging.outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, $2, $3, $4)`,
      [
        input.aggregateType,
        input.aggregateId,
        input.eventType,
        JSON.stringify(input.payload),
      ],
    );
  }

  /** Every event due for processing right now -- PENDING, or FAILED and due
   * for retry (next_attempt_at has passed), oldest first so a backlog drains
   * in order. */
  async findDueBatch(
    limit: number,
    executor: Queryable = this.postgres,
  ): Promise<OutboxEventRow[]> {
    const { rows } = await executor.query(
      `SELECT id, aggregate_type, aggregate_id, event_type, payload, attempt_count
       FROM messaging.outbox_events
       WHERE status IN ('PENDING', 'FAILED') AND next_attempt_at <= now()
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit],
    );
    return rows.map(mapRow);
  }

  async markPublished(
    id: string,
    executor: Queryable = this.postgres,
  ): Promise<void> {
    await executor.query(
      `UPDATE messaging.outbox_events SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
      [id],
    );
  }

  /** Exponential backoff, capped -- after maxAttempts, DEAD_LETTER instead of
   * retrying forever (LLD §58). */
  async markFailed(
    id: string,
    attemptCount: number,
    maxAttempts: number,
    lastError: string,
    executor: Queryable = this.postgres,
  ): Promise<void> {
    const nextAttempt =
      attemptCount >= maxAttempts ? null : Math.min(2 ** attemptCount, 300);
    if (nextAttempt === null) {
      await executor.query(
        `UPDATE messaging.outbox_events
         SET status = 'DEAD_LETTER', attempt_count = attempt_count + 1, last_error = $2
         WHERE id = $1`,
        [id, lastError],
      );
    } else {
      await executor.query(
        `UPDATE messaging.outbox_events
         SET status = 'FAILED', attempt_count = attempt_count + 1, last_error = $2,
             next_attempt_at = now() + ($3 || ' seconds')::interval
         WHERE id = $1`,
        [id, lastError, String(nextAttempt)],
      );
    }
  }
}
