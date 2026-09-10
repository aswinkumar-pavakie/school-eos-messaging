-- School EOS Messaging Microservice — initial schema.
--
-- Runs against the EXISTING, real School EOS Supabase PostgreSQL project (the
-- same one school-eos-backend already uses) — this is NOT a new database.
-- Everything here lives inside a new, dedicated `messaging` schema so it can
-- never collide with, or need to modify, any of Core's own `public`-schema
-- tables. No Core table is touched. No cross-schema foreign key is created
-- into `public.person` (or any other Core table) — every person/user
-- reference here is a plain `uuid` column, independently verified by this
-- service via JWT + the new internal Core relationship endpoints, never via a
-- DB-level FK into a database this service doesn't own the migration
-- lifecycle of.
--
-- NOT executed automatically — run this against the real Supabase database
-- yourself, exactly like every school-eos-backend migration, then confirm
-- back so the service can be verified against it.
--
-- Conventions (matching school-eos-backend's own database/migrations/*.sql):
--   * lowercase unquoted snake_case identifiers throughout.
--   * gen_random_uuid() bare for uuid PKs; bigserial for append-only child rows
--     (messages), matching Core's own message/notification id style.
--   * text + named CHECK constraint for every status-like column, never a
--     native Postgres ENUM (matches every Core migration this session).
--   * No DB trigger maintains updated_at anywhere — application code sets it
--     explicitly on every UPDATE, same as Core's own convention.
--   * ON DELETE CASCADE only for rows genuinely owned by their parent
--     (conversation_members/messages/etc. -> conversations; e2ee prekeys ->
--     messaging_devices) — nothing here references a Core table, so there is
--     no NO ACTION reference-only FK case to mirror from Core's own style.

BEGIN;

CREATE SCHEMA IF NOT EXISTS messaging;

-- 1. Conversations. DIRECT-only per the approved LLD (§6, §60 — "no group
--    chat"): person_a_id/person_b_id are always stored in sorted order so a
--    partial unique index can guarantee at most one non-CLOSED conversation
--    per pair, regardless of who initiated — this is the real, DB-level race
--    protection LLD §32 requires ("two simultaneous requests must not create
--    two conversations... database uniqueness constraints remain the final
--    protection"), not just an application-level check.
--    last_sequence_no is incremented transactionally on every message send
--    (`UPDATE ... SET last_sequence_no = last_sequence_no + 1 ... RETURNING`)
--    -- the UPDATE's own row lock is what serializes concurrent senders into
--    a correct, gapless per-conversation sequence (LLD §10).
--    last_message_id/last_message_at are denormalized for the conversation
--    list preview (LLD §54's "cursor-based... conversation list"), updated in
--    the same transaction as every message insert. Deliberately NOT a foreign
--    key back to messages.id (bigserial) -- that would make conversations and
--    messages mutually referencing with no clean single-statement direction;
--    application code sets it inside the same transaction as the insert.
CREATE TABLE messaging.conversations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_type text NOT NULL DEFAULT 'DIRECT',
  status            text NOT NULL DEFAULT 'ACTIVE',
  person_a_id       uuid NOT NULL,
  person_b_id       uuid NOT NULL,
  created_by        uuid NOT NULL,
  last_sequence_no  bigint NOT NULL DEFAULT 0,
  last_message_id   bigint,
  last_message_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           bigint NOT NULL DEFAULT 1,
  CONSTRAINT chk_conversations_type CHECK (conversation_type IN ('DIRECT')),
  CONSTRAINT chk_conversations_status CHECK (status IN ('ACTIVE', 'BLOCKED', 'CLOSED')),
  CONSTRAINT chk_conversations_pair_order CHECK (person_a_id < person_b_id)
);

CREATE UNIQUE INDEX uq_conversations_active_pair
  ON messaging.conversations (person_a_id, person_b_id)
  WHERE status <> 'CLOSED';

CREATE INDEX idx_conversations_updated_at ON messaging.conversations (updated_at);

-- 2. Conversation membership — always exactly 2 rows per conversation
--    (DIRECT-only). last_read_message_id kept here too (cheap denormalized
--    "have I opened this conversation at all" signal for the list view);
--    message_read_state (table 6 below) is the real, sequence-based read
--    cursor LLD §12 actually specifies for correctness.
CREATE TABLE messaging.conversation_members (
  conversation_id      uuid NOT NULL REFERENCES messaging.conversations (id) ON DELETE CASCADE,
  person_id            uuid NOT NULL,
  membership_status    text NOT NULL DEFAULT 'ACTIVE',
  joined_at            timestamptz NOT NULL DEFAULT now(),
  left_at              timestamptz,
  last_read_message_id bigint,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, person_id),
  CONSTRAINT chk_conversation_members_status CHECK (membership_status IN ('ACTIVE', 'LEFT'))
);

CREATE INDEX idx_conversation_members_person ON messaging.conversation_members (person_id, membership_status);

-- 3. Conversation requests — the REQUEST-required path (LLD §8, §30-32). A
--    conversation row is created immediately alongside a PENDING request (not
--    deferred to acceptance); conversations.status itself has no PENDING
--    value (see table 1) -- whether normal messaging is open is entirely
--    governed by "does this conversation have a PENDING request row", checked
--    inside the same transaction as every message send (LLD §31's one-message
--    rule). The partial unique index is the DB-level guarantee that two
--    concurrent request attempts for the same relationship can't both
--    succeed (LLD §32).
CREATE TABLE messaging.conversation_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     uuid NOT NULL REFERENCES messaging.conversations (id) ON DELETE CASCADE,
  requester_person_id uuid NOT NULL,
  recipient_person_id uuid NOT NULL,
  status              text NOT NULL DEFAULT 'PENDING',
  initial_message_id  bigint,
  created_at          timestamptz NOT NULL DEFAULT now(),
  responded_at        timestamptz,
  expires_at          timestamptz,
  version             bigint NOT NULL DEFAULT 1,
  CONSTRAINT chk_conversation_requests_status
    CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED'))
);

CREATE UNIQUE INDEX uq_conversation_requests_pending
  ON messaging.conversation_requests (conversation_id)
  WHERE status = 'PENDING';

CREATE INDEX idx_conversation_requests_recipient ON messaging.conversation_requests (recipient_person_id, status);
CREATE INDEX idx_conversation_requests_requester ON messaging.conversation_requests (requester_person_id, status);

-- 4. Messages — no plaintext column exists, anywhere (LLD §9/§19/§21's core
--    rule). ciphertext/encryption_header are exactly what the client's E2EE
--    layer hands the server; this service never decrypts, never could.
--    uq_messages_idempotency is the real, DB-level idempotency guarantee LLD
--    §26/§34 requires ("the database must enforce uniqueness... never rely
--    only on application-level duplicate checks").
CREATE TABLE messaging.messages (
  id                  bigserial PRIMARY KEY,
  conversation_id     uuid NOT NULL REFERENCES messaging.conversations (id) ON DELETE CASCADE,
  sender_person_id    uuid NOT NULL,
  client_message_id   uuid NOT NULL,
  sequence_no         bigint NOT NULL,
  ciphertext          bytea NOT NULL,
  encryption_version  text NOT NULL,
  encryption_header   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  server_received_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT uq_messages_idempotency UNIQUE (sender_person_id, conversation_id, client_message_id),
  CONSTRAINT uq_messages_sequence UNIQUE (conversation_id, sequence_no)
);

CREATE INDEX idx_messages_conversation_sequence ON messaging.messages (conversation_id, sequence_no);
CREATE INDEX idx_messages_conversation_created ON messaging.messages (conversation_id, created_at);

-- 5. Per-recipient delivery state (LLD §11). device_id is nullable -- delivery
--    can be recorded before a specific device is resolved (e.g. recipient has
--    no registered device yet: PENDING forever until one registers, never
--    fabricated as DELIVERED).
CREATE TABLE messaging.message_delivery (
  message_id          bigint NOT NULL REFERENCES messaging.messages (id) ON DELETE CASCADE,
  recipient_person_id uuid NOT NULL,
  device_id           uuid,
  delivered_at        timestamptz,
  delivery_status     text NOT NULL DEFAULT 'PENDING',
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, recipient_person_id),
  CONSTRAINT chk_message_delivery_status CHECK (delivery_status IN ('PENDING', 'DELIVERED', 'FAILED'))
);

CREATE INDEX idx_message_delivery_recipient ON messaging.message_delivery (recipient_person_id, delivery_status);

-- 6. Read state — one row per (conversation, person), not one row per read
--    event (LLD §12: "more efficient than inserting a row for every read
--    event").
CREATE TABLE messaging.message_read_state (
  conversation_id     uuid NOT NULL REFERENCES messaging.conversations (id) ON DELETE CASCADE,
  person_id           uuid NOT NULL,
  last_read_sequence  bigint NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, person_id)
);

-- 7. Devices (LLD §13). platform matches the mobile app's own real
--    DevicePlatform union (see school-eos-backend's person_device_token
--    migration and mobile's push-token.ts) so a single client integration
--    can register the same platform value in both places consistently.
CREATE TABLE messaging.messaging_devices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id           uuid NOT NULL,
  device_public_key   text NOT NULL,
  device_key_version  integer NOT NULL DEFAULT 1,
  platform            text NOT NULL,
  app_version         text,
  registered_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at          timestamptz,
  status              text NOT NULL DEFAULT 'ACTIVE',
  CONSTRAINT chk_messaging_devices_platform CHECK (platform IN ('ANDROID', 'IOS')),
  CONSTRAINT chk_messaging_devices_status CHECK (status IN ('ACTIVE', 'REVOKED', 'SUSPENDED'))
);

CREATE INDEX idx_messaging_devices_person ON messaging.messaging_devices (person_id, status);

-- 8-10. E2EE public key metadata ONLY (LLD §14/§46-47). Every column here is
--       public material or protocol metadata the server needs to relay
--       correctly -- no private key ever has a column to live in, on any of
--       these three tables, anywhere in this schema.
CREATE TABLE messaging.e2ee_identity_keys (
  device_id            uuid PRIMARY KEY REFERENCES messaging.messaging_devices (id) ON DELETE CASCADE,
  identity_public_key  text NOT NULL,
  algorithm            text NOT NULL DEFAULT 'Ed25519',
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  revoked_at           timestamptz
);

CREATE TABLE messaging.e2ee_signed_prekeys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   uuid NOT NULL REFERENCES messaging.messaging_devices (id) ON DELETE CASCADE,
  public_key  text NOT NULL,
  signature   text NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  status      text NOT NULL DEFAULT 'ACTIVE',
  CONSTRAINT chk_e2ee_signed_prekeys_status CHECK (status IN ('ACTIVE', 'EXPIRED', 'REVOKED'))
);

