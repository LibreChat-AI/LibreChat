/**
 * Loads the real wiring against the real packages. Only the app's own singletons are stood
 * in for, so a factory the packages do not export fails here and not on a chat request.
 */
jest.mock('~/server/services/Config/app', () => ({ getAppConfig: jest.fn() }));

const { getAppConfig } = require('~/server/services/Config/app');

describe('watch tool wiring', () => {
  it('builds the per-run tool host from what the packages really export', () => {
    const resolveWatchTools = require('./watch');
    expect(resolveWatchTools).toEqual(expect.any(Function));
  });

  it('offers nothing, after reading only the base config, while events are off', async () => {
    getAppConfig.mockResolvedValue({ endpoints: { agents: {} } });
    const resolveWatchTools = require('./watch');
    await expect(
      resolveWatchTools({ user: { id: 'owner' }, agentId: 'agent_1', conversationId: 'convo_1' }),
    ).resolves.toBeUndefined();
    expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
  });
});
