# auth

Verifies Core's JWT. Never issues one. See the approved plan's decision #4 and
`jwt-auth.guard.ts`'s own header comment for the full reasoning; summary:

- Same payload shape (`{ sub, roles }`), same `JWT_ACCESS_SECRET`, no network
  hop per request.
- **Revocation**: a stale-but-unexpired JWT can't be instantly invalidated by
  this guard alone (inherent to stateless JWTs, and the same exposure window
  Core's own REST APIs already accept). Messaging closes the gap two ways
  instead of adding a webhook/event pipeline this pass:
  1. Every authorization-sensitive decision re-derives current
     relationship/`messagingEnabled` state live from Core (`core-integration/`,
     `relationships/`) and fails closed if Core disagrees with the token.
  2. Device revocation — the one case needing an *immediate* WebSocket
     disconnect (LLD §49) — is Messaging's own owned state
     (`messaging_devices.status`), checked independently on connect/heartbeat
     in `websocket/`, never derived from the JWT.
