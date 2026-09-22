import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MESSAGING_ERRORS } from '../common/errors/error-codes';
import { AuditService } from '../audit/audit.service';
import {
  DeviceRow,
  DevicePlatform,
  MessagingDevicesRepository,
} from './repositories/messaging-devices.repository';

@Injectable()
export class DevicesService {
  constructor(
    private readonly devicesRepo: MessagingDevicesRepository,
    private readonly audit: AuditService,
  ) {}

  async register(
    personId: string,
    devicePublicKey: string,
    platform: DevicePlatform,
    appVersion?: string,
  ): Promise<DeviceRow> {
    // V1 scope is explicitly one active messaging device per person (see the
    // mobile messaging plan's own "one active messaging device per person...
    // registering a new device revokes the old one's messaging keys"). Without
    // this, a person who re-registers (e.g. after clearing local app storage,
    // or switching test accounts on one physical phone) accumulates multiple
    // ACTIVE rows -- and getKeyBundleForUser/findActiveForPerson would then
    // hand a message sender an ARBITRARY one of them, including a stale
    // device whose private key material no longer exists anywhere, making
    // the resulting group permanently unjoinable by this person on any real
    // device. Revoking every prior active device before adding the new one
    // keeps "this person's active device" unambiguous, always.
    const priorActiveDevices = await this.devicesRepo.findActiveForPerson(personId);
    for (const prior of priorActiveDevices) {
      await this.devicesRepo.revoke(prior.id);
      await this.audit.record('DEVICE_REVOKED', {
        actorPersonId: personId,
        deviceId: prior.id,
      });
    }

    const device = await this.devicesRepo.register({
      personId,
      devicePublicKey,
      platform,
      appVersion,
    });
    await this.audit.record('DEVICE_REGISTERED', {
      actorPersonId: personId,
      deviceId: device.id,
    });
    return device;
  }

  /** Only the owning person can revoke their own device -- never someone
   * else's, and revoking is idempotent-safe to call again on an
   * already-revoked device (no error, just confirms the end state). */
  async revoke(deviceId: string, actorPersonId: string): Promise<void> {
    const device = await this.devicesRepo.findById(deviceId);
    if (!device)
      throw new NotFoundException({ code: MESSAGING_ERRORS.DEVICE_REVOKED });
    if (device.personId !== actorPersonId) {
      throw new ForbiddenException({ code: MESSAGING_ERRORS.ACCESS_DENIED });
    }
    if (device.status === 'ACTIVE') {
      await this.devicesRepo.revoke(deviceId);
      await this.audit.record('DEVICE_REVOKED', { actorPersonId, deviceId });
    }
  }

  async listMine(personId: string): Promise<DeviceRow[]> {
    return this.devicesRepo.findActiveForPerson(personId);
  }
}
