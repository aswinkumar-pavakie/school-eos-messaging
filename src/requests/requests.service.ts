// Request lifecycle: create/accept/decline/cancel (LLD §16/§30-32). Creation
// mirrors ConversationsService.createDirect's own race-safety (LLD §32) but
// is the REQUEST path -- LLD §72's API surface has this as its own
// POST /requests endpoint, separate from POST /conversations. If the target
// actually resolves to ALLOW_DIRECT right now (relationship changed, or the
// client used stale discovery data), this creates a plain ACTIVE/DIRECT
// conversation instead of forcing an unnecessary PENDING/request ceremony on
// someone who's already entitled to direct access -- ending up MORE open
// than what was asked is not a security concern the way ending up less-open
// would be.

import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthorizationService } from '../authorization/authorization.service';
import {
  canCancelRequest,
  canDecideRequest,
} from '../authorization/authorization.types';
import { MESSAGING_ERRORS } from '../common/errors/error-codes';
import { UnitOfWork } from '../common/transactions/unit-of-work';
import { ConversationMembersRepository } from '../conversations/repositories/conversation-members.repository';
import {
  ConversationsRepository,
  ConversationRow,
} from '../conversations/repositories/conversations.repository';
import { insertFirstMessage } from '../conversations/conversations.service';
import { MessageDeliveryRepository } from '../delivery/repositories/message-delivery.repository';
import { MessagesRepository } from '../messages/repositories/messages.repository';
import { OutboxEventsRepository } from '../outbox/repositories/outbox-events.repository';
import {
  ConversationRequestRow,
  ConversationRequestsRepository,
  RequestStatus,
} from './repositories/conversation-requests.repository';

export interface CreateRequestInput {
  actorPersonId: string;
  actorRoles: string[];
  targetPersonId: string;
  /** Base64-decoded MLS Welcome for the recipient -- see
   * ConversationsService's own CreateDirectConversationInput.mlsWelcome. */
  mlsWelcome?: Buffer;
  initialMessage: {
    clientMessageId: string;
    ciphertext: Buffer;
    encryptionVersion: string;
    encryptionHeader: Record<string, unknown>;
  };
}

export interface CreateRequestResult {
  conversationId: string;
  state: 'ACTIVE' | 'PENDING';
  messagingMode: 'DIRECT' | 'REQUEST';
  // See CreateConversationResult's own comment in conversations.service.ts --
  // identical reasoning, same describeExisting short-circuit here.
  isNew: boolean;
}

@Injectable()
export class RequestsService {
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

