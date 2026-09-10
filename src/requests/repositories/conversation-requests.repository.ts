// messaging.conversation_requests -- LLD §8/§30-32. The partial unique index
// (uq_conversation_requests_pending, one PENDING row per conversation) is the
// real, DB-level guarantee against a concurrent duplicate request racing this
// one (LLD §32) — this repository's create() relies on that constraint, the
// caller must handle a unique-violation as "someone already requested this",
// never a generic 500.

import { Injectable } from '@nestjs/common';
import {
  PostgresService,
  Queryable,
} from '../../common/postgres/postgres.service';

export type RequestStatus =
  'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED';

export interface ConversationRequestRow {
  id: string;
  conversationId: string;
  requesterPersonId: string;
  recipientPersonId: string;
  status: RequestStatus;
  initialMessageId: string | null;
  createdAt: string;
  respondedAt: string | null;
  expiresAt: string | null;
  version: number;
}

function mapRow(row: any): ConversationRequestRow {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    requesterPersonId: row.requester_person_id,
    recipientPersonId: row.recipient_person_id,
    status: row.status,
    initialMessageId:
      row.initial_message_id === null ? null : String(row.initial_message_id),
    createdAt: row.created_at,
    respondedAt: row.responded_at,
    expiresAt: row.expires_at,
    version: Number(row.version),
  };
}

const COLUMNS = `id, conversation_id, requester_person_id, recipient_person_id, status,
  initial_message_id, created_at, responded_at, expires_at, version`;

@Injectable()
export class ConversationRequestsRepository {
  constructor(private readonly postgres: PostgresService) {}

  async create(
    input: {
      conversationId: string;
      requesterPersonId: string;
      recipientPersonId: string;
    },
    executor: Queryable,
  ): Promise<ConversationRequestRow> {
    const { rows } = await executor.query(
      `INSERT INTO messaging.conversation_requests (conversation_id, requester_person_id, recipient_person_id)
       VALUES ($1, $2, $3)
       RETURNING ${COLUMNS}`,
      [input.conversationId, input.requesterPersonId, input.recipientPersonId],
    );
    return mapRow(rows[0]);
  }

  async findById(
    id: string,
    executor: Queryable = this.postgres,
  ): Promise<ConversationRequestRow | null> {
    const { rows } = await executor.query(
      `SELECT ${COLUMNS} FROM messaging.conversation_requests WHERE id = $1`,
      [id],
    );
    return rows.length ? mapRow(rows[0]) : null;
  }

  async findByIdForUpdate(
    id: string,
    executor: Queryable,
  ): Promise<ConversationRequestRow | null> {
    const { rows } = await executor.query(
      `SELECT ${COLUMNS} FROM messaging.conversation_requests WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return rows.length ? mapRow(rows[0]) : null;
  }

  /** The single PENDING request for a conversation, if any — this IS the
   * "is normal messaging currently gated" signal (LLD §31), re-checked on
   * every message send. */
  async findPendingForConversation(
    conversationId: string,
    executor: Queryable = this.postgres,
  ): Promise<ConversationRequestRow | null> {
    const { rows } = await executor.query(
      `SELECT ${COLUMNS} FROM messaging.conversation_requests WHERE conversation_id = $1 AND status = 'PENDING'`,
      [conversationId],
    );
    return rows.length ? mapRow(rows[0]) : null;
  }

  async setInitialMessage(
    id: string,
    messageId: string,
    executor: Queryable,
  ): Promise<void> {
    await executor.query(
      `UPDATE messaging.conversation_requests SET initial_message_id = $2 WHERE id = $1`,
      [id, messageId],
    );
  }

  async accept(id: string, executor: Queryable): Promise<void> {
    await executor.query(
      `UPDATE messaging.conversation_requests SET status = 'ACCEPTED', responded_at = now() WHERE id = $1`,
      [id],
    );
  }

  async decline(id: string, executor: Queryable): Promise<void> {
    await executor.query(
      `UPDATE messaging.conversation_requests SET status = 'DECLINED', responded_at = now() WHERE id = $1`,
      [id],
    );
  }

  async cancel(id: string, executor: Queryable): Promise<void> {
    await executor.query(
      `UPDATE messaging.conversation_requests SET status = 'CANCELLED', responded_at = now() WHERE id = $1`,
      [id],
    );
  }

  async listForRecipient(
    personId: string,
    status: RequestStatus,
    executor: Queryable = this.postgres,
  ): Promise<ConversationRequestRow[]> {
    const { rows } = await executor.query(
      `SELECT ${COLUMNS} FROM messaging.conversation_requests
       WHERE recipient_person_id = $1 AND status = $2
       ORDER BY created_at DESC`,
      [personId, status],
    );
    return rows.map(mapRow);
  }

  async listForRequester(
    personId: string,
    status: RequestStatus,
    executor: Queryable = this.postgres,
  ): Promise<ConversationRequestRow[]> {
    const { rows } = await executor.query(
      `SELECT ${COLUMNS} FROM messaging.conversation_requests
       WHERE requester_person_id = $1 AND status = $2
       ORDER BY created_at DESC`,
      [personId, status],
    );
    return rows.map(mapRow);
  }
}
