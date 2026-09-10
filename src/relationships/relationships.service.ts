// Canonical "what is this actor's current direct-message scope" -- wraps
// core-integration, unions relationships across every messaging-enabled role
// the actor currently holds (a person could plausibly hold more than one --
// e.g. FACULTY + a HOSTEL_WARDEN assignment -- this never assumes exactly
// one). PRINCIPAL/VICE_PRINCIPAL are NOT resolved as a finite relationship
// set here -- their scope is "any messaging-enabled user" (LLD §26),
// unbounded, so the authorization engine checks that role directly rather
// than asking this service for an impossible-to-enumerate list.

import { Injectable } from '@nestjs/common';
import { CoreIntegrationService } from '../core-integration/core-integration.service';

@Injectable()
export class RelationshipsService {
  constructor(private readonly core: CoreIntegrationService) {}

  /** Every person this exact actor can message ALLOW_DIRECT right now, across
   * every messaging-enabled role they currently hold (PARENT/FACULTY/
   * HOSTEL_WARDEN only -- PRINCIPAL/VICE_PRINCIPAL's own unbounded scope is
   * handled directly by the authorization engine, never enumerated here). */
  async getDirectScope(
    personId: string,
    roles: string[],
  ): Promise<Set<string>> {
    const scope = new Set<string>();

    if (roles.includes('PARENT')) {
      for (const id of await this.core.getParentRelationships(personId))
        scope.add(id);
    }
    if (roles.includes('FACULTY')) {
      for (const id of await this.core.getFacultyRelationships(personId))
        scope.add(id);
    }
    if (roles.includes('HOSTEL_WARDEN')) {
      for (const id of await this.core.getWardenRelationships(personId))
        scope.add(id);
    }

    scope.delete(personId);
    return scope;
  }
}