CREATE INDEX idx_e2ee_signed_prekeys_device ON messaging.e2ee_signed_prekeys (device_id, status);

CREATE TABLE messaging.e2ee_one_time_prekeys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    uuid NOT NULL REFERENCES messaging.messaging_devices (id) ON DELETE CASCADE,
  public_key   text NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'AVAILABLE',
  CONSTRAINT chk_e2ee_one_time_prekeys_status CHECK (status IN ('AVAILABLE', 'CONSUMED'))
);

CREATE INDEX idx_e2ee_one_time_prekeys_device_available
  ON messaging.e2ee_one_time_prekeys (device_id)
  WHERE status = 'AVAILABLE';

-- 11. Attachments (LLD §15/§29/§50). message_id is nullable: the upload-init
--     flow creates this row BEFORE the message referencing it is ever sent
--     (request upload -> authorize -> token -> upload -> scan -> THEN create
--     the message that encrypts a reference to it).
CREATE TABLE messaging.attachments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id          bigint REFERENCES messaging.messages (id) ON DELETE CASCADE,
  storage_object_id   text NOT NULL,
  encrypted_metadata  bytea,
  size_bytes          bigint NOT NULL,
  media_type          text NOT NULL,
  sha256              text NOT NULL,
  scan_status         text NOT NULL DEFAULT 'PENDING',
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_attachments_scan_status CHECK (scan_status IN ('PENDING', 'CLEAN', 'INFECTED', 'FAILED'))
);

