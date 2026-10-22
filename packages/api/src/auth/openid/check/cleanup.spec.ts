import type { SessionOpenIDTokens } from '../types';
import { createOpenIDCheckCleanup } from './cleanup';

it('retires only the captured refresh chain and its local recovery records', async () => {
  const tokens: SessionOpenIDTokens = {
    appUserId: 'user-A',
    openidSubject: 'A',
    openidIssuer: 'https://issuer.test',
    tenantId: 'tenant-A',
    refreshToken: 'old',
    authGenerationId: 'generation-A',
    publicationFlightKey: 'publication-A',
  };
  const revokeOpenIDRefreshTokenChain = jest.fn(async () => ['old', 'successor']);
  const deleteRefreshTokenBridges = jest.fn(async () => {});
  const deleteSession = jest.fn(async () => {});
  const retirePrivate = jest.fn(async () => {});
  const tenants: string[] = [];
  const cleanup = createOpenIDCheckCleanup({
    runAsTenant: async (tenantId, work) => {
      tenants.push(tenantId);
      return work();
    },
    revokeOpenIDRefreshTokenChain,
    deleteRefreshTokenBridges,
    deleteSession,
    retirePrivate,
    clearOpenIDAuthTokens: jest.fn(),
    ttl: 60_000,
  });
  const req = {
    sessionID: 'browser',
    session: { openidTokens: { ...tokens, refreshToken: 'newer' } },
  };
  await cleanup.retire(req, tokens);
  expect(revokeOpenIDRefreshTokenChain).toHaveBeenCalledWith(
    expect.objectContaining({
      identityContext: tokens,
      refreshTokens: ['old'],
      publicationKeys: ['publication-A'],
    }),
  );
  expect(deleteRefreshTokenBridges).toHaveBeenCalledWith({
    refreshTokens: ['old', 'successor'],
    userId: 'user-A',
    tenantId: 'tenant-A',
  });
  expect(deleteSession.mock.calls).toEqual([
    [{ refreshToken: 'old' }],
    [{ refreshToken: 'successor' }],
  ]);
  expect(retirePrivate).toHaveBeenCalledWith(
    { sessionID: 'browser', session: { openidTokens: tokens } },
    tokens,
  );
  expect(req.session.openidTokens.refreshToken).toBe('newer');
  expect(tenants).toEqual(['tenant-A']);
});
