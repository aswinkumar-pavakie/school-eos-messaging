-- School EOS Messaging Microservice — adds 'WEB' as a real device platform.
--
-- Additive to 0001_messaging_schema.sql. Runs against the SAME existing,
-- real School EOS Supabase PostgreSQL project — not a new database, not a
-- new schema. NOT executed automatically — run this against the real
-- Supabase database yourself, exactly like 0001/0002, then confirm back so
-- the service can be verified against it.
--
-- Context: the faculty portal website now has its own real, browser-based
-- MLS client (school-eos-website's src/lib/e2ee/*, ported faithfully from
-- the mobile app's own proven implementation) and registers its own
-- messaging_devices row the same way a phone does -- it just isn't a phone,
-- so 'ANDROID'/'IOS' don't fit. This widens the existing CHECK constraint
-- to also allow 'WEB'; no other column or table changes.

ALTER TABLE messaging.messaging_devices
  DROP CONSTRAINT chk_messaging_devices_platform;

ALTER TABLE messaging.messaging_devices
  ADD CONSTRAINT chk_messaging_devices_platform
  CHECK (platform IN ('ANDROID', 'IOS', 'WEB'));
