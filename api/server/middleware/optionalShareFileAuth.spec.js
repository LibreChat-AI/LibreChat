const mockVerify = jest.fn();
const mockGetUserById = jest.fn();
const mockFindSession = jest.fn();
const mockRunAsSystem = jest.fn((fn) => fn());
const mockIsTwoFactorEnrollmentRequired = jest.fn(() => false);
const mockIsTokenRetired = jest.fn(() => false);
const mockClearCloudFrontCookies = jest.fn();

jest.mock('jsonwebtoken', () => ({ verify: (...args) => mockVerify(...args) }));
jest.mock('@librechat/api', () => ({
  createOptionalShareFileAuth: jest.requireActual('@librechat/api').createOptionalShareFileAuth,
  isEnabled: (v) => v === 'true' || v === true,
  clearCloudFrontCookies: (...args) => mockClearCloudFrontCookies(...args),
  isTwoFactorEnrollmentRequired: (...args) => mockIsTwoFactorEnrollmentRequired(...args),
  isTokenRetired: (...args) => mockIsTokenRetired(...args),
}));
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { warn: jest.fn(), error: jest.fn() },
  runAsSystem: (...args) => mockRunAsSystem(...args),
}));
jest.mock('~/models', () => ({
  getUserById: (...args) => mockGetUserById(...args),
  findSession: (...args) => mockFindSession(...args),
}));

const optionalShareFileAuth = require('./optionalShareFileAuth');

const run = async (req) => {
  const next = jest.fn();
  await optionalShareFileAuth(req, {}, next);
  return next;
};

