import { Types } from 'mongoose';
import { logger } from '@librechat/data-schemas';

import type { IUser } from '@librechat/data-schemas';
import type { AdminRefreshDeps, RefreshTokenset } from './refresh';

import {
  applyAdminRefresh,
  lookupAdminRefreshBinding,
  precheckAdminRefreshBinding,
  resolveAdminRefreshToken,
  AdminRefreshError,
  buildOpenIDRefreshParams,
} from './refresh';
import { ProviderSessionUnavailableError } from './openid/providerSession/errors';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
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
        message: 'IdP returned an incomplete tokenset (missing access_token)',
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
        message: 'No user found for the refreshed identity',
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
      ).rejects.toMatchObject({
        code: 'ISSUER_MISMATCH',
        status: 401,
        message: 'Refreshed tokenset was issued by an unexpected issuer',
      });
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

  describe('email domain guard', () => {
    it('throws FORBIDDEN before the admin-access check or minting when isEmailAllowed returns false', async () => {
      const user = makeUser();
      const isEmailAllowed = jest.fn().mockResolvedValue(false);
      const canAccessAdmin = jest.fn().mockResolvedValue(true);
      const deps = makeDeps(user, { isEmailAllowed, canAccessAdmin });

      await expect(applyAdminRefresh(makeTokenset(), deps)).rejects.toMatchObject({
        name: 'AdminRefreshError',
        code: 'FORBIDDEN',
        status: 403,
        message: 'User email domain is not on the deployment allowlist',
      });

      expect(isEmailAllowed).toHaveBeenCalledWith(user);
      expect(canAccessAdmin).not.toHaveBeenCalled();
      expect(deps.mintToken).not.toHaveBeenCalled();
    });

    it('proceeds past the email guard and mints when isEmailAllowed returns true', async () => {
      const user = makeUser();
      const isEmailAllowed = jest.fn().mockResolvedValue(true);
      const deps = makeDeps(user, { isEmailAllowed });

      const result = await applyAdminRefresh(makeTokenset(), deps);

      expect(isEmailAllowed).toHaveBeenCalledWith(user);
      expect(result.token).toBe('minted-jwt');
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
        message: 'User does not have admin access',
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
    it('logs the refreshed user id at debug, never the email', async () => {
      const user = makeUser();
      const deps = makeDeps(user);

      await applyAdminRefresh(makeTokenset(), deps);

      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining(String(user._id)));
      expect(JSON.stringify((logger.debug as jest.Mock).mock.calls)).not.toContain(
        'admin@example.com',
      );
    });
  });

  describe('provider-session binding', () => {
    const ref = { issuer: 'https://issuer.example.com', clientId: 'test-client', sid: 'sid-1' };
    const getProviderSessionClient = () => ({ issuer: ref.issuer, clientId: ref.clientId });

    function makeDepsWithClient(
      user: IUser | undefined,
      overrides: Partial<AdminRefreshDeps> = {},
    ) {
      return makeDeps(user, { getProviderSessionClient, ...overrides });
    }

    it('authorizes before returning tokens and persists the rotated binding', async () => {
      const user = makeUser();
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: true });
      const upsertSession = jest.fn().mockResolvedValue({});
      const deleteSession = jest.fn().mockResolvedValue({ deletedCount: 0 });
      const deps = makeDepsWithClient(user, {
        authorizeProviderSession,
        upsertSession,
        deleteSession,
      });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      const result = await applyAdminRefresh(tokenset, deps, {
        previousRefreshToken: 'old-refresh',
        boundProviderSession: ref,
      });

      expect(authorizeProviderSession).toHaveBeenCalledWith({
        ref,
        subject: SUB,
        expiresAt: expect.any(Date),
        legacy: false,
      });
      expect(upsertSession).toHaveBeenCalledWith(
        String(user._id),
        'rotated-refresh',
        expect.objectContaining({ providerSession: ref, authMethod: 'openid' }),
      );
      expect(deleteSession).toHaveBeenCalledWith({ refreshToken: 'old-refresh' });
      expect(result.token).toBe('minted-jwt');
    });

    it('falls back to the bridged grant token, not the client token, when the IdP grant does not rotate', async () => {
      const user = makeUser();
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: true });
      const upsertSession = jest.fn().mockResolvedValue({});
      const deleteSession = jest.fn().mockResolvedValue({ deletedCount: 0 });
      const deps = makeDepsWithClient(user, {
        authorizeProviderSession,
        upsertSession,
        deleteSession,
      });
      const tokenset = makeTokenset({
        refresh_token: undefined,
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      const result = await applyAdminRefresh(tokenset, deps, {
        previousRefreshToken: 'client-token-a',
        grantRefreshToken: 'bridged-token-b',
        boundProviderSession: ref,
      });

      expect(result.refreshToken).toBe('bridged-token-b');
      expect(upsertSession).toHaveBeenCalledWith(
        String(user._id),
        'bridged-token-b',
        expect.objectContaining({ providerSession: ref, authMethod: 'openid' }),
      );
      expect(deleteSession).toHaveBeenCalledWith({ refreshToken: 'client-token-a' });
    });

    it('passes the request tenantId through to the stored binding', async () => {
      const user = makeUser();
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: true });
      const upsertSession = jest.fn().mockResolvedValue({});
      const deleteSession = jest.fn().mockResolvedValue({ deletedCount: 0 });
      const deps = makeDepsWithClient(user, {
        authorizeProviderSession,
        upsertSession,
        deleteSession,
      });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      await applyAdminRefresh(tokenset, deps, {
        previousRefreshToken: 'old-refresh',
        boundProviderSession: ref,
        tenantId: 'tenant-a',
      });

      expect(upsertSession).toHaveBeenCalledWith(
        String(user._id),
        'rotated-refresh',
        expect.objectContaining({ tenantId: 'tenant-a' }),
      );
    });

    it('throws OPENID_SESSION_ENDED when authorize denies', async () => {
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: false });
      const deps = makeDepsWithClient(makeUser(), { authorizeProviderSession });

      await expect(
        applyAdminRefresh(makeTokenset({ claims: () => ({ sub: SUB }) }), deps, {
          boundProviderSession: ref,
        }),
      ).rejects.toMatchObject({ code: 'OPENID_SESSION_ENDED', status: 401 });
    });

    it('stores the bridge immediately after the grant, keeps it when authorize throws unavailable, then rethrows', async () => {
      const user = makeUser({ openidIssuer: ref.issuer } as Partial<IUser>);
      const unavailableError = new ProviderSessionUnavailableError('db down');
      const authorizeProviderSession = jest.fn().mockRejectedValue(unavailableError);
      const storeRefreshTokenBridge = jest.fn().mockResolvedValue('bridge-version');
      const deleteRefreshTokenBridges = jest.fn();
      const deps = makeDepsWithClient(user, {
        authorizeProviderSession,
        storeRefreshTokenBridge,
        deleteRefreshTokenBridges,
        bridgeGraceMs: 60000,
      });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      await expect(
        applyAdminRefresh(tokenset, deps, {
          userId: String(user._id),
          previousRefreshToken: 'old-refresh',
          boundProviderSession: ref,
          expectedIssuer: ref.issuer,
        }),
      ).rejects.toBe(unavailableError);

      expect(storeRefreshTokenBridge).toHaveBeenCalledWith({
        oldRefreshToken: 'old-refresh',
        newRefreshToken: 'rotated-refresh',
        userId: String(user._id),
        tenantId: undefined,
        openidIssuer: ref.issuer,
        ttl: 60000,
        providerSession: ref,
      });
      expect(deleteRefreshTokenBridges).not.toHaveBeenCalled();
    });

    it('falls back to options.tenantId for the bridge store and the denial-delete when bridgeIdentity carries no tenantId', async () => {
      const user = makeUser({ tenantId: 'tenant-Z' } as Partial<IUser>);
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: false });
      const storeRefreshTokenBridge = jest.fn().mockResolvedValue('bridge-version');
      const deleteRefreshTokenBridges = jest.fn().mockResolvedValue({ deletedCount: 1 });
      const deps = makeDepsWithClient(user, {
        authorizeProviderSession,
        storeRefreshTokenBridge,
        deleteRefreshTokenBridges,
      });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      await expect(
        applyAdminRefresh(tokenset, deps, {
          userId: String(user._id),
          previousRefreshToken: 'old-refresh',
          boundProviderSession: ref,
          tenantId: 'tenant-Z',
        }),
      ).rejects.toMatchObject({ code: 'OPENID_SESSION_ENDED' });

      expect(storeRefreshTokenBridge).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-Z' }),
      );
      expect(deleteRefreshTokenBridges).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-Z' }),
      );
    });

    it('never touches provider-session deps when authorizeProviderSession is not configured, even if other provider-session deps are wired (mode off stays off)', async () => {
      const user = makeUser();
      const getProviderSessionClient = jest.fn();
      const storeRefreshTokenBridge = jest.fn();
      const deps = makeDeps(user, { getProviderSessionClient, storeRefreshTokenBridge });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      await applyAdminRefresh(tokenset, deps, {
        previousRefreshToken: 'old-refresh',
        boundProviderSession: ref,
      });

      expect(getProviderSessionClient).not.toHaveBeenCalled();
      expect(storeRefreshTokenBridge).not.toHaveBeenCalled();
    });

    it('authorizes with a null, legacy ref without throwing when getProviderSessionClient is not configured', async () => {
      const user = makeUser();
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: true });
      const deps = makeDeps(user, { authorizeProviderSession });

      const result = await applyAdminRefresh(makeTokenset({ claims: () => ({ sub: SUB }) }), deps);

      expect(authorizeProviderSession).toHaveBeenCalledWith(
        expect.objectContaining({ ref: null, legacy: true }),
      );
      expect(result.token).toBe('minted-jwt');
    });

    it('does not store a recovery bridge when there is no previousRefreshToken to key it under, even with a resolvable bridge identity', async () => {
      const user = makeUser();
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: true });
      const storeRefreshTokenBridge = jest.fn();
      const deps = makeDepsWithClient(user, { authorizeProviderSession, storeRefreshTokenBridge });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      const result = await applyAdminRefresh(tokenset, deps, {
        userId: String(user._id),
        boundProviderSession: ref,
      });

      expect(storeRefreshTokenBridge).not.toHaveBeenCalled();
      expect(result.token).toBe('minted-jwt');
    });

    it('never attempts a bridge store when storeRefreshTokenBridge is not configured, even when a userId is supplied', async () => {
      const user = makeUser();
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: true });
      const deps = makeDepsWithClient(user, { authorizeProviderSession });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      const result = await applyAdminRefresh(tokenset, deps, {
        userId: String(user._id),
        previousRefreshToken: 'old-refresh',
        boundProviderSession: ref,
      });

      expect(result.token).toBe('minted-jwt');
    });

    it('stores no recovery bridge under mode off, even when storeRefreshTokenBridge is wired', async () => {
      const user = makeUser();
      const storeRefreshTokenBridge = jest.fn();
      const deps = makeDeps(user, { storeRefreshTokenBridge });
      const tokenset = makeTokenset({ claims: () => ({ sub: SUB }) });

      await applyAdminRefresh(tokenset, deps);

      expect(storeRefreshTokenBridge).not.toHaveBeenCalled();
    });

    it('deletes the bridge by version, and runs no success side effects, when authorize denies', async () => {
      const user = makeUser();
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: false });
      const storeRefreshTokenBridge = jest.fn().mockResolvedValue('bridge-version');
      const deleteRefreshTokenBridges = jest.fn().mockResolvedValue({ deletedCount: 1 });
      const mintToken = jest.fn();
      const onRefreshSuccess = jest.fn();
      const deps = makeDepsWithClient(user, {
        authorizeProviderSession,
        storeRefreshTokenBridge,
        deleteRefreshTokenBridges,
        mintToken,
        onRefreshSuccess,
      });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      await expect(
        applyAdminRefresh(tokenset, deps, {
          userId: String(user._id),
          previousRefreshToken: 'old-refresh',
          boundProviderSession: ref,
        }),
      ).rejects.toMatchObject({
        code: 'OPENID_SESSION_ENDED',
        status: 401,
        message: 'Provider session has ended',
      });

      expect(storeRefreshTokenBridge).toHaveBeenCalled();
      expect(deleteRefreshTokenBridges).toHaveBeenCalledWith({
        refreshTokens: ['old-refresh'],
        userId: String(user._id),
        tenantId: undefined,
        version: 'bridge-version',
      });
      expect(mintToken).not.toHaveBeenCalled();
      expect(onRefreshSuccess).not.toHaveBeenCalled();
    });

    it('does not attempt to delete the bridge when no bridge version was returned from the store', async () => {
      const user = makeUser();
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: false });
      const storeRefreshTokenBridge = jest.fn().mockResolvedValue(null);
      const deleteRefreshTokenBridges = jest.fn();
      const deps = makeDepsWithClient(user, {
        authorizeProviderSession,
        storeRefreshTokenBridge,
        deleteRefreshTokenBridges,
      });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      await expect(
        applyAdminRefresh(tokenset, deps, {
          userId: String(user._id),
          previousRefreshToken: 'old-refresh',
          boundProviderSession: ref,
        }),
      ).rejects.toMatchObject({ code: 'OPENID_SESSION_ENDED' });

      expect(deleteRefreshTokenBridges).not.toHaveBeenCalled();
    });

    it('does not throw when deleteRefreshTokenBridges is not configured, even though a bridge was stored', async () => {
      const user = makeUser();
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: false });
      const storeRefreshTokenBridge = jest.fn().mockResolvedValue('bridge-version');
      const deps = makeDepsWithClient(user, { authorizeProviderSession, storeRefreshTokenBridge });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      await expect(
        applyAdminRefresh(tokenset, deps, {
          userId: String(user._id),
          previousRefreshToken: 'old-refresh',
          boundProviderSession: ref,
        }),
      ).rejects.toMatchObject({ code: 'OPENID_SESSION_ENDED' });
    });

    it('logs and swallows a failure deleting the bridge after a provider-session denial, still throwing OPENID_SESSION_ENDED', async () => {
      const user = makeUser();
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: false });
      const storeRefreshTokenBridge = jest.fn().mockResolvedValue('bridge-version');
      const deleteError = new Error('bridge delete backend down');
      const deleteRefreshTokenBridges = jest.fn().mockRejectedValue(deleteError);
      const deps = makeDepsWithClient(user, {
        authorizeProviderSession,
        storeRefreshTokenBridge,
        deleteRefreshTokenBridges,
      });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      await expect(
        applyAdminRefresh(tokenset, deps, {
          userId: String(user._id),
          previousRefreshToken: 'old-refresh',
          boundProviderSession: ref,
        }),
      ).rejects.toMatchObject({ code: 'OPENID_SESSION_ENDED', status: 401 });

      expect(logger.warn).toHaveBeenCalledWith(
        '[adminRefresh] Failed to remove the refresh-token bridge after a provider-session denial',
        { error: deleteError },
      );
    });

    it('denies on a conflicting sid without ever calling authorize', async () => {
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: true });
      const deps = makeDepsWithClient(makeUser(), { authorizeProviderSession });
      const tokenset = makeTokenset({
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: 'a-different-sid' }),
      });

      await expect(
        applyAdminRefresh(tokenset, deps, { boundProviderSession: ref }),
      ).rejects.toMatchObject({
        code: 'OPENID_SESSION_ENDED',
        status: 401,
        message: 'Provider session id changed during refresh',
      });
      expect(authorizeProviderSession).not.toHaveBeenCalled();
    });

    it('does not conflict when a templated configured issuer resolves to the bound tenant issuer', async () => {
      const templateIssuer = 'https://login.microsoftonline.com/{tenantid}/v2.0';
      const tenantRef = {
        issuer: 'https://login.microsoftonline.com/tenant-a/v2.0',
        clientId: ref.clientId,
        sid: ref.sid,
      };
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: true });
      const deps = makeDepsWithClient(makeUser(), {
        authorizeProviderSession,
        getProviderSessionClient: () => ({ issuer: templateIssuer, clientId: tenantRef.clientId }),
      });
      const tokenset = makeTokenset({
        claims: () => ({ sub: SUB, iss: tenantRef.issuer, sid: tenantRef.sid }),
      });

      await applyAdminRefresh(tokenset, deps, { boundProviderSession: tenantRef });

      expect(authorizeProviderSession).toHaveBeenCalledWith(
        expect.objectContaining({ ref: tenantRef, legacy: false }),
      );
    });

    it('keeps the bound ref when the refreshed tokenset carries no sid', async () => {
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: true });
      const deps = makeDepsWithClient(makeUser(), { authorizeProviderSession });
      const tokenset = makeTokenset({ claims: () => ({ sub: SUB }) });

      await applyAdminRefresh(tokenset, deps, { boundProviderSession: ref });

      expect(authorizeProviderSession).toHaveBeenCalledWith(
        expect.objectContaining({ ref, legacy: false }),
      );
    });

    it('passes a null ref and marks the entry legacy when there is no binding', async () => {
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: true });
      const deps = makeDepsWithClient(makeUser(), { authorizeProviderSession });

      await applyAdminRefresh(makeTokenset({ claims: () => ({ sub: SUB }) }), deps);

      expect(authorizeProviderSession).toHaveBeenCalledWith(
        expect.objectContaining({ ref: null, legacy: true }),
      );
    });

    it('makes zero provider-session or Session-collection calls when the deps are omitted', async () => {
      const upsertSession = jest.fn();
      const deleteSession = jest.fn();
      const deps = makeDeps(makeUser(), { upsertSession, deleteSession });

      await applyAdminRefresh(makeTokenset({ claims: () => ({ sub: SUB }) }), deps, {
        boundProviderSession: ref,
      });

      expect(upsertSession).not.toHaveBeenCalled();
      expect(deleteSession).not.toHaveBeenCalled();
    });

    it('stores the bridge immediately after the grant and throws unavailable (enforce) when storing the session fails', async () => {
      const user = makeUser({ openidIssuer: ref.issuer } as Partial<IUser>);
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: true });
      const saveError = new Error('session upsert failed');
      const upsertSession = jest.fn().mockRejectedValue(saveError);
      const deleteSession = jest.fn().mockResolvedValue({ deletedCount: 0 });
      const storeRefreshTokenBridge = jest.fn().mockResolvedValue('bridge-version');
      const deleteRefreshTokenBridges = jest.fn();
      const deps = makeDepsWithClient(user, {
        authorizeProviderSession,
        upsertSession,
        deleteSession,
        storeRefreshTokenBridge,
        deleteRefreshTokenBridges,
        bridgeGraceMs: 60000,
      });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      await expect(
        applyAdminRefresh(tokenset, deps, {
          userId: String(user._id),
          previousRefreshToken: 'old-refresh',
          boundProviderSession: ref,
          expectedIssuer: ref.issuer,
        }),
      ).rejects.toMatchObject({
        name: 'ProviderSessionUnavailableError',
        message: 'Failed to persist the refreshed session',
        cause: saveError,
      });

      expect(storeRefreshTokenBridge).toHaveBeenCalledWith({
        oldRefreshToken: 'old-refresh',
        newRefreshToken: 'rotated-refresh',
        userId: String(user._id),
        tenantId: undefined,
        openidIssuer: ref.issuer,
        ttl: 60000,
        providerSession: ref,
      });
      expect(deleteRefreshTokenBridges).not.toHaveBeenCalled();
    });

    it('tolerates a session-store failure in record mode, logs a warning, and returns the rotated token', async () => {
      const user = makeUser();
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: true });
      const saveError = new Error('session upsert failed');
      const upsertSession = jest.fn().mockRejectedValue(saveError);
      const deleteSession = jest.fn().mockResolvedValue({ deletedCount: 0 });
      const getMode = jest.fn().mockResolvedValue('record');
      const deps = makeDepsWithClient(user, {
        authorizeProviderSession,
        upsertSession,
        deleteSession,
        getMode,
      });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      const result = await applyAdminRefresh(tokenset, deps, {
        userId: String(user._id),
        previousRefreshToken: 'old-refresh',
        boundProviderSession: ref,
      });

      expect(result.refreshToken).toBe('rotated-refresh');
      expect(logger.warn).toHaveBeenCalledWith(
        '[adminRefresh] Failed to persist the refreshed session; tolerating in record mode',
        { error: saveError },
      );
    });

    it('logs and swallows a failure storing the bridge immediately after the grant, continuing the rest of the refresh', async () => {
      const user = makeUser();
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: true });
      const upsertSession = jest.fn().mockResolvedValue({});
      const deleteSession = jest.fn().mockResolvedValue({ deletedCount: 0 });
      const bridgeError = new Error('bridge store failed');
      const storeRefreshTokenBridge = jest.fn().mockRejectedValue(bridgeError);
      const deps = makeDepsWithClient(user, {
        authorizeProviderSession,
        upsertSession,
        deleteSession,
        storeRefreshTokenBridge,
      });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      const result = await applyAdminRefresh(tokenset, deps, {
        userId: String(user._id),
        previousRefreshToken: 'old-refresh',
        boundProviderSession: ref,
      });

      expect(result.token).toBe('minted-jwt');
      expect(logger.warn).toHaveBeenCalledWith(
        '[adminRefresh] Failed to store the refresh-token bridge after the IdP grant',
        { error: bridgeError },
      );
    });

    it('keeps the bridge stored after the grant when the provider-session check throws an unrelated error', async () => {
      const user = makeUser();
      const unrelatedError = new Error('network blip');
      const authorizeProviderSession = jest.fn().mockRejectedValue(unrelatedError);
      const storeRefreshTokenBridge = jest.fn().mockResolvedValue('bridge-version');
      const deleteRefreshTokenBridges = jest.fn();
      const deps = makeDepsWithClient(user, {
        authorizeProviderSession,
        storeRefreshTokenBridge,
        deleteRefreshTokenBridges,
      });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      await expect(
        applyAdminRefresh(tokenset, deps, {
          userId: String(user._id),
          previousRefreshToken: 'old-refresh',
          boundProviderSession: ref,
        }),
      ).rejects.toBe(unrelatedError);

      expect(storeRefreshTokenBridge).toHaveBeenCalled();
      expect(deleteRefreshTokenBridges).not.toHaveBeenCalled();
    });

    it('stores the bridge before resolving the user, so a user-lookup failure still leaves a usable bridge', async () => {
      const id = new Types.ObjectId();
      const lookupError = new Error('user lookup backend down');
      const getUserById = jest.fn().mockRejectedValue(lookupError);
      const authorizeProviderSession = jest.fn();
      const storeRefreshTokenBridge = jest.fn().mockResolvedValue('bridge-version');
      const deps = makeDepsWithClient(undefined, {
        getUserById,
        authorizeProviderSession,
        storeRefreshTokenBridge,
      });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      await expect(
        applyAdminRefresh(tokenset, deps, {
          userId: id.toString(),
          previousRefreshToken: 'old-refresh',
          boundProviderSession: ref,
        }),
      ).rejects.toBe(lookupError);

      expect(storeRefreshTokenBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          oldRefreshToken: 'old-refresh',
          newRefreshToken: 'rotated-refresh',
          userId: id.toString(),
        }),
      );
      expect(authorizeProviderSession).not.toHaveBeenCalled();
    });

    it('keeps the bridge when mintToken throws after a successful authorize and session store', async () => {
      const user = makeUser();
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: true });
      const upsertSession = jest.fn().mockResolvedValue({});
      const deleteSession = jest.fn().mockResolvedValue({ deletedCount: 0 });
      const storeRefreshTokenBridge = jest.fn().mockResolvedValue('bridge-version');
      const deleteRefreshTokenBridges = jest.fn();
      const mintError = new Error('signing key unavailable');
      const mintToken = jest.fn().mockRejectedValue(mintError);
      const deps = makeDepsWithClient(user, {
        authorizeProviderSession,
        upsertSession,
        deleteSession,
        storeRefreshTokenBridge,
        deleteRefreshTokenBridges,
        mintToken,
      });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      await expect(
        applyAdminRefresh(tokenset, deps, {
          userId: String(user._id),
          previousRefreshToken: 'old-refresh',
          boundProviderSession: ref,
        }),
      ).rejects.toBe(mintError);

      expect(storeRefreshTokenBridge).toHaveBeenCalled();
      expect(deleteRefreshTokenBridges).not.toHaveBeenCalled();
    });

    it('keeps the bridge when onRefreshSuccess throws after minting', async () => {
      const user = makeUser();
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: true });
      const upsertSession = jest.fn().mockResolvedValue({});
      const deleteSession = jest.fn().mockResolvedValue({ deletedCount: 0 });
      const storeRefreshTokenBridge = jest.fn().mockResolvedValue('bridge-version');
      const deleteRefreshTokenBridges = jest.fn();
      const successError = new Error('onRefreshSuccess backend down');
      const onRefreshSuccess = jest.fn().mockRejectedValue(successError);
      const deps = makeDepsWithClient(user, {
        authorizeProviderSession,
        upsertSession,
        deleteSession,
        storeRefreshTokenBridge,
        deleteRefreshTokenBridges,
        onRefreshSuccess,
      });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      await expect(
        applyAdminRefresh(tokenset, deps, {
          userId: String(user._id),
          previousRefreshToken: 'old-refresh',
          boundProviderSession: ref,
        }),
      ).rejects.toBe(successError);

      expect(storeRefreshTokenBridge).toHaveBeenCalled();
      expect(deleteRefreshTokenBridges).not.toHaveBeenCalled();
    });

    it('runs mintToken and onRefreshSuccess only after authorization and session persistence succeed', async () => {
      const user = makeUser();
      const calls: string[] = [];
      const authorizeProviderSession = jest.fn().mockImplementation(async () => {
        calls.push('authorize');
        return { ok: true };
      });
      const upsertSession = jest.fn().mockImplementation(async () => {
        calls.push('upsertSession');
        return {};
      });
      const deleteSession = jest.fn().mockImplementation(async () => {
        calls.push('deleteSession');
        return { deletedCount: 0 };
      });
      const mintToken = jest.fn().mockImplementation(async () => {
        calls.push('mintToken');
        return { token: 'minted-jwt', expiresAt: 1234567890 };
      });
      const onRefreshSuccess = jest.fn().mockImplementation(async () => {
        calls.push('onRefreshSuccess');
      });
      const deps = makeDepsWithClient(user, {
        authorizeProviderSession,
        upsertSession,
        deleteSession,
        mintToken,
        onRefreshSuccess,
      });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      await applyAdminRefresh(tokenset, deps, {
        previousRefreshToken: 'old-refresh',
        boundProviderSession: ref,
      });

      expect(calls.indexOf('authorize')).toBeLessThan(calls.indexOf('mintToken'));
      expect(calls.indexOf('deleteSession')).toBeLessThan(calls.indexOf('mintToken'));
      expect(calls.indexOf('mintToken')).toBeLessThan(calls.indexOf('onRefreshSuccess'));
    });

    it('re-points the bridge under the originally-presented token on a second bridged retry', async () => {
      const user = makeUser();
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: true });
      const storeRefreshTokenBridge = jest
        .fn()
        .mockResolvedValueOnce('bridge-version-1')
        .mockResolvedValueOnce('bridge-version-2');
      const deps = makeDepsWithClient(user, { authorizeProviderSession, storeRefreshTokenBridge });

      const firstTokenset = makeTokenset({
        refresh_token: 'rotated-refresh-1',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });
      await applyAdminRefresh(firstTokenset, deps, {
        userId: String(user._id),
        previousRefreshToken: 'old-refresh',
        boundProviderSession: ref,
      });

      const secondTokenset = makeTokenset({
        refresh_token: 'rotated-refresh-2',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });
      await applyAdminRefresh(secondTokenset, deps, {
        userId: String(user._id),
        previousRefreshToken: 'old-refresh',
        grantRefreshToken: 'rotated-refresh-1',
        boundProviderSession: ref,
      });

      expect(storeRefreshTokenBridge).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          oldRefreshToken: 'old-refresh',
          newRefreshToken: 'rotated-refresh-2',
        }),
      );
    });

    it('stores the Session under the resolved user tenant when the request tenantId is undefined', async () => {
      const user = makeUser({ tenantId: 'tenant-T' } as Partial<IUser>);
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: true });
      const upsertSession = jest.fn().mockResolvedValue({});
      const deleteSession = jest.fn().mockResolvedValue({ deletedCount: 0 });
      const deps = makeDepsWithClient(user, {
        authorizeProviderSession,
        upsertSession,
        deleteSession,
      });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      await applyAdminRefresh(tokenset, deps, {
        previousRefreshToken: 'old-refresh',
        boundProviderSession: ref,
      });

      expect(upsertSession).toHaveBeenCalledWith(
        String(user._id),
        'rotated-refresh',
        expect.objectContaining({ tenantId: 'tenant-T' }),
      );
    });

    it('never attempts a bridge store when storeRefreshTokenBridge is not configured, even after a session-store failure', async () => {
      const user = makeUser();
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: true });
      const saveError = new Error('session upsert failed');
      const upsertSession = jest.fn().mockRejectedValue(saveError);
      const deleteSession = jest.fn().mockResolvedValue({ deletedCount: 0 });
      const deps = makeDepsWithClient(user, {
        authorizeProviderSession,
        upsertSession,
        deleteSession,
      });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      await expect(
        applyAdminRefresh(tokenset, deps, {
          previousRefreshToken: 'old-refresh',
          boundProviderSession: ref,
        }),
      ).rejects.toMatchObject({ name: 'ProviderSessionUnavailableError', cause: saveError });

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('does not call getMode or store the session when the IdP grant has no rotated or bridged token', async () => {
      const user = makeUser();
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: true });
      const upsertSession = jest.fn().mockResolvedValue({});
      const deleteSession = jest.fn().mockResolvedValue({ deletedCount: 0 });
      const getMode = jest.fn().mockResolvedValue('enforce');
      const deps = makeDepsWithClient(user, {
        authorizeProviderSession,
        upsertSession,
        deleteSession,
        getMode,
      });
      const tokenset = makeTokenset({
        refresh_token: undefined,
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      await applyAdminRefresh(tokenset, deps, { boundProviderSession: ref });

      expect(getMode).not.toHaveBeenCalled();
      expect(upsertSession).not.toHaveBeenCalled();
    });

    it('skips storing the session when only one of upsertSession/deleteSession is configured', async () => {
      const user = makeUser();
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: true });
      const upsertSession = jest.fn().mockResolvedValue({});
      const deps = makeDepsWithClient(user, { authorizeProviderSession, upsertSession });
      const tokenset = makeTokenset({
        refresh_token: 'rotated-refresh',
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      await applyAdminRefresh(tokenset, deps, { boundProviderSession: ref });

      expect(upsertSession).not.toHaveBeenCalled();
    });

    it('stores no recovery bridge when the IdP did not rotate the refresh token, even if storing the session fails', async () => {
      const user = makeUser();
      const authorizeProviderSession = jest.fn().mockResolvedValue({ ok: true });
      const saveError = new Error('session upsert failed');
      const upsertSession = jest.fn().mockRejectedValue(saveError);
      const deleteSession = jest.fn().mockResolvedValue({ deletedCount: 0 });
      const storeRefreshTokenBridge = jest.fn();
      const deps = makeDepsWithClient(user, {
        authorizeProviderSession,
        upsertSession,
        deleteSession,
        storeRefreshTokenBridge,
      });
      const tokenset = makeTokenset({
        refresh_token: undefined,
        claims: () => ({ sub: SUB, iss: ref.issuer, sid: ref.sid }),
      });

      await expect(
        applyAdminRefresh(tokenset, deps, {
          previousRefreshToken: 'old-refresh',
          grantRefreshToken: 'bridged-token-b',
          boundProviderSession: ref,
        }),
      ).rejects.toMatchObject({ name: 'ProviderSessionUnavailableError', cause: saveError });

      expect(storeRefreshTokenBridge).not.toHaveBeenCalled();
    });
  });
});

