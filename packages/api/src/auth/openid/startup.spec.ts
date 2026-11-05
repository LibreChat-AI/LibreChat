import { startOpenIDAuthorization } from './startup';

function buildDeps() {
  return {
    sessions: { connectOpenIDAuthorization: jest.fn().mockResolvedValue(undefined) },
    backchannel: {
      initOpenIDBackchannelLogout: jest.fn().mockResolvedValue(undefined),
      startOpenIDBackchannelLogoutWorker: jest.fn(),
    },
  };
}

describe('startOpenIDAuthorization', () => {
  it('awaits the authorization connection when enforcement is on', async () => {
    const deps = buildDeps();
    const appConfig = { registration: { openidSessionEnforcement: true } };

    await startOpenIDAuthorization({ appConfig, ...deps });

    expect(deps.sessions.connectOpenIDAuthorization).toHaveBeenCalledWith(appConfig);
  });

  it('starts the authorization connection in the background when enforcement is off', async () => {
    const deps = buildDeps();
    let resolveConnect: () => void = () => {};
    deps.sessions.connectOpenIDAuthorization.mockImplementation(
      () => new Promise((resolve) => (resolveConnect = () => resolve(undefined))),
    );
    const appConfig = { registration: { openidSessionEnforcement: false } };

    const pending = startOpenIDAuthorization({ appConfig, ...deps });
    await Promise.resolve();
    expect(deps.backchannel.initOpenIDBackchannelLogout).toHaveBeenCalled();

    resolveConnect();
    await pending;
  });

  it('starts the authorization connection in the background when appConfig is absent', async () => {
    const deps = buildDeps();

    await startOpenIDAuthorization({ ...deps });

    expect(deps.sessions.connectOpenIDAuthorization).toHaveBeenCalledWith(undefined);
  });

  it('inits then starts the backchannel worker, in that order, after the connection decision', async () => {
    const deps = buildDeps();
    const order: string[] = [];
    deps.sessions.connectOpenIDAuthorization.mockImplementation(async () => {
      order.push('connect');
    });
    deps.backchannel.initOpenIDBackchannelLogout.mockImplementation(async () => {
      order.push('init');
    });
    deps.backchannel.startOpenIDBackchannelLogoutWorker.mockImplementation(() => {
      order.push('start');
    });

    await startOpenIDAuthorization({
      appConfig: { registration: { openidSessionEnforcement: true } },
      ...deps,
    });

    expect(order).toEqual(['connect', 'init', 'start']);
  });
});
