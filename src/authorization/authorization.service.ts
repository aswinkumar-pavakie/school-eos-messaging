// The one function that decides whether a NEW conversation between two
// people is ALLOW_DIRECT, REQUIRE_REQUEST, or DENY (LLD §9/§22-27). This is
// deliberately the ONLY place this decision is made — directory,
// conversations, and requests all call THIS, never re-derive their own
// version of it (the user's own explicit instruction: "centralized,
// testable authorization logic... never scattered in controllers").
//
// Resolved ambiguity, documented rather than silently picked (per the plan's
// "don't silently invent" rule): the LLD's own §61 test matrix only tests
// Faculty -> assigned-class (ALLOW) and Faculty -> Principal/VP (REQUEST) —
// it never states what Faculty -> an unrelated Parent/Faculty should be, and
// the Warden section (§25) has the identical gap ("otherwise: evaluate
// configured policy"). Resolved as: the SAME default fallback as every other
// role — REQUIRE_REQUEST, never DENY — because the Directory algorithm
// itself (§18) is written generically ("scoped users first, THEN remaining
// messaging-enabled users are still discoverable/requestable"), never
// carved out per-role, and §24's own "no unapproved broad Faculty->all-user
// permission is assumed" reads most naturally as "don't skip the request
// step," not "Faculty may not even request an unrelated person" (which would
// make Faculty's directory silently narrower than every other role's, with
// no textual basis for that asymmetry).

import { Injectable } from '@nestjs/common';
import { CoreIntegrationService } from '../core-integration/core-integration.service';
import { RelationshipsService } from '../relationships/relationships.service';
import {
  AuthorizationActor,
  AuthorizationDecision,
  isMessagingEnabledRole,
} from './authorization.types';

const UNBOUNDED_SCOPE_ROLES = ['PRINCIPAL', 'VICE_PRINCIPAL'];

@Injectable()
export class AuthorizationService {
  constructor(
    private readonly core: CoreIntegrationService,
    private readonly relationships: RelationshipsService,
  ) {}

  /** Throws CoreIntegrationUnavailableError (never returns a permissive
   * default) if Core can't be reached to verify the target — a caller
   * catching this must treat it as a hard denial, not retry-as-allow. */
  async authorizeMessaging(
    actor: AuthorizationActor,
    targetPersonId: string,
  ): Promise<AuthorizationDecision> {
    if (!isMessagingEnabledRole(actor.roles)) return 'DENY';
    if (actor.personId === targetPersonId) return 'DENY';

    const target = await this.core.getUserProjection(targetPersonId);
    if (!target || !target.messagingEnabled) return 'DENY';

    if (actor.roles.some((r) => UNBOUNDED_SCOPE_ROLES.includes(r))) {
      return 'ALLOW_DIRECT';
    }

    const scope = await this.relationships.getDirectScope(
      actor.personId,
      actor.roles,
    );
    if (scope.has(targetPersonId)) return 'ALLOW_DIRECT';

    return 'REQUIRE_REQUEST';
  }
}
