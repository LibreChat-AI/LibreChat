/**
 * Loads the real wiring against the real packages. Only the app's own singletons are stood
 * in for, so a factory the packages do not export fails here and not on a remote request.
 */
jest.mock('~/models', () => ({
  findUser: jest.fn(),
  getRoleByName: jest.fn(),
  getAgent: jest.fn(),
  getAgentApiKeyById: jest.fn(),
  resolveAgentGraphAccess: jest.fn(),
  getAgentGraphNodes: jest.fn(),
}));
jest.mock('~/config', () => ({ getMCPServersRegistry: jest.fn() }));
jest.mock('~/server/services/Config/app', () => ({ getAppConfig: jest.fn() }));
jest.mock('~/server/controllers/ModelController', () => ({ getModelsConfig: jest.fn() }));
jest.mock('~/server/services/PermissionService', () => ({ getEffectivePermissions: jest.fn() }));

const {
  getMCPRequestContext,
  bindScheduledMCPInvocation,
  createRemoteExecutionContext,
} = require('@librechat/api');
const { getAppConfig } = require('~/server/services/Config/app');

describe('API key grant wiring', () => {
  const run = (keyId) =>
    createRemoteExecutionContext({
      principal: { userId: 'owner' },
      agentId: 'agent_a',
      protocol: 'responses',
      background: false,
      keyId,
    });

  it('builds the grant host from what the packages really export', () => {
    const host = require('./grants');
    expect(host.prepare).toEqual(expect.any(Function));
    expect(host.handlers).toEqual({
      get: expect.any(Function),
      confirm: expect.any(Function),
      revoke: expect.any(Function),
    });
  });

  it('lets a personal key run through untouched where key runs are not limited', async () => {
    const host = require('./grants');
    for (const config of [undefined, { endpoints: { agents: {} } }]) {
      getAppConfig.mockResolvedValueOnce(config);
      const req = { user: { id: 'owner', role: 'USER' } };
      await expect(
        host.prepare({ req, executionContext: run('66f000000000000000000001') }),
      ).resolves.toBeUndefined();
      expect(
        bindScheduledMCPInvocation(getMCPRequestContext(req), 'agent_a', 'query'),
      ).toBeUndefined();
    }
    expect(getAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner', role: 'USER', failClosed: true }),
    );
  });

  it('asks the key store what kind of key a background run names', async () => {
    const host = require('./grants');
    const { getAgentApiKeyById } = require('~/models');
    const delegated = {
      endpoints: { agents: { remoteApi: { integrations: { mode: 'delegated' } } } },
    };
    getAppConfig.mockResolvedValueOnce(delegated);
    getAgentApiKeyById.mockResolvedValueOnce({ binding: { type: 'channel' } });
    // Rebuilt by the worker from its admitted record: no key of its own on the request.
    const req = { user: { id: 'owner', role: 'USER' } };
    await expect(
      host.prepare({ req, executionContext: run('66f000000000000000000001') }),
    ).resolves.toBeUndefined();
    expect(getAgentApiKeyById).toHaveBeenCalledWith('66f000000000000000000001', 'owner');
    expect(
      bindScheduledMCPInvocation(getMCPRequestContext(req), 'agent_a', 'query'),
    ).toBeUndefined();
  });

  it('reads no config for a run that no personal key started', async () => {
    const host = require('./grants');
    getAppConfig.mockClear();
    await host.prepare({ req: { user: { id: 'owner' } }, executionContext: run(undefined) });
    expect(getAppConfig).not.toHaveBeenCalled();
  });
});