describe('optionalShareFileAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTwoFactorEnrollmentRequired.mockReturnValue(false);
    mockIsTokenRetired.mockReturnValue(false);
    process.env.JWT_REFRESH_SECRET = 'test-secret';
  });

  it('short-circuits when a bearer user is already set (no cookie work)', async () => {
    const req = { user: { id: 'u1' }, headers: { cookie: 'refreshToken=x' } };
    const next = await run(req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockFindSession).not.toHaveBeenCalled();
  });

  it('removes an existing viewer when required enrollment is incomplete', async () => {
    mockIsTwoFactorEnrollmentRequired.mockReturnValue(true);
    const req = {
      user: { id: 'u1', provider: 'local', twoFactorEnabled: false },
      authStrategy: 'jwt',
      headers: { cookie: 'refreshToken=x' },
    };

    const next = await run(req);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
    expect(req.authStrategy).toBeUndefined();
    expect(mockClearCloudFrontCookies).toHaveBeenCalledWith(expect.any(Object), {
      userId: 'u1',
      tenantId: undefined,
      storageRegion: undefined,
    });
    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockFindSession).not.toHaveBeenCalled();
  });

  it('resolves the viewer from a valid refreshToken cookie with a live session', async () => {
    mockVerify.mockReturnValue({ id: 'viewer-1' });
    mockFindSession.mockResolvedValue({ _id: 'session-1' });
    mockGetUserById.mockResolvedValue({ _id: 'viewer-1', role: 'USER' });
    const req = { headers: { cookie: 'refreshToken=good.jwt' } };
    const next = await run(req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockVerify).toHaveBeenCalledWith('good.jwt', 'test-secret');
    expect(mockFindSession).toHaveBeenCalledWith({ userId: 'viewer-1', refreshToken: 'good.jwt' });
    expect(mockRunAsSystem).toHaveBeenCalledTimes(2);
    expect(req.user).toMatchObject({ id: 'viewer-1', role: 'USER' });
  });

  it('does not restore a cookie viewer when required enrollment is incomplete', async () => {
    mockVerify.mockReturnValue({ id: 'viewer-required' });
    mockFindSession.mockResolvedValue({ _id: 'session-required' });
    mockGetUserById.mockResolvedValue({
      _id: 'viewer-required',
      role: 'USER',
      provider: 'local',
      twoFactorEnabled: false,
    });
    mockIsTwoFactorEnrollmentRequired.mockReturnValue(true);
    const req = { headers: { cookie: 'refreshToken=good.jwt' } };

    const next = await run(req);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
    expect(mockClearCloudFrontCookies).toHaveBeenCalledWith(expect.any(Object), {
      userId: 'viewer-required',
      tenantId: undefined,
      storageRegion: undefined,
    });
    expect(mockGetUserById).toHaveBeenCalledTimes(1);
  });

  it('does not restore a cookie viewer minted before two-factor enrollment', async () => {
    mockVerify.mockReturnValue({ id: 'viewer-stale', iat: 1000 });
    mockFindSession.mockResolvedValue({ _id: 'session-stale' });
    mockGetUserById.mockResolvedValue({
      _id: 'viewer-stale',
      role: 'USER',
      provider: 'local',
      twoFactorEnabled: true,
      twoFactorEnrolledAt: new Date(2000 * 1000),
    });
    mockIsTokenRetired.mockReturnValue(true);
    const req = { headers: { cookie: 'refreshToken=stale.jwt' } };

    const next = await run(req);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
    expect(mockClearCloudFrontCookies).toHaveBeenCalledWith(expect.any(Object), {
      userId: 'viewer-stale',
      tenantId: undefined,
      storageRegion: undefined,
    });
  });

  it('dates the cookie by its own mint stamps rather than discarding them', async () => {
    const enrolledAt = new Date(2000 * 1000);
    mockVerify.mockReturnValue({ id: 'viewer-dated', iat: 1234, issuedAtMs: 1234_500 });
    mockFindSession.mockResolvedValue({ _id: 'session-dated' });
    mockGetUserById.mockResolvedValue({
      _id: 'viewer-dated',
      role: 'USER',
      twoFactorEnrolledAt: enrolledAt,
    });
    const req = { headers: { cookie: 'refreshToken=dated.jwt' } };

    await run(req);

    expect(mockIsTokenRetired).toHaveBeenCalledWith(
      expect.objectContaining({ issuedAt: 1234, issuedAtMs: 1234_500 }),
      expect.objectContaining({ twoFactorEnrolledAt: enrolledAt }),
    );
  });

  it('dates an OpenID cookie viewer by its own mint stamps too', async () => {
    process.env.OPENID_REUSE_TOKENS = 'true';
    const enrolledAt = new Date(2000 * 1000);
    mockVerify.mockReturnValue({ id: 'viewer-openid', iat: 4321, issuedAtMs: 4321_500 });
    mockGetUserById.mockResolvedValue({
      _id: 'viewer-openid',
      role: 'USER',
      twoFactorEnrolledAt: enrolledAt,
    });
    const req = {
      headers: {
        cookie: 'refreshToken=live.jwt; token_provider=openid; openid_user_id=signed.jwt',
      },
      session: { openidTokens: { refreshToken: 'live.jwt' } },
    };

    await run(req);

    expect(mockIsTokenRetired).toHaveBeenCalledWith(
      expect.objectContaining({ issuedAt: 4321, issuedAtMs: 4321_500 }),
      expect.objectContaining({ twoFactorEnrolledAt: enrolledAt }),
    );
    delete process.env.OPENID_REUSE_TOKENS;
  });

  it('defaults the role to USER when the record has none', async () => {
    mockVerify.mockReturnValue({ id: 'viewer-2' });
    mockFindSession.mockResolvedValue({ _id: 'session-2' });
    mockGetUserById.mockResolvedValue({ _id: 'viewer-2' });
    const req = { headers: { cookie: 'refreshToken=good.jwt' } };
    await run(req);
    expect(req.user.role).toBe('USER');
  });

  it('leaves req.user unset when there is no cookie', async () => {
    const req = { headers: {} };
    const next = await run(req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  it('leaves req.user unset when the refresh token has no live session', async () => {
    mockVerify.mockReturnValue({ id: 'viewer-3' });
    mockFindSession.mockResolvedValue(null);
    const req = { headers: { cookie: 'refreshToken=revoked.jwt' } };
    const next = await run(req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
    expect(mockFindSession).toHaveBeenCalledWith({
      userId: 'viewer-3',
      refreshToken: 'revoked.jwt',
    });
    expect(mockRunAsSystem).toHaveBeenCalledTimes(1);
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  it('leaves req.user unset when the token is invalid', async () => {
    mockVerify.mockImplementation(() => {
      throw new Error('bad token');
    });
    const req = { headers: { cookie: 'refreshToken=bad' } };
    const next = await run(req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  it('uses the signed openid_user_id cookie only for active OpenID-reuse sessions', async () => {
    process.env.OPENID_REUSE_TOKENS = 'true';
    mockVerify.mockReturnValue({ id: 'oidc-1' });
    mockGetUserById.mockResolvedValue({ _id: 'oidc-1', role: 'USER' });
    const req = {
      headers: {
        cookie: 'token_provider=openid; refreshToken=stored-refresh; openid_user_id=signed.jwt',
      },
      session: { openidTokens: { refreshToken: 'stored-refresh' } },
    };
    await run(req);
    expect(mockVerify).toHaveBeenCalledWith('signed.jwt', 'test-secret');
    expect(mockFindSession).not.toHaveBeenCalled();
    expect(req.user).toMatchObject({ id: 'oidc-1' });
    delete process.env.OPENID_REUSE_TOKENS;
  });

  it('leaves req.user unset for OpenID-reuse cookies without an active matching session', async () => {
    process.env.OPENID_REUSE_TOKENS = 'true';
    mockVerify.mockReturnValue({ id: 'oidc-2' });
    const req = {
      headers: {
        cookie: 'token_provider=openid; refreshToken=stale-refresh; openid_user_id=signed.jwt',
      },
      session: { openidTokens: { refreshToken: 'current-refresh' } },
    };
    await run(req);
    expect(req.user).toBeUndefined();
    expect(mockGetUserById).not.toHaveBeenCalled();
    delete process.env.OPENID_REUSE_TOKENS;
  });
});
