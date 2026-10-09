import { Types } from 'mongoose';
import { logger } from '@librechat/data-schemas';

import type { IUser } from '@librechat/data-schemas';
import type { AdminRefreshDeps, RefreshTokenset } from './refresh';

import { applyAdminRefresh, AdminRefreshError, buildOpenIDRefreshParams } from './refresh';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

const SUB = 'idp-sub-12345';

const ORIGINAL_OPENID_SCOPE = process.env.OPENID_SCOPE;
const ORIGINAL_OPENID_REFRESH_AUDIENCE = process.env.OPENID_REFRESH_AUDIENCE;
const ORIGINAL_OPENID_ISSUER = process.env.OPENID_ISSUER;

function makeUser(overrides: Partial<IUser> = {}): IUser {
  const _id = overrides._id ?? new Types.ObjectId();
  return {
    _id,
    email: 'admin@example.com',
    name: 'Admin User',
    username: 'admin',
    role: 'ADMIN',
    provider: 'openid',
    openidId: SUB,
    ...overrides,
  } as unknown as IUser;
}

function makeTokenset(overrides: Partial<RefreshTokenset> = {}): RefreshTokenset {
  return {
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    claims: () => ({ sub: SUB }),
    ...overrides,
  };
}

function makeDeps(user: IUser | undefined, overrides: Partial<AdminRefreshDeps> = {}) {
  const findUsers = jest.fn().mockResolvedValue(user ? [user] : []);
  const getUserById = jest.fn().mockResolvedValue(user ?? null);
  const mintToken = jest.fn().mockResolvedValue({ token: 'minted-jwt', expiresAt: 1234567890 });
  const onRefreshSuccess = jest.fn().mockResolvedValue(undefined);
  return {
    findUsers,
    getUserById,
    mintToken,
    onRefreshSuccess,
    ...overrides,
  };
}

describe('buildOpenIDRefreshParams', () => {
  beforeEach(() => {
    delete process.env.OPENID_SCOPE;
    delete process.env.OPENID_REFRESH_AUDIENCE;
  });

  afterAll(() => {
    if (ORIGINAL_OPENID_SCOPE === undefined) {
      delete process.env.OPENID_SCOPE;
    } else {
      process.env.OPENID_SCOPE = ORIGINAL_OPENID_SCOPE;
    }

    if (ORIGINAL_OPENID_REFRESH_AUDIENCE === undefined) {
      delete process.env.OPENID_REFRESH_AUDIENCE;
    } else {
      process.env.OPENID_REFRESH_AUDIENCE = ORIGINAL_OPENID_REFRESH_AUDIENCE;
    }

    if (ORIGINAL_OPENID_ISSUER === undefined) {
      delete process.env.OPENID_ISSUER;
    } else {
      process.env.OPENID_ISSUER = ORIGINAL_OPENID_ISSUER;
    }
  });

  it('returns scope-only params when OPENID_SCOPE is set', () => {
    process.env.OPENID_SCOPE = 'openid profile email';

    expect(buildOpenIDRefreshParams()).toEqual({ scope: 'openid profile email' });
  });

  it('returns scope and audience params when both refresh settings are set', () => {
    process.env.OPENID_SCOPE = 'openid profile email';
    process.env.OPENID_REFRESH_AUDIENCE = 'https://api.example.com';

    expect(buildOpenIDRefreshParams()).toEqual({
      scope: 'openid profile email',
      audience: 'https://api.example.com',
    });
  });

  it('returns audience-only params when OPENID_SCOPE is unset', () => {
    process.env.OPENID_REFRESH_AUDIENCE = 'https://api.example.com';

    expect(buildOpenIDRefreshParams()).toEqual({ audience: 'https://api.example.com' });
  });

  it('omits an empty refresh audience', () => {
    process.env.OPENID_REFRESH_AUDIENCE = '';

    expect(buildOpenIDRefreshParams()).toEqual({});
  });

  it('returns no params when scope and refresh audience are unset', () => {
    expect(buildOpenIDRefreshParams()).toEqual({});
  });
});

