import type { OpenIdIssuerSource } from '~/auth/openid';
import { createProviderSessionService } from './service';

function makeLogger() {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeMethods() {
  return { establish: jest.fn(), authorize: jest.fn(), revoke: jest.fn() };
}

describe('createProviderSessionService', () => {
  it('memoizes getProviderSessionAuthorizer and the config load behind it', async () => {
    const getAppConfig = jest
      .fn()
      .mockResolvedValue({ registration: { openidBackchannelLogout: { mode: 'off' } } });
    const service = createProviderSessionService({
      methods: makeMethods(),
      getAppConfig,
      getOpenIdClient: jest.fn(),
      getClientId: jest.fn(),
      logger: makeLogger(),
    });

    const first = service.getProviderSessionAuthorizer();
    const second = service.getProviderSessionAuthorizer();
    expect(first).toBe(second);

    await first.getMode();
    await first.getMode();
    expect(getAppConfig).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed config load; the next call retries', async () => {
    const loadError = new Error('config store unavailable');
    const getAppConfig = jest
      .fn()
      .mockRejectedValueOnce(loadError)
      .mockResolvedValueOnce({
        registration: { openidBackchannelLogout: { mode: 'off' } },
      });
    const service = createProviderSessionService({
      methods: makeMethods(),
      getAppConfig,
      getOpenIdClient: jest.fn(),
      getClientId: jest.fn(),
      logger: makeLogger(),
    });

    await expect(service.getBackchannelLogoutConfig()).rejects.toBe(loadError);
    await expect(service.getBackchannelLogoutConfig()).resolves.toMatchObject({ mode: 'off' });
    expect(getAppConfig).toHaveBeenCalledTimes(2);
  });

  it('initialize logs a failed load and rejects, so the server does not start', async () => {
    const loadError = new Error('config store unavailable');
    const getAppConfig = jest.fn().mockRejectedValue(loadError);
    const logger = makeLogger();
    const service = createProviderSessionService({
      methods: makeMethods(),
      getAppConfig,
      getOpenIdClient: jest.fn(),
      getClientId: jest.fn(),
      logger,
    });

    await expect(service.initializeBackchannelLogoutConfig()).rejects.toBe(loadError);
    expect(logger.error).toHaveBeenCalledWith(
      '[ProviderSession] Startup load of openidBackchannelLogout config failed',
      { error: loadError },
    );
  });

  it('after initialize, off mode authorizes with no config load and no database call', async () => {
    const getAppConfig = jest
      .fn()
      .mockResolvedValueOnce({ registration: { openidBackchannelLogout: { mode: 'off' } } })
      .mockRejectedValue(new Error('config store unavailable'));
    const methods = makeMethods();
    const service = createProviderSessionService({
      methods,
      getAppConfig,
      getOpenIdClient: jest.fn(),
      getClientId: jest.fn(),
      logger: makeLogger(),
    });

    await service.initializeBackchannelLogoutConfig();
    const authorizer = service.getProviderSessionAuthorizer();
    const input = {
      ref: { issuer: 'https://idp.example.com', clientId: 'librechat', sid: 'session-1' },
      expiresAt: new Date('2026-01-01T00:00:00Z'),
      legacy: false,
    };

    await expect(authorizer.authorize(input)).resolves.toEqual({ ok: true });
    await expect(authorizer.authorize(input)).resolves.toEqual({ ok: true });
    expect(getAppConfig).toHaveBeenCalledTimes(1);
    expect(methods.authorize).not.toHaveBeenCalled();
  });

  describe('getProviderSessionClient', () => {
    it('is null when the client ID getter returns undefined', () => {
      const service = createProviderSessionService({
        methods: makeMethods(),
        getAppConfig: jest.fn(),
        getOpenIdClient: jest.fn(),
        getClientId: () => undefined,
        logger: makeLogger(),
      });

      expect(service.getProviderSessionClient()).toBeNull();
    });

    it('is null when the OpenID client has not been initialized', () => {
      const getOpenIdClient = jest.fn(() => {
        throw new Error('OpenID client is not initialized');
      });
      const service = createProviderSessionService({
        methods: makeMethods(),
        getAppConfig: jest.fn(),
        getOpenIdClient,
        getClientId: () => 'librechat',
        logger: makeLogger(),
      });

      expect(service.getProviderSessionClient()).toBeNull();
    });

    it('is null when the configured client reports no issuer', () => {
      const openidClient: OpenIdIssuerSource = { serverMetadata: () => undefined };
      const service = createProviderSessionService({
        methods: makeMethods(),
        getAppConfig: jest.fn(),
        getOpenIdClient: () => openidClient,
        getClientId: () => 'librechat',
        logger: makeLogger(),
      });

      expect(service.getProviderSessionClient()).toBeNull();
    });

    it('returns the normalized issuer and configured client id', () => {
      const openidClient: OpenIdIssuerSource = { issuer: 'https://idp.example.com/' };
      const getClientId = jest.fn(() => 'librechat');
      const service = createProviderSessionService({
        methods: makeMethods(),
        getAppConfig: jest.fn(),
        getOpenIdClient: () => openidClient,
        getClientId,
        logger: makeLogger(),
      });

      expect(service.getProviderSessionClient()).toEqual({
        issuer: 'https://idp.example.com',
        clientId: 'librechat',
      });
      expect(getClientId).toHaveBeenCalledTimes(1);
    });
  });

  it('forwards revokeProviderSession to the injected method', async () => {
    const methods = makeMethods();
    methods.revoke.mockResolvedValue({ ok: true });
    const service = createProviderSessionService({
      methods,
      getAppConfig: jest.fn(),
      getOpenIdClient: jest.fn(),
      getClientId: jest.fn(),
      logger: makeLogger(),
    });

    const data = {
      issuer: 'https://idp.example.com',
      clientId: 'librechat',
      sid: 'session-1',
      expiresAt: new Date('2026-01-01T00:00:00Z'),
    };
    await expect(service.revokeProviderSession(data)).resolves.toEqual({ ok: true });
    expect(methods.revoke).toHaveBeenCalledWith(data);
  });
});
