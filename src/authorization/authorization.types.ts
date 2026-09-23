// The central messaging authorization/relationship policy layer's own
// vocabulary (LLD §9, §22). Every messaging-authorization decision in this
// service resolves to exactly one of these three values -- there is no
// fourth option, and nothing outside this module invents its own variant.

export type AuthorizationDecision = 'ALLOW_DIRECT' | 'REQUIRE_REQUEST' | 'DENY';

export interface AuthorizationActor {
  personId: string;
  roles: string[];
}

/** The exact, documented answer to "which roles are messagingEnabled" — kept
 * in lockstep with school-eos-backend's own
 * messaging-integration/messaging-roles.constant.ts (that side computes
 * `messagingEnabled` for arbitrary target persons; this side needs the same
 * list to evaluate the ACTOR's own JWT roles, which never round-trips
 * through Core on every single request). A role never listed here defaults
 * to NOT messaging-enabled -- fail-closed, not a broadened permission (LLD
 * §47/§71).
 *
 * SUPERSEDED: the original LLD narrowly enabled only PARENT/FACULTY/
 * HOSTEL_WARDEN/PRINCIPAL/VICE_PRINCIPAL. The user's own explicit later
 * instruction widened this to every real login role EXCEPT CANTEEN_VENDOR,
 * DRIVER, and BUS_ATTENDANT (device-credential-only logins with no
 * person-to-person messaging use case) -- keep this list identical to the
 * backend's own constant, both sides must change together. */
export const MESSAGING_ENABLED_ROLE_CODES = [
  'PARENT',
  'FACULTY',
  'HOSTEL_WARDEN',
  'PRINCIPAL',
  'VICE_PRINCIPAL',
  'ADMIN',
  'CORRESPONDENT',
  'TRANSPORT_MANAGER',
  'LIBRARY',
  'FINANCE',
  'MEDIA_ROOM',
  'SPORTS_ADMIN',
  'COMMUNITY',
] as const;

export function isMessagingEnabledRole(roles: string[]): boolean {
  return roles.some((r) =>
    (MESSAGING_ENABLED_ROLE_CODES as readonly string[]).includes(r),
  );
}

// ---- Conversation/request-state guards (LLD §28-32, §38) --------------------
//
// These take already-fetched state as plain data rather than querying
// anything themselves, so they stay pure, DB-agnostic, and directly
// unit-testable — the actual state comes from conversations/messages/
// requests' own repositories (this service's real Postgres tables), never
// re-derived here.

export type ConversationStatus = 'ACTIVE' | 'BLOCKED' | 'CLOSED';
export type MembershipStatus = 'ACTIVE' | 'LEFT';

export interface ConversationMembershipState {
  isMember: boolean;
  membershipStatus: MembershipStatus | null;
  conversationStatus: ConversationStatus;
}

/** LLD §38: "conversation active? sender authorized?" -- the base check every
 * conversation-scoped operation (send, read, sync) needs before anything
 * else. A former member (LEFT) or a CLOSED/BLOCKED conversation never
 * qualifies, regardless of how the row got there. */
export function canAccessConversation(
  state: ConversationMembershipState,
): boolean {
  return (
    state.isMember &&
    state.membershipStatus === 'ACTIVE' &&
    state.conversationStatus === 'ACTIVE'
  );
}

export interface PendingRequestState {
  requesterPersonId: string;
  hasInitialMessage: boolean;
}

export interface MessageSendState extends ConversationMembershipState {
  /** Null if there is no PENDING request on this conversation right now (an
   * originally-DIRECT conversation, or a request that has already been
   * accepted/declined/cancelled/expired) — normal messaging rules apply. */
  pendingRequest: PendingRequestState | null;
}

export type SendDenialReason = 'CONVERSATION_NOT_ACTIVE' | 'REQUEST_PENDING';

/** LLD §31: "when request status is PENDING: if initial_message_id != NULL:
 * reject additional message... only recipient acceptance changes state to
 * ACTIVE." Concretely: while a request is pending, at most ONE message may
 * ever exist on that conversation, and only the ORIGINAL requester may send
 * it — the recipient cannot send anything until they accept (there is
 * nothing to reply to yet, and accepting is a distinct action from
 * messaging). This is enforced here as a pure decision, then re-checked
 * transactionally at insert time against the real DB state (LLD §31: "this
 * check is performed inside the transaction") — this function is the single
 * source of truth for the RULE, not a second copy of it. */
export function canSendMessage(
  actorPersonId: string,
  state: MessageSendState,
): { allowed: true } | { allowed: false; reason: SendDenialReason } {
  if (!canAccessConversation(state)) {
    return { allowed: false, reason: 'CONVERSATION_NOT_ACTIVE' };
  }
  if (state.pendingRequest) {
    if (state.pendingRequest.hasInitialMessage) {
      return { allowed: false, reason: 'REQUEST_PENDING' };
    }
    if (actorPersonId !== state.pendingRequest.requesterPersonId) {
      return { allowed: false, reason: 'REQUEST_PENDING' };
    }
  }
  return { allowed: true };
}

export interface RequestDecisionState {
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED';
  recipientPersonId: string;
  requesterPersonId: string;
}

/** Only the real recipient may accept/decline, and only while genuinely
 * PENDING — never the requester (LLD §16: "recipient accepts"), never a
 * request already resolved one way or another. */
export function canDecideRequest(
  actorPersonId: string,
  state: RequestDecisionState,
): boolean {
  return (
    state.status === 'PENDING' && actorPersonId === state.recipientPersonId
  );
}

/** Only the real requester may cancel their own still-pending request. */
export function canCancelRequest(
  actorPersonId: string,
  state: RequestDecisionState,
): boolean {
  return (
    state.status === 'PENDING' && actorPersonId === state.requesterPersonId
  );
}

export interface AttachmentAccessState extends ConversationMembershipState {
  attachmentBelongsToConversation: boolean;
}

/** LLD §33/§50: an attachment is only reachable through a conversation the
 * caller can currently access, and only if it genuinely belongs to that
 * conversation's own message — never trusts a client-supplied attachment id
 * in isolation. */
export function canAccessAttachment(state: AttachmentAccessState): boolean {
  return state.attachmentBelongsToConversation && canAccessConversation(state);
}
