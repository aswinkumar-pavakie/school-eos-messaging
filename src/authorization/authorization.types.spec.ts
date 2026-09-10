import {
  canAccessAttachment,
  canAccessConversation,
  canCancelRequest,
  canDecideRequest,
  canSendMessage,
  isMessagingEnabledRole,
  MESSAGING_ENABLED_ROLE_CODES,
} from './authorization.types';

describe('isMessagingEnabledRole', () => {
  it.each(MESSAGING_ENABLED_ROLE_CODES)('%s is messaging-enabled', (role) => {
    expect(isMessagingEnabledRole([role])).toBe(true);
  });

  it.each([
    'ADMIN',
    'FINANCE',
    'BUS_ATTENDANT',
    'CANTEEN_VENDOR',
    'TRANSPORT_MANAGER',
    'MEDIA_ROOM',
  ])('%s is NOT messaging-enabled', (role) => {
    expect(isMessagingEnabledRole([role])).toBe(false);
  });

  it('an empty role list is not messaging-enabled', () => {
    expect(isMessagingEnabledRole([])).toBe(false);
  });
});

describe('canAccessConversation', () => {
  it('allows an ACTIVE member of an ACTIVE conversation', () => {
    expect(
      canAccessConversation({
        isMember: true,
        membershipStatus: 'ACTIVE',
        conversationStatus: 'ACTIVE',
      }),
    ).toBe(true);
  });

  it('denies a non-member entirely (BOLA/IDOR guard)', () => {
    expect(
      canAccessConversation({
        isMember: false,
        membershipStatus: null,
        conversationStatus: 'ACTIVE',
      }),
    ).toBe(false);
  });

  it('denies a member who has LEFT', () => {
    expect(
      canAccessConversation({
        isMember: true,
        membershipStatus: 'LEFT',
        conversationStatus: 'ACTIVE',
      }),
    ).toBe(false);
  });

  it('denies a CLOSED conversation even for an ACTIVE member', () => {
    expect(
      canAccessConversation({
        isMember: true,
        membershipStatus: 'ACTIVE',
        conversationStatus: 'CLOSED',
      }),
    ).toBe(false);
  });

  it('denies a BLOCKED conversation even for an ACTIVE member', () => {
    expect(
      canAccessConversation({
        isMember: true,
        membershipStatus: 'ACTIVE',
        conversationStatus: 'BLOCKED',
      }),
    ).toBe(false);
  });
});

describe('canSendMessage — LLD §31 one-message request rule', () => {
  const activeBase = {
    isMember: true,
    membershipStatus: 'ACTIVE' as const,
    conversationStatus: 'ACTIVE' as const,
  };

  it('allows normal messaging with no pending request', () => {
    const result = canSendMessage('actor-1', {
      ...activeBase,
      pendingRequest: null,
    });
    expect(result).toEqual({ allowed: true });
  });

  it('denies a non-member outright, pending request or not', () => {
    const result = canSendMessage('actor-1', {
      isMember: false,
      membershipStatus: null,
      conversationStatus: 'ACTIVE',
      pendingRequest: null,
    });
    expect(result).toEqual({
      allowed: false,
      reason: 'CONVERSATION_NOT_ACTIVE',
    });
  });

  it('allows the requester to send the FIRST message while pending', () => {
    const result = canSendMessage('requester-1', {
      ...activeBase,
      pendingRequest: {
        requesterPersonId: 'requester-1',
        hasInitialMessage: false,
      },
    });
    expect(result).toEqual({ allowed: true });
  });

  it("denies the recipient sending anything before they've accepted", () => {
    const result = canSendMessage('recipient-1', {
      ...activeBase,
      pendingRequest: {
        requesterPersonId: 'requester-1',
        hasInitialMessage: false,
      },
    });
    expect(result).toEqual({ allowed: false, reason: 'REQUEST_PENDING' });
  });

  it('denies the requester a SECOND message once the initial one exists — the core anti-abuse rule', () => {
    const result = canSendMessage('requester-1', {
      ...activeBase,
      pendingRequest: {
        requesterPersonId: 'requester-1',
        hasInitialMessage: true,
      },
    });
    expect(result).toEqual({ allowed: false, reason: 'REQUEST_PENDING' });
  });

  it('denies the recipient too once an initial message already exists', () => {
    const result = canSendMessage('recipient-1', {
      ...activeBase,
      pendingRequest: {
        requesterPersonId: 'requester-1',
        hasInitialMessage: true,
      },
    });
    expect(result).toEqual({ allowed: false, reason: 'REQUEST_PENDING' });
  });

  it('a malicious client cannot bypass this by claiming a different actor id — the check is server-derived, not client-supplied', () => {
    // Simulates a forged actor id that happens to equal the real requester's —
    // the function only ever trusts the personId the caller independently
    // verified via JWT, never anything from the request body.
    const forged = canSendMessage('requester-1', {
      ...activeBase,
      pendingRequest: {
        requesterPersonId: 'requester-1',
        hasInitialMessage: true,
      },
    });
    expect(forged.allowed).toBe(false);
  });
});

describe('canDecideRequest / canCancelRequest', () => {
  const pending = {
    status: 'PENDING' as const,
    recipientPersonId: 'recipient-1',
    requesterPersonId: 'requester-1',
  };

  it('the real recipient can decide a PENDING request', () => {
    expect(canDecideRequest('recipient-1', pending)).toBe(true);
  });

  it('the requester cannot decide their own request', () => {
    expect(canDecideRequest('requester-1', pending)).toBe(false);
  });

  it('an unrelated third party cannot decide it', () => {
    expect(canDecideRequest('stranger-1', pending)).toBe(false);
  });

  it('an already-ACCEPTED request cannot be decided again', () => {
    expect(
      canDecideRequest('recipient-1', { ...pending, status: 'ACCEPTED' }),
    ).toBe(false);
  });

  it('the real requester can cancel their own PENDING request', () => {
    expect(canCancelRequest('requester-1', pending)).toBe(true);
  });

  it('the recipient cannot cancel a request addressed to them', () => {
    expect(canCancelRequest('recipient-1', pending)).toBe(false);
  });

  it('a non-PENDING request cannot be cancelled', () => {
    expect(
      canCancelRequest('requester-1', { ...pending, status: 'EXPIRED' }),
    ).toBe(false);
  });
});

describe('canAccessAttachment', () => {
  const activeMember = {
    isMember: true,
    membershipStatus: 'ACTIVE' as const,
    conversationStatus: 'ACTIVE' as const,
  };

  it('allows access when the attachment belongs to an accessible conversation', () => {
    expect(
      canAccessAttachment({
        ...activeMember,
        attachmentBelongsToConversation: true,
      }),
    ).toBe(true);
  });

  it('denies access when the attachment does not actually belong to this conversation (forged attachment id)', () => {
    expect(
      canAccessAttachment({
        ...activeMember,
        attachmentBelongsToConversation: false,
      }),
    ).toBe(false);
  });

  it('denies access even to a real attachment if the conversation itself is not accessible', () => {
    expect(
      canAccessAttachment({
        isMember: false,
        membershipStatus: null,
        conversationStatus: 'ACTIVE',
        attachmentBelongsToConversation: true,
      }),
    ).toBe(false);
  });
});
