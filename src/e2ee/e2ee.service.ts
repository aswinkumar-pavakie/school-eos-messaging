// E2EE key-metadata boundary (LLD §14/§46-49). This service NEVER receives,
// stores, or could even structurally represent a private key -- every DTO
// and repository row here is public material or protocol metadata only.

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthorizationService } from '../authorization/authorization.service';
import { MESSAGING_ERRORS } from '../common/errors/error-codes';
import { MessagingDevicesRepository } from '../devices/repositories/messaging-devices.repository';
import { verifyEd25519Signature } from './e2ee-signature.util';
import { E2eeKeysRepository } from './repositories/e2ee-keys.repository';

export interface PublishPrekeysInput {
  deviceId: string;
  identityPublicKey?: string;
  signedPrekey?: { publicKey: string; signature: string; expiresAt?: string };
  oneTimePrekeys?: string[];
}

export interface DeviceKeyBundle {
  deviceId: string;
  identityPublicKey: string;
  algorithm: string;
  signedPrekey: { publicKey: string; signature: string } | null;
  oneTimePrekey: string | null;
}

const MAX_ONE_TIME_PREKEYS_PER_BATCH = 200;

@Injectable()
export class E2eeService {
  constructor(
    private readonly keysRepo: E2eeKeysRepository,
    private readonly devicesRepo: MessagingDevicesRepository,
    private readonly authorization: AuthorizationService,
  ) {}

  /** The device owner publishes (or rotates) their own key material -- never
   * anyone else's (LLD §22/§82: "who am I? is this my device?"). */
  async publish(
    actorPersonId: string,
    input: PublishPrekeysInput,
  ): Promise<void> {
    const device = await this.devicesRepo.findById(input.deviceId);
    if (!device || device.personId !== actorPersonId) {
      throw new ForbiddenException({ code: MESSAGING_ERRORS.ACCESS_DENIED });
    }
    if (device.status !== 'ACTIVE') {
      throw new ForbiddenException({ code: MESSAGING_ERRORS.DEVICE_REVOKED });
    }

    if (input.identityPublicKey) {
      await this.keysRepo.upsertIdentityKey(
        input.deviceId,
        input.identityPublicKey,
        'Ed25519',
      );
    }

    if (input.signedPrekey) {
      const identityKey = await this.keysRepo.findIdentityKey(input.deviceId);
      if (!identityKey) {
        throw new BadRequestException({
          code: MESSAGING_ERRORS.KEY_INVALID,
          message: 'Register an identity key before a signed prekey.',
        });
      }
      // The ONE real cryptographic check this backend performs: the signed
      // prekey's signature must actually verify against this device's own
      // identity public key (LLD §46-47) -- never accepted on trust.
      const verified = verifyEd25519Signature(
        input.signedPrekey.publicKey,
        identityKey.identityPublicKey,
        input.signedPrekey.signature,
      );
      if (!verified) {
        throw new BadRequestException({
          code: MESSAGING_ERRORS.KEY_INVALID,
          message: 'Signed prekey signature does not verify.',
        });
      }
      await this.keysRepo.retireActiveSignedPrekeys(input.deviceId);
      await this.keysRepo.createSignedPrekey({
        deviceId: input.deviceId,
        publicKey: input.signedPrekey.publicKey,
        signature: input.signedPrekey.signature,
        expiresAt: input.signedPrekey.expiresAt,
      });
    }

    if (input.oneTimePrekeys && input.oneTimePrekeys.length > 0) {
      if (input.oneTimePrekeys.length > MAX_ONE_TIME_PREKEYS_PER_BATCH) {
        throw new BadRequestException({
          code: MESSAGING_ERRORS.INVALID_PROTOCOL,
          message: 'Too many one-time prekeys in one batch.',
        });
      }
      await this.keysRepo.bulkCreateOneTimePrekeys(
        input.deviceId,
        input.oneTimePrekeys,
      );
    }
  }

  /** The prekey bundle a sender fetches before establishing a new E2EE
   * session (LLD §47). Gated by the SAME authorization decision as sending
   * that person a message at all -- DENY here means no key material leaks to
   * someone with no legitimate path to this person, matching the directory's
   * own "never expose more than authorized" posture. REQUIRE_REQUEST is
   * still allowed through: constructing a request's own initial ciphertext
   * needs the recipient's bundle first (LLD §16's flow: pick a target -> the
   * client encrypts the first message -> THEN calls POST /requests). */
  async getKeyBundleForUser(
    actor: { personId: string; roles: string[] },
    targetPersonId: string,
  ): Promise<DeviceKeyBundle[]> {
    if (actor.personId === targetPersonId) {
      throw new ForbiddenException({ code: MESSAGING_ERRORS.ACCESS_DENIED });
    }
    const decision = await this.authorization.authorizeMessaging(
      actor,
      targetPersonId,
    );
    if (decision === 'DENY') {
      throw new ForbiddenException({ code: MESSAGING_ERRORS.ACCESS_DENIED });
    }

    const devices = await this.devicesRepo.findActiveForPerson(targetPersonId);
    if (devices.length === 0) {
      throw new NotFoundException({
        code: MESSAGING_ERRORS.RECIPIENT_NOT_FOUND,
      });
    }

    const bundles: DeviceKeyBundle[] = [];
    for (const device of devices) {
      const identityKey = await this.keysRepo.findIdentityKey(device.id);
      if (!identityKey || identityKey.revokedAt) continue;
      const signedPrekey = await this.keysRepo.findActiveSignedPrekey(
        device.id,
      );
      const oneTimePrekey = await this.keysRepo.consumeOneOneTimePrekey(
        device.id,
      );
      bundles.push({
        deviceId: device.id,
        identityPublicKey: identityKey.identityPublicKey,
        algorithm: identityKey.algorithm,
        signedPrekey: signedPrekey
          ? {
              publicKey: signedPrekey.publicKey,
              signature: signedPrekey.signature,
            }
          : null,
        oneTimePrekey: oneTimePrekey?.publicKey ?? null,
      });
    }
    return bundles;
  }
}