  async createRequest(input: CreateRequestInput): Promise<CreateRequestResult> {
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

    try {
      if (decision === 'ALLOW_DIRECT') {
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
          if (input.mlsWelcome) {
            await this.membersRepo.setMlsWelcome(
              created.id,
              input.targetPersonId,
              input.mlsWelcome,
              client,
            );
          }
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
          return created;
        });
        return {
          conversationId: conversation.id,
          state: 'ACTIVE',
          messagingMode: 'DIRECT',
          isNew: true,
        };
      }

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
        if (input.mlsWelcome) {
          await this.membersRepo.setMlsWelcome(
            created.id,
            input.targetPersonId,
            input.mlsWelcome,
            client,
          );
        }
        const request = await this.requestsRepo.create(
          {
            conversationId: created.id,
            requesterPersonId: input.actorPersonId,
            recipientPersonId: input.targetPersonId,
          },
          client,
        );
        const messageId = await insertFirstMessage(
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
        await this.requestsRepo.setInitialMessage(
          request.id,
          messageId,
          client,
        );
        await this.outboxRepo.enqueue(
          {
            aggregateType: 'conversation_request',
            aggregateId: request.id,
            eventType: 'request.created',
            payload: {
              conversationId: created.id,
              requestId: request.id,
              recipientPersonId: input.targetPersonId,
              requesterPersonId: input.actorPersonId,
            },
          },
          client,
        );
        return created;
      });
      return {
        conversationId: conversation.id,
        state: 'PENDING',
        messagingMode: 'REQUEST',
        isNew: true,
      };
    } catch (err) {
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

  async accept(
    requestId: string,
    actorPersonId: string,
  ): Promise<ConversationRequestRow> {
    return this.unitOfWork.run(async (client) => {
      const request = await this.requestsRepo.findByIdForUpdate(
        requestId,
        client,
      );
      if (!request)
        throw new NotFoundException({
          code: MESSAGING_ERRORS.CONVERSATION_NOT_FOUND,
        });
      if (!canDecideRequest(actorPersonId, request)) {
        throw new NotFoundException({
          code: MESSAGING_ERRORS.CONVERSATION_NOT_FOUND,
        });
      }
      await this.requestsRepo.accept(requestId, client);
      await this.outboxRepo.enqueue(
        {
          aggregateType: 'conversation_request',
          aggregateId: requestId,
          eventType: 'request.accepted',
          payload: {
            conversationId: request.conversationId,
            requestId,
            requesterPersonId: request.requesterPersonId,
          },
        },
        client,
      );
      return {
        ...request,
        status: 'ACCEPTED',
        respondedAt: new Date().toISOString(),
      };
    });
  }

  async decline(
    requestId: string,
    actorPersonId: string,
  ): Promise<ConversationRequestRow> {
    return this.unitOfWork.run(async (client) => {
      const request = await this.requestsRepo.findByIdForUpdate(
        requestId,
        client,
      );
      if (!request)
        throw new NotFoundException({
          code: MESSAGING_ERRORS.CONVERSATION_NOT_FOUND,
        });
      if (!canDecideRequest(actorPersonId, request)) {
        throw new NotFoundException({
          code: MESSAGING_ERRORS.CONVERSATION_NOT_FOUND,
        });
      }
      await this.requestsRepo.decline(requestId, client);
      await this.outboxRepo.enqueue(
        {
          aggregateType: 'conversation_request',
          aggregateId: requestId,
          eventType: 'request.declined',
          payload: {
            conversationId: request.conversationId,
            requestId,
            requesterPersonId: request.requesterPersonId,
          },
        },
        client,
      );
      return {
        ...request,
        status: 'DECLINED',
        respondedAt: new Date().toISOString(),
      };
    });
  }

  async cancel(
    requestId: string,
    actorPersonId: string,
  ): Promise<ConversationRequestRow> {
    return this.unitOfWork.run(async (client) => {
      const request = await this.requestsRepo.findByIdForUpdate(
        requestId,
        client,
      );
      if (!request)
        throw new NotFoundException({
          code: MESSAGING_ERRORS.CONVERSATION_NOT_FOUND,
        });
      if (!canCancelRequest(actorPersonId, request)) {
        if (request.requesterPersonId !== actorPersonId) {
          throw new NotFoundException({
            code: MESSAGING_ERRORS.CONVERSATION_NOT_FOUND,
          });
        }
        throw new ForbiddenException({
          code: MESSAGING_ERRORS.REQUEST_NOT_ALLOWED,
        });
      }
      await this.requestsRepo.cancel(requestId, client);
      return {
        ...request,
        status: 'CANCELLED',
        respondedAt: new Date().toISOString(),
      };
    });
  }

  async listForRecipient(
    personId: string,
    status: RequestStatus,
  ): Promise<ConversationRequestRow[]> {
    return this.requestsRepo.listForRecipient(personId, status);
  }

  async listForRequester(
    personId: string,
    status: RequestStatus,
  ): Promise<ConversationRequestRow[]> {
    return this.requestsRepo.listForRequester(personId, status);
  }

  private async describeExisting(
    conversation: ConversationRow,
  ): Promise<CreateRequestResult> {
    const pending = await this.requestsRepo.findPendingForConversation(
      conversation.id,
    );
    return {
      conversationId: conversation.id,
      state: pending ? 'PENDING' : 'ACTIVE',
      messagingMode: pending ? 'REQUEST' : 'DIRECT',
      isNew: false,
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
