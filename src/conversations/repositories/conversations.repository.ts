// messaging.conversations -- DIRECT-only (LLD §6/§60). person_a_id/person_b_id
// are always stored sorted so the partial unique index
// (uq_conversations_active_pair) can do its job regardless of who's "A" — this
// repository is the ONLY place that sorts them, every caller just passes the
// two real person IDs in whatever order it has them.

import { Injectable } from '@nestjs/common';
import {
  PostgresService,
  Queryable,
} from '../../common/postgres/postgres.service';

export interface ConversationRow {
  id: string;
  conversationType: 'DIRECT';
  status: 'ACTIVE' | 'BLOCKED' | 'CLOSED';
  personAId: string;
  personBId: string;
  createdBy: string;
  lastSequenceNo: number;
  lastMessageId: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  /** Present only on actor-scoped queries (listForPerson) -- the calling
   * person's own pending MLS Welcome for this conversation, base64-encoded,
   * or null if none/already delivered. Undefined (not present at all) on
   * queries with no actor context (findById, findActiveBetween, etc). */
  mlsWelcome?: string | null;
}

function mapRow(row: any): ConversationRow {
  return {
    id: row.id,
    conversationType: row.conversation_type,
    status: row.status,
    personAId: row.person_a_id,
    personBId: row.person_b_id,
    createdBy: row.created_by,
    lastSequenceNo: Number(row.last_sequence_no),
    lastMessageId:
      row.last_message_id === null ? null : String(row.last_message_id),
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: Number(row.version),
  };
}

function mapRowWithMlsWelcome(row: any): ConversationRow {
  return {
    ...mapRow(row),
    mlsWelcome:
      row.mls_welcome_delivered_at === null && row.mls_welcome !== null
        ? Buffer.from(row.mls_welcome).toString('base64')
        : null,
  };
}

const COLUMNS = `id, conversation_type, status, person_a_id, person_b_id, created_by,
  last_sequence_no, last_message_id, last_message_at, created_at, updated_at, version`;
const QUALIFIED_COLUMNS = `c.id, c.conversation_type, c.status, c.person_a_id, c.person_b_id, c.created_by,
  c.last_sequence_no, c.last_message_id, c.last_message_at, c.created_at, c.updated_at, c.version`;

@Injectable()
export class ConversationsRepository {
  constructor(private readonly postgres: PostgresService) {}

  /** The one, real, existing (possibly BLOCKED) DIRECT conversation between
   * these two people, if any — never returns a CLOSED one (LLD §28: "existing
   * active conversation? -> open it", a closed conversation is historical,
   * not reusable). */
  async findActiveBetween(
    personA: string,
    personB: string,
    executor: Queryable = this.postgres,
  ): Promise<ConversationRow | null> {
    const [a, b] = [personA, personB].sort();
    const { rows } = await executor.query(
      `SELECT ${COLUMNS} FROM messaging.conversations
       WHERE person_a_id = $1 AND person_b_id = $2 AND status <> 'CLOSED'`,
      [a, b],
    );
    return rows.length ? mapRow(rows[0]) : null;
  }

  async findById(
    id: string,
    executor: Queryable = this.postgres,
  ): Promise<ConversationRow | null> {
    const { rows } = await executor.query(
      `SELECT ${COLUMNS} FROM messaging.conversations WHERE id = $1`,
      [id],
    );
    return rows.length ? mapRow(rows[0]) : null;
  }

