// messaging.messaging_devices -- LLD §13/§23. A person may have several
// active devices at once (User -> Device A/B/C); this table's real key is
// device.id, never (person, platform).

import { Injectable } from '@nestjs/common';
import {
  PostgresService,
  Queryable,
} from '../../common/postgres/postgres.service';

export type DeviceStatus = 'ACTIVE' | 'REVOKED' | 'SUSPENDED';
export type DevicePlatform = 'ANDROID' | 'IOS' | 'WEB';

export interface DeviceRow {
  id: string;
  personId: string;
  devicePublicKey: string;
  deviceKeyVersion: number;
  platform: DevicePlatform;
  appVersion: string | null;
  registeredAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  status: DeviceStatus;
}

function mapRow(row: any): DeviceRow {
  return {
    id: row.id,
    personId: row.person_id,
    devicePublicKey: row.device_public_key,
    deviceKeyVersion: Number(row.device_key_version),
    platform: row.platform,
    appVersion: row.app_version,
    registeredAt: row.registered_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    status: row.status,
  };
}

const COLUMNS = `id, person_id, device_public_key, device_key_version, platform, app_version,
  registered_at, last_seen_at, revoked_at, status`;

@Injectable()
export class MessagingDevicesRepository {
  constructor(private readonly postgres: PostgresService) {}

  async register(
    input: {
      personId: string;
      devicePublicKey: string;
      platform: DevicePlatform;
      appVersion?: string;
    },
    executor: Queryable = this.postgres,
  ): Promise<DeviceRow> {
    const { rows } = await executor.query(
      `INSERT INTO messaging.messaging_devices (person_id, device_public_key, platform, app_version)
       VALUES ($1, $2, $3, $4)
       RETURNING ${COLUMNS}`,
      [
        input.personId,
        input.devicePublicKey,
        input.platform,
        input.appVersion ?? null,
      ],
    );
    return mapRow(rows[0]);
  }

  async findById(
    id: string,
    executor: Queryable = this.postgres,
  ): Promise<DeviceRow | null> {
    const { rows } = await executor.query(
      `SELECT ${COLUMNS} FROM messaging.messaging_devices WHERE id = $1`,
      [id],
    );
    return rows.length ? mapRow(rows[0]) : null;
  }

  async findActiveForPerson(
    personId: string,
    executor: Queryable = this.postgres,
  ): Promise<DeviceRow[]> {
    const { rows } = await executor.query(
      `SELECT ${COLUMNS} FROM messaging.messaging_devices WHERE person_id = $1 AND status = 'ACTIVE'`,
      [personId],
    );
    return rows.map(mapRow);
  }

  async revoke(id: string, executor: Queryable = this.postgres): Promise<void> {
    await executor.query(
      `UPDATE messaging.messaging_devices SET status = 'REVOKED', revoked_at = now() WHERE id = $1`,
      [id],
    );
  }

  async touchLastSeen(
    id: string,
    executor: Queryable = this.postgres,
  ): Promise<void> {
    await executor.query(
      `UPDATE messaging.messaging_devices SET last_seen_at = now() WHERE id = $1`,
      [id],
    );
  }
}
