// The exact LLD §18 directory algorithm. This is the ONLY place discovery
// results get assembled -- the empty-initial-state / scoped-first / +
// button model (LLD §17) all live downstream of what this returns.

import { Injectable } from '@nestjs/common';
import { isMessagingEnabledRole } from '../authorization/authorization.types';
import { ConversationsRepository } from '../conversations/repositories/conversations.repository';
import { CoreIntegrationService } from '../core-integration/core-integration.service';
import { CoreUserProjection } from '../core-integration/core-integration.types';
import { RelationshipsService } from '../relationships/relationships.service';

export interface DiscoveryItem {
  userId: string;
  displayName: string;
  role: string | null;
  profilePhoto: string | null;
  scope: 'SCOPED' | 'UNSCOPED';
  messagingMode: 'DIRECT' | 'REQUEST';
  existingConversationState: 'ACTIVE' | 'BLOCKED' | null;
}

export interface DiscoveryResult {
  items: DiscoveryItem[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 30;

// Core's own internal /users listing endpoint caps `limit` at 100
// (list-messaging-users.query.dto.ts's @Max(100)) -- the over-fetch below
// must never exceed that or Core rejects the request with a 400, which
// surfaced here as an uncaught 500 for anyone with a large scoped set (e.g.
// a Class Advisor with a full section roster easily exceeds 100 on its own).
const CORE_LIST_USERS_MAX_LIMIT = 100;

@Injectable()
export class DirectoryService {
  constructor(
    private readonly core: CoreIntegrationService,
    private readonly relationships: RelationshipsService,
    private readonly conversationsRepo: ConversationsRepository,
  ) {}

  async discover(
    actor: { personId: string; roles: string[] },
    params: { search?: string; cursor?: string; limit?: number },
  ): Promise<DiscoveryResult> {
    if (!isMessagingEnabledRole(actor.roles)) {
      // A messaging-disabled caller sees an empty directory, never an error
      // that reveals more than "there is nothing here for you" (LLD §27/§53).
      return { items: [], nextCursor: null };
    }

    const limit = params.limit ?? DEFAULT_LIMIT;
    const isPrincipalLike = actor.roles.some(
      (r) => r === 'PRINCIPAL' || r === 'VICE_PRINCIPAL',
    );

    // 1-4. Resolve scoped users first (empty set for Principal/VP -- their
    // scope is unbounded, handled entirely by the "remaining" bucket below).
    // Sorted deterministically by personId so this list can be paginated
    // across calls the same way Core's own keyset pagination works below --
    // it's recomputed fresh on every call (not cached across a "session"),
    // same tradeoff the original single-page version already accepted.
    const scopeIds = isPrincipalLike
      ? new Set<string>()
      : await this.relationships.getDirectScope(actor.personId, actor.roles);
    const scopedProjectionsById = await this.core.getUserProjectionsBatch([
      ...scopeIds,
    ]);
    const scopedUsers = [...scopeIds]
      .map((id) => scopedProjectionsById.get(id) ?? null)
      .filter((p): p is CoreUserProjection => p !== null && p.messagingEnabled)
      .sort((a, b) => a.personId.localeCompare(b.personId));

    // The opaque cursor this method hands back encodes WHICH phase the walk
    // is in -- "S:<personId>" mid-way through the (locally-paginated) scoped
    // list, or "C:<coreCursor|''>" once scoped is exhausted and we're
    // resuming Core's own keyset-paginated "remaining" listing. Mixing these
    // two ordered sets into one combined-array position (the previous
    // design) meant a cursor value could be a SCOPED user's id fed back into
    // Core's `p.id > cursor` filter -- semantically meaningless to Core, and
    // silently corrupted the walk. Found live: a Class Advisor with a large
    // section roster (275 scoped ids) searching for a real, valid colleague
    // who simply wasn't within the first ~200 combined results ever got
    // "not found" -- of 1,017 real messaging-enabled people, only 184 were
    // ever reachable via pagination, because the OLD nextCursor was computed
    // from `combined.length > limit`, which goes false (falsely signalling
    // "no more data") the instant scope-overlap filtering trims one Core
    // page below `limit`, even while Core's own real nextCursor says there
    // is plenty more.
    let scopedCursor: string | null = null;
    let coreCursor: string | undefined;
    let phase: 'scoped' | 'core' = scopedUsers.length > 0 ? 'scoped' : 'core';
    if (params.cursor?.startsWith('S:')) {
      phase = 'scoped';
      scopedCursor = params.cursor.slice(2);
    } else if (params.cursor?.startsWith('C:')) {
      phase = 'core';
      coreCursor = params.cursor.slice(2) || undefined;
    }

    let combined: { user: CoreUserProjection; scope: 'SCOPED' | 'UNSCOPED' }[] =
      [];
    let nextCursor: string | null = null;

    if (phase === 'scoped') {
      const startIdx = scopedCursor
        ? scopedUsers.findIndex((u) => u.personId === scopedCursor) + 1
        : 0;
      const scopedPage = scopedUsers.slice(startIdx, startIdx + limit);
      combined = scopedPage.map((user) => ({ user, scope: 'SCOPED' as const }));

      if (startIdx + scopedPage.length < scopedUsers.length) {
        // More scoped users remain -- resume the scoped phase, Core is not
        // touched at all this call (matches the original design's intent
        // that scoped results are cheap/local and never re-fetched from
        // Core on every page).
        nextCursor = `S:${scopedPage[scopedPage.length - 1]!.personId}`;
      } else {
        // Scoped exhausted (or never existed). Fill the rest of THIS page
        // from Core's "remaining" listing too -- preserves the original
        // behavior where page 1 shows scoped-then-remaining together in one
        // response, it just now also works correctly as page 2, 3, ... of a
        // scoped list that itself spans multiple pages.
        const budget = limit - combined.length;
        if (budget > 0) {
          const remaining = await this.core.listMessagingUsers({
            limit: Math.min(budget, CORE_LIST_USERS_MAX_LIMIT),
            excludePersonId: actor.personId,
          });
          const remainingUsers = remaining.items.filter(
            (u) => !scopeIds.has(u.personId),
          );
          combined = combined.concat(
            remainingUsers.map((user) => ({
              user,
              scope: 'UNSCOPED' as const,
            })),
          );
          nextCursor = remaining.nextCursor
            ? `C:${remaining.nextCursor}`
            : null;
        } else {
          // Scoped exactly filled this page -- next call starts the core
          // phase fresh (empty coreCursor = "from the beginning").
          nextCursor = 'C:';
        }
      }
    } else {
      const remaining = await this.core.listMessagingUsers({
        cursor: coreCursor,
        limit: Math.min(limit, CORE_LIST_USERS_MAX_LIMIT),
        excludePersonId: actor.personId,
      });
      const remainingUsers = remaining.items.filter(
        (u) => !scopeIds.has(u.personId),
      );
      combined = remainingUsers.map((user) => ({
        user,
        scope: 'UNSCOPED' as const,
      }));
      // Core's own signal is authoritative here, independent of how many
      // items survived the scope-overlap filter above -- a filtered-short
      // page must never be mistaken for "no more data" (this exact
      // confusion was the root cause being fixed).
      nextCursor = remaining.nextCursor ? `C:${remaining.nextCursor}` : null;
    }

    // 9. Search (case-insensitive substring over displayName -- Core's own
    // listing endpoint has no server-side search param yet; filtering the
    // already-fetched candidate set is correct and sufficient at this scale,
    // LLD §48). Same accepted "search only within what's already fetched"
    // scope as before -- a caller must still walk pages via nextCursor to
    // search the full directory, which is exactly what the pagination fix
    // above now makes possible all the way to the end.
    if (params.search) {
      const needle = params.search.trim().toLowerCase();
      if (needle) {
        combined = combined.filter((c) =>
          c.user.displayName.toLowerCase().includes(needle),
        );
      }
    }

    const page = combined;

    // 11. Policy metadata -- messagingMode per item, plus whether a
    // conversation already exists (never auto-created here, LLD §28).
    const candidateIds = page.map((c) => c.user.personId);
    const existingByTarget =
      await this.conversationsRepo.findActiveStatusForCandidates(
        actor.personId,
        candidateIds,
      );

    const items: DiscoveryItem[] = page.map(({ user, scope }) => ({
      userId: user.personId,
      displayName: user.displayName,
      role: user.roles[0] ?? null,
      profilePhoto: user.profilePhotoUrl,
      scope,
      messagingMode:
        scope === 'SCOPED' || isPrincipalLike ? 'DIRECT' : 'REQUEST',
      existingConversationState:
        (existingByTarget.get(user.personId) as
          'ACTIVE' | 'BLOCKED' | undefined) ?? null,
    }));

    return { items, nextCursor };
  }
}
