// RequestsService's accept/decline/cancel authorization boundaries -- the
// security-critical part of the request lifecycle (LLD §16/§30-32): only the
// real recipient may accept/decline, only the real requester may cancel,
// and only while genuinely PENDING.

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RequestsService } from './requests.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { UnitOfWork } from '../common/transactions/unit-of-work';
import { OutboxEventsRepository } from '../outbox/repositories/outbox-events.repository';
import { MessagesRepository } from '../messages/repositories/messages.repository';
import { MessageDeliveryRepository } from '../delivery/repositories/message-delivery.repository';
import { ConversationRequestsRepository } from './repositories/conversation-requests.repository';
import { ConversationMembersRepository } from '../conversations/repositories/conversation-members.repository';
import { ConversationsRepository } from '../conversations/repositories/conversations.repository';

const REQUESTER = 'requester-1';
const RECIPIENT = 'recipient-1';
const STRANGER = 'stranger-1';

function buildService(pendingRequest: any) {
  const authorization = {
    authorizeMessaging: jest.fn(),
  } as unknown as AuthorizationService;
  const conversationsRepo = {} as unknown as ConversationsRepository;
  const membersRepo = {} as unknown as ConversationMembersRepository;
  const requestsRepo = {
    findByIdForUpdate: jest.fn().mockResolvedValue(pendingRequest),
    accept: jest.fn().mockResolvedValue(undefined),
    decline: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConversationRequestsRepository;
  const messagesRepo = {} as unknown as MessagesRepository;
  const deliveryRepo = {} as unknown as MessageDeliveryRepository;
  const outboxRepo = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  } as unknown as OutboxEventsRepository;
  const unitOfWork = {
    run: jest.fn((work: (client: unknown) => Promise<unknown>) => work({})),
  } as unknown as UnitOfWork;

  const service = new RequestsService(
    authorization,
    conversationsRepo,
    membersRepo,
    requestsRepo,
    messagesRepo,
    deliveryRepo,
    outboxRepo,
    unitOfWork,
  );
  return { service, requestsRepo, outboxRepo };
}

const PENDING = {
  id: 'req-1',
  conversationId: 'conv-1',
  requesterPersonId: REQUESTER,
  recipientPersonId: RECIPIENT,
  status: 'PENDING' as const,
  initialMessageId: 'msg-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  respondedAt: null,
  expiresAt: null,
  version: 1,
};

describe('RequestsService.accept', () => {
  it('the real recipient can accept', async () => {
    const { service, requestsRepo } = buildService(PENDING);
    const result = await service.accept('req-1', RECIPIENT);
    expect(result.status).toBe('ACCEPTED');
    expect(requestsRepo.accept).toHaveBeenCalledWith(
      'req-1',
      expect.anything(),
    );
  });

  it('the requester cannot accept their own request', async () => {
    const { service, requestsRepo } = buildService(PENDING);
    await expect(service.accept('req-1', REQUESTER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(requestsRepo.accept).not.toHaveBeenCalled();
  });

  it('an unrelated stranger cannot accept it', async () => {
    const { service } = buildService(PENDING);
    await expect(service.accept('req-1', STRANGER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('an already-ACCEPTED request cannot be accepted again', async () => {
    const { service, requestsRepo } = buildService({
      ...PENDING,
      status: 'ACCEPTED',
    });
    await expect(service.accept('req-1', RECIPIENT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(requestsRepo.accept).not.toHaveBeenCalled();
  });

  it('a genuinely nonexistent request is a clean 404', async () => {
    const { service } = buildService(null);
    await expect(
      service.accept('does-not-exist', RECIPIENT),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('RequestsService.decline', () => {
  it('the real recipient can decline', async () => {
    const { service, requestsRepo } = buildService(PENDING);
    const result = await service.decline('req-1', RECIPIENT);
    expect(result.status).toBe('DECLINED');
    expect(requestsRepo.decline).toHaveBeenCalled();
  });

  it('the requester cannot decline their own request', async () => {
    const { service } = buildService(PENDING);
    await expect(service.decline('req-1', REQUESTER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('RequestsService.cancel', () => {
  it('the real requester can cancel their own PENDING request', async () => {
    const { service, requestsRepo } = buildService(PENDING);
    const result = await service.cancel('req-1', REQUESTER);
    expect(result.status).toBe('CANCELLED');
    expect(requestsRepo.cancel).toHaveBeenCalled();
  });

  it('the recipient cannot cancel a request addressed to them (that is decline/accept, not cancel)', async () => {
    const { service, requestsRepo } = buildService(PENDING);
    await expect(service.cancel('req-1', RECIPIENT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(requestsRepo.cancel).not.toHaveBeenCalled();
  });

  it('a non-PENDING request cannot be cancelled even by its own requester', async () => {
    const { service, requestsRepo } = buildService({
      ...PENDING,
      status: 'ACCEPTED',
    });
    await expect(service.cancel('req-1', REQUESTER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(requestsRepo.cancel).not.toHaveBeenCalled();
  });
});