CREATE INDEX idx_attachments_message ON messaging.attachments (message_id);

-- 12. Transactional outbox (LLD §16/§27/§30/§56-58). Written in the SAME
--     transaction as the business row it accompanies; a separate worker
--     processes delivery afterward (push notifications, future consumers) --
--     never the other way around.
CREATE TABLE messaging.outbox_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type   text NOT NULL,
  aggregate_id     text NOT NULL,
  event_type       text NOT NULL,
  payload          jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz,
  attempt_count    integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'PENDING',
  last_error       text,
  CONSTRAINT chk_outbox_events_status
    CHECK (status IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'DEAD_LETTER'))
);

CREATE INDEX idx_outbox_events_status_next_attempt ON messaging.outbox_events (status, next_attempt_at);

-- 13. Security/audit events (LLD §17/§59-61). Never a plaintext message body
--     goes into metadata -- enforced at the application layer, not the
--     database, since jsonb can't structurally forbid a specific key.
CREATE TABLE messaging.security_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type       text NOT NULL,
  actor_person_id  uuid,
  device_id        uuid,
  conversation_id  uuid,
  ip_hash          text,
  user_agent_hash  text,
  correlation_id   text NOT NULL,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_security_events_created_type ON messaging.security_events (created_at, event_type);

COMMIT;
