import { createHash } from 'node:crypto';
import {
  rememberAdminOpenIDSessionRef,
  recallAdminOpenIDSessionRef,
  rotateAdminOpenIDSessionRef,
} from './adminSessionRef';
import { isOpenIDSessionAuthorizationUnavailableError } from './sessions/authorize';

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function buildDeps() {
  const cache = { get: jest.fn(), set: jest.fn(), delete: jest.fn() };
  const logger = { warn: jest.fn() };
  return { cache, logger } as unknown as Parameters<typeof rememberAdminOpenIDSessionRef>[0] & {
    cache: typeof cache;
    logger: typeof logger;
  };
}

describe('rememberAdminOpenIDSessionRef', () => {
  it('is a no-op when the refresh token is missing', async () => {
    const deps = buildDeps();
    await rememberAdminOpenIDSessionRef(deps, undefined, 'session-1');
    expect(deps.cache.set).not.toHaveBeenCalled();
  });

  it('is a no-op when the openidSessionId is missing', async () => {
    const deps = buildDeps();
    await rememberAdminOpenIDSessionRef(deps, 'rt-1', undefined);
    expect(deps.cache.set).not.toHaveBeenCalled();
  });

  it('stores the session id under the SHA-256 hash of the refresh token', async () => {
    const deps = buildDeps();
    await rememberAdminOpenIDSessionRef(deps, 'rt-1', 'session-1');
    expect(deps.cache.set).toHaveBeenCalledWith(hashOf('rt-1'), 'session-1', undefined);
  });

  it('writes the entry with the caller-supplied TTL', async () => {
    const deps = buildDeps();
    await rememberAdminOpenIDSessionRef(deps, 'rt-1', 'session-1', { ttlMs: 123_000 });
    expect(deps.cache.set).toHaveBeenCalledWith(hashOf('rt-1'), 'session-1', 123_000);
  });

  it('logs and does not throw when the cache write fails and enforcement is off', async () => {
    const deps = buildDeps();
    deps.cache.set.mockRejectedValue(new Error('cache unavailable'));
    await expect(rememberAdminOpenIDSessionRef(deps, 'rt-1', 'session-1')).resolves.toBeUndefined();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to remember'),
      expect.any(Error),
    );
  });

  it('throws the unavailable error when the cache write fails and enforcement is on', async () => {
    const deps = buildDeps();
    deps.cache.set.mockRejectedValue(new Error('cache unavailable'));
    const promise = rememberAdminOpenIDSessionRef(deps, 'rt-1', 'session-1', { enforcement: true });
    const error = await promise.catch((err: unknown) => err);
    expect(isOpenIDSessionAuthorizationUnavailableError(error)).toBe(true);
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });
});

describe('recallAdminOpenIDSessionRef', () => {
  it('returns undefined without touching the cache when the refresh token is missing', async () => {
    const deps = buildDeps();
    const result = await recallAdminOpenIDSessionRef(deps, undefined);
    expect(result).toBeUndefined();
    expect(deps.cache.get).not.toHaveBeenCalled();
  });

  it('reads back by the SHA-256 hash of the refresh token', async () => {
    const deps = buildDeps();
    deps.cache.get.mockResolvedValue('session-1');
    const result = await recallAdminOpenIDSessionRef(deps, 'rt-1');
    expect(deps.cache.get).toHaveBeenCalledWith(hashOf('rt-1'));
    expect(result).toBe('session-1');
  });

  it('logs and returns undefined, like no reference recorded, when enforcement is off', async () => {
    const deps = buildDeps();
    deps.cache.get.mockRejectedValue(new Error('cache unavailable'));
    const result = await recallAdminOpenIDSessionRef(deps, 'rt-1');
    expect(result).toBeUndefined();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to recall'),
      expect.any(Error),
    );
  });

  it('throws the unavailable error instead of returning undefined when enforcement is on', async () => {
    const deps = buildDeps();
    deps.cache.get.mockRejectedValue(new Error('cache unavailable'));
    const promise = recallAdminOpenIDSessionRef(deps, 'rt-1', { enforcement: true });
    const error = await promise.catch((err: unknown) => err);
    expect(isOpenIDSessionAuthorizationUnavailableError(error)).toBe(true);
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });
});

