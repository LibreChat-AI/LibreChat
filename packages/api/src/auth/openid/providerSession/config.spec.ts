import { resolveBackchannelLogoutConfig, createMemoizedConfigLoader } from './config';

describe('resolveBackchannelLogoutConfig', () => {
  it('defaults to disabled when registration is undefined', () => {
    expect(resolveBackchannelLogoutConfig(undefined)).toEqual({
      mode: 'off',
      algorithms: ['RS256'],
      clockToleranceSec: 60,
      maxTokenAgeSec: 120,
      maxBodyBytes: 16384,
      rateLimit: { windowMs: 60_000, max: 60 },
      processingTimeoutMs: 5000,
      callbackGraceMs: 600_000,
    });
  });

  it('defaults to disabled when registration carries no openidBackchannelLogout section', () => {
    expect(resolveBackchannelLogoutConfig({}).mode).toBe('off');
  });

  it('fills in schema defaults for fields the YAML leaves unset', () => {
    const resolved = resolveBackchannelLogoutConfig({
      openidBackchannelLogout: { mode: 'enforce' },
    });
    expect(resolved.mode).toBe('enforce');
    expect(resolved.algorithms).toEqual(['RS256']);
    expect(resolved.callbackGraceMs).toBe(600_000);
  });

  it('keeps an explicitly configured value above the floor', () => {
    expect(
      resolveBackchannelLogoutConfig({
        openidBackchannelLogout: { mode: 'record', callbackGraceMs: 700_000 },
      }).callbackGraceMs,
    ).toBe(700_000);
  });

  it('floors callbackGraceMs at DEFAULT_OAUTH_STATE_TTL_MS when oauthStateTtlMs is unset', () => {
    expect(
      resolveBackchannelLogoutConfig({
        openidBackchannelLogout: { mode: 'record', callbackGraceMs: 30_000 },
      }).callbackGraceMs,
    ).toBe(600_000);
  });

  it('raises callbackGraceMs to cover a larger configured oauthStateTtlMs', () => {
    expect(
      resolveBackchannelLogoutConfig({
        openidBackchannelLogout: { mode: 'record', callbackGraceMs: 30_000 },
        oauthStateTtlMs: 900_000,
      }).callbackGraceMs,
    ).toBe(900_000);
  });
});

describe('createMemoizedConfigLoader', () => {
  it('memoizes a successful load for the process lifetime', async () => {
    const load = jest.fn().mockResolvedValue('config-value');
    const getConfig = createMemoizedConfigLoader(load);

    await expect(getConfig()).resolves.toBe('config-value');
    await expect(getConfig()).resolves.toBe('config-value');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('awaits a pending load rather than starting a second one for a concurrent caller', async () => {
    let resolveLoad: (value: string) => void = () => {};
    const load = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const getConfig = createMemoizedConfigLoader(load);

    const first = getConfig();
    const second = getConfig();
    resolveLoad('config-value');

    await expect(first).resolves.toBe('config-value');
    await expect(second).resolves.toBe('config-value');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed load; the next call retries', async () => {
    const loadError = new Error('load failed');
    const load = jest.fn().mockRejectedValueOnce(loadError).mockResolvedValueOnce('config-value');
    const getConfig = createMemoizedConfigLoader(load);

    await expect(getConfig()).rejects.toBe(loadError);
    await expect(getConfig()).resolves.toBe('config-value');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
