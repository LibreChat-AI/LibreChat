const mockStartOpenIDSessionAuthorization = jest.fn().mockResolvedValue(undefined);
jest.mock('@librechat/api', () => ({
  startOpenIDAuthorization: (...args) => mockStartOpenIDSessionAuthorization(...args),
}));

const mockCreateRouteMiddleware = jest.fn(() => ['body-parser', 'rate-limiter', 'receiver']);
jest.mock('./OpenIDSessions', () => ({ connectOpenIDAuthorization: jest.fn() }));
jest.mock('./OpenIDBackchannelLogout', () => ({
  initOpenIDBackchannelLogout: jest.fn(),
  startOpenIDBackchannelLogoutWorker: jest.fn(),
  createRouteMiddleware: (...args) => mockCreateRouteMiddleware(...args),
}));

const { startOpenIDAuthorization } = require('./startOpenIDAuthorization');
const OpenIDSessions = require('./OpenIDSessions');
const OpenIDBackchannelLogout = require('./OpenIDBackchannelLogout');

describe('startOpenIDAuthorization (api wiring)', () => {
  beforeEach(() => {
    mockStartOpenIDSessionAuthorization.mockClear();
    mockCreateRouteMiddleware.mockClear();
  });

  it('mounts the back-channel logout route ahead of the shared startup call', async () => {
    const app = { post: jest.fn() };
    const appConfig = { registration: { openidSessionEnforcement: true } };

    await startOpenIDAuthorization(app, appConfig);

    expect(app.post).toHaveBeenCalledWith(
      '/oauth/openid/backchannel-logout',
      'body-parser',
      'rate-limiter',
      'receiver',
    );
    expect(mockStartOpenIDSessionAuthorization).toHaveBeenCalledWith({
      appConfig,
      sessions: OpenIDSessions,
      backchannel: OpenIDBackchannelLogout,
    });
  });

  it('delegates the enforcement and worker-ordering decision entirely to @librechat/api', async () => {
    const app = { post: jest.fn() };

    await startOpenIDAuthorization(app, undefined);

    expect(mockStartOpenIDSessionAuthorization).toHaveBeenCalledWith({
      appConfig: undefined,
      sessions: OpenIDSessions,
      backchannel: OpenIDBackchannelLogout,
    });
  });
});
