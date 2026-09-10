// MessagesService.send is the single riskiest piece of business logic in
// this service (idempotency, the one-message-while-pending rule, and a real
// unique-constraint race all converge here) -- covered with mocked
// repositories so this logic is verified without needing a live database.

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { ConversationsRepository } from '../conversations/repositories/conversations.repository';
import { ConversationMembersRepository } from '../conversations/repositories/conversation-members.repository';
import { ConversationRequestsRepository } from '../requests/repositories/conversation-requests.repository';
import { MessageDeliveryRepository } from '../delivery/repositories/message-delivery.repository';
import { OutboxEventsRepository } from '../outbox/repositories/outbox-events.repository';
import { MessagesRepository } from './repositories/messages.repository';
import { UnitOfWork } from '../common/transactions/unit-of-work';

const CONVERSATION_ID = 'conv-1';
const SENDER = 'sender-1';
const RECIPIENT = 'recipient-1';

function buildService(
  overrides: {
    existingMessage?: any;
    conversation?: any;
    membership?: any;
    pendingRequest?: any;
    insertThrows?: unknown;
  } = {},
) {
  const conversation =
    overrides.conversation === undefined
      ? { id: CONVERSATION_ID, status: 'ACTIVE' }
      : overrides.conversation;
  const membership =
    overrides.membership === undefined
      ? {
          conversationId: CONVERSATION_ID,
          personId: SENDER,
          membershipStatus: 'ACTIVE',
        }
      : overrides.membership;

  const conversationsRepo = {
    findById: jest.fn().mockResolvedValue(conversation),
    allocateNextSequence: jest.fn().mockResolvedValue(1),
    updateLastMessage: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConversationsRepository;

  const membersRepo = {
    findMembership: jest.fn().mockResolvedValue(membership),
    findOtherMember: jest.fn().mockResolvedValue({
      conversationId: CONVERSATION_ID,
      personId: RECIPIENT,
      membershipStatus: 'ACTIVE',
    }),
  } as unknown as ConversationMembersRepository;

  const requestsRepo = {
    findPendingForConversation: jest
      .fn()
      .mockResolvedValue(overrides.pendingRequest ?? null),
    setInitialMessage: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConversationRequestsRepository;

  let idempotencyCallCount = 0;
  const messagesRepo = {
    findByIdempotencyKey: jest.fn().mockImplementation(() => {
      idempotencyCallCount += 1;
      // First call: nothing exists yet. Second call (only reached after a
      // simulated unique-violation race): the "winner" row.
      if (idempotencyCallCount === 1)
        return Promise.resolve(overrides.existingMessage ?? null);
      return Promise.resolve({
        id: 'winner-message-id',
        conversationId: CONVERSATION_ID,
        senderPersonId: SENDER,
        clientMessageId: 'client-msg-1',
        sequenceNo: 1,
        ciphertext: Buffer.from('winner'),
        encryptionVersion: 'v1',
        encryptionHeader: {},
        createdAt: '2026-01-01T00:00:00.000Z',
        serverReceivedAt: '2026-01-01T00:00:00.000Z',
        deletedAt: null,
      });
    }),
    insert: overrides.insertThrows
      ? jest.fn().mockRejectedValue(overrides.insertThrows)
      : jest.fn().mockImplementation((input) =>
          Promise.resolve({
            id: 'new-message-id',
            conversationId: input.conversationId,
            senderPersonId: input.senderPersonId,
            clientMessageId: input.clientMessageId,
            sequenceNo: input.sequenceNo,
            ciphertext: input.ciphertext,
            encryptionVersion: input.encryptionVersion,
            encryptionHeader: input.encryptionHeader,
            createdAt: '2026-01-01T00:00:00.000Z',
            serverReceivedAt: '2026-01-01T00:00:00.000Z',
            deletedAt: null,
          }),
        ),
  } as unknown as MessagesRepository;

  const deliveryRepo = {
    create: jest.fn().mockResolvedValue(undefined),
  } as unknown as MessageDeliveryRepository;
  const outboxRepo = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  } as unknown as OutboxEventsRepository;
  const unitOfWork = {
    run: jest.fn((work: (client: unknown) => Promise<unknown>) => work({})),
  } as unknown as UnitOfWork;

  const service = new MessagesService(
    conversationsRepo,
    membersRepo,
    requestsRepo,
    messagesRepo,
    deliveryRepo,
    outboxRepo,
    unitOfWork,
  );
  return {
    service,
    conversationsRepo,
    membersRepo,
    requestsRepo,
    messagesRepo,
    deliveryRepo,
    outboxRepo,
  };
}

function baseInput(
  overrides: Partial<Parameters<MessagesService['send']>[0]> = {},
) {
  return {
    conversationId: CONVERSATION_ID,
    senderPersonId: SENDER,
    clientMessageId: 'client-msg-1',
    ciphertext: Buffer.from('hello'),
    encryptionVersion: 'v1',
    encryptionHeader: {},
    ...overrides,
  };
}

describe('MessagesService.send', () => {
  it('rejects empty ciphertext', async () => {
    const { service } = buildService();
    await expect(
      service.send(baseInput({ ciphertext: Buffer.alloc(0) })),
    ).rejects.toThrow();
  });

  it('rejects oversized ciphertext', async () => {
    const { service } = buildService();
    await expect(
      service.send(baseInput({ ciphertext: Buffer.alloc(100_000) })),
    ).rejects.toThrow();
  });

  it('idempotency fast-path: a retried clientMessageId returns the SAME existing message, never inserts a new one', async () => {
    const existing = {
      id: 'already-sent',
      conversationId: CONVERSATION_ID,
      senderPersonId: SENDER,
      clientMessageId: 'client-msg-1',
      sequenceNo: 3,
      ciphertext: Buffer.from('hello'),
      encryptionVersion: 'v1',
      encryptionHeader: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      serverReceivedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
    };
    const { service, messagesRepo } = buildService({
      existingMessage: existing,
    });
    const result = await service.send(baseInput());
    expect(result.messageId).toBe('already-sent');
    expect(result.sequence).toBe(3);
    expect(messagesRepo.insert).not.toHaveBeenCalled();
  });

  it('a non-member is denied (404, never distinguishable from "conversation does not exist")', async () => {
    const { service } = buildService({ membership: null });
    await expect(service.send(baseInput())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('conversation not found: 404', async () => {
    const { service } = buildService({ conversation: null });
    await expect(service.send(baseInput())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('a CLOSED conversation rejects sending, even for an active member', async () => {
    const { service } = buildService({
      conversation: { id: CONVERSATION_ID, status: 'CLOSED' },
    });
    await expect(service.send(baseInput())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('the requester CAN send the first message while their own request is pending', async () => {
    const { service, requestsRepo } = buildService({
      pendingRequest: {
        id: 'req-1',
        requesterPersonId: SENDER,
        initialMessageId: null,
      },
    });
    const result = await service.send(baseInput());
    expect(result.status).toBe('ACCEPTED');
    // The new message gets linked onto the request as its initial message.
    expect(requestsRepo.setInitialMessage).toHaveBeenCalledWith(
      'req-1',
      'new-message-id',
      {},
    );
  });

  it('the RECIPIENT cannot send anything before accepting a pending request', async () => {
    const { service } = buildService({
      pendingRequest: {
        id: 'req-1',
        requesterPersonId: RECIPIENT,
        initialMessageId: null,
      },
    });
    // Sender here (SENDER) is NOT the requester of this pending request.
    await expect(service.send(baseInput())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('the requester CANNOT send a second message once the initial one already exists', async () => {
    const { service } = buildService({
      pendingRequest: {
        id: 'req-1',
        requesterPersonId: SENDER,
        initialMessageId: 'already-sent-initial',
      },
    });
    await expect(service.send(baseInput())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('a genuine race on the idempotency unique constraint returns the WINNER, never a raw error or a duplicate', async () => {
    const uniqueViolation = {
      code: '23505',
      message: 'duplicate key value violates unique constraint',
    };
    const { service, messagesRepo } = buildService({
      insertThrows: uniqueViolation,
    });
    const result = await service.send(baseInput());
    expect(result.messageId).toBe('winner-message-id');
    expect(messagesRepo.findByIdempotencyKey).toHaveBeenCalledTimes(2);
  });

  it('a non-unique-violation database error propagates, never silently swallowed', async () => {
    const genuineError = new Error('connection terminated unexpectedly');
    const { service } = buildService({ insertThrows: genuineError });
    await expect(service.send(baseInput())).rejects.toThrow(
      'connection terminated unexpectedly',
    );
  });
});
