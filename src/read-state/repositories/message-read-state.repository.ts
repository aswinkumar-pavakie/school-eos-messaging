// One row per (conversation, person) -- not one row per read event (LLD §12,
// §28: "more efficient than inserting a row for every read action").

import { Injectable } from '@nestjs/common';
import {
  PostgresService,
  Queryable,
} from '../../common/postgres/postgres.service';

export interface ReadStateRow {
  conversationId: string;
  personId: string;
  lastReadSequence: number;
  updatedAt: string;
}

function mapRow(row: any): ReadStateRow {
  return {
    conversationId: row.conversation_id,
    personId: row.person_id,
    lastReadSequence: Number(row.last_read_sequence),
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class MessageReadStateRepository {
  constructor(private readonly postgres: PostgresService) {}

  async get(
    conversationId: string,
    personId: string,
    executor: Queryable = this.postgres,
  ): Promise<ReadStateRow | null> {
    const { rows } = await executor.query(
      `SELECT conversation_id, person_id, last_read_sequence, updated_at
       FROM messaging.message_read_state WHERE conversation_id = $1 AND person_id = $2`,
      [conversationId, personId],
    );
    return rows.length ? mapRow(rows[0]) : null;
  }

  /** Race-safe against an out-of-order or repeated read receipt -- never
   * moves the cursor backwards (GREATEST), and the upsert itself is
   * idempotent (marking the same message read twice is a no-op, not a second
   * row per LLD §12's own stated efficiency goal). */
  async upsert(
    conversationId: string,
    personId: string,
    sequence: number,
    executor: Queryable = this.postgres,
  ): Promise<void> {
    await executor.query(
      `INSERT INTO messaging.message_read_state (conversation_id, person_id, last_read_sequence, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (conversation_id, person_id) DO UPDATE
         SET last_read_sequence = GREATEST(messaging.message_read_state.last_read_sequence, EXCLUDED.last_read_sequence),
             updated_at = now()`,
      [conversationId, personId, sequence],
    );
  }
}
