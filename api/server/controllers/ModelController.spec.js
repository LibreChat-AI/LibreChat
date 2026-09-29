const mockLoadDefaultModels = jest.fn();
const mockLoadConfigModels = jest.fn();
const mockGetGeneration = jest.fn(() => '2');

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
  },
}));

jest.mock('~/server/services/Config', () => ({
  loadDefaultModels: (...args) => mockLoadDefaultModels(...args),
  loadConfigModels: (...args) => mockLoadConfigModels(...args),
  getConfigGenerationForConfig: (...args) => mockGetGeneration(...args),
}));

const { loadModels, modelController } = require('./ModelController');

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('loadModels', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads default and configured models concurrently while preserving custom precedence', async () => {
    const defaultModels = deferred();
    const configuredModels = deferred();
    const req = { user: { id: 'user-1' } };
    mockLoadDefaultModels.mockReturnValue(defaultModels.promise);
    mockLoadConfigModels.mockReturnValue(configuredModels.promise);

    const resultPromise = loadModels(req);

    expect(mockLoadDefaultModels).toHaveBeenCalledWith(req);
    expect(mockLoadConfigModels).toHaveBeenCalledWith(req);

    configuredModels.resolve({
      openAI: ['configured-model'],
      custom: ['custom-model'],
    });
    defaultModels.resolve({
      openAI: ['default-model'],
      anthropic: ['default-anthropic'],
    });

    await expect(resultPromise).resolves.toEqual({
      openAI: ['configured-model'],
      anthropic: ['default-anthropic'],
      custom: ['custom-model'],
    });
  });
});

describe('versioned model response', () => {
  it('stamps the generation of the config used for the actual model request', async () => {
    const req = { user: { id: 'user-1' }, config: { endpoints: {} } };
    const res = { set: jest.fn(), send: jest.fn(), status: jest.fn() };
    mockLoadDefaultModels.mockResolvedValue({});
    mockLoadConfigModels.mockResolvedValue({ gateway: ['new-model'] });
    await modelController(req, res);
    expect(mockGetGeneration).toHaveBeenCalledWith(req.config);
    expect(res.set).toHaveBeenCalledWith('X-LibreChat-Config-Generation', '2');
    expect(res.send).toHaveBeenCalledWith({ gateway: ['new-model'] });
  });
});
