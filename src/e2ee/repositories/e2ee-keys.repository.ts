// The three E2EE public-key-metadata tables (LLD §14/§46-49) -- public
// material and protocol metadata only, never a private key column exists
// anywhere in this file's own SQL.

import { Injectable } from '@nestjs/common';
import {
  PostgresService,
  Queryable,
} from '../../common/postgres/postgres.service';

export interface IdentityKeyRow {
  deviceId: string;
  identityPublicKey: string;
  algorithm: string;
  version: number;
  revokedAt: string | null;
}

export interface SignedPrekeyRow {
  id: string;
  deviceId: string;
  publicKey: string;
  signature: string;
  version: number;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
}

export interface OneTimePrekeyRow {
  id: string;
  deviceId: string;
  publicKey: string;
  status: 'AVAILABLE' | 'CONSUMED';
}

export interface MlsKeyPackageRow {
  id: string;
  deviceId: string;
  keyPackage: string;
  status: 'AVAILABLE' | 'CONSUMED';
}

@Injectable()
export class E2eeKeysRepository {
  constructor(private readonly postgres: PostgresService) {}

  async upsertIdentityKey(
    deviceId: string,
    identityPublicKey: string,
    algorithm: string,
    executor: Queryable = this.postgres,
  ): Promise<IdentityKeyRow> {
    const { rows } = await executor.query(
      `INSERT INTO messaging.e2ee_identity_keys (device_id, identity_public_key, algorithm)
       VALUES ($1, $2, $3)
       ON CONFLICT (device_id) DO UPDATE
         SET identity_public_key = EXCLUDED.identity_public_key, algorithm = EXCLUDED.algorithm,
             version = messaging.e2ee_identity_keys.version + 1, revoked_at = NULL
       RETURNING device_id, identity_public_key, algorithm, version, revoked_at`,
      [deviceId, identityPublicKey, algorithm],
    );
    const row = rows[0];
    return {
      deviceId: row.device_id,
      identityPublicKey: row.identity_public_key,
      algorithm: row.algorithm,
      version: Number(row.version),
      revokedAt: row.revoked_at,
    };
  }

  async findIdentityKey(
    deviceId: string,
    executor: Queryable = this.postgres,
  ): Promise<IdentityKeyRow | null> {
    const { rows } = await executor.query(
      `SELECT device_id, identity_public_key, algorithm, version, revoked_at
       FROM messaging.e2ee_identity_keys WHERE device_id = $1`,
      [deviceId],
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      deviceId: row.device_id,
      identityPublicKey: row.identity_public_key,
      algorithm: row.algorithm,
      version: Number(row.version),
      revokedAt: row.revoked_at,
    };
  }

  async createSignedPrekey(
    input: {
      deviceId: string;
      publicKey: string;
      signature: string;
      expiresAt?: string;
    },
    executor: Queryable = this.postgres,
  ): Promise<SignedPrekeyRow> {
    const { rows } = await executor.query(
      `INSERT INTO messaging.e2ee_signed_prekeys (device_id, public_key, signature, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, device_id, public_key, signature, version, status`,
      [
        input.deviceId,
        input.publicKey,
        input.signature,
        input.expiresAt ?? null,
      ],
    );
    return mapSignedPrekey(rows[0]);
  }

  /** Retires every currently-ACTIVE signed prekey for this device -- called
   * right before creating a new one, so a device never has more than one
   * ACTIVE signed prekey at a time (LLD §48: signed pre-key rotation). */
  async retireActiveSignedPrekeys(
    deviceId: string,
    executor: Queryable = this.postgres,
  ): Promise<void> {
    await executor.query(
      `UPDATE messaging.e2ee_signed_prekeys SET status = 'EXPIRED' WHERE device_id = $1 AND status = 'ACTIVE'`,
      [deviceId],
    );
  }

  async findActiveSignedPrekey(
    deviceId: string,
    executor: Queryable = this.postgres,
  ): Promise<SignedPrekeyRow | null> {
    const { rows } = await executor.query(
      `SELECT id, device_id, public_key, signature, version, status
       FROM messaging.e2ee_signed_prekeys WHERE device_id = $1 AND status = 'ACTIVE'
       ORDER BY created_at DESC LIMIT 1`,
      [deviceId],
    );
    return rows.length ? mapSignedPrekey(rows[0]) : null;
  }

