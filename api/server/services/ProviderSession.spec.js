jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('~/strategies/openidStrategy', () => ({ getOpenIdConfig: jest.fn() }));
jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn() }));
jest.mock('~/models', () => ({
  establishProviderSession: jest.fn(),
  authorizeProviderSession: jest.fn(),
  revokeProviderSession: jest.fn(),
}));

describe('ProviderSession wiring', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('forwards establish, authorize, preCheck, and getMode to the real authorizer', async () => {
    const { getAppConfig } = require('~/server/services/Config');
    const { establishProviderSession, authorizeProviderSession } = require('~/models');
    getAppConfig.mockResolvedValue({
      registration: { openidBackchannelLogout: { mode: 'enforce' } },
    });
    establishProviderSession.mockResolvedValue({ ok: true });
    authorizeProviderSession.mockResolvedValue({ ok: true });
    const {
      providerSessionAuthorizer,
      getProviderSessionAuthorizer,
    } = require('./ProviderSession');

    expect(await providerSessionAuthorizer.getMode()).toBe('enforce');

    const ref = { issuer: 'https://idp.example.com', clientId: 'librechat', sid: 'sid-1' };
    await providerSessionAuthorizer.establish({ ref, callbackIssuedAt: new Date() });
    expect(establishProviderSession).toHaveBeenCalled();

    await providerSessionAuthorizer.authorize({ ref, expiresAt: new Date() });
    expect(authorizeProviderSession).toHaveBeenCalled();

    expect(typeof providerSessionAuthorizer.preCheck).toBe('function');
    expect(providerSessionAuthorizer).not.toBe(getProviderSessionAuthorizer());
    expect(getProviderSessionAuthorizer()).toBe(getProviderSessionAuthorizer());
  });

  it('is off by default when registration has no openidBackchannelLogout config', async () => {
    const { getAppConfig } = require('~/server/services/Config');
    getAppConfig.mockResolvedValue({ registration: {} });
    const { providerSessionAuthorizer } = require('./ProviderSession');

    expect(await providerSessionAuthorizer.getMode()).toBe('off');
  });
});