describe('lookupAdminRefreshBinding', () => {
  it('returns { ok: true, binding: null } when findProviderSessionBinding is not provided', async () => {
    const result = await lookupAdminRefreshBinding('refresh-token', {});
    expect(result).toEqual({ ok: true, binding: null });
  });

  it('returns the binding on a successful lookup', async () => {
    const binding = { userId: 'user-1', tenantId: 'tenant-a' };
    const findProviderSessionBinding = jest.fn().mockResolvedValue(binding);

    const result = await lookupAdminRefreshBinding('refresh-token', {
      findProviderSessionBinding,
    });

    expect(findProviderSessionBinding).toHaveBeenCalledWith('refresh-token');
    expect(result).toEqual({ ok: true, binding });
  });

  it('returns { ok: false } and logs a warning when the lookup throws', async () => {
    const lookupError = new Error('db down');
    const findProviderSessionBinding = jest.fn().mockRejectedValue(lookupError);

    const result = await lookupAdminRefreshBinding('refresh-token', {
      findProviderSessionBinding,
    });

    expect(result).toEqual({ ok: false });
    expect(logger.warn).toHaveBeenCalledWith(
      '[adminRefresh] provider-session binding lookup failed',
      { error: lookupError },
    );
  });
});

describe('precheckAdminRefreshBinding', () => {
  it('skips the check and returns a null ref when deps are omitted (mode off)', async () => {
    const result = await precheckAdminRefreshBinding({ ok: true, binding: null }, {});
    expect(result).toEqual({ ref: null });
  });

  it('resolves with the bound ref when preCheck authorizes', async () => {
    const ref = { issuer: 'https://issuer.example.com', clientId: 'test-client', sid: 'sid-1' };
    const preCheckProviderSession = jest.fn().mockResolvedValue({ ok: true });

    const result = await precheckAdminRefreshBinding(
      { ok: true, binding: { providerSession: ref } },
      { preCheckProviderSession },
    );

    expect(preCheckProviderSession).toHaveBeenCalledWith({
      ref,
      subject: undefined,
      expiresAt: expect.any(Date),
    });
    expect(result).toEqual({ ref });
  });

  it('passes the bound subject to preCheck when the binding carries one', async () => {
    const ref = { issuer: 'https://issuer.example.com', clientId: 'test-client', sid: 'sid-1' };
    const preCheckProviderSession = jest.fn().mockResolvedValue({ ok: true });

    await precheckAdminRefreshBinding(
      { ok: true, binding: { providerSession: ref, subject: 'idp-sub-99' } },
      { preCheckProviderSession },
    );

    expect(preCheckProviderSession).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'idp-sub-99' }),
    );
  });

  it('passes ref: null to preCheck when no binding is found', async () => {
    const preCheckProviderSession = jest.fn().mockResolvedValue({ ok: true });

    const result = await precheckAdminRefreshBinding(
      { ok: true, binding: null },
      { preCheckProviderSession },
    );

    expect(preCheckProviderSession).toHaveBeenCalledWith({
      ref: null,
      subject: undefined,
      expiresAt: expect.any(Date),
    });
    expect(result).toEqual({ ref: null });
  });

  it('throws AdminRefreshError before any IdP grant would occur when preCheck denies', async () => {
    const preCheckProviderSession = jest.fn().mockResolvedValue({ ok: false });

    await expect(
      precheckAdminRefreshBinding({ ok: true, binding: null }, { preCheckProviderSession }),
    ).rejects.toMatchObject({
      name: 'AdminRefreshError',
      code: 'OPENID_SESSION_ENDED',
      status: 401,
      message: 'Provider session has ended',
    });
  });

  it('propagates an unavailable provider-session check uncaught', async () => {
    const unavailableError = new Error('db down');
    const preCheckProviderSession = jest.fn().mockRejectedValue(unavailableError);

    await expect(
      precheckAdminRefreshBinding({ ok: true, binding: null }, { preCheckProviderSession }),
    ).rejects.toBe(unavailableError);
  });

  it('throws ProviderSessionUnavailableError, not a raw 500, when the binding lookup failed under enforce', async () => {
    const preCheckProviderSession = jest.fn();
    const getMode = jest.fn().mockResolvedValue('enforce');

    await expect(
      precheckAdminRefreshBinding({ ok: false }, { preCheckProviderSession, getMode }),
    ).rejects.toMatchObject({
      name: 'ProviderSessionUnavailableError',
      status: 503,
      message: 'Provider session check unavailable',
    });
    expect(preCheckProviderSession).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      '[precheckAdminRefreshBinding] provider-session binding lookup unavailable',
    );
  });

  it('fails open with a null ref when the binding lookup failed under record', async () => {
    const preCheckProviderSession = jest.fn().mockResolvedValue({ ok: true });
    const getMode = jest.fn().mockResolvedValue('record');

    const result = await precheckAdminRefreshBinding(
      { ok: false },
      { preCheckProviderSession, getMode },
    );

    expect(result).toEqual({ ref: null });
    expect(preCheckProviderSession).toHaveBeenCalledWith({
      ref: null,
      subject: undefined,
      expiresAt: expect.any(Date),
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[precheckAdminRefreshBinding] provider-session binding lookup unavailable; continuing in record mode',
    );
  });

  it('treats a missing getMode as not enforced and fails open when the binding lookup failed', async () => {
    const preCheckProviderSession = jest.fn().mockResolvedValue({ ok: true });

    const result = await precheckAdminRefreshBinding({ ok: false }, { preCheckProviderSession });

    expect(result).toEqual({ ref: null });
    expect(preCheckProviderSession).toHaveBeenCalledWith({
      ref: null,
      subject: undefined,
      expiresAt: expect.any(Date),
    });
  });
});

