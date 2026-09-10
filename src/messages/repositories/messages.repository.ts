// messaging.messages -- no plaintext column exists (LLD §9/§19/§21). This
// repository only ever moves ciphertext/encryption_header bytes around; it
// never inspects, transforms, or logs their content.

import { Injectable } from '@nestjs/common';
import {
  PostgresService,
  Queryable,
} from '../../common/postgres/postgres.service';

export interface MessageRow {
  id: string;
  conversationId: string;
  senderPersonId: string;
  clientMessageId: string;
  sequenceNo: number;
  ciphertext: Buffer;
  encryptionVersion: string;
  encryptionHeader: Record<string, unknown>;
  createdAt: string;
  serverReceivedAt: string;
  deletedAt: string | null;
}

function mapRow(row: any): MessageRow {
  return {
    id: String(row.id),
    conversationId: row.conversation_id,
    senderPersonId: row.sender_person_id,
    clientMessageId: row.client_message_id,
    sequenceNo: Number(row.sequence_no),
    ciphertext: row.ciphertext,
    encryptionVersion: row.encryption_version,
    encryptionHeader: row.encryption_header,
    createdAt: row.created_at,
    serverReceivedAt: row.server_received_at,
    deletedAt: row.deleted_at,
  };
}

const COLUMNS = `id, conversation_id, sender_person_id, client_message_id, sequence_no,
  ciphertext, encryption_version, encryption_header, created_at, server_received_at, deleted_at`;

@Injectable()
export class MessagesRepository {
  constructor(private readonly postgres: PostgresService) {}

  /** The real, DB-level idempotency check (LLD §26/§34) -- if a message with
   * this exact (sender, conversation, clientMessageId) already exists, this
   * is a retried/duplicate submission, not a new message. Checked BEFORE
   * insert as a fast path; uq_messages_idempotency is still the final,
   * authoritative guarantee against a genuine race (two identical submissions
   * arriving concurrently) — insert() below must have its unique-violation
   * caught by the caller and turned into "return the existing message", never
   * a raw 500. */
  async findByIdempotencyKey(
    senderPersonId: string,
    conversationId: string,
    clientMessageId: string,
    executor: Queryable = this.postgres,
  ): Promise<MessageRow | null> {
    const { rows } = await executor.query(
      `SELECT ${COLUMNS} FROM messaging.messages
       WHERE sender_person_id = $1 AND conversation_id = $2 AND client_message_id = $3`,
      [senderPersonId, conversationId, clientMessageId],
    );
    return rows.length ? mapRow(rows[0]) : null;
  }

  async insert(
    input: {
      conversationId: string;
      senderPersonId: string;
      clientMessageId: string;
      sequenceNo: number;
      ciphertext: Buffer;
      encryptionVersion: string;
      encryptionHeader: Record<string, unknown>;
    },
    executor: Queryable,
  ): Promise<MessageRow> {
    const { rows } = await executor.query(
      `INSERT INTO messaging.messages
         (conversation_id, sender_person_id, client_message_id, sequence_no, ciphertext, encryption_version, encryption_header)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${COLUMNS}`,
      [
        input.conversationId,
        input.senderPersonId,
        input.clientMessageId,
        input.sequenceNo,
        input.ciphertext,
        input.encryptionVersion,
        JSON.stringify(input.encryptionHeader),
      ],
    );
    return mapRow(rows[0]);
  }

  async findById(
    id: string,
    executor: Queryable = this.postgres,
  ): Promise<MessageRow | null> {
    const { rows } = await executor.query(
      `SELECT ${COLUMNS} FROM messaging.messages WHERE id = $1`,
      [id],
    );
    return rows.length ? mapRow(rows[0]) : null;
  }

  /** Sequence/cursor-based sync (LLD §44) -- everything strictly after the
   * client's own last-known sequence, oldest first, bounded. Never an
   * unbounded SELECT (LLD §44/§54). */
  async findAfterSequence(
    conversationId: string,
    afterSequence: number,
    limit: number,
    executor: Queryable = this.postgres,
  ): Promise<MessageRow[]> {
    const { rows } = await executor.query(
      `SELECT ${COLUMNS} FROM messaging.messages
       WHERE conversation_id = $1 AND sequence_no > $2
       ORDER BY sequence_no ASC
       LIMIT $3`,
      [conversationId, afterSequence, limit],
    );
    return rows.map(mapRow);
  }

  /** History pagination, newest-page-first (cursor = oldest message id
   * already seen), reversed to chronological order for direct rendering --
   * mirrors the proven convention from Core's own messaging module (see its
   * README: "response messages are chronological... for direct rendering"). */
  async findPageBefore(
    conversationId: string,
    beforeSequence: number | null,
    limit: number,
    executor: Queryable = this.postgres,
  ): Promise<MessageRow[]> {
    const conditions = [`conversation_id = $1`];
    const values: unknown[] = [conversationId];
    if (beforeSequence !== null) {
      values.push(beforeSequence);
      conditions.push(`sequence_no < $${values.length}`);
    }
    values.push(limit);
    const { rows } = await executor.query(
      `SELECT ${COLUMNS} FROM messaging.messages
       WHERE ${conditions.join(' AND ')}
       ORDER BY sequence_no DESC
       LIMIT $${values.length}`,
      values,
    );
    return rows.map(mapRow).reverse();
  }
}
