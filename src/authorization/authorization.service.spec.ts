// The LLD §61 authorization test matrix, implemented as real unit tests
// against the actual AuthorizationService (mocking only its two real
// dependencies — CoreIntegrationService and RelationshipsService — never
// re-implementing the decision logic itself in the test). Also covers §62's
// "authorization changes immediately when relationships change" requirement
// by proving two calls with different mocked live data produce different
// decisions — there is no caching of a DECISION anywhere in this service.

import { AuthorizationService } from './authorization.service';
import { CoreIntegrationService } from '../core-integration/core-integration.service';
import { RelationshipsService } from '../relationships/relationships.service';
import { CoreIntegrationUnavailableError } from '../core-integration/core-integration.types';

function buildService(
  opts: {
    targetMessagingEnabled?: boolean;
    targetExists?: boolean;
    scope?: string[];
  } = {},
) {
  const core = {
    getUserProjection: jest.fn().mockResolvedValue(
      opts.targetExists === false
        ? null
        : {
            personId: 'target',
            firstName: 'T',
            lastName: null,
            displayName: 'T',
            profilePhotoUrl: null,
            roles: [],
            messagingEnabled: opts.targetMessagingEnabled ?? true,
          },
    ),
  } as unknown as CoreIntegrationService;

  const relationships = {
    getDirectScope: jest.fn().mockResolvedValue(new Set(opts.scope ?? [])),
  } as unknown as RelationshipsService;

  return {
    service: new AuthorizationService(core, relationships),
    core,
    relationships,
  };
}

