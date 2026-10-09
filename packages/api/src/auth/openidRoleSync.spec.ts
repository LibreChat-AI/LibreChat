import { SystemRoles } from 'librechat-data-provider';
import {
  getOpenIdRoleSyncOptions,
  getOpenIdRolesForOpenIdSync,
  getLibreChatRolesForOpenIdSync,
  selectOpenIdRole,
} from './openidRoleSync';

describe('getOpenIdRoleSyncOptions', () => {
  it('defaults role sync and API role sync to disabled', () => {
    expect(getOpenIdRoleSyncOptions({})).toEqual({
      enabled: false,
      apiEnabled: false,
      claimSource: 'id',
      claim: undefined,
      rolePriority: [],
      fallbackRole: undefined,
    });
  });

  it('parses enabled config and comma-separated priority roles', () => {
    expect(
      getOpenIdRoleSyncOptions({
        OPENID_ROLE_SYNC_ENABLED: 'true',
        OPENID_ROLE_SYNC_API_ENABLED: 'true',
        OPENID_ROLE_SYNC_SOURCE: 'access',
        OPENID_ROLE_SYNC_CLAIM: 'roles',
        OPENID_ROLE_SYNC_ROLE_PRIORITY: 'STANDARD-USER, BASIC-USER',
        OPENID_ROLE_SYNC_FALLBACK_ROLE: SystemRoles.USER,
      }),
    ).toEqual({
      enabled: true,
      apiEnabled: true,
      claimSource: 'access',
      claim: 'roles',
      rolePriority: ['STANDARD-USER', 'BASIC-USER'],
      fallbackRole: SystemRoles.USER,
    });
  });

  it('requires claim when role sync is enabled', () => {
    expect(() => getOpenIdRoleSyncOptions({ OPENID_ROLE_SYNC_ENABLED: 'true' })).toThrow(
      'OPENID_ROLE_SYNC_CLAIM is required',
    );
  });

  it('rejects invalid claim sources when enabled', () => {
    expect(() =>
      getOpenIdRoleSyncOptions({
        OPENID_ROLE_SYNC_ENABLED: 'true',
        OPENID_ROLE_SYNC_CLAIM: 'roles',
        OPENID_ROLE_SYNC_SOURCE: 'profile',
      }),
    ).toThrow('OPENID_ROLE_SYNC_SOURCE must be one of');
  });

  it('ignores role-sync-specific settings when the feature is disabled', () => {
    expect(
      getOpenIdRoleSyncOptions({
        OPENID_ROLE_SYNC_SOURCE: 'profile',
        OPENID_ROLE_SYNC_ROLE_PRIORITY: SystemRoles.ADMIN,
        OPENID_ROLE_SYNC_FALLBACK_ROLE: SystemRoles.ADMIN,
      }),
    ).toMatchObject({ enabled: false, apiEnabled: false });
  });

  it('rejects API role sync when global role sync is disabled', () => {
    expect(() =>
      getOpenIdRoleSyncOptions({
        OPENID_ROLE_SYNC_API_ENABLED: 'true',
      }),
    ).toThrow('OPENID_ROLE_SYNC_API_ENABLED requires OPENID_ROLE_SYNC_ENABLED=true');
  });

  it('rejects ADMIN in role priority and fallback role when enabled', () => {
    expect(() =>
      getOpenIdRoleSyncOptions({
        OPENID_ROLE_SYNC_ENABLED: 'true',
        OPENID_ROLE_SYNC_CLAIM: 'roles',
        OPENID_ROLE_SYNC_ROLE_PRIORITY: `STANDARD-USER,${SystemRoles.ADMIN}`,
      }),
    ).toThrow('OPENID_ROLE_SYNC_ROLE_PRIORITY cannot include ADMIN');

    expect(() =>
      getOpenIdRoleSyncOptions({
        OPENID_ROLE_SYNC_ENABLED: 'true',
        OPENID_ROLE_SYNC_CLAIM: 'roles',
        OPENID_ROLE_SYNC_FALLBACK_ROLE: SystemRoles.ADMIN,
      }),
    ).toThrow('OPENID_ROLE_SYNC_FALLBACK_ROLE cannot be ADMIN');
  });
});