describe('resolveAdminRefreshToken', () => {
  it('returns the incoming token unchanged when the deps are omitted (mode off)', async () => {
    const result = await resolveAdminRefreshToken('refresh-token', { ok: true, binding: null }, {});
    expect(result).toEqual({ refreshToken: 'refresh-token', bridged: false });
  });

  it('returns the incoming token unchanged when no binding and no userId is available', async () => {
    const getRefreshTokenBridge = jest.fn();

    const result = await resolveAdminRefreshToken(
      'refresh-token',
      { ok: true, binding: null },
      { getRefreshTokenBridge },
    );

    expect(result).toEqual({ refreshToken: 'refresh-token', bridged: false });
    expect(getRefreshTokenBridge).not.toHaveBeenCalled();
  });

  it('returns the incoming token unchanged, without calling the unconfigured bridge lookup, even when a userId is resolvable', async () => {
    const result = await resolveAdminRefreshToken(
      'refresh-token',
      { ok: true, binding: { userId: 'user-1' } },
      {},
    );

    expect(result).toEqual({ refreshToken: 'refresh-token', bridged: false });
  });

  it('looks up the bridge by options.userId when there is no Session row', async () => {
    const getRefreshTokenBridge = jest.fn().mockResolvedValue({ refreshToken: 'bridged-refresh' });

    const result = await resolveAdminRefreshToken(
      'refresh-token',
      { ok: true, binding: null },
      { getRefreshTokenBridge },
      { userId: 'user-99' },
    );

    expect(getRefreshTokenBridge).toHaveBeenCalledWith(
      expect.objectContaining({ oldRefreshToken: 'refresh-token', userId: 'user-99' }),
    );
    expect(result.bridged).toBe(true);
    expect(result.identity).toEqual({
      userId: 'user-99',
      tenantId: undefined,
      openidIssuer: undefined,
    });
  });

  it('uses the request tenantId over the binding tenant when looking up the bridge', async () => {
    const getRefreshTokenBridge = jest.fn().mockResolvedValue(null);

    const result = await resolveAdminRefreshToken(
      'refresh-token',
      { ok: true, binding: { userId: 'user-1', tenantId: 'tenant-T' } },
      { getRefreshTokenBridge },
      { tenantId: undefined },
    );

    // The Session row behind `binding` is gone by the time a retry presents the token it
    // replaced, so keying the lookup by its tenant instead of the request tenant would make the
    // same client's retry miss the bridge it stored under the request tenant. `options.tenantId`
    // is the one value both requests of the same client resolve identically.
    expect(getRefreshTokenBridge).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: undefined }),
    );
    expect(result).toEqual({
      refreshToken: 'refresh-token',
      bridged: false,
      identity: { userId: 'user-1', tenantId: undefined, openidIssuer: undefined },
    });
  });

  it('uses the request tenantId for the bridge lookup even when it differs from the binding tenant', async () => {
    const getRefreshTokenBridge = jest.fn().mockResolvedValue({ refreshToken: 'bridged-refresh' });

    const result = await resolveAdminRefreshToken(
      'refresh-token',
      { ok: true, binding: { userId: 'user-1', tenantId: 'tenant-session' } },
      { getRefreshTokenBridge },
      { tenantId: 'tenant-request' },
    );

    expect(getRefreshTokenBridge).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-request' }),
    );
    expect(result.identity).toEqual({
      userId: 'user-1',
      tenantId: 'tenant-request',
      openidIssuer: undefined,
    });
  });

  it('swaps in the bridged token when a bridge exists for the incoming token', async () => {
    const getRefreshTokenBridge = jest.fn().mockResolvedValue({ refreshToken: 'bridged-refresh' });

    const result = await resolveAdminRefreshToken(
      'refresh-token',
      { ok: true, binding: { userId: 'user-1' } },
      { getRefreshTokenBridge },
      { expectedIssuer: 'https://issuer.example.com' },
    );

    expect(getRefreshTokenBridge).toHaveBeenCalledWith({
      oldRefreshToken: 'refresh-token',
      userId: 'user-1',
      tenantId: undefined,
      openidIssuer: 'https://issuer.example.com',
    });
    expect(result.refreshToken).toBe('bridged-refresh');
    expect(result.bridged).toBe(true);
    expect(result.identity).toEqual({
      userId: 'user-1',
      tenantId: undefined,
      openidIssuer: 'https://issuer.example.com',
    });
  });

  it('throws ProviderSessionUnavailableError when the bridge lookup fails', async () => {
    const lookupError = new Error('db down');
    const getRefreshTokenBridge = jest.fn().mockRejectedValue(lookupError);

    await expect(
      resolveAdminRefreshToken(
        'refresh-token',
        { ok: true, binding: { userId: 'user-1' } },
        { getRefreshTokenBridge },
      ),
    ).rejects.toMatchObject({
      name: 'ProviderSessionUnavailableError',
      message: 'Provider session check unavailable',
      cause: lookupError,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[resolveAdminRefreshToken] Refresh-token bridge lookup failed',
      { error: lookupError },
    );
  });

  it('throws ProviderSessionUnavailableError and never calls getRefreshTokenBridge when the binding lookup itself failed', async () => {
    const getRefreshTokenBridge = jest.fn();

    await expect(
      resolveAdminRefreshToken('refresh-token', { ok: false }, { getRefreshTokenBridge }),
    ).rejects.toMatchObject({
      name: 'ProviderSessionUnavailableError',
      message: 'Provider session check unavailable',
    });
    expect(getRefreshTokenBridge).not.toHaveBeenCalled();
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