  /** Locks the row for the duration of the caller's transaction -- required
   * before allocating a sequence number or deciding a request, so two
   * concurrent operations on the same conversation serialize correctly (LLD
   * §32/§45). */
  async findByIdForUpdate(
    id: string,
    executor: Queryable,
  ): Promise<ConversationRow | null> {
    const { rows } = await executor.query(
      `SELECT ${COLUMNS} FROM messaging.conversations WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return rows.length ? mapRow(rows[0]) : null;
  }

  /** Race-safe creation: relies entirely on uq_conversations_active_pair (a
   * partial unique index) to reject a concurrent duplicate — the caller must
   * catch a unique-violation and treat it as "someone else just created the
   * same conversation, go read it" rather than a real error (LLD §32). */
  async create(
    input: { personA: string; personB: string; createdBy: string },
    executor: Queryable,
  ): Promise<ConversationRow> {
    const [a, b] = [input.personA, input.personB].sort();
    const { rows } = await executor.query(
      `INSERT INTO messaging.conversations (person_a_id, person_b_id, created_by)
       VALUES ($1, $2, $3)
       RETURNING ${COLUMNS}`,
      [a, b, input.createdBy],
    );
    return mapRow(rows[0]);
  }

  /** Atomically allocates the next monotonic sequence number for this
   * conversation — the UPDATE's own row lock is what serializes concurrent
   * senders into a correct, gapless sequence (LLD §10), no separate explicit
   * lock statement needed. */
  async allocateNextSequence(
    conversationId: string,
    executor: Queryable,
  ): Promise<number> {
    const { rows } = await executor.query(
      `UPDATE messaging.conversations
       SET last_sequence_no = last_sequence_no + 1, updated_at = now()
       WHERE id = $1
       RETURNING last_sequence_no`,
      [conversationId],
    );
    return Number(rows[0].last_sequence_no);
  }

  async updateLastMessage(
    conversationId: string,
    messageId: string,
    sentAt: string,
    executor: Queryable,
  ): Promise<void> {
    await executor.query(
      `UPDATE messaging.conversations
       SET last_message_id = $2, last_message_at = $3, updated_at = now()
       WHERE id = $1`,
      [conversationId, messageId, sentAt],
    );
  }

  /** Cursor-paginated by (updated_at, id) -- most-recently-active first,
   * matching a normal chat app's conversation list (LLD §44/§54: cursor-based,
   * never offset, for a high-churn list). */
  async listForPerson(
    personId: string,
    params: { cursor?: { updatedAt: string; id: string }; limit: number },
    executor: Queryable = this.postgres,
  ): Promise<ConversationRow[]> {
    const conditions = [`(cm.person_id = $1) `, `c.status <> 'CLOSED'`];
    const values: unknown[] = [personId];
    if (params.cursor) {
      values.push(params.cursor.updatedAt, params.cursor.id);
      conditions.push(
        `(c.updated_at, c.id) < ($${values.length - 1}, $${values.length})`,
      );
    }
    values.push(params.limit);
    const { rows } = await executor.query(
      `SELECT ${QUALIFIED_COLUMNS}, cm.mls_welcome, cm.mls_welcome_delivered_at
       FROM messaging.conversations c
       JOIN messaging.conversation_members cm ON cm.conversation_id = c.id AND cm.membership_status = 'ACTIVE'
       WHERE ${conditions.join(' AND ')}
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT $${values.length}`,
      values,
    );
    return rows.map(mapRowWithMlsWelcome);
  }

  /** Batched "does a non-CLOSED conversation already exist with each of these
   * candidates" -- feeds Directory's own existingConversationState field
   * (LLD §18/§73) without N separate queries per discovery page. */
  async findActiveStatusForCandidates(
    personId: string,
    candidateIds: string[],
    executor: Queryable = this.postgres,
  ): Promise<Map<string, ConversationRow['status']>> {
    const result = new Map<string, ConversationRow['status']>();
    if (candidateIds.length === 0) return result;
    const { rows } = await executor.query(
      `SELECT person_a_id, person_b_id, status FROM messaging.conversations
       WHERE status <> 'CLOSED'
         AND ((person_a_id = $1 AND person_b_id = ANY($2::uuid[]))
           OR (person_b_id = $1 AND person_a_id = ANY($2::uuid[])))`,
      [personId, candidateIds],
    );
    for (const row of rows) {
      const otherId =
        row.person_a_id === personId ? row.person_b_id : row.person_a_id;
      result.set(otherId, row.status);
    }
    return result;
  }
}
