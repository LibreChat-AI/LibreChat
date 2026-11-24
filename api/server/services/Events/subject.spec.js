/**
 * Loads the real wiring against the real packages. Only the app's own singletons are stood
 * in for, so a factory the packages do not export fails here and not on a delivery.
 */
jest.mock('~/models', () => ({
  findUser: jest.fn(),
  getRoleByName: jest.fn(),
  resolveAgentGraphAccess: jest.fn(),
  getAgentGraphNodes: jest.fn(),
}));
jest.mock('~/config', () => ({ getMCPServersRegistry: jest.fn() }));
jest.mock('~/server/services/Config/app', () => ({ getAppConfig: jest.fn() }));
jest.mock('~/server/controllers/ModelController', () => ({ getModelsConfig: jest.fn() }));
jest.mock('~/server/services/Schedules/access', () => ({ resolveAgentFireAccess: jest.fn() }));

const {
  subscriptionSubject,
  createRemoteExecutionContext,
  createTriggerExecutionContext,
} = require('@librechat/api');
const { getAppConfig } = require('~/server/services/Config/app');
const { findUser } = require('~/models');

describe('event subscription wiring', () => {
  it('builds the subscription host from what the packages really export', () => {
    const host = require('./subject');
    expect(host.resolve).toEqual(expect.any(Function));
    expect(host.execution).toEqual({
      resolve: expect.any(Function),
      attach: expect.any(Function),
    });
    expect(host.service).toEqual(
      expect.objectContaining({
        view: expect.any(Function),
        confirm: expect.any(Function),
        revoke: expect.any(Function),
      }),
    );
  });

  it('is claimed for a delivery a subscription matched, and for no other run', () => {
    const adapter = subscriptionSubject(() => require('./subject'));
    const req = {
      user: { id: 'owner' },
      _isAgentTrigger: true,
      body: {
        agent_id: 'agent_a',
        clientRequestId: 'trigger_delivery',
        agentTrigger: {
          version: 1,
          event: {
            id: 'event-1',
            type: 'github.check_suite.completed',
            occurredAt: 0,
            source: { type: 'subscription', id: 'sub_1' },
          },
        },
      },
    };
    expect(adapter.claims({ req, executionContext: createTriggerExecutionContext(req) })).toBe(
      true,
    );
    const remote = createRemoteExecutionContext({
      principal: { userId: 'owner' },
      agentId: 'agent_a',
      protocol: 'responses',
      background: false,
    });
    expect(adapter.claims({ req: { user: { id: 'owner' } }, executionContext: remote })).toBe(
      false,
    );
  });

  it('reads nothing for a run no subscription started', async () => {
    const host = require('./subject');
    const executionContext = createRemoteExecutionContext({
      principal: { userId: 'owner' },
      agentId: 'agent_a',
      protocol: 'responses',
      background: false,
    });
    await expect(
      host.resolve({ req: { user: { id: 'owner' } }, executionContext }),
    ).resolves.toBeUndefined();
    expect(findUser).not.toHaveBeenCalled();
    expect(getAppConfig).not.toHaveBeenCalled();
  });
});