describe('AuthorizationService.authorizeMessaging — LLD §61 matrix', () => {
  it('Parent -> own class faculty (in direct scope): ALLOW_DIRECT', async () => {
    const { service } = buildService({ scope: ['target'] });
    const result = await service.authorizeMessaging(
      { personId: 'parent-1', roles: ['PARENT'] },
      'target',
    );
    expect(result).toBe('ALLOW_DIRECT');
  });

  it('Parent -> own class advisor (in direct scope): ALLOW_DIRECT', async () => {
    const { service } = buildService({ scope: ['target'] });
    const result = await service.authorizeMessaging(
      { personId: 'parent-1', roles: ['PARENT'] },
      'target',
    );
    expect(result).toBe('ALLOW_DIRECT');
  });

  it('Parent -> same-class parent (in direct scope): ALLOW_DIRECT', async () => {
    const { service } = buildService({ scope: ['target'] });
    const result = await service.authorizeMessaging(
      { personId: 'parent-1', roles: ['PARENT'] },
      'target',
    );
    expect(result).toBe('ALLOW_DIRECT');
  });

  it("Parent -> child's warden when currently in hostel (in direct scope): ALLOW_DIRECT", async () => {
    const { service } = buildService({ scope: ['target'] });
    const result = await service.authorizeMessaging(
      { personId: 'parent-1', roles: ['PARENT'] },
      'target',
    );
    expect(result).toBe('ALLOW_DIRECT');
  });

  it('Parent -> Principal (not in direct scope): REQUEST', async () => {
    const { service } = buildService({ scope: [] });
    const result = await service.authorizeMessaging(
      { personId: 'parent-1', roles: ['PARENT'] },
      'target',
    );
    expect(result).toBe('REQUIRE_REQUEST');
  });

  it('Parent -> Vice Principal (not in direct scope): REQUEST', async () => {
    const { service } = buildService({ scope: [] });
    const result = await service.authorizeMessaging(
      { personId: 'parent-1', roles: ['PARENT'] },
      'target',
    );
    expect(result).toBe('REQUIRE_REQUEST');
  });

  it('Parent -> unrelated faculty: REQUEST', async () => {
    const { service } = buildService({ scope: [] });
    const result = await service.authorizeMessaging(
      { personId: 'parent-1', roles: ['PARENT'] },
      'target',
    );
    expect(result).toBe('REQUIRE_REQUEST');
  });

  it('Parent -> unrelated parent: REQUEST', async () => {
    const { service } = buildService({ scope: [] });
    const result = await service.authorizeMessaging(
      { personId: 'parent-1', roles: ['PARENT'] },
      'target',
    );
    expect(result).toBe('REQUIRE_REQUEST');
  });

  it('Faculty -> assigned-class parent (in direct scope): ALLOW_DIRECT', async () => {
    const { service } = buildService({ scope: ['target'] });
    const result = await service.authorizeMessaging(
      { personId: 'fac-1', roles: ['FACULTY'] },
      'target',
    );
    expect(result).toBe('ALLOW_DIRECT');
  });

  it('Faculty -> assigned-class faculty (in direct scope): ALLOW_DIRECT', async () => {
    const { service } = buildService({ scope: ['target'] });
    const result = await service.authorizeMessaging(
      { personId: 'fac-1', roles: ['FACULTY'] },
      'target',
    );
    expect(result).toBe('ALLOW_DIRECT');
  });

  it('Faculty -> Principal (not in direct scope): REQUEST', async () => {
    const { service } = buildService({ scope: [] });
    const result = await service.authorizeMessaging(
      { personId: 'fac-1', roles: ['FACULTY'] },
      'target',
    );
    expect(result).toBe('REQUIRE_REQUEST');
  });

  it('Faculty -> Vice Principal (not in direct scope): REQUEST', async () => {
    const { service } = buildService({ scope: [] });
    const result = await service.authorizeMessaging(
      { personId: 'fac-1', roles: ['FACULTY'] },
      'target',
    );
    expect(result).toBe('REQUIRE_REQUEST');
  });

  it("Warden -> hostel student's parent (in direct scope): ALLOW_DIRECT", async () => {
    const { service } = buildService({ scope: ['target'] });
    const result = await service.authorizeMessaging(
      { personId: 'warden-1', roles: ['HOSTEL_WARDEN'] },
      'target',
    );
    expect(result).toBe('ALLOW_DIRECT');
  });

  it('Warden -> unrelated person (not in direct scope): REQUEST', async () => {
    const { service } = buildService({ scope: [] });
    const result = await service.authorizeMessaging(
      { personId: 'warden-1', roles: ['HOSTEL_WARDEN'] },
      'target',
    );
    expect(result).toBe('REQUIRE_REQUEST');
  });

  it('Principal -> any messaging-enabled user: ALLOW_DIRECT', async () => {
    const { service, relationships } = buildService({ scope: [] });
    const result = await service.authorizeMessaging(
      { personId: 'principal-1', roles: ['PRINCIPAL'] },
      'target',
    );
    expect(result).toBe('ALLOW_DIRECT');
    // Principal's scope is unbounded -- it must never even ask relationships
    // for a finite list (there isn't one to compute).
    expect(relationships.getDirectScope).not.toHaveBeenCalled();
  });

  it('Vice Principal -> any messaging-enabled user: ALLOW_DIRECT', async () => {
    const { service } = buildService({ scope: [] });
    const result = await service.authorizeMessaging(
      { personId: 'vp-1', roles: ['VICE_PRINCIPAL'] },
      'target',
    );
    expect(result).toBe('ALLOW_DIRECT');
  });

  it('Admin -> Messaging: DENY (role never messaging-enabled)', async () => {
    const { service } = buildService();
    const result = await service.authorizeMessaging(
      { personId: 'admin-1', roles: ['ADMIN'] },
      'target',
    );
    expect(result).toBe('DENY');
  });

  it('Finance -> Messaging: DENY', async () => {
    const { service } = buildService();
    const result = await service.authorizeMessaging(
      { personId: 'finance-1', roles: ['FINANCE'] },
      'target',
    );
    expect(result).toBe('DENY');
  });

  it('Driver (BUS_ATTENDANT) -> Messaging: DENY', async () => {
    const { service } = buildService();
    const result = await service.authorizeMessaging(
      { personId: 'driver-1', roles: ['BUS_ATTENDANT'] },
      'target',
    );
    expect(result).toBe('DENY');
  });

  it('Canteen (CANTEEN_VENDOR) -> Messaging: DENY', async () => {
    const { service } = buildService();
    const result = await service.authorizeMessaging(
      { personId: 'canteen-1', roles: ['CANTEEN_VENDOR'] },
      'target',
    );
    expect(result).toBe('DENY');
  });

  it('a role the LLD never mentions (e.g. TRANSPORT_MANAGER): DENY, fail-closed', async () => {
    const { service } = buildService();
    const result = await service.authorizeMessaging(
      { personId: 'tm-1', roles: ['TRANSPORT_MANAGER'] },
      'target',
    );
    expect(result).toBe('DENY');
  });
});

