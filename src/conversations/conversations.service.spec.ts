// ConversationsService.createDirect is the DIRECT-path half of LLD §28-32 --
// covered with mocked repositories/authorization so its race-safety and
// REQUEST_REQUIRED redirection logic are verified without a live database.

import { ForbiddenException } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { UnitOfWork } from '../common/transactions/unit-of-work';
import { OutboxEventsRepository } from '../outbox/repositories/outbox-events.repository';
import { MessagesRepository } from '../messages/repositories/messages.repository';
import { MessageDeliveryRepository } from '../delivery/repositories/message-delivery.repository';
import { ConversationRequestsRepository } from '../requests/repositories/conversation-requests.repository';
import { ConversationMembersRepository } from './repositories/conversation-members.repository';
import { ConversationsRepository } from './repositories/conversations.repository';

const ACTOR = 'actor-1';
const TARGET = 'target-1';

function buildService(
  opts: {
    existing?: any;
    decision?: 'ALLOW_DIRECT' | 'REQUIRE_REQUEST' | 'DENY';
    pendingForExisting?: any;
    createThrows?: unknown;
  } = {},
) {
  const authorization = {
    authorizeMessaging: jest
      .fn()
      .mockResolvedValue(opts.decision ?? 'ALLOW_DIRECT'),
  } as unknown as AuthorizationService;

  const conversationsRepo = {
    findActiveBetween: jest.fn().mockResolvedValue(opts.existing ?? null),
    create: opts.createThrows
      ? jest.fn().mockRejectedValue(opts.createThrows)
      : jest.fn().mockResolvedValue({ id: 'new-conv-1', status: 'ACTIVE' }),
    allocateNextSequence: jest.fn().mockResolvedValue(1),
    updateLastMessage: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConversationsRepository;

  const membersRepo = {
    createMembers: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConversationMembersRepository;
  const requestsRepo = {
    findPendingForConversation: jest
      .fn()
      .mockResolvedValue(opts.pendingForExisting ?? null),
  } as unknown as ConversationRequestsRepository;
  const messagesRepo = {
    insert: jest.fn().mockResolvedValue({
      id: 'msg-1',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    findByIdempotencyKey: jest.fn().mockResolvedValue({ id: 'msg-1' }),
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

  const service = new ConversationsService(
    authorization,
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
    authorization,
    conversationsRepo,
    membersRepo,
    requestsRepo,
  };
}

describe('ConversationsService.createDirect', () => {
  it('cannot create a conversation with yourself', async () => {
    const { service } = buildService();
    await expect(
      service.createDirect({
        actorPersonId: ACTOR,
        actorRoles: ['PARENT'],
        targetPersonId: ACTOR,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reopens an existing ACTIVE conversation without creating a new one or re-checking authorization', async () => {
    const { service, authorization, conversationsRepo } = buildService({
      existing: { id: 'existing-conv', status: 'ACTIVE' },
    });
    const result = await service.createDirect({
      actorPersonId: ACTOR,
      actorRoles: ['PARENT'],
      targetPersonId: TARGET,
    });
    expect(result).toEqual({
      conversationId: 'existing-conv',
      state: 'ACTIVE',
      messagingMode: 'DIRECT',
    });
    expect(authorization.authorizeMessaging).not.toHaveBeenCalled();
    expect(conversationsRepo.create).not.toHaveBeenCalled();
  });

  it('reopening an existing conversation that still has a PENDING request reports PENDING/REQUEST, not ACTIVE/DIRECT', async () => {
    const { service } = buildService({
      existing: { id: 'existing-conv', status: 'ACTIVE' },
      pendingForExisting: { id: 'req-1', status: 'PENDING' },
    });
    const result = await service.createDirect({
      actorPersonId: ACTOR,
      actorRoles: ['PARENT'],
      targetPersonId: TARGET,
    });
    expect(result).toEqual({
      conversationId: 'existing-conv',
      state: 'PENDING',
      messagingMode: 'REQUEST',
    });
  });

  it('DENY from the authorization engine is a hard stop', async () => {
    const { service, conversationsRepo } = buildService({ decision: 'DENY' });
    await expect(
      service.createDirect({
        actorPersonId: ACTOR,
        actorRoles: ['ADMIN'],
        targetPersonId: TARGET,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(conversationsRepo.create).not.toHaveBeenCalled();
  });

  it('REQUIRE_REQUEST redirects the client to the request endpoint instead of silently creating one here', async () => {
    const { service, conversationsRepo } = buildService({
      decision: 'REQUIRE_REQUEST',
    });
    await expect(
      service.createDirect({
        actorPersonId: ACTOR,
        actorRoles: ['PARENT'],
        targetPersonId: TARGET,
      }),
    ).rejects.toMatchObject({ response: { code: 'REQUEST_REQUIRED' } });
    expect(conversationsRepo.create).not.toHaveBeenCalled();
  });

  it('ALLOW_DIRECT creates a new conversation with both members', async () => {
    const { service, conversationsRepo, membersRepo } = buildService({
      decision: 'ALLOW_DIRECT',
    });
    const result = await service.createDirect({
      actorPersonId: ACTOR,
      actorRoles: ['PARENT'],
      targetPersonId: TARGET,
    });
    expect(result).toEqual({
      conversationId: 'new-conv-1',
      state: 'ACTIVE',
      messagingMode: 'DIRECT',
    });
    expect(conversationsRepo.create).toHaveBeenCalledWith(
      { personA: ACTOR, personB: TARGET, createdBy: ACTOR },
      expect.anything(),
    );
    expect(membersRepo.createMembers).toHaveBeenCalledWith(
      'new-conv-1',
      [ACTOR, TARGET],
      expect.anything(),
    );
  });

  it('a concurrent create race (unique violation) opens whatever the winner created instead of erroring', async () => {
    const uniqueViolation = { code: '23505' };
    const { service, conversationsRepo } = buildService({
      decision: 'ALLOW_DIRECT',
      createThrows: uniqueViolation,
    });
    // After the race, findActiveBetween is called again (this time returning
    // the winner's row) -- reconfigure the mock for that second call.
    (conversationsRepo.findActiveBetween as jest.Mock)
      .mockResolvedValueOnce(null) // first call: nothing exists yet, proceed to create
      .mockResolvedValueOnce({ id: 'winner-conv', status: 'ACTIVE' }); // second call: after the race

    const result = await service.createDirect({
      actorPersonId: ACTOR,
      actorRoles: ['PARENT'],
      targetPersonId: TARGET,
    });
    expect(result.conversationId).toBe('winner-conv');
  });

  it('a genuine (non-race) database error during creation propagates, never silently swallowed', async () => {
    const genuineError = new Error('connection terminated unexpectedly');
    const { service } = buildService({
      decision: 'ALLOW_DIRECT',
      createThrows: genuineError,
    });
    await expect(
      service.createDirect({
        actorPersonId: ACTOR,
        actorRoles: ['PARENT'],
        targetPersonId: TARGET,
      }),
    ).rejects.toThrow('connection terminated unexpectedly');
  });
});
