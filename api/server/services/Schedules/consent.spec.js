/**
 * Loads the real wiring against the real packages. Only the app's own singletons are stood
 * in for, so something the packages do not provide fails here and not when the router loads.
 */
jest.mock('~/models', () => ({
  findUser: jest.fn(),
  getRoleByName: jest.fn(),
  getScheduleById: jest.fn(),
  getAgentGraphNodes: jest.fn(),
  resolveAgentGraphAccess: jest.fn(),
  getScheduleMCPCompletionState: jest.fn(),
}));
jest.mock('~/config', () => ({ getMCPServersRegistry: jest.fn() }));
jest.mock('~/server/services/Config/app', () => ({ getAppConfig: jest.fn() }));
jest.mock('~/server/controllers/ModelController', () => ({ getModelsConfig: jest.fn() }));
jest.mock('./access', () => ({ resolveAgentFireAccess: jest.fn() }));

const { findUser, getRoleByName } = require('~/models');
const { resolveAgentFireAccess } = require('./access');

describe('schedule consent wiring', () => {
  it('provides the routes and the service the schedule router uses', () => {
    const { consent } = require('./consent');
    expect(consent.handlers).toEqual({
      draft: expect.any(Function),
      get: expect.any(Function),
      confirm: expect.any(Function),
      revoke: expect.any(Function),
    });
    expect(consent.service.grant).toEqual(expect.any(Function));
  });

  it('answers the offer for a schedule not yet created from the caller and the agent it names', async () => {
    const { consent } = require('./consent');
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    // No agent named: there is nothing to make an offer for.
    await consent.handlers.draft({ user: { id: 'owner' }, body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(404);

    findUser.mockResolvedValue({ id: 'owner', role: 'USER' });
    getRoleByName.mockResolvedValue({ permissions: {} });
    resolveAgentFireAccess.mockResolvedValue('ok');
    res.status.mockClear();
    // An owner whose role may not use schedules is refused, by the same check as a stored one.
    await consent.handlers.draft({ user: { id: 'owner' }, body: { agent_id: 'agent_a' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenLastCalledWith({ code: 'consent_forbidden' });
  });
});
