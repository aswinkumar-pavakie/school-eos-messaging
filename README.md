# School EOS Messaging Microservice

Independently deployable, E2EE, WebSocket-realtime messaging backend for
School EOS — Parent, Faculty, Hostel Warden, Principal, and Vice Principal
only. Built from the approved Low Level Design at
`school-eos-mobile/brain/School EOS Messaging Microservice — Low Level
Design.md` ("the LLD" throughout this repo's comments).

This service **replaces** the legacy Parent↔Faculty messaging module in
`school-eos-backend/src/modules/messaging` (plaintext, REST-only, no E2EE).
That module stays live and untouched until this service is deployed, tested,
and the cutover is explicitly approved — see the Final Report handed over
alongside this repo for the current status of that transition.

## Architecture

```
School EOS Mobile
        |
        | HTTPS (REST) / WSS (realtime)
        v
school-eos-messaging  <---->  school-eos-backend (Core)
        |                      (GET /internal/v1/messaging/*,
        |                       shared-secret authenticated)
        +-- PostgreSQL (existing Supabase project, `messaging` schema)
        +-- Redis (presence, typing, cross-instance fan-out, rate limits)
        +-- Outbox worker (push notifications, realtime fan-out)
```

Messaging never queries Core's database directly (LLD §79) — it calls five
narrow, read-only internal endpoints Core exposes for exactly this purpose
(`school-eos-backend/src/modules/messaging-integration/`), and independently
verifies the same JWT Core issues (same secret, no network hop per request).
Messaging owns its own tables inside a dedicated `messaging` Postgres schema
in the **same real Supabase project** Core uses — never a second database,
never local/Docker Postgres.

Module-by-module detail lives in each module's own file-header comments,
matching this codebase's own convention (`src/auth/README.md`,
`src/core-integration/`, `src/authorization/`, etc.).

## Local setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `DATABASE_URL` — the **existing** Supabase project's connection string
     (same one `school-eos-backend/.env` uses). Never a new database.
   - `JWT_ACCESS_SECRET` — must equal Core's own `JWT_ACCESS_SECRET` exactly.
   - `MESSAGING_INTERNAL_KEY` — must equal Core's own `MESSAGING_INTERNAL_KEY`
     (configure Core's `.env` too — see
     `school-eos-backend/src/modules/messaging-integration/README.md`).
   - `CORE_INTERNAL_BASE_URL` — Core's own base URL + `/internal/v1/messaging`
     (defaults to `http://localhost:3000/internal/v1/messaging`).
3. `docker compose up -d redis` — Redis only; Postgres is the real Supabase
   project above, never a local container (see `docker-compose.yml`'s own
   header comment for why).
4. **Run the migration yourself**: hand
   `database/migrations/0001_messaging_schema.sql` to whoever runs Core's own
   migrations, against the same Supabase project. This service's own
   standing rule (matching Core's) is that nothing here ever runs a
   migration against the real database directly — only read-only
   verification afterward.
5. `npm run start:dev`

## Testing

`npm test` runs the full unit suite (authorization decision matrix, pure
state-transition functions, real Ed25519 signature verification — no mocked
crypto). Everything that needs a live Postgres/Redis (repository SQL,
integration flows, the WebSocket protocol end-to-end) is verified manually
against a real boot once the migration has been run — see the Final Report
for exactly what has and hasn't been exercised that way yet.

## Security notes

- **E2EE**: this service never receives or stores plaintext message content
  or any private key — see `src/e2ee/` and the `messages` table's own
  `ciphertext bytea` column (no plaintext column exists anywhere in the
  schema). The one real cryptographic operation performed server-side is
  Ed25519 signature verification on a submitted signed prekey
  (`src/e2ee/e2ee-signature.util.ts`), using Node's built-in `crypto` module.
- **Fail-closed**: every authorization decision denies on any uncertainty
  (Core unreachable, unknown role, missing relationship) — see
  `src/authorization/authorization.service.ts`'s own header comment and its
  test suite.
- **Fail-open exception**: rate limiting alone fails *open* (allows the
  request) if Redis is unreachable — documented explicitly in
  `src/ratelimit/rate-limit.service.ts`, since it's a defense-in-depth
  abuse control, not the boundary deciding who may act at all.
- **Graceful degradation, proven live**: audit logging, presence tracking,
  and the outbox worker's scheduled tick were each confirmed, by actually
  running this service against an unreachable Postgres/Redis, to degrade
  correctly (log and continue) rather than crash the process — see each
  service's own header comment for the specific failure this was tested
  against.

## Explicitly deferred (see the Final Report for the complete list)

Real object-storage wiring for attachments, real FCM/APNs push credentials
(Expo push is real and working — see `src/notifications/expo-push.util.ts`),
the domain-events relationship projection (a documented future scaling
optimization, not a requirement at current DAU), load/penetration testing,
the mobile client, and actually retiring the legacy messaging module.
