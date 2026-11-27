import { logger } from '@librechat/data-schemas';
import { registerOpenIdWithRetry, resolveOpenIdDiscovery } from './retry';

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const openIdConfig = { issuer: 'https://idp.example.com' };

describe('resolveOpenIdDiscovery', () => {
  afterEach(() => jest.clearAllMocks());

  it('defaults to one startup attempt and a 5000ms delay', () => {
    expect(resolveOpenIdDiscovery()).toEqual({ startupAttempts: 1, retryDelayMs: 5000 });
    expect(resolveOpenIdDiscovery(undefined, { startupAttempts: '', retryDelayMs: ' ' })).toEqual({
      startupAttempts: 1,
      retryDelayMs: 5000,
    });
  });

  it('prefers librechat.yaml values over the environment, per field', () => {
    expect(
      resolveOpenIdDiscovery({ startupAttempts: 0 }, { startupAttempts: '4', retryDelayMs: '750' }),
    ).toEqual({ startupAttempts: 0, retryDelayMs: 750 });
  });

  it.each([
    ['retryDelayMs', '1'],
    ['retryDelayMs', '99999999999'],
    ['retryDelayMs', 'soon'],
    ['startupAttempts', '-1'],
    ['startupAttempts', '1.5'],
  ] as const)('applies the schema bounds to environment %s=%s', (field, raw) => {
    const resolved = resolveOpenIdDiscovery(undefined, { [field]: raw });
    expect(resolved).toEqual({ startupAttempts: 1, retryDelayMs: 5000 });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`"${raw}"`));
  });
});

describe('registerOpenIdWithRetry', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('makes one startup attempt by default, then recovers in the background', async () => {
    const setupOpenId = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(openIdConfig);
    const registerJwtStrategy = jest.fn();

    await registerOpenIdWithRetry({ setupOpenId, registerJwtStrategy, reuseTokens: true });
    expect(setupOpenId).toHaveBeenCalledTimes(1);
    expect(registerJwtStrategy).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(5000);
    expect(setupOpenId).toHaveBeenCalledTimes(2);
    expect(registerJwtStrategy).toHaveBeenCalledWith(openIdConfig);

    await jest.advanceTimersByTimeAsync(20000);
    expect(setupOpenId).toHaveBeenCalledTimes(2);
  });

  it('retries during startup when more attempts are configured', async () => {
    const setupOpenId = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(openIdConfig);

    const done = registerOpenIdWithRetry({
      setupOpenId,
      registerJwtStrategy: jest.fn(),
      reuseTokens: false,
      discovery: { startupAttempts: 2, retryDelayMs: 1000 },
    });
    await jest.advanceTimersByTimeAsync(1000);
    await done;

    expect(setupOpenId).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('skips startup attempts when set to zero', async () => {
    const setupOpenId = jest.fn().mockResolvedValue(openIdConfig);
    const registerJwtStrategy = jest.fn();

    await registerOpenIdWithRetry({
      setupOpenId,
      registerJwtStrategy,
      reuseTokens: false,
      discovery: { startupAttempts: 0, retryDelayMs: 1000 },
    });
    expect(setupOpenId).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1000);
    expect(setupOpenId).toHaveBeenCalledTimes(1);
    expect(registerJwtStrategy).not.toHaveBeenCalled();
  });

  it('continues background retries when strategy registration throws', async () => {
    const setupOpenId = jest.fn().mockResolvedValue(openIdConfig);
    const registerJwtStrategy = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('strategy registration failed');
      })
      .mockImplementationOnce(() => undefined);

    await registerOpenIdWithRetry({
      setupOpenId,
      registerJwtStrategy,
      reuseTokens: true,
      env: { retryDelayMs: '1000' },
    });
    expect(logger.error).toHaveBeenCalledWith(
      'OpenID Connect strategy registration failed.',
      expect.any(Error),
    );

    await jest.advanceTimersByTimeAsync(1000);
    expect(registerJwtStrategy).toHaveBeenCalledTimes(2);
  });
});
