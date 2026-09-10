// Shapes returned by school-eos-backend's own /internal/v1/messaging/* —
// kept in exact sync with messaging-integration.controller.ts's real response
// bodies (Core repo, not this one). Any drift here is a real integration bug,
// not a design choice.

export interface CoreUserProjection {
  personId: string;
  firstName: string;
  lastName: string | null;
  displayName: string;
  profilePhotoUrl: string | null;
  roles: string[];
  messagingEnabled: boolean;
}

export interface ListMessagingUsersResult {
  items: CoreUserProjection[];
  nextCursor: string | null;
}

/** Thrown by every core-integration method on any failure — network error,
 * non-2xx response, malformed body, or timeout. Deliberately a distinct type
 * (never swallowed into "empty result") so the authorization layer's
 * fail-closed behavior is a deliberate catch of THIS error, not an accident
 * of an empty array happening to also mean DENY (LLD §71: "no fallback to
 * permissive behavior... prefer DENY when relationship state is uncertain"). */
export class CoreIntegrationUnavailableError extends Error {
  /** The underlying error (network failure, non-2xx HttpException, etc.) --
   * declared explicitly rather than relying on the built-in ES2022
   * Error#cause, since this repo's tsconfig targets ES2021. */
  public readonly cause?: unknown;

  constructor(
    public readonly operation: string,
    cause?: unknown,
  ) {
    super(`Core integration unavailable: ${operation}`);
    this.name = 'CoreIntegrationUnavailableError';
    this.cause = cause;
  }
}