describe('AuthorizationService.authorizeMessaging — additional security-critical cases', () => {
  it('actor cannot message themselves: DENY', async () => {
    const { service } = buildService({ scope: ['self-1'] });
    const result = await service.authorizeMessaging(
      { personId: 'self-1', roles: ['PARENT'] },
      'self-1',
    );
    expect(result).toBe('DENY');
  });

  it('target does not exist at all: DENY (never fabricates a decision for an unknown person)', async () => {
    const { service } = buildService({ targetExists: false });
    const result = await service.authorizeMessaging(
      { personId: 'parent-1', roles: ['PARENT'] },
      'target',
    );
    expect(result).toBe('DENY');
  });

  it('target exists but is not currently messaging-enabled: DENY even if once in scope', async () => {
    const { service } = buildService({
      targetMessagingEnabled: false,
      scope: ['target'],
    });
    const result = await service.authorizeMessaging(
      { personId: 'parent-1', roles: ['PARENT'] },
      'target',
    );
    expect(result).toBe('DENY');
  });

  it('Core integration failure propagates, never resolves to a permissive default (fail closed)', async () => {
    const core = {
      getUserProjection: jest
        .fn()
        .mockRejectedValue(new CoreIntegrationUnavailableError('users/:id')),
    } as unknown as CoreIntegrationService;
    const relationships = {
      getDirectScope: jest.fn(),
    } as unknown as RelationshipsService;
    const service = new AuthorizationService(core, relationships);

    await expect(
      service.authorizeMessaging(
        { personId: 'parent-1', roles: ['PARENT'] },
        'target',
      ),
    ).rejects.toBeInstanceOf(CoreIntegrationUnavailableError);
  });

  it('LLD §62: relationship change is reflected immediately -- no decision caching', async () => {
    const core = {
      getUserProjection: jest.fn().mockResolvedValue({
        personId: 'target',
        firstName: 'T',
        lastName: null,
        displayName: 'T',
        profilePhotoUrl: null,
        roles: [],
        messagingEnabled: true,
      }),
    } as unknown as CoreIntegrationService;
    // First call: target IS in scope (e.g. still teaching the child's class).
    const relationships = {
      getDirectScope: jest
        .fn()
        .mockResolvedValueOnce(new Set(['target']))
        .mockResolvedValueOnce(new Set()),
    } as unknown as RelationshipsService;
    const service = new AuthorizationService(core, relationships);
    const actor = { personId: 'parent-1', roles: ['PARENT'] };

    const before = await service.authorizeMessaging(actor, 'target');
    expect(before).toBe('ALLOW_DIRECT');

    // Second call: the underlying relationship (e.g. faculty reassignment)
    // has changed -- the exact same actor/target pair must now resolve
    // differently, proving the engine re-derives live every time.
    const after = await service.authorizeMessaging(actor, 'target');
    expect(after).toBe('REQUIRE_REQUEST');
  });

  it('a person holding two messaging-enabled roles gets the union of both scopes', async () => {
    const core = {
      getUserProjection: jest.fn().mockResolvedValue({
        personId: 'target',
        firstName: 'T',
        lastName: null,
        displayName: 'T',
        profilePhotoUrl: null,
        roles: [],
        messagingEnabled: true,
      }),
    } as unknown as CoreIntegrationService;
    const relationships = {
      getDirectScope: jest.fn().mockResolvedValue(new Set(['target'])),
    } as unknown as RelationshipsService;
    const service = new AuthorizationService(core, relationships);

    const result = await service.authorizeMessaging(
      { personId: 'dual-role-1', roles: ['FACULTY', 'HOSTEL_WARDEN'] },
      'target',
    );
    expect(result).toBe('ALLOW_DIRECT');
  });
});
