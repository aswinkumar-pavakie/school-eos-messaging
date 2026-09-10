// The one real message-send pipeline (LLD §25/§33), called by BOTH the REST
// controller and the WebSocket gateway's message.send handler — one
// implementation, never two copies (architecture note LLD §56: Controller/
// Gateway -> Application Service -> Authorization -> Domain Logic ->
// Repository, shared beneath both transports).
//
// Ongoing-message authorization note (resolves LLD §20's own framing,
// documented rather than silently picked): once a conversation exists,
// sending a message re-checks CURRENT membership + conversation-ACTIVE
// status — not the original relationship that justified creating it. LLD
// §20 explicitly separates "current authorization" (governs NEW conversation
// creation / discovery) from "historical conversation access" ("the old
// conversation does not automatically become a current direct relationship...
// never confuse current authorization with historical conversation access").
// A conversation, once real, is not silently revoked because the underlying
// relationship later changes — it can only become BLOCKED/CLOSED through an
// explicit, separate action (not built in this pass).

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UnitOfWork } from '../common/transactions/unit-of-work';
import { MESSAGING_ERRORS } from '../common/errors/error-codes';
import { canSendMessage } from '../authorization/authorization.types';
import { ConversationMembersRepository } from '../conversations/repositories/conversation-members.repository';
import { ConversationsRepository } from '../conversations/repositories/conversations.repository';
import { ConversationRequestsRepository } from '../requests/repositories/conversation-requests.repository';
import { MessageDeliveryRepository } from '../delivery/repositories/message-delivery.repository';
import { OutboxEventsRepository } from '../outbox/repositories/outbox-events.repository';
import {
  MessageRow,
  MessagesRepository,
} from './repositories/messages.repository';

export interface SendMessageInput {
  conversationId: string;
  senderPersonId: string;
  clientMessageId: string;
  ciphertext: Buffer;
  encryptionVersion: string;
  encryptionHeader: Record<string, unknown>;
}

export interface SendMessageResult {
  clientMessageId: string;
  messageId: string;
  conversationId: string;
  sequence: number;
  status: 'ACCEPTED';
}

const MAX_CIPHERTEXT_BYTES = 64 * 1024; // 64 KiB -- generous for real text-message-scale E2EE payloads; attachments never go through this path (LLD §29/§50, separate object-storage flow).