describe('getOpenIdRolesForOpenIdSync', () => {
  const options = {
    enabled: true,
    apiEnabled: false,
    claimSource: 'id' as const,
    claim: 'roles',
    rolePriority: ['STANDARD-USER'],
  };

  it('extracts a configured claim from the selected source', async () => {
    await expect(
      getOpenIdRolesForOpenIdSync({
        options,
        idToken: 'id-token',
        decodeToken: () => ({ roles: ['STANDARD-USER'] }),
      }),
    ).resolves.toEqual(['STANDARD-USER']);
  });

  it('returns an empty list when the source lacks a usable claim value (applies fallback)', async () => {
    await expect(
      getOpenIdRolesForOpenIdSync({
        options,
        idToken: 'id-token',
        decodeToken: () => ({ roles: { STANDARD_USER: true } }),
      }),
    ).resolves.toEqual([]);
  });

  it('returns undefined when no token source is available (skips sync)', async () => {
    await expect(
      getOpenIdRolesForOpenIdSync({
        options,
        decodeToken: () => ({ roles: ['STANDARD-USER'] }),
      }),
    ).resolves.toBeUndefined();
  });

  it('uses overage resolution for id token groups', async () => {
    await expect(
      getOpenIdRolesForOpenIdSync({
        options: { ...options, claim: 'groups' },
        idToken: 'id-token',
        decodeToken: () => ({ hasgroups: true }),
        resolveGroupOverage: async () => ['group-a'],
      }),
    ).resolves.toEqual(['group-a']);
  });

  it('decodes only the configured access token source', async () => {
    const decodeToken = jest.fn((token: string) => ({ token }));

    await expect(
      getOpenIdRolesForOpenIdSync({
        options: { ...options, claimSource: 'access' },
        accessToken: 'access-token',
        idToken: 'id-token',
        decodeToken,
      }),
    ).resolves.toEqual([]);
    expect(decodeToken).toHaveBeenCalledTimes(1);
  });

  it('resolves group overage from an access token source (not just id)', async () => {
    await expect(
      getOpenIdRolesForOpenIdSync({
        options: { ...options, claimSource: 'access', claim: 'groups' },
        accessClaims: {
          _claim_names: { groups: 'src1' },
          _claim_sources: { src1: { endpoint: 'https://graph' } },
        },
        decodeToken: () => ({}),
        resolveGroupOverage: async () => ['group-a'],
      }),
    ).resolves.toEqual(['group-a']);
  });

  it('uses claims for the id source when no id token is available', async () => {
    const decodeToken = jest.fn();
    const claims = { roles: ['STANDARD-USER'] };

    await expect(
      getOpenIdRolesForOpenIdSync({
        options,
        claims,
        decodeToken,
      }),
    ).resolves.toEqual(['STANDARD-USER']);
    expect(decodeToken).not.toHaveBeenCalled();
  });

  it('uses userinfo directly for the userinfo source', async () => {
    const userinfo = { roles: ['STANDARD-USER'] };

    await expect(
      getOpenIdRolesForOpenIdSync({
        options: { ...options, claimSource: 'userinfo' },
        userinfo,
        decodeToken: jest.fn(),
      }),
    ).resolves.toEqual(['STANDARD-USER']);
  });
});

describe('getLibreChatRolesForOpenIdSync', () => {
  it('deduplicates configured roles and returns canonical role names', async () => {
    const getRolesByNames = jest.fn(async (roleNames: string[]) =>
      roleNames.map((roleName) => ({
        name: roleName.toLowerCase() === 'standard-user' ? 'STANDARD-USER' : roleName,
      })),
    );

    await expect(
      getLibreChatRolesForOpenIdSync({
        getRolesByNames,
        rolePriority: [' standard-user ', 'STANDARD-USER'],
        fallbackRole: SystemRoles.USER,
      }),
    ).resolves.toEqual({
      rolePriority: ['STANDARD-USER', 'STANDARD-USER'],
      fallbackRole: SystemRoles.USER,
    });
    expect(getRolesByNames).toHaveBeenCalledTimes(1);
    expect(getRolesByNames).toHaveBeenCalledWith(['standard-user', SystemRoles.USER], 'name');
  });

  it('rejects configured roles that do not exist', async () => {
    const getRolesByNames = jest.fn(async (roleNames: string[]) =>
      roleNames
        .filter((roleName) => roleName !== 'MISSING')
        .map((roleName) => ({ name: roleName })),
    );

    await expect(
      getLibreChatRolesForOpenIdSync({
        getRolesByNames,
        rolePriority: ['STANDARD-USER', 'MISSING'],
        logPrefix: '[openidStrategy]',
      }),
    ).rejects.toThrow('[openidStrategy] OpenID role sync configured roles do not exist: MISSING');
  });

  it('accepts a system fallback role even when a tenant-scoped lookup omits it', async () => {
    // Tenant-scoped getRolesByNames returns only the tenant's own roles, not the
    // globally-provisioned system USER role.
    const getRolesByNames = jest.fn(async (roleNames: string[]) =>
      roleNames
        .filter((roleName) => roleName === 'STANDARD-USER')
        .map((roleName) => ({ name: roleName })),
    );

    await expect(
      getLibreChatRolesForOpenIdSync({
        getRolesByNames,
        rolePriority: ['STANDARD-USER'],
        fallbackRole: SystemRoles.USER,
      }),
    ).resolves.toEqual({
      rolePriority: ['STANDARD-USER'],
      fallbackRole: SystemRoles.USER,
    });
  });
});