  async bulkCreateOneTimePrekeys(
    deviceId: string,
    publicKeys: string[],
    executor: Queryable = this.postgres,
  ): Promise<number> {
    if (publicKeys.length === 0) return 0;
    const values = publicKeys.map((_, i) => `($1, $${i + 2})`).join(', ');
    const { rowCount } = await executor.query(
      `INSERT INTO messaging.e2ee_one_time_prekeys (device_id, public_key) VALUES ${values}`,
      [deviceId, ...publicKeys],
    );
    return rowCount ?? 0;
  }

  /** Atomically claims and consumes ONE available one-time prekey for this
   * device -- the UPDATE...RETURNING pattern (not a separate SELECT then
   * UPDATE) is what makes two concurrent callers never receive the same
   * prekey (LLD §45: concurrency-safe by construction, not by a hand-rolled
   * lock). Returns null if none are left (a real, honest "replenish needed"
   * state, never fabricated). */
  async consumeOneOneTimePrekey(
    deviceId: string,
    executor: Queryable = this.postgres,
  ): Promise<OneTimePrekeyRow | null> {
    const { rows } = await executor.query(
      `UPDATE messaging.e2ee_one_time_prekeys
       SET status = 'CONSUMED', consumed_at = now()
       WHERE id = (
         SELECT id FROM messaging.e2ee_one_time_prekeys
         WHERE device_id = $1 AND status = 'AVAILABLE'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, device_id, public_key, status`,
      [deviceId],
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      id: row.id,
      deviceId: row.device_id,
      publicKey: row.public_key,
      status: row.status,
    };
  }

  async countAvailableOneTimePrekeys(
    deviceId: string,
    executor: Queryable = this.postgres,
  ): Promise<number> {
    const { rows } = await executor.query(
      `SELECT count(*)::int AS count FROM messaging.e2ee_one_time_prekeys WHERE device_id = $1 AND status = 'AVAILABLE'`,
      [deviceId],
    );
    return rows[0].count;
  }

  /** Publishes a batch of MLS KeyPackages -- same shape as
   * bulkCreateOneTimePrekeys, but RETURNING the created ids in submission
   * order: the client must durably map each server-assigned id to its own
   * local private KeyPackage material, so (unlike a plain prekey) it needs
   * that id back. */
  async bulkCreateMlsKeyPackages(
    deviceId: string,
    keyPackages: string[],
    executor: Queryable = this.postgres,
  ): Promise<string[]> {
    if (keyPackages.length === 0) return [];
    const values = keyPackages.map((_, i) => `($1, $${i + 2})`).join(', ');
    const { rows } = await executor.query(
      `INSERT INTO messaging.e2ee_mls_key_packages (device_id, key_package) VALUES ${values}
       RETURNING id`,
      [deviceId, ...keyPackages],
    );
    return rows.map((row) => row.id);
  }

  /** Atomically claims and consumes ONE available MLS KeyPackage for this
   * device -- identical concurrency-safety pattern to
   * consumeOneOneTimePrekey (UPDATE...RETURNING, not SELECT-then-UPDATE).
   * Returns null if none are left (a real "replenish needed" state). */
  async consumeOneMlsKeyPackage(
    deviceId: string,
    executor: Queryable = this.postgres,
  ): Promise<MlsKeyPackageRow | null> {
    const { rows } = await executor.query(
      `UPDATE messaging.e2ee_mls_key_packages
       SET status = 'CONSUMED', consumed_at = now()
       WHERE id = (
         SELECT id FROM messaging.e2ee_mls_key_packages
         WHERE device_id = $1 AND status = 'AVAILABLE'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, device_id, key_package, status`,
      [deviceId],
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      id: row.id,
      deviceId: row.device_id,
      keyPackage: row.key_package,
      status: row.status,
    };
  }

  async countAvailableMlsKeyPackages(
    deviceId: string,
    executor: Queryable = this.postgres,
  ): Promise<number> {
    const { rows } = await executor.query(
      `SELECT count(*)::int AS count FROM messaging.e2ee_mls_key_packages WHERE device_id = $1 AND status = 'AVAILABLE'`,
      [deviceId],
    );
    return rows[0].count;
  }
}

function mapSignedPrekey(row: any): SignedPrekeyRow {
  return {
    id: row.id,
    deviceId: row.device_id,
    publicKey: row.public_key,
    signature: row.signature,
    version: Number(row.version),
    status: row.status,
  };
}
