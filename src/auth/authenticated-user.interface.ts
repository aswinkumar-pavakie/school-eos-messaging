// Shape JwtAuthGuard attaches to request.user (and to a WebSocket connection's
// handshake data) after verifying Core's access token. `personId` is Core's own
// `person.id` UUID — Messaging never mints its own identity (LLD §3).
export interface AuthenticatedUser {
  personId: string;
  roles: string[];
}