describe('selectOpenIdRole', () => {
  it('selects the highest-priority configured role from matching OpenID values', () => {
    expect(
      selectOpenIdRole({
        currentRole: SystemRoles.USER,
        openIdRoleValues: 'BASIC-USER STANDARD-USER',
        rolePriority: ['STANDARD-USER', 'BASIC-USER'],
      }),
    ).toEqual({
      selectedRole: 'STANDARD-USER',
      reason: 'matched_priority',
    });
  });

  it('matches roles case-insensitively and returns the configured canonical role name', () => {
    expect(
      selectOpenIdRole({
        openIdRoleValues: ['standard-user'],
        rolePriority: ['STANDARD-USER'],
      }).selectedRole,
    ).toBe('STANDARD-USER');
  });

  it('uses rolePriority as the ordered assignable role list', () => {
    expect(
      selectOpenIdRole({
        currentRole: 'BASIC-USER',
        openIdRoleValues: ['BASIC-USER', 'STANDARD-USER'],
        rolePriority: ['BASIC-USER', 'STANDARD-USER'],
      }),
    ).toEqual({
      selectedRole: 'BASIC-USER',
      reason: 'matched_priority',
    });
  });

  it('ignores token values that are not in rolePriority or fallbackRole', () => {
    expect(
      selectOpenIdRole({
        currentRole: SystemRoles.USER,
        openIdRoleValues: ['BASIC-USER', 'STANDARD-USER'],
        rolePriority: [],
      }),
    ).toEqual({
      reason: 'no_matching_role',
    });
  });

  it('applies fallback only when no configured role matches', () => {
    expect(
      selectOpenIdRole({
        currentRole: 'BASIC-USER',
        openIdRoleValues: ['UNKNOWN'],
        rolePriority: ['BASIC-USER'],
        fallbackRole: SystemRoles.USER,
      }),
    ).toEqual({
      selectedRole: SystemRoles.USER,
      reason: 'fallback',
    });
  });

  it('does not apply fallback when a priority role already matches', () => {
    expect(
      selectOpenIdRole({
        openIdRoleValues: ['BASIC-USER'],
        rolePriority: ['BASIC-USER'],
        fallbackRole: SystemRoles.USER,
      }),
    ).toEqual({
      selectedRole: 'BASIC-USER',
      reason: 'matched_priority',
    });
  });

  it('keeps the current fallback role when it is present in the OpenID values', () => {
    expect(
      selectOpenIdRole({
        currentRole: SystemRoles.USER,
        openIdRoleValues: [SystemRoles.USER],
        rolePriority: ['BASIC-USER'],
        fallbackRole: SystemRoles.USER,
      }),
    ).toEqual({
      selectedRole: SystemRoles.USER,
      reason: 'kept_current',
    });
  });

  it('does not keep a current role that is outside rolePriority and fallbackRole', () => {
    expect(
      selectOpenIdRole({
        currentRole: 'LOCAL-ROLE',
        openIdRoleValues: ['LOCAL-ROLE'],
        rolePriority: ['STANDARD-USER'],
        fallbackRole: SystemRoles.USER,
      }),
    ).toEqual({
      selectedRole: SystemRoles.USER,
      reason: 'fallback',
    });
  });

  it('selects fallback when the fallback role is present and no priority role matches', () => {
    expect(
      selectOpenIdRole({
        currentRole: 'BASIC-USER',
        openIdRoleValues: [SystemRoles.USER],
        rolePriority: ['STANDARD-USER'],
        fallbackRole: SystemRoles.USER,
      }),
    ).toEqual({
      selectedRole: SystemRoles.USER,
      reason: 'fallback',
    });
  });

  it('excludes ADMIN from generic matching and fallback assignment', () => {
    expect(
      selectOpenIdRole({
        openIdRoleValues: [SystemRoles.ADMIN],
        rolePriority: [SystemRoles.ADMIN],
        fallbackRole: SystemRoles.ADMIN,
      }),
    ).toEqual({
      reason: 'no_matching_role',
    });
  });

  it('ignores unknown normalized values without affecting priority selection', () => {
    expect(
      selectOpenIdRole({
        openIdRoleValues: ['UNKNOWN', 'unknown', 'BASIC-USER', 'ignored'],
        rolePriority: ['BASIC-USER'],
      }),
    ).toEqual({
      selectedRole: 'BASIC-USER',
      reason: 'matched_priority',
    });
  });
});
