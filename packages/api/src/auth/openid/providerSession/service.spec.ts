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
      storeOpenIDSession: jest.fn(),
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
      storeOpenIDSession: jest.fn(),
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
      storeOpenIDSession: jest.fn(),
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
        storeOpenIDSession: jest.fn(),
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
        storeOpenIDSession: jest.fn(),
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
        storeOpenIDSession: jest.fn(),
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
        storeOpenIDSession: jest.fn(),
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
      storeOpenIDSession: jest.fn(),
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

  describe('bound OAuth callback steps', () => {
    const ORIGINAL_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY;

    afterEach(() => {
      if (ORIGINAL_EXPIRY === undefined) {
        delete process.env.REFRESH_TOKEN_EXPIRY;
      } else {
        process.env.REFRESH_TOKEN_EXPIRY = ORIGINAL_EXPIRY;
      }
    });

    function makeRecordService(storeOpenIDSession = jest.fn()) {
      const methods = makeMethods();
      methods.establish.mockResolvedValue({ ok: true });
      const service = createProviderSessionService({
        methods,
        getAppConfig: jest
          .fn()
          .mockResolvedValue({ registration: { openidBackchannelLogout: { mode: 'record' } } }),
        getOpenIdClient: () => ({ issuer: 'https://idp.example.com/' }),
        getClientId: () => 'librechat',
        storeOpenIDSession,
        logger: makeLogger(),
      });
      return { service, methods, storeOpenIDSession };
    }

    it('establishOAuthCallback binds the client and the REFRESH_TOKEN_EXPIRY lifetime', async () => {
      process.env.REFRESH_TOKEN_EXPIRY = '60000';
      const { service, methods } = makeRecordService();
      const before = Date.now();

      const ref = await service.establishOAuthCallback({
        req: {
          user: {
            provider: 'openid',
            tokenset: { claims: () => ({ sub: 'sub-1', sid: 'sid-1' }) },
          },
          session: { openidLoginIssuedAt: Date.now() },
        },
        res: {} as never,
        clientDomain: 'http://client.test',
      });

      expect(ref).toEqual({
        issuer: 'https://idp.example.com',
        clientId: 'librechat',
        sid: 'sid-1',
      });
      const [data] = methods.establish.mock.calls[0];
      expect(data).toMatchObject({ sid: 'sid-1', subject: 'sub-1' });
      expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60000);
      expect(data.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60000);
    });

    it('persistOAuthAdminBinding stores through the injected storeOpenIDSession', async () => {
      const { service, storeOpenIDSession } = makeRecordService();
      const providerSession = {
        issuer: 'https://idp.example.com',
        clientId: 'librechat',
        sid: 'sid-1',
      };

      await service.persistOAuthAdminBinding({
        provider: 'openid',
        refreshToken: 'refresh-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        providerSession,
      });

      expect(storeOpenIDSession).toHaveBeenCalledWith(
        'user-1',
        'refresh-1',
        'tenant-1',
        undefined,
        {
          providerSession,
        },
      );
    });
  });
});
