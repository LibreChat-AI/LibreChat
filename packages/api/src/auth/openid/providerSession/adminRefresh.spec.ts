import type { IUser } from '@librechat/data-schemas';
import type { AdminOpenIdRefreshDeps } from './adminRefresh';
import { refreshAdminOpenIdSession } from './adminRefresh';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const user = { _id: 'user-1', openidId: 'sub-1', email: 'admin@example.com' } as unknown as IUser;

function makeDeps(
  mode: 'off' | 'record' | 'enforce',
  overrides: Partial<AdminOpenIdRefreshDeps> = {},
): AdminOpenIdRefreshDeps {
  return {
    grant: jest.fn(async (token: string) => ({
      access_token: `at-${token}`,
      refresh_token: `${token}-r`,
      claims: () => ({ sub: 'sub-1' }),
    })),
    providerSession: {
      authorizer: {
        establish: jest.fn(),
        authorize: jest.fn().mockResolvedValue({ ok: true }),
        preCheck: jest.fn().mockResolvedValue({ ok: true }),
        getMode: jest.fn().mockResolvedValue(mode),
      },
      getProviderSessionClient: jest.fn(() => null),
      findProviderSessionBinding: jest.fn().mockResolvedValue(null),
      getRefreshTokenBridge: jest.fn().mockResolvedValue(null),
      storeRefreshTokenBridge: jest.fn().mockResolvedValue(null),
      deleteRefreshTokenBridges: jest.fn().mockResolvedValue(null),
      bridgeGraceMs: 60_000,
      upsertSession: jest.fn().mockResolvedValue({}),
      deleteSession: jest.fn().mockResolvedValue({ deletedCount: 0 }),
      getRefreshTokenExpiryMs: () => 60_000,
    },
    flight: {},
    user: {
      findUsers: jest.fn().mockResolvedValue([user]),
      getUserById: jest.fn().mockResolvedValue(null),
      mintToken: jest.fn().mockResolvedValue({ token: 'minted', expiresAt: 1 }),
    },
    ...overrides,
  };
}

describe('refreshAdminOpenIdSession', () => {
  it('grants the presented token and returns the minted admin tokens', async () => {
    const deps = makeDeps('off');

    const outcome = await refreshAdminOpenIdSession({ refreshToken: 'refresh-1' }, deps);

    expect(deps.grant).toHaveBeenCalledWith('refresh-1');
    expect(outcome).toEqual({
      ok: true,
      value: expect.objectContaining({ token: 'minted', refreshToken: 'refresh-1-r' }),
    });
  });

  it('returns the denial of the precheck without calling the IdP', async () => {
    const deps = makeDeps('enforce');
    (deps.providerSession.authorizer.preCheck as jest.Mock).mockResolvedValue({
      ok: false,
      code: 'OPENID_SESSION_ENDED',
    });

    const outcome = await refreshAdminOpenIdSession({ refreshToken: 'refresh-1' }, deps);

    expect(outcome).toEqual({
      ok: false,
      error: {
        status: 401,
        body: { error: 'Provider session has ended', error_code: 'OPENID_SESSION_ENDED' },
      },
    });
    expect(deps.grant).not.toHaveBeenCalled();
  });

  it('classifies a grant failure with mapAdminRefreshError', async () => {
    const deps = makeDeps('off', {
      grant: jest.fn().mockRejectedValue({ error: 'invalid_client', status: 401 }),
    });

    const outcome = await refreshAdminOpenIdSession({ refreshToken: 'refresh-1' }, deps);

    expect(outcome).toEqual({
      ok: false,
      error: expect.objectContaining({
        status: 500,
        body: expect.objectContaining({ error_code: 'OPENID_CLIENT_MISCONFIGURED' }),
      }),
    });
  });

  it('throws a failure after the grant that has no admin-auth code', async () => {
    const failure = new Error('mint failed');
    const deps = makeDeps('off');
    (deps.user.mintToken as jest.Mock).mockRejectedValue(failure);

    await expect(refreshAdminOpenIdSession({ refreshToken: 'refresh-1' }, deps)).rejects.toBe(
      failure,
    );
  });
});