describe('rotateAdminOpenIDSessionRef', () => {
  it('deletes the old hash and sets the new one when the refresh token rotates', async () => {
    const deps = buildDeps();
    await rotateAdminOpenIDSessionRef(deps, 'rt-old', 'rt-new', 'session-1');
    expect(deps.cache.delete).toHaveBeenCalledWith(hashOf('rt-old'));
    expect(deps.cache.set).toHaveBeenCalledWith(hashOf('rt-new'), 'session-1', undefined);
  });

  it('passes the TTL through to the rewritten entry', async () => {
    const deps = buildDeps();
    await rotateAdminOpenIDSessionRef(deps, 'rt-old', 'rt-new', 'session-1', { ttlMs: 5_000 });
    expect(deps.cache.set).toHaveBeenCalledWith(hashOf('rt-new'), 'session-1', 5_000);
  });

  it('does not delete anything when the refresh token is unchanged', async () => {
    const deps = buildDeps();
    await rotateAdminOpenIDSessionRef(deps, 'rt-1', 'rt-1', 'session-1');
    expect(deps.cache.delete).not.toHaveBeenCalled();
    expect(deps.cache.set).toHaveBeenCalledWith(hashOf('rt-1'), 'session-1', undefined);
  });

  it('falls back to the old refresh token when no new one is given, without deleting', async () => {
    const deps = buildDeps();
    await rotateAdminOpenIDSessionRef(deps, 'rt-old', undefined, 'session-1');
    expect(deps.cache.delete).not.toHaveBeenCalled();
    expect(deps.cache.set).toHaveBeenCalledWith(hashOf('rt-old'), 'session-1', undefined);
  });

  it('does not delete when there is no old refresh token to begin with', async () => {
    const deps = buildDeps();
    await rotateAdminOpenIDSessionRef(deps, undefined, 'rt-new', 'session-1');
    expect(deps.cache.delete).not.toHaveBeenCalled();
    expect(deps.cache.set).toHaveBeenCalledWith(hashOf('rt-new'), 'session-1', undefined);
  });

  it('logs and continues when the delete fails and enforcement is off', async () => {
    const deps = buildDeps();
    deps.cache.delete.mockRejectedValue(new Error('cache unavailable'));
    await expect(
      rotateAdminOpenIDSessionRef(deps, 'rt-old', 'rt-new', 'session-1'),
    ).resolves.toBeUndefined();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to delete'),
      expect.any(Error),
    );
    expect(deps.cache.set).toHaveBeenCalledWith(hashOf('rt-new'), 'session-1', undefined);
  });

  it('logs but does not throw when the delete fails and enforcement is on, leaving the new reference in place', async () => {
    const deps = buildDeps();
    deps.cache.delete.mockRejectedValue(new Error('cache unavailable'));
    await expect(
      rotateAdminOpenIDSessionRef(deps, 'rt-old', 'rt-new', 'session-1', { enforcement: true }),
    ).resolves.toBeUndefined();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to delete'),
      expect.any(Error),
    );
    expect(deps.cache.set).toHaveBeenCalledWith(hashOf('rt-new'), 'session-1', undefined);
  });

  it('throws the unavailable error when the write fails and enforcement is on, keeping the old reference', async () => {
    const deps = buildDeps();
    deps.cache.set.mockRejectedValue(new Error('cache unavailable'));
    const promise = rotateAdminOpenIDSessionRef(deps, 'rt-old', 'rt-new', 'session-1', {
      enforcement: true,
    });
    const error = await promise.catch((err: unknown) => err);
    expect(isOpenIDSessionAuthorizationUnavailableError(error)).toBe(true);
    expect(deps.cache.delete).not.toHaveBeenCalled();
  });
});
