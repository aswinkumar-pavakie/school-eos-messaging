// E2eeService.publishMlsKeyPackages -- the same ownership/active-device
// authorization guard as publish() (LLD §22/§82: "who am I? is this my
// device?"), covered here since no prior E2eeService spec existed.

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { E2eeService } from './e2ee.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { MessagingDevicesRepository } from '../devices/repositories/messaging-devices.repository';
import { E2eeKeysRepository } from './repositories/e2ee-keys.repository';

const OWNER = 'owner-1';
const STRANGER = 'stranger-1';
const DEVICE_ID = 'device-1';

function buildService(device: any) {
  const keysRepo = {
    bulkCreateMlsKeyPackages: jest.fn().mockResolvedValue(['kp-1', 'kp-2']),
  } as unknown as E2eeKeysRepository;
  const devicesRepo = {
    findById: jest.fn().mockResolvedValue(device),
  } as unknown as MessagingDevicesRepository;
  const authorization = {} as unknown as AuthorizationService;

  const service = new E2eeService(keysRepo, devicesRepo, authorization);
  return { service, keysRepo, devicesRepo };
}

describe('E2eeService.publishMlsKeyPackages', () => {
  it('the device owner can publish, and gets back the created ids in order', async () => {
    const { service, keysRepo } = buildService({
      id: DEVICE_ID,
      personId: OWNER,
      status: 'ACTIVE',
    });
    const ids = await service.publishMlsKeyPackages(OWNER, DEVICE_ID, [
      'kp-data-1',
      'kp-data-2',
    ]);
    expect(ids).toEqual(['kp-1', 'kp-2']);
    expect(keysRepo.bulkCreateMlsKeyPackages).toHaveBeenCalledWith(
      DEVICE_ID,
      ['kp-data-1', 'kp-data-2'],
    );
  });

  it('someone else cannot publish KeyPackages for a device they do not own', async () => {
    const { service } = buildService({
      id: DEVICE_ID,
      personId: OWNER,
      status: 'ACTIVE',
    });
    await expect(
      service.publishMlsKeyPackages(STRANGER, DEVICE_ID, ['kp-data-1']),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a revoked device cannot publish new KeyPackages', async () => {
    const { service } = buildService({
      id: DEVICE_ID,
      personId: OWNER,
      status: 'REVOKED',
    });
    await expect(
      service.publishMlsKeyPackages(OWNER, DEVICE_ID, ['kp-data-1']),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a nonexistent device is rejected the same as an unowned one', async () => {
    const { service } = buildService(null);
    await expect(
      service.publishMlsKeyPackages(OWNER, DEVICE_ID, ['kp-data-1']),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects an oversized batch before ever touching the repository', async () => {
    const { service, keysRepo } = buildService({
      id: DEVICE_ID,
      personId: OWNER,
      status: 'ACTIVE',
    });
    const oversized = Array.from({ length: 201 }, (_, i) => `kp-${i}`);
    await expect(
      service.publishMlsKeyPackages(OWNER, DEVICE_ID, oversized),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(keysRepo.bulkCreateMlsKeyPackages).not.toHaveBeenCalled();
  });
});
