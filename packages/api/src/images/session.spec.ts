import { storeOpenIdSession } from './session';

describe('storeOpenIdSession', () => {
  const originalRefreshTokenExpiry = process.env.REFRESH_TOKEN_EXPIRY;
  const deps = {
    upsertSession: jest.fn(),
    deleteSession: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.REFRESH_TOKEN_EXPIRY;
    deps.upsertSession.mockResolvedValue({ _id: 'session-id' });
    deps.deleteSession.mockResolvedValue({ deletedCount: 1 });
  });

  afterAll(() => {
    if (originalRefreshTokenExpiry === undefined) {
      delete process.env.REFRESH_TOKEN_EXPIRY;
      return;
    }
    process.env.REFRESH_TOKEN_EXPIRY = originalRefreshTokenExpiry;
  });

  it('stores the active OpenID refresh token with a durable expiration', async () => {
    const before = Date.now();

    await storeOpenIdSession(
      { userId: 'user-id', refreshToken: 'new-refresh', tenantId: 'tenant-a' },
      deps,
    );

    expect(deps.upsertSession).toHaveBeenCalledWith(
      'user-id',
      'new-refresh',
      expect.objectContaining({ tenantId: 'tenant-a', expiration: expect.any(Date) }),
    );
    expect(deps.upsertSession.mock.calls[0][2].expiration.getTime()).toBeGreaterThan(before);
  });

  it('revokes the previous durable session after refresh-token rotation', async () => {
    await storeOpenIdSession(
      {
        userId: 'user-id',
        refreshToken: 'new-refresh',
        previousRefreshToken: 'old-refresh',
      },
      deps,
    );

    expect(deps.deleteSession).toHaveBeenCalledWith({ refreshToken: 'old-refresh' });
  });

  it('does not create a durable session without a refresh token', async () => {
    await expect(storeOpenIdSession({ userId: 'user-id' }, deps)).resolves.toBe(false);
    expect(deps.upsertSession).not.toHaveBeenCalled();
  });
});