describe('applyAdminRefresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('happy path', () => {
    it('returns a fully-populated AdminExchangeResponse', async () => {
      const user = makeUser();
      const deps = makeDeps(user);
      const tokenset = makeTokenset();

      const result = await applyAdminRefresh(tokenset, deps);

      expect(result).toEqual({
        token: 'minted-jwt',
        refreshToken: 'new-refresh',
        user: expect.objectContaining({
          email: 'admin@example.com',
          openidId: SUB,
        }),
        expiresAt: 1234567890,
      });
      expect(deps.mintToken).toHaveBeenCalledWith(user, tokenset);
      expect(deps.onRefreshSuccess).toHaveBeenCalledWith(user, tokenset);
    });

    it('uses findUsers when no userId is supplied', async () => {
      const user = makeUser();
      const deps = makeDeps(user);

      await applyAdminRefresh(makeTokenset(), deps);

      expect(deps.findUsers).toHaveBeenCalledWith(
        { openidId: SUB },
        '-password -__v -totpSecret -backupCodes',
        { sort: { updatedAt: -1 }, limit: 1 },
      );
      expect(deps.getUserById).not.toHaveBeenCalled();
    });

    it('skips onRefreshSuccess when not provided', async () => {
      const user = makeUser();
      const { onRefreshSuccess: _omit, ...rest } = makeDeps(user);
      const deps: AdminRefreshDeps = rest;

      const result = await applyAdminRefresh(makeTokenset(), deps);
      expect(result.token).toBe('minted-jwt');
      expect(result.user.email).toBe('admin@example.com');
    });
  });

  describe('userId disambiguation', () => {
    it('returns the direct user when userId resolves and openidId matches', async () => {
      const id = new Types.ObjectId();
      const user = makeUser({ _id: id });
      const deps = makeDeps(user);

      await applyAdminRefresh(makeTokenset(), deps, { userId: id.toString() });

      expect(deps.getUserById).toHaveBeenCalledWith(
        id.toString(),
        '-password -__v -totpSecret -backupCodes',
      );
      expect(deps.findUsers).not.toHaveBeenCalled();
    });

    it('falls through to findUsers when userId is not a valid ObjectId', async () => {
      const user = makeUser();
      const deps = makeDeps(user);

      await applyAdminRefresh(makeTokenset(), deps, { userId: 'not-a-valid-id' });

      expect(deps.getUserById).not.toHaveBeenCalled();
      expect(deps.findUsers).toHaveBeenCalled();
    });

    it('falls through to findUsers when userId resolves to null', async () => {
      const user = makeUser();
      const id = new Types.ObjectId().toString();
      const deps = makeDeps(user, { getUserById: jest.fn().mockResolvedValue(null) });

      await applyAdminRefresh(makeTokenset(), deps, { userId: id });

      expect(deps.getUserById).toHaveBeenCalledWith(id, '-password -__v -totpSecret -backupCodes');
      expect(deps.findUsers).toHaveBeenCalledWith(
        { openidId: SUB },
        '-password -__v -totpSecret -backupCodes',
        { sort: { updatedAt: -1 }, limit: 1 },
      );
    });

    it('throws USER_ID_MISMATCH when the resolved user has a different openidId', async () => {
      const id = new Types.ObjectId();
      const user = makeUser({ _id: id, openidId: 'different-sub' });
      const deps = makeDeps(user, {
        getUserById: jest.fn().mockResolvedValue(user),
        findUsers: jest.fn(),
      });

      await expect(
        applyAdminRefresh(makeTokenset(), deps, { userId: id.toString() }),
      ).rejects.toMatchObject({
        name: 'AdminRefreshError',
        code: 'USER_ID_MISMATCH',
        status: 401,
      });
      expect(deps.findUsers).not.toHaveBeenCalled();
    });
  });

  describe('error branches', () => {
    it('throws IDP_INCOMPLETE when access_token is missing', async () => {
      const deps = makeDeps(makeUser());
      const tokenset = makeTokenset({ access_token: undefined });

      await expect(applyAdminRefresh(tokenset, deps)).rejects.toMatchObject({
        code: 'IDP_INCOMPLETE',
        status: 502,
      });
      expect(deps.mintToken).not.toHaveBeenCalled();
    });

    it('throws CLAIMS_INCOMPLETE when claims() throws', async () => {
      const deps = makeDeps(makeUser());
      const tokenset = makeTokenset({
        claims: () => {
          throw new Error('id_token missing');
        },
      });

      await expect(applyAdminRefresh(tokenset, deps)).rejects.toMatchObject({
        code: 'CLAIMS_INCOMPLETE',
        status: 502,
      });
    });

    it('throws CLAIMS_INCOMPLETE when sub is missing', async () => {
      const deps = makeDeps(makeUser());
      const tokenset = makeTokenset({ claims: () => ({}) });

      await expect(applyAdminRefresh(tokenset, deps)).rejects.toMatchObject({
        code: 'CLAIMS_INCOMPLETE',
        status: 502,
      });
    });

    it('throws USER_NOT_FOUND when no user matches the refreshed identity', async () => {
      const deps = makeDeps(undefined);

      await expect(applyAdminRefresh(makeTokenset(), deps)).rejects.toMatchObject({
        code: 'USER_NOT_FOUND',
        status: 401,
      });
      expect(deps.mintToken).not.toHaveBeenCalled();
    });

    it('propagates errors thrown from mintToken', async () => {
      const deps = makeDeps(makeUser(), {
        mintToken: jest.fn().mockRejectedValue(new Error('signing failure')),
      });

      await expect(applyAdminRefresh(makeTokenset(), deps)).rejects.toThrow('signing failure');
    });

    it('propagates errors thrown from onRefreshSuccess', async () => {
      const deps = makeDeps(makeUser(), {
        onRefreshSuccess: jest.fn().mockRejectedValue(new Error('cache write failed')),
      });

      await expect(applyAdminRefresh(makeTokenset(), deps)).rejects.toThrow('cache write failed');
    });
  });

  describe('issuer-bound user lookup', () => {
    it('binds findUsers to (openidId, openidIssuer) when expectedIssuer is provided', async () => {
      const user = makeUser();
      const deps = makeDeps(user);
      const tokenset = makeTokenset({
        claims: () => ({ sub: SUB, iss: 'https://issuer.example.com' }),
      });

      await applyAdminRefresh(tokenset, deps, {
        expectedIssuer: 'https://issuer.example.com',
      });

      const [filter] = (deps.findUsers as jest.Mock).mock.calls[0];
      expect(filter).toEqual({
        openidId: SUB,
        openidIssuer: 'https://issuer.example.com',
      });
    });

    it('falls back to openidId-only lookup when expectedIssuer is not provided', async () => {
      const user = makeUser();
      const deps = makeDeps(user);

      await applyAdminRefresh(makeTokenset(), deps);

      expect(deps.findUsers).toHaveBeenCalledWith(
        { openidId: SUB },
        '-password -__v -totpSecret -backupCodes',
        { sort: { updatedAt: -1 }, limit: 1 },
      );
    });

    it('selects the most recently updated user across legacy issuer fallback filters', async () => {
      const previousOpenIDIssuer = process.env.OPENID_ISSUER;
      process.env.OPENID_ISSUER = 'https://issuer.example.com';
      try {
        const olderMissingIssuer = makeUser({
          email: 'older@example.com',
          openidIssuer: undefined,
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        });
        const newerEmptyIssuer = makeUser({
          email: 'newer@example.com',
          openidIssuer: '',
          updatedAt: new Date('2026-02-01T00:00:00.000Z'),
        });
        const findUsers = jest
          .fn()
          .mockImplementation(async (filter: { openidIssuer?: unknown }) => {
            if (filter.openidIssuer === '') return [newerEmptyIssuer];
            if (
              typeof filter.openidIssuer === 'object' &&
              filter.openidIssuer != null &&
              '$exists' in filter.openidIssuer
            ) {
              return [olderMissingIssuer];
            }
            return [];
          });
        const deps = makeDeps(undefined, { findUsers });
        const tokenset = makeTokenset({
          claims: () => ({ sub: SUB, iss: 'https://issuer.example.com' }),
        });

        const result = await applyAdminRefresh(tokenset, deps, {
          expectedIssuer: 'https://issuer.example.com',
        });

        expect(result.user.email).toBe('newer@example.com');
        expect(deps.mintToken).toHaveBeenCalledWith(newerEmptyIssuer, tokenset);
        expect(findUsers).toHaveBeenCalledTimes(4);
      } finally {
        if (previousOpenIDIssuer === undefined) {
          delete process.env.OPENID_ISSUER;
        } else {
          process.env.OPENID_ISSUER = previousOpenIDIssuer;
        }
      }
    });

    it('throws USER_ID_MISMATCH when direct user_id resolves but issuer differs', async () => {
      const id = new Types.ObjectId();
      const user = makeUser({ _id: id, openidIssuer: 'https://other-issuer.example.com' });
      const deps = makeDeps(user, {
        getUserById: jest.fn().mockResolvedValue(user),
        findUsers: jest.fn(),
      });
      const tokenset = makeTokenset({
        claims: () => ({ sub: SUB, iss: 'https://issuer.example.com' }),
      });

      await expect(
        applyAdminRefresh(tokenset, deps, {
          userId: id.toString(),
          expectedIssuer: 'https://issuer.example.com',
        }),
      ).rejects.toMatchObject({ code: 'USER_ID_MISMATCH', status: 401 });
      expect(deps.findUsers).not.toHaveBeenCalled();
    });

    it('accepts direct user_id when stored openidIssuer matches the expected issuer', async () => {
      const id = new Types.ObjectId();
      const user = makeUser({ _id: id, openidIssuer: 'https://issuer.example.com' });
      const deps = makeDeps(user, { getUserById: jest.fn().mockResolvedValue(user) });
      const tokenset = makeTokenset({
        claims: () => ({ sub: SUB, iss: 'https://issuer.example.com' }),
      });

      await expect(
        applyAdminRefresh(tokenset, deps, {
          userId: id.toString(),
          expectedIssuer: 'https://issuer.example.com',
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('issuer guard', () => {
    it('passes when expected and actual issuers match', async () => {
      const deps = makeDeps(makeUser());
      const tokenset = makeTokenset({
        claims: () => ({ sub: SUB, iss: 'https://issuer.example.com' }),
      });

      await expect(
        applyAdminRefresh(tokenset, deps, { expectedIssuer: 'https://issuer.example.com' }),
      ).resolves.toBeDefined();
    });

    it('passes when expected and actual issuers match modulo trailing slash', async () => {
      const deps = makeDeps(makeUser());
      const tokenset = makeTokenset({
        claims: () => ({ sub: SUB, iss: 'https://issuer.example.com/' }),
      });

      await expect(
        applyAdminRefresh(tokenset, deps, { expectedIssuer: 'https://issuer.example.com' }),
      ).resolves.toBeDefined();
    });

    it('throws ISSUER_MISMATCH when issuers differ', async () => {
      const deps = makeDeps(makeUser());
      const tokenset = makeTokenset({
        claims: () => ({ sub: SUB, iss: 'https://attacker.example.com' }),
      });

      await expect(
        applyAdminRefresh(tokenset, deps, { expectedIssuer: 'https://issuer.example.com' }),
      ).rejects.toMatchObject({ code: 'ISSUER_MISMATCH', status: 401 });
      expect(deps.findUsers).not.toHaveBeenCalled();
      expect(deps.mintToken).not.toHaveBeenCalled();
    });

    it('skips the check when expectedIssuer is not provided', async () => {
      const deps = makeDeps(makeUser());
      const tokenset = makeTokenset({
        claims: () => ({ sub: SUB, iss: 'https://attacker.example.com' }),
      });

      await expect(applyAdminRefresh(tokenset, deps)).resolves.toBeDefined();
    });

    it('skips the check when the tokenset has no iss claim', async () => {
      const deps = makeDeps(makeUser());

      await expect(
        applyAdminRefresh(makeTokenset(), deps, {
          expectedIssuer: 'https://issuer.example.com',
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('refresh-token preservation', () => {
    it('preserves the inbound refresh token when the IdP does not rotate', async () => {
      const deps = makeDeps(makeUser());
      const tokenset = makeTokenset({ refresh_token: undefined });

      const result = await applyAdminRefresh(tokenset, deps, {
        previousRefreshToken: 'inbound-refresh',
      });

      expect(result.refreshToken).toBe('inbound-refresh');
    });

    it('prefers the rotated refresh token over the previousRefreshToken fallback', async () => {
      const deps = makeDeps(makeUser());
      const tokenset = makeTokenset({ refresh_token: 'rotated-refresh' });

      const result = await applyAdminRefresh(tokenset, deps, {
        previousRefreshToken: 'inbound-refresh',
      });

      expect(result.refreshToken).toBe('rotated-refresh');
    });

    it('returns undefined refreshToken when neither rotation nor fallback is available', async () => {
      const deps = makeDeps(makeUser());
      const tokenset = makeTokenset({ refresh_token: undefined });

      const result = await applyAdminRefresh(tokenset, deps);

      expect(result.refreshToken).toBeUndefined();
    });
  });

  describe('tenant scoping', () => {
    it('constrains the fallback findUsers filter to options.tenantId', async () => {
      const user = makeUser({ tenantId: 'tenant-a' } as Partial<IUser>);
      const deps = makeDeps(user);

      await applyAdminRefresh(makeTokenset(), deps, { tenantId: 'tenant-a' });

      const [filter] = (deps.findUsers as jest.Mock).mock.calls[0];
      expect(filter).toMatchObject({ openidId: SUB, tenantId: 'tenant-a' });
    });

    it('returns the tenant-A user when two users share (sub, iss) across tenants', async () => {
      const userA = makeUser({ tenantId: 'tenant-a', email: 'a@example.com' } as Partial<IUser>);
      const userB = makeUser({ tenantId: 'tenant-b', email: 'b@example.com' } as Partial<IUser>);

      const findUsers = jest.fn().mockImplementation(async (filter: { tenantId?: string }) => {
        if (filter.tenantId === 'tenant-a') return [userA];
        if (filter.tenantId === 'tenant-b') return [userB];
        return [userA, userB];
      });
      const deps = makeDeps(userA, { findUsers });

      const result = await applyAdminRefresh(makeTokenset(), deps, { tenantId: 'tenant-a' });

      expect(result.user.email).toBe('a@example.com');
      expect(findUsers).toHaveBeenCalledWith(
        { openidId: SUB, tenantId: 'tenant-a' },
        '-password -__v -totpSecret -backupCodes',
        { sort: { updatedAt: -1 }, limit: 1 },
      );
    });

    it('throws TENANT_MISMATCH when direct user_id resolves to a different tenant', async () => {
      const id = new Types.ObjectId();
      const user = makeUser({ _id: id, tenantId: 'tenant-b' } as Partial<IUser>);
      const deps = makeDeps(user, {
        getUserById: jest.fn().mockResolvedValue(user),
        findUsers: jest.fn(),
      });

      await expect(
        applyAdminRefresh(makeTokenset(), deps, {
          userId: id.toString(),
          tenantId: 'tenant-a',
        }),
      ).rejects.toMatchObject({
        name: 'AdminRefreshError',
        code: 'TENANT_MISMATCH',
        status: 401,
      });
      expect(deps.findUsers).not.toHaveBeenCalled();
      expect(deps.mintToken).not.toHaveBeenCalled();
    });

    it('accepts direct user_id when stored tenantId matches options.tenantId', async () => {
      const id = new Types.ObjectId();
      const user = makeUser({ _id: id, tenantId: 'tenant-a' } as Partial<IUser>);
      const deps = makeDeps(user, {
        getUserById: jest.fn().mockResolvedValue(user),
        findUsers: jest.fn(),
      });

      const result = await applyAdminRefresh(makeTokenset(), deps, {
        userId: id.toString(),
        tenantId: 'tenant-a',
      });

      expect(result.token).toBe('minted-jwt');
      expect(deps.findUsers).not.toHaveBeenCalled();
    });

    it('falls back to openidId-only filter when options.tenantId is omitted', async () => {
      const user = makeUser();
      const deps = makeDeps(user);

      await applyAdminRefresh(makeTokenset(), deps);

      const [filter] = (deps.findUsers as jest.Mock).mock.calls[0];
      expect(filter).toEqual({ openidId: SUB });
      expect(filter).not.toHaveProperty('tenantId');
    });
  });

  describe('admin-access guard', () => {
    it('throws FORBIDDEN and does not mint when canAccessAdmin returns false', async () => {
      const user = makeUser();
      const canAccessAdmin = jest.fn().mockResolvedValue(false);
      const deps = makeDeps(user, { canAccessAdmin });

      await expect(applyAdminRefresh(makeTokenset(), deps)).rejects.toMatchObject({
        name: 'AdminRefreshError',
        code: 'FORBIDDEN',
        status: 403,
      });

      expect(canAccessAdmin).toHaveBeenCalledWith(user);
      expect(deps.mintToken).not.toHaveBeenCalled();
      expect(deps.onRefreshSuccess).not.toHaveBeenCalled();
    });

    it('mints when canAccessAdmin returns true', async () => {
      const user = makeUser();
      const canAccessAdmin = jest.fn().mockResolvedValue(true);
      const deps = makeDeps(user, { canAccessAdmin });

      const result = await applyAdminRefresh(makeTokenset(), deps);

      expect(canAccessAdmin).toHaveBeenCalledWith(user);
      expect(deps.mintToken).toHaveBeenCalledWith(user, expect.any(Object));
      expect(result.token).toBe('minted-jwt');
    });

    it('skips the check when canAccessAdmin is not provided', async () => {
      const user = makeUser();
      const { canAccessAdmin: _omit, ...rest } = makeDeps(user);
      const deps: AdminRefreshDeps = rest;

      const result = await applyAdminRefresh(makeTokenset(), deps);
      expect(result.token).toBe('minted-jwt');
    });

    it('propagates errors thrown by canAccessAdmin without minting', async () => {
      const user = makeUser();
      const boom = new Error('capability backend exploded');
      const canAccessAdmin = jest.fn().mockRejectedValue(boom);
      const deps = makeDeps(user, { canAccessAdmin });

      await expect(applyAdminRefresh(makeTokenset(), deps)).rejects.toBe(boom);
      expect(deps.mintToken).not.toHaveBeenCalled();
      expect(deps.onRefreshSuccess).not.toHaveBeenCalled();
    });
  });

  describe('logging', () => {
    it('logs the refreshed user email at debug', async () => {
      const deps = makeDeps(makeUser());

      await applyAdminRefresh(makeTokenset(), deps);

      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('admin@example.com'));
    });
  });
});

describe('AdminRefreshError', () => {
  it('captures code, status, and message', () => {
    const err = new AdminRefreshError('SOME_CODE', 418, 'teapot');
    expect(err.name).toBe('AdminRefreshError');
    expect(err.code).toBe('SOME_CODE');
    expect(err.status).toBe(418);
    expect(err.message).toBe('teapot');
    expect(err).toBeInstanceOf(Error);
  });
});
