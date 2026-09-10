// Conversation creation/lifecycle for the DIRECT path only (LLD §28-29,32).
// The REQUEST path (LLD §16/§30) lives in RequestsService.createRequest() --
// LLD §72's API surface itself has separate POST /conversations vs
// POST /requests endpoints, and this split mirrors that: the client already
// knows which one to call from discovery's own messagingMode field, but the
// SERVER re-verifies independently either way (LLD §7 -- never trust a
// client-supplied mode). If a client hits POST /conversations for a target
// that actually resolves to REQUIRE_REQUEST right now, this throws
// REQUEST_REQUIRED rather than silently creating a request with no message
// (a request is inseparable from its one initial message, which this
// endpoint's own DTO doesn't even carry).
//
// Selecting a user never auto-creates a conversation on its own (LLD §28) --
// this service is only ever invoked from an explicit "start a conversation"
// action, and even then opens an existing one first rather than creating a
// duplicate.

import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthorizationService } from '../authorization/authorization.service';
import { canAccessConversation } from '../authorization/authorization.types';
import { MESSAGING_ERRORS } from '../common/errors/error-codes';
import { Queryable } from '../common/postgres/postgres.service';
import { UnitOfWork } from '../common/transactions/unit-of-work';
import { OutboxEventsRepository } from '../outbox/repositories/outbox-events.repository';
import { MessagesRepository } from '../messages/repositories/messages.repository';
import { MessageDeliveryRepository } from '../delivery/repositories/message-delivery.repository';
import { ConversationRequestsRepository } from '../requests/repositories/conversation-requests.repository';
import { ConversationMembersRepository } from './repositories/conversation-members.repository';
import {
  ConversationsRepository,
  ConversationRow,
} from './repositories/conversations.repository';

export interface CreateDirectConversationInput {
  actorPersonId: string;
  actorRoles: string[];
  targetPersonId: string;
  initialMessage?: {
    clientMessageId: string;
    ciphertext: Buffer;
    encryptionVersion: string;
    encryptionHeader: Record<string, unknown>;
  };
}

export interface CreateConversationResult {
  conversationId: string;
  state: 'ACTIVE' | 'PENDING';
  messagingMode: 'DIRECT' | 'REQUEST';
}

