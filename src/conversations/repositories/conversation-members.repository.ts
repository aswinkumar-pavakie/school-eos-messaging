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
}

function mapRow(row: any): MembershipRow {
  return {
    conversationId: row.conversation_id,
    personId: row.person_id,
    membershipStatus: row.membership_status,
    lastReadMessageId:
      row.last_read_message_id === null
        ? null
        : String(row.last_read_message_id),
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
      `SELECT conversation_id, person_id, membership_status, last_read_message_id
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
      `SELECT conversation_id, person_id, membership_status, last_read_message_id
       FROM messaging.conversation_members
       WHERE conversation_id = $1 AND person_id <> $2`,
      [conversationId, excludingPersonId],
    );
    return rows.length ? mapRow(rows[0]) : null;
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
