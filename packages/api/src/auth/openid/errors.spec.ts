import { isOpenIDSessionMissingError, reloadOpenIDSessionIfPersisted } from './errors';

describe('isOpenIDSessionMissingError', () => {
  it('recognizes the express-session missing record error', () => {
    expect(isOpenIDSessionMissingError(new Error('failed to load session'))).toBe(true);
  });

  it.each([
    new Error('connection unavailable'),
    new Error('session unavailable'),
    null,
    'failed to load session',
  ])('does not interpret other failures as permission to clear credentials: %s', (error) =>
    expect(isOpenIDSessionMissingError(error)).toBe(false),
  );
});

describe('reloadOpenIDSessionIfPersisted', () => {
  it('reports a persisted session that reloaded', async () => {
    await expect(
      reloadOpenIDSessionIfPersisted({
        reload: (callback: (error?: Error | null) => void) => callback(null),
      }),
    ).resolves.toBe(true);
  });

  it('reports an absent record instead of failing the refresh', async () => {
    await expect(
      reloadOpenIDSessionIfPersisted({
        reload: (callback: (error?: Error | null) => void) =>
          callback(new Error('failed to load session')),
      }),
    ).resolves.toBe(false);
  });

  it('propagates a session store outage', async () => {
    const error = new Error('connection unavailable');
    await expect(
      reloadOpenIDSessionIfPersisted({
        reload: (callback: (error?: Error | null) => void) => callback(error),
      }),
    ).rejects.toBe(error);
  });

  it('reports a request without a reloadable session', async () => {
    await expect(reloadOpenIDSessionIfPersisted(undefined)).resolves.toBe(false);
  });
});