@Injectable()
export class ConversationsService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly conversationsRepo: ConversationsRepository,
    private readonly membersRepo: ConversationMembersRepository,
    private readonly requestsRepo: ConversationRequestsRepository,
    private readonly messagesRepo: MessagesRepository,
    private readonly deliveryRepo: MessageDeliveryRepository,
    private readonly outboxRepo: OutboxEventsRepository,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async createDirect(
    input: CreateDirectConversationInput,
  ): Promise<CreateConversationResult> {
    if (input.actorPersonId === input.targetPersonId) {
      throw new ForbiddenException({ code: MESSAGING_ERRORS.ACCESS_DENIED });
    }

    const existing = await this.conversationsRepo.findActiveBetween(
      input.actorPersonId,
      input.targetPersonId,
    );
    if (existing) {
      return this.describeExisting(existing);
    }

    const decision = await this.authorization.authorizeMessaging(
      { personId: input.actorPersonId, roles: input.actorRoles },
      input.targetPersonId,
    );
    if (decision === 'DENY') {
      throw new ForbiddenException({ code: MESSAGING_ERRORS.ACCESS_DENIED });
    }
    if (decision === 'REQUIRE_REQUEST') {
      throw new ForbiddenException({ code: MESSAGING_ERRORS.REQUEST_REQUIRED });
    }

    try {
      const conversation = await this.unitOfWork.run(async (client) => {
        const created = await this.conversationsRepo.create(
          {
            personA: input.actorPersonId,
            personB: input.targetPersonId,
            createdBy: input.actorPersonId,
          },
          client,
        );
        await this.membersRepo.createMembers(
          created.id,
          [input.actorPersonId, input.targetPersonId],
          client,
        );
        if (input.initialMessage) {
          await insertFirstMessage(
            {
              conversationsRepo: this.conversationsRepo,
              messagesRepo: this.messagesRepo,
              deliveryRepo: this.deliveryRepo,
              outboxRepo: this.outboxRepo,
            },
            created.id,
            input.actorPersonId,
            input.targetPersonId,
            input.initialMessage,
            client,
          );
        }
        return created;
      });
      return {
        conversationId: conversation.id,
        state: 'ACTIVE',
        messagingMode: 'DIRECT',
      };
    } catch (err) {
      // LLD §32: a concurrent create for the same pair races on
      // uq_conversations_active_pair -- the loser re-reads and opens what the
      // winner created, never a raw 500 or a duplicate conversation.
      if (isUniqueViolation(err)) {
        const winner = await this.conversationsRepo.findActiveBetween(
          input.actorPersonId,
          input.targetPersonId,
        );
        if (winner) return this.describeExisting(winner);
      }
      throw err;
    }
  }

  async getById(
    conversationId: string,
    personId: string,
  ): Promise<ConversationRow & { ownLastReadSequence: number }> {
    const conversation = await this.conversationsRepo.findById(conversationId);
    const membership = conversation
      ? await this.membersRepo.findMembership(conversationId, personId)
      : null;
    if (
      !conversation ||
      !canAccessConversation({
        isMember: membership !== null,
        membershipStatus: membership?.membershipStatus ?? null,
        conversationStatus: conversation.status,
      })
    ) {
      // Same 404-not-403 convention throughout this service (LLD §53:
      // "responses must avoid revealing sensitive distinctions where
      // practical").
      throw new NotFoundException({
        code: MESSAGING_ERRORS.CONVERSATION_NOT_FOUND,
      });
    }
    return { ...conversation, ownLastReadSequence: 0 };
  }

  async list(
    personId: string,
    cursor: { updatedAt: string; id: string } | undefined,
    limit: number,
  ): Promise<ConversationRow[]> {
    return this.conversationsRepo.listForPerson(personId, { cursor, limit });
  }

  /** Re-opening an existing conversation still needs to report its REAL
   * current state -- PENDING if a request is still awaiting acceptance,
   * ACTIVE otherwise (conversations.status itself has no PENDING value; see
   * the migration comment on conversation_requests). */
  private async describeExisting(
    conversation: ConversationRow,
  ): Promise<CreateConversationResult> {
    const pending = await this.requestsRepo.findPendingForConversation(
      conversation.id,
    );
    return {
      conversationId: conversation.id,
      state: pending ? 'PENDING' : 'ACTIVE',
      messagingMode: pending ? 'REQUEST' : 'DIRECT',
    };
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '23505'
  );
}

/** Shared by ConversationsService.createDirect (optional initial message) and
 * RequestsService.createRequest (mandatory one) -- one real implementation of
 * "write the first message of a brand-new conversation," not two copies. */
export async function insertFirstMessage(
  repos: {
    conversationsRepo: ConversationsRepository;
    messagesRepo: MessagesRepository;
    deliveryRepo: MessageDeliveryRepository;
    outboxRepo: OutboxEventsRepository;
  },
  conversationId: string,
  senderPersonId: string,
  recipientPersonId: string,
  initialMessage: {
    clientMessageId: string;
    ciphertext: Buffer;
    encryptionVersion: string;
    encryptionHeader: Record<string, unknown>;
  },
  client: Queryable,
): Promise<string> {
  const sequence = await repos.conversationsRepo.allocateNextSequence(
    conversationId,
    client,
  );
  const message = await repos.messagesRepo.insert(
    {
      conversationId,
      senderPersonId,
      clientMessageId: initialMessage.clientMessageId,
      sequenceNo: sequence,
      ciphertext: initialMessage.ciphertext,
      encryptionVersion: initialMessage.encryptionVersion,
      encryptionHeader: initialMessage.encryptionHeader,
    },
    client,
  );
  await repos.deliveryRepo.create(message.id, recipientPersonId, client);
  await repos.conversationsRepo.updateLastMessage(
    conversationId,
    message.id,
    message.createdAt,
    client,
  );
  await repos.outboxRepo.enqueue(
    {
      aggregateType: 'message',
      aggregateId: message.id,
      eventType: 'message.created',
      payload: {
        conversationId,
        messageId: message.id,
        sequenceNo: message.sequenceNo,
        senderPersonId,
        recipientPersonId,
      },
    },
    client,
  );
  return message.id;
}