@Injectable()
export class MessagesService {
  constructor(
    private readonly conversationsRepo: ConversationsRepository,
    private readonly membersRepo: ConversationMembersRepository,
    private readonly requestsRepo: ConversationRequestsRepository,
    private readonly messagesRepo: MessagesRepository,
    private readonly deliveryRepo: MessageDeliveryRepository,
    private readonly outboxRepo: OutboxEventsRepository,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    if (input.ciphertext.length === 0) {
      throw new BadRequestException({
        code: MESSAGING_ERRORS.INVALID_PROTOCOL,
        message: 'ciphertext must not be empty',
      });
    }
    if (input.ciphertext.length > MAX_CIPHERTEXT_BYTES) {
      throw new BadRequestException({
        code: MESSAGING_ERRORS.MESSAGE_TOO_LARGE,
      });
    }

    // Idempotency fast-path (LLD §26/§34) -- checked outside the transaction
    // first (cheap, avoids opening a transaction for the common retry case),
    // then re-checked by the real unique constraint inside it for the
    // genuine-race case.
    const existing = await this.messagesRepo.findByIdempotencyKey(
      input.senderPersonId,
      input.conversationId,
      input.clientMessageId,
    );
    if (existing) {
      return this.toResult(existing);
    }

    const conversation = await this.conversationsRepo.findById(
      input.conversationId,
    );
    if (!conversation) {
      throw new NotFoundException({
        code: MESSAGING_ERRORS.CONVERSATION_NOT_FOUND,
      });
    }

    const membership = await this.membersRepo.findMembership(
      input.conversationId,
      input.senderPersonId,
    );
    const pendingRequest = await this.requestsRepo.findPendingForConversation(
      input.conversationId,
    );

    const decision = canSendMessage(input.senderPersonId, {
      isMember: membership !== null,
      membershipStatus: membership?.membershipStatus ?? null,
      conversationStatus: conversation.status,
      pendingRequest: pendingRequest
        ? {
            requesterPersonId: pendingRequest.requesterPersonId,
            hasInitialMessage: pendingRequest.initialMessageId !== null,
          }
        : null,
    });
    if (!decision.allowed) {
      if (decision.reason === 'CONVERSATION_NOT_ACTIVE') {
        throw new ForbiddenException({
          code: MESSAGING_ERRORS.CONVERSATION_NOT_ACTIVE,
        });
      }
      throw new ForbiddenException({ code: MESSAGING_ERRORS.REQUEST_PENDING });
    }

    const recipient = await this.membersRepo.findOtherMember(
      input.conversationId,
      input.senderPersonId,
    );
    if (!recipient) {
      // Structurally shouldn't happen (every DIRECT conversation has exactly
      // 2 members) -- fail closed rather than send to nobody.
      throw new NotFoundException({
        code: MESSAGING_ERRORS.RECIPIENT_NOT_FOUND,
      });
    }

    try {
      const message = await this.unitOfWork.run(async (client) => {
        const sequence = await this.conversationsRepo.allocateNextSequence(
          input.conversationId,
          client,
        );
        const inserted = await this.messagesRepo.insert(
          {
            conversationId: input.conversationId,
            senderPersonId: input.senderPersonId,
            clientMessageId: input.clientMessageId,
            sequenceNo: sequence,
            ciphertext: input.ciphertext,
            encryptionVersion: input.encryptionVersion,
            encryptionHeader: input.encryptionHeader,
          },
          client,
        );
        await this.deliveryRepo.create(inserted.id, recipient.personId, client);
        await this.conversationsRepo.updateLastMessage(
          input.conversationId,
          inserted.id,
          inserted.createdAt,
          client,
        );
        if (pendingRequest && !pendingRequest.initialMessageId) {
          await this.requestsRepo.setInitialMessage(
            pendingRequest.id,
            inserted.id,
            client,
          );
        }
        await this.outboxRepo.enqueue(
          {
            aggregateType: 'message',
            aggregateId: inserted.id,
            eventType: 'message.created',
            payload: {
              conversationId: input.conversationId,
              messageId: inserted.id,
              sequenceNo: inserted.sequenceNo,
              senderPersonId: input.senderPersonId,
              recipientPersonId: recipient.personId,
            },
          },
          client,
        );
        return inserted;
      });
      return this.toResult(message);
    } catch (err) {
      // A genuine race on the idempotency unique constraint (two identical
      // submissions committing concurrently) -- the loser here just returns
      // the winner's row, never a raw 500 (LLD §26: "must never create a
      // duplicate message").
      if (this.isUniqueViolation(err)) {
        const winner = await this.messagesRepo.findByIdempotencyKey(
          input.senderPersonId,
          input.conversationId,
          input.clientMessageId,
        );
        if (winner) return this.toResult(winner);
      }
      throw err;
    }
  }

  /** LLD §44: everything strictly after the client's own last-known
   * sequence, for reconnect/offline sync. Membership is re-verified here too
   * — sync is still a conversation-scoped read, not exempt from the same
   * access check every other operation gets. */
  async sync(
    conversationId: string,
    personId: string,
    afterSequence: number,
    limit: number,
  ): Promise<MessageRow[]> {
    await this.assertCanAccess(conversationId, personId);
    return this.messagesRepo.findAfterSequence(
      conversationId,
      afterSequence,
      limit,
    );
  }

  async history(
    conversationId: string,
    personId: string,
    before: number | null,
    limit: number,
  ): Promise<MessageRow[]> {
    await this.assertCanAccess(conversationId, personId);
    return this.messagesRepo.findPageBefore(conversationId, before, limit);
  }

  private async assertCanAccess(
    conversationId: string,
    personId: string,
  ): Promise<void> {
    const conversation = await this.conversationsRepo.findById(conversationId);
    if (!conversation)
      throw new NotFoundException({
        code: MESSAGING_ERRORS.CONVERSATION_NOT_FOUND,
      });
    const membership = await this.membersRepo.findMembership(
      conversationId,
      personId,
    );
    if (
      !membership ||
      membership.membershipStatus !== 'ACTIVE' ||
      conversation.status !== 'ACTIVE'
    ) {
      // Same 404-not-403 convention as Core's own messaging module: whether
      // it doesn't exist, belongs to someone else, or access has lapsed is
      // never distinguishable to the caller.
      throw new NotFoundException({
        code: MESSAGING_ERRORS.CONVERSATION_NOT_FOUND,
      });
    }
  }

  private toResult(message: MessageRow): SendMessageResult {
    return {
      clientMessageId: message.clientMessageId,
      messageId: message.id,
      conversationId: message.conversationId,
      sequence: message.sequenceNo,
      status: 'ACCEPTED',
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === '23505'
    );
  }
}
