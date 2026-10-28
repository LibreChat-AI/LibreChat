import { OpenIDReauthRequiredError } from '~/utils/oidc';
import { loadMCPTools } from './loading';

const request = (serverName: string, type: 'all' | 'single' = 'all') => ({
  type,
  serverName,
  toolKey: `${type}:${serverName}`,
  config: { serverName },
});

function setup(signal?: AbortSignal) {
  return {
    userId: 'user-id',
    context: { user: { id: 'safe-user-id' }, signal },
    requestedTools: { first: [request('first')] },
    getAvailableTools: jest.fn().mockResolvedValue(undefined),
    createTools: jest.fn().mockResolvedValue([{ name: 'bulk' }]),
    createTool: jest.fn().mockResolvedValue({ name: 'selected' }),
  };
}

describe('loadMCPTools', () => {
  it('does not schedule any work after an already-cancelled request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    const options = setup(controller.signal);
    await expect(loadMCPTools(options)).rejects.toBe(controller.signal.reason);
    expect(options.createTools).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'settles siblings then prefers cancellation: authFailure=%s',
    async (authFailure) => {
      const controller = new AbortController();
      const options = setup(controller.signal);
      const stopped = new Error('stopped');
      let settled = false;
      options.createTools.mockImplementationOnce(async () => {
        if (authFailure) {
          throw new OpenIDReauthRequiredError('Please sign in again');
        }
        return [];
      });
      options.createTools.mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setImmediate(() => {
              settled = true;
              controller.abort(stopped);
              resolve([]);
            }),
          ),
      );
      await expect(
        loadMCPTools({
          ...options,
          requestedTools: {
            first: [request('first')],
            second: [request('second')],
          },
        }),
      ).rejects.toBe(stopped);
      expect(settled).toBe(true);
    },
  );

  it('does not create selected tools after cancellation during catalog loading', async () => {
    const controller = new AbortController();
    const options = setup(controller.signal);
    options.getAvailableTools.mockImplementationOnce(async () => {
      controller.abort();
      return {};
    });
    await expect(
      loadMCPTools({
        ...options,
        requestedTools: {
          first: [request('first', 'single')],
        },
      }),
    ).rejects.toBe(controller.signal.reason);
    expect(options.createTool).not.toHaveBeenCalled();
  });

  it('preserves the first typed error without treating ordinary optional errors as fatal', async () => {
    const options = setup();
    const error = new OpenIDReauthRequiredError('Please sign in again');
    options.createTools.mockRejectedValueOnce(new Error('optional tool unavailable'));
    await expect(loadMCPTools(options)).resolves.toEqual([]);
    options.createTools.mockRejectedValueOnce(error);
    await expect(loadMCPTools(options)).rejects.toBe(error);
    await expect(loadMCPTools(options)).resolves.toEqual([{ name: 'bulk' }]);
  });

  it('reuses the refreshed catalog for sequential tools without changing parameters', async () => {
    const options = setup();
    const catalog = { search: true };
    options.createTool.mockImplementationOnce(async ({ onAvailableTools }) => {
      onAvailableTools(catalog);
      return { name: 'one' };
    });
    await loadMCPTools({
      ...options,
      requestedTools: {
        first: [request('first', 'single'), request('first', 'single')],
      },
    });
    expect(options.getAvailableTools).toHaveBeenCalledTimes(1);
    expect(options.getAvailableTools).toHaveBeenCalledWith('user-id', 'first', {
      serverName: 'first',
    });
    expect(options.createTool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        user: { id: 'safe-user-id' },
        index: 0,
        availableTools: catalog,
        config: { serverName: 'first' },
      }),
    );
  });
});
