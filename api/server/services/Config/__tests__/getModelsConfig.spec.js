jest.mock('../loadConfigModels');
jest.mock('../loadDefaultModels');

const loadConfigModels = require('../loadConfigModels');
const loadDefaultModels = require('../loadDefaultModels');
const getModelsConfig = require('../getModelsConfig');

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('getModelsConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    loadDefaultModels.mockResolvedValue({ bedrock: ['anthropic.claude'] });
    loadConfigModels.mockResolvedValue({ Claude: ['claude-sonnet-5'] });
  });

  it('loads default and configured models concurrently, custom taking precedence', async () => {
    const defaultModels = deferred();
    const configuredModels = deferred();
    const req = { user: { id: 'user-1' } };
    loadDefaultModels.mockReturnValue(defaultModels.promise);
    loadConfigModels.mockReturnValue(configuredModels.promise);

    const resultPromise = getModelsConfig(req);

    /* Both started before either settled — neither waits on the other. */
    expect(loadDefaultModels).toHaveBeenCalledWith(req);
    expect(loadConfigModels).toHaveBeenCalledWith(req);

    configuredModels.resolve({ openAI: ['configured-model'], custom: ['custom-model'] });
    defaultModels.resolve({ openAI: ['default-model'], anthropic: ['default-anthropic'] });

    await expect(resultPromise).resolves.toEqual({
      openAI: ['configured-model'],
      anthropic: ['default-anthropic'],
      custom: ['custom-model'],
    });
  });

  it('resolves once per request, however many callers ask', async () => {
    const req = { user: { id: 'u1' } };

    const [first, second, third] = await Promise.all([
      getModelsConfig(req),
      getModelsConfig(req),
      getModelsConfig(req),
    ]);
    await getModelsConfig(req);

    expect(loadConfigModels).toHaveBeenCalledTimes(1);
    expect(loadDefaultModels).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it('does not share a result between requests', async () => {
    loadConfigModels
      .mockResolvedValueOnce({ Claude: ['claude-sonnet-5'] })
      .mockResolvedValueOnce({ Claude: [] });

    const alice = await getModelsConfig({ user: { id: 'alice' } });
    const bob = await getModelsConfig({ user: { id: 'bob' } });

    expect(alice.Claude).toEqual(['claude-sonnet-5']);
    expect(bob.Claude).toEqual([]);
    expect(loadConfigModels).toHaveBeenCalledTimes(2);
  });

  it('lets a later caller retry after a failure instead of inheriting it', async () => {
    const req = { user: { id: 'u1' } };
    loadConfigModels.mockRejectedValueOnce(new Error('gateway unreachable'));

    await expect(getModelsConfig(req)).rejects.toThrow('gateway unreachable');

    loadConfigModels.mockResolvedValueOnce({ Claude: ['claude-sonnet-5'] });
    await expect(getModelsConfig(req)).resolves.toEqual(
      expect.objectContaining({ Claude: ['claude-sonnet-5'] }),
    );
  });
});
