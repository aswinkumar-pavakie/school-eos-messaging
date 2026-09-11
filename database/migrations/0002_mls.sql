-- School EOS Messaging Microservice — MLS (RFC 9420) support.
--
-- Additive to 0001_messaging_schema.sql. Runs against the SAME existing,
-- real School EOS Supabase PostgreSQL project — not a new database, not a
-- new schema. NOT executed automatically — run this against the real
-- Supabase database yourself, exactly like 0001, then confirm back so the
-- service can be verified against it.
--
-- Context: the mobile client's E2EE design moved from a static X25519
-- prekey-bundle exchange (what 0001's e2ee_* tables modeled) to real MLS
-- (ts-mls) for genuine per-message forward secrecy. This migration adds
-- exactly what MLS needs that the prekey model didn't: a KeyPackage
-- inventory (MLS's equivalent of a prekey bundle, same consume-once
-- lifecycle as e2ee_one_time_prekeys) and a slot to deliver the one MLS
-- Welcome message a new conversation's joining member needs. Everything
-- else -- messages.ciphertext/encryption_version/encryption_header -- is
-- already fully opaque to the server and needs no change: an MLS
-- application message is just bytes in the same column an X25519 message
-- would have been.
--
-- The old e2ee_identity_keys/e2ee_signed_prekeys/e2ee_one_time_prekeys
-- tables from 0001 are deliberately left untouched and unused by the new
-- design -- same "old stays in place, unreachable, remove in a later
-- confirmed pass" discipline used everywhere else in this project.

BEGIN;

-- MLS KeyPackage inventory -- identical lifecycle to e2ee_one_time_prekeys
-- (one row per published KeyPackage, consumed at most once, atomically, via
-- `UPDATE ... SET status = 'CONSUMED' ... WHERE id = (SELECT id FROM ...
-- FOR UPDATE SKIP LOCKED) RETURNING *`). key_package is the base64-encoded
-- `encodeMlsMessage({ keyPackage, wireformat: 'mls_key_package', ... })`
-- output -- opaque to this service either way, same as every other key
-- column in this schema.
CREATE TABLE messaging.e2ee_mls_key_packages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    uuid NOT NULL REFERENCES messaging.messaging_devices (id) ON DELETE CASCADE,
  key_package  text NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'AVAILABLE',
  CONSTRAINT chk_e2ee_mls_key_packages_status CHECK (status IN ('AVAILABLE', 'CONSUMED'))
);

CREATE INDEX idx_e2ee_mls_key_packages_device_available
  ON messaging.e2ee_mls_key_packages (device_id)
  WHERE status = 'AVAILABLE';

-- Welcome delivery -- lives on the joining member's own conversation_members
-- row (never the creator's; a creator never needs a Welcome for a group
-- they created). Retry-safe by design: `mls_welcome` is NOT cleared on
-- fetch, only after the client confirms it has actually joined and durably
-- persisted the resulting group state (see requests/README.md's Welcome
-- lifecycle notes) -- a fetch -> crash -> refetch cycle re-reads the exact
-- same Welcome and is a safe no-op on a client that already joined.
ALTER TABLE messaging.conversation_members
  ADD COLUMN mls_welcome bytea,
  ADD COLUMN mls_welcome_delivered_at timestamptz;

COMMIT;
