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
    const scopeIds = isPrincipalLike
      ? new Set<string>()
      : await this.relationships.getDirectScope(actor.personId, actor.roles);
    const scopedProjections = await Promise.all(
      [...scopeIds].map((id) => this.core.getUserProjection(id)),
    );
    const scopedUsers = scopedProjections.filter(
      (p): p is CoreUserProjection => p !== null && p.messagingEnabled,
    );

    // 5-6. Remaining messaging-enabled users (paginated at Core), excluding
    // whoever's already scoped and the actor themselves.
    const remaining = await this.core.listMessagingUsers({
      cursor: params.cursor,
      limit: limit + scopeIds.size, // over-fetch a little to absorb scoped overlap removed below
      excludePersonId: actor.personId,
    });
    const remainingUsers = remaining.items.filter(
      (u) => !scopeIds.has(u.personId),
    );

    // 8. Scoped first, then remaining -- never interleaved.
    let combined: { user: CoreUserProjection; scope: 'SCOPED' | 'UNSCOPED' }[] =
      [
        ...scopedUsers.map((user) => ({ user, scope: 'SCOPED' as const })),
        ...remainingUsers.map((user) => ({ user, scope: 'UNSCOPED' as const })),
      ];

    // 9. Search (case-insensitive substring over displayName -- Core's own
    // listing endpoint has no server-side search param yet; filtering the
    // already-fetched candidate set is correct and sufficient at this scale,
    // LLD §48).
    if (params.search) {
      const needle = params.search.trim().toLowerCase();
      if (needle) {
        combined = combined.filter((c) =>
          c.user.displayName.toLowerCase().includes(needle),
        );
      }
    }

    // 10. Cursor pagination over the combined, ordered set.
    const page = combined.slice(0, limit);
    const nextCursor =
      combined.length > limit
        ? (page[page.length - 1]?.user.personId ?? null)
        : null;

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
