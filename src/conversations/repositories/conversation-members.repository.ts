import { Injectable } from '@nestjs/common';
import {
  PostgresService,
  Queryable,
} from '../../common/postgres/postgres.service';

export interface MembershipRow {
  conversationId: string;
  personId: string;
  membershipStatus: 'ACTIVE' | 'LEFT';
  lastReadMessageId: string | null;
  mlsWelcome: Buffer | null;
  mlsWelcomeDeliveredAt: string | null;
}

const COLUMNS = `conversation_id, person_id, membership_status, last_read_message_id,
  mls_welcome, mls_welcome_delivered_at`;

function mapRow(row: any): MembershipRow {
  return {
    conversationId: row.conversation_id,
    personId: row.person_id,
    membershipStatus: row.membership_status,
    lastReadMessageId:
      row.last_read_message_id === null
        ? null
        : String(row.last_read_message_id),
    mlsWelcome: row.mls_welcome ?? null,
    mlsWelcomeDeliveredAt: row.mls_welcome_delivered_at ?? null,
  };
}

@Injectable()
export class ConversationMembersRepository {
  constructor(private readonly postgres: PostgresService) {}

  /** Always exactly 2 rows for a DIRECT conversation (LLD §6/§60 -- no group
   * chat) -- created once, at conversation-creation time, in the same
   * transaction. */
  async createMembers(
    conversationId: string,
    personIds: string[],
    executor: Queryable,
  ): Promise<void> {
    for (const personId of personIds) {
      await executor.query(
        `INSERT INTO messaging.conversation_members (conversation_id, person_id) VALUES ($1, $2)`,
        [conversationId, personId],
      );
    }
  }

  async findMembership(
    conversationId: string,
    personId: string,
    executor: Queryable = this.postgres,
  ): Promise<MembershipRow | null> {
    const { rows } = await executor.query(
      `SELECT ${COLUMNS}
       FROM messaging.conversation_members
       WHERE conversation_id = $1 AND person_id = $2`,
      [conversationId, personId],
    );
    return rows.length ? mapRow(rows[0]) : null;
  }

  /** The OTHER member of a DIRECT conversation -- used to resolve "who am I
   * sending this to" server-side from the conversation row itself, never
   * from anything the client claims. */
  async findOtherMember(
    conversationId: string,
    excludingPersonId: string,
    executor: Queryable = this.postgres,
  ): Promise<MembershipRow | null> {
    const { rows } = await executor.query(
      `SELECT ${COLUMNS}
       FROM messaging.conversation_members
       WHERE conversation_id = $1 AND person_id <> $2`,
      [conversationId, excludingPersonId],
    );
    return rows.length ? mapRow(rows[0]) : null;
  }

  /** Stores the MLS Welcome on the JOINING member's own row only (never the
   * creator's -- a creator never needs a Welcome for a group they created).
   * Deliberately NOT cleared by anything except ackMlsWelcome below -- a
   * fetch is not consumption; see the Welcome-delivery contract in
   * database/migrations/0002_mls.sql. */
  async setMlsWelcome(
    conversationId: string,
    personId: string,
    welcome: Buffer,
    executor: Queryable,
  ): Promise<void> {
    await executor.query(
      `UPDATE messaging.conversation_members
       SET mls_welcome = $3
       WHERE conversation_id = $1 AND person_id = $2`,
      [conversationId, personId, welcome],
    );
  }

  /** Marks a Welcome delivered -- called by the client ONLY after joinGroup()
   * succeeded AND the resulting state was durably persisted locally, never
   * merely after a fetch (LLD-adjacent Welcome-delivery contract: retry-safe,
   * not a destructive one-shot). Idempotent: a second ack is a harmless
   * no-op. */
  async ackMlsWelcome(
    conversationId: string,
    personId: string,
    executor: Queryable = this.postgres,
  ): Promise<void> {
    await executor.query(
      `UPDATE messaging.conversation_members
       SET mls_welcome_delivered_at = now()
       WHERE conversation_id = $1 AND person_id = $2 AND mls_welcome_delivered_at IS NULL`,
      [conversationId, personId],
    );
  }

  async updateLastRead(
    conversationId: string,
    personId: string,
    messageId: string,
    executor: Queryable,
  ): Promise<void> {
    await executor.query(
      `UPDATE messaging.conversation_members
       SET last_read_message_id = $3
       WHERE conversation_id = $1 AND person_id = $2`,
      [conversationId, personId, messageId],
    );
  }
}
