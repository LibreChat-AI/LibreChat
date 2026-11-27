import { Types } from 'mongoose';

import type { IUser } from '@librechat/data-schemas';
import type { GoogleAdminRefreshDeps, GoogleAdminRefreshOptions } from './googleRefresh';

import { applyGoogleAdminRefresh } from './googleRefresh';
import { AdminRefreshError } from './refresh';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

const SUB = 'google-admin-sub';

function makeUser(overrides: Partial<IUser> = {}): IUser {
  const _id = overrides._id ?? new Types.ObjectId();
  return {
    _id,
    email: 'admin@example.com',
    name: 'Admin User',
    username: 'admin',
    role: 'ADMIN',
    provider: 'google',
    googleId: SUB,
    avatar: 'https://example.com/avatar.png',
    ...overrides,
  } as IUser;
}

function makeIdToken(claims: Record<string, unknown> = { sub: SUB }): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.signature`;
}

function makeOkJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeStatus(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const baseOptions: GoogleAdminRefreshOptions = {
  refreshToken: 'incoming-refresh',
  clientId: 'google-client-id',
  clientSecret: 'google-client-secret',
};

describe('applyGoogleAdminRefresh', () => {
  let deps: jest.Mocked<GoogleAdminRefreshDeps>;
  let fetchMock: jest.Mock;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    deps = {
      findUsers: jest.fn(),
      getUserById: jest.fn(),
      canAccessAdmin: jest.fn(),
      isEmailAllowed: jest.fn().mockResolvedValue(true),
      mintToken: jest.fn(),
    };
    originalFetch = global.fetch;
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('refreshes a Google admin session and returns the exchange-shaped response', async () => {
    const user = makeUser();
    fetchMock.mockResolvedValueOnce(
      makeOkJson({ access_token: 'new-access', id_token: makeIdToken() }),
    );
    deps.findUsers.mockResolvedValue([user]);
    deps.canAccessAdmin.mockResolvedValue(true);
    deps.mintToken.mockResolvedValue({ token: 'minted-jwt', expiresAt: 1700000000000 });

    const result = await applyGoogleAdminRefresh(deps, baseOptions);

    expect(result).toEqual({
      token: 'minted-jwt',
      refreshToken: 'incoming-refresh',
      user: expect.objectContaining({
        id: String(user._id),
        _id: String(user._id),
        email: 'admin@example.com',
        provider: 'google',
        username: 'admin',
        role: 'ADMIN',
      }),
      expiresAt: 1700000000000,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const body = (init as { body: URLSearchParams }).body.toString();
    expect(body).toContain('client_id=google-client-id');
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=incoming-refresh');
  });

  it('throws GOOGLE_NOT_CONFIGURED when credentials are missing', async () => {
    await expect(
      applyGoogleAdminRefresh(deps, {
        ...baseOptions,
        clientId: undefined,
        clientSecret: undefined,
      }),
    ).rejects.toMatchObject({ code: 'GOOGLE_NOT_CONFIGURED', status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws REFRESH_FAILED when Google rejects the grant', async () => {
    fetchMock.mockResolvedValueOnce(makeStatus(401));
    await expect(applyGoogleAdminRefresh(deps, baseOptions)).rejects.toMatchObject({
      code: 'REFRESH_FAILED',
      status: 401,
    });
  });

  it('throws IDP_INCOMPLETE when Google returns a non-JSON body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('not json', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    );
    await expect(applyGoogleAdminRefresh(deps, baseOptions)).rejects.toMatchObject({
      code: 'IDP_INCOMPLETE',
      status: 502,
    });
  });

  it('throws IDP_INCOMPLETE when the tokenset is missing access_token', async () => {
    fetchMock.mockResolvedValueOnce(makeOkJson({ id_token: makeIdToken() }));
    await expect(applyGoogleAdminRefresh(deps, baseOptions)).rejects.toMatchObject({
      code: 'IDP_INCOMPLETE',
      status: 502,
    });
  });

  it('throws ISSUER_MISMATCH when the id_token aud does not match the configured clientId', async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkJson({
        access_token: 'new-access',
        id_token: makeIdToken({ sub: SUB, aud: 'wrong-client' }),
      }),
    );

    await expect(applyGoogleAdminRefresh(deps, baseOptions)).rejects.toMatchObject({
      code: 'ISSUER_MISMATCH',
      status: 401,
    });
    expect(deps.findUsers).not.toHaveBeenCalled();
  });

  it('falls back to the userinfo endpoint when id_token is absent', async () => {
    const user = makeUser();
    fetchMock
      .mockResolvedValueOnce(makeOkJson({ access_token: 'new-access' }))
      .mockResolvedValueOnce(makeOkJson({ sub: SUB }));
    deps.findUsers.mockResolvedValue([user]);
    deps.canAccessAdmin.mockResolvedValue(true);
    deps.mintToken.mockResolvedValue({ token: 'minted-jwt', expiresAt: 1 });

    const result = await applyGoogleAdminRefresh(deps, baseOptions);

    expect(fetchMock.mock.calls[1][0]).toBe('https://openidconnect.googleapis.com/v1/userinfo');
    expect(result.user.id).toBe(String(user._id));
  });

  it('throws CLAIMS_INCOMPLETE when neither id_token nor userinfo yields a sub', async () => {
    fetchMock
      .mockResolvedValueOnce(makeOkJson({ access_token: 'new-access' }))
      .mockResolvedValueOnce(makeStatus(401));

    await expect(applyGoogleAdminRefresh(deps, baseOptions)).rejects.toMatchObject({
      code: 'CLAIMS_INCOMPLETE',
      status: 502,
    });
  });

  it('throws USER_ID_MISMATCH when user_id resolves to a different googleId', async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkJson({ access_token: 'new-access', id_token: makeIdToken() }),
    );
    const direct = makeUser({ googleId: 'other-google-id' });
    deps.getUserById.mockResolvedValue(direct);

    await expect(
      applyGoogleAdminRefresh(deps, { ...baseOptions, userId: String(direct._id) }),
    ).rejects.toMatchObject({ code: 'USER_ID_MISMATCH', status: 401 });
  });

  it('ignores malformed user_id values that are not valid ObjectIds', async () => {
    const user = makeUser();
    fetchMock.mockResolvedValueOnce(
      makeOkJson({ access_token: 'new-access', id_token: makeIdToken() }),
    );
    deps.findUsers.mockResolvedValue([user]);
    deps.canAccessAdmin.mockResolvedValue(true);
    deps.mintToken.mockResolvedValue({ token: 'minted-jwt', expiresAt: 1 });

    const result = await applyGoogleAdminRefresh(deps, {
      ...baseOptions,
      userId: 'not-an-objectid',
    });

    expect(deps.getUserById).not.toHaveBeenCalled();
    expect(result.token).toBe('minted-jwt');
  });

  it('throws TENANT_MISMATCH when the resolved direct user belongs to another tenant', async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkJson({ access_token: 'new-access', id_token: makeIdToken() }),
    );
    const direct = makeUser({ tenantId: 'tenant-a' });
    deps.getUserById.mockResolvedValue(direct);

    await expect(
      applyGoogleAdminRefresh(deps, {
        ...baseOptions,
        userId: String(direct._id),
        tenantId: 'tenant-b',
      }),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH', status: 401 });
  });

  it('throws USER_ID_MISMATCH when multiple users share the same googleId', async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkJson({ access_token: 'new-access', id_token: makeIdToken() }),
    );
    deps.findUsers.mockResolvedValue([makeUser(), makeUser({ email: 'other@example.com' })]);

    await expect(applyGoogleAdminRefresh(deps, baseOptions)).rejects.toMatchObject({
      code: 'USER_ID_MISMATCH',
      status: 401,
    });
  });

  it('throws PROVIDER_MISMATCH when the resolved user is not bound to the google provider (findUsers path)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkJson({ access_token: 'new-access', id_token: makeIdToken() }),
    );
    deps.findUsers.mockResolvedValue([makeUser({ provider: 'openid' })]);

    await expect(applyGoogleAdminRefresh(deps, baseOptions)).rejects.toMatchObject({
      code: 'PROVIDER_MISMATCH',
      status: 401,
    });
    expect(deps.canAccessAdmin).not.toHaveBeenCalled();
  });

  it('throws PROVIDER_MISMATCH when the direct-lookup user is not bound to the google provider', async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkJson({ access_token: 'new-access', id_token: makeIdToken() }),
    );
    const direct = makeUser({ provider: 'openid' });
    deps.getUserById.mockResolvedValue(direct);

    await expect(
      applyGoogleAdminRefresh(deps, { ...baseOptions, userId: String(direct._id) }),
    ).rejects.toMatchObject({ code: 'PROVIDER_MISMATCH', status: 401 });
    expect(deps.canAccessAdmin).not.toHaveBeenCalled();
  });

  it('throws USER_NOT_FOUND when no admin user matches the refreshed googleId', async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkJson({ access_token: 'new-access', id_token: makeIdToken() }),
    );
    deps.findUsers.mockResolvedValue([]);

    await expect(applyGoogleAdminRefresh(deps, baseOptions)).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
      status: 401,
    });
  });

  it('throws FORBIDDEN when the resolved user no longer holds ACCESS_ADMIN', async () => {
    const user = makeUser();
    fetchMock.mockResolvedValueOnce(
      makeOkJson({ access_token: 'new-access', id_token: makeIdToken() }),
    );
    deps.findUsers.mockResolvedValue([user]);
    deps.canAccessAdmin.mockResolvedValue(false);

    await expect(applyGoogleAdminRefresh(deps, baseOptions)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
  });

  it('throws FORBIDDEN when isEmailAllowed rejects the refreshed identity', async () => {
    const user = makeUser();
    fetchMock.mockResolvedValueOnce(
      makeOkJson({ access_token: 'new-access', id_token: makeIdToken() }),
    );
    deps.findUsers.mockResolvedValue([user]);
    (deps.isEmailAllowed as jest.Mock).mockResolvedValue(false);

    await expect(applyGoogleAdminRefresh(deps, baseOptions)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
      message: expect.stringContaining('domain'),
    });
    expect(deps.canAccessAdmin).not.toHaveBeenCalled();
  });

  it('returns the rotated refresh_token when Google supplies one', async () => {
    const user = makeUser();
    fetchMock.mockResolvedValueOnce(
      makeOkJson({
        access_token: 'new-access',
        id_token: makeIdToken(),
        refresh_token: 'rotated-refresh',
      }),
    );
    deps.findUsers.mockResolvedValue([user]);
    deps.canAccessAdmin.mockResolvedValue(true);
    deps.mintToken.mockResolvedValue({ token: 'minted-jwt', expiresAt: 1 });

    const result = await applyGoogleAdminRefresh(deps, baseOptions);

    expect(result.refreshToken).toBe('rotated-refresh');
  });

  it('uses (AdminRefreshError instanceof) for route mapping', () => {
    const err = new AdminRefreshError('GOOGLE_NOT_CONFIGURED', 503, 'msg');
    expect(err).toBeInstanceOf(AdminRefreshError);
  });
});
