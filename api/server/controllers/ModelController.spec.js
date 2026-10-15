const mockLoadDefaultModels = jest.fn();
const mockLoadConfigModels = jest.fn();
const mockGetAppConfig = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  getTenantId: () => undefined,
  logger: {
    error: jest.fn(),
  },
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
  loadDefaultModels: (...args) => mockLoadDefaultModels(...args),
  loadConfigModels: (...args) => mockLoadConfigModels(...args),
}));

const { loadModels, getModelsConfig } = require('./ModelController');

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
    mockGetAppConfig.mockResolvedValue({ endpoints: {} });
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

  it('preserves model catalogs when no user endpoint access rule matches', async () => {
    const req = { user: { id: 'user-1', username: 'restricted-user' } };
    mockLoadDefaultModels.mockResolvedValue({ openAI: ['gpt-4o'], anthropic: ['claude'] });
    mockLoadConfigModels.mockResolvedValue({
      'Allowed Provider': ['allowed-model'],
      'Restricted Provider': ['restricted-model'],
    });
    mockGetAppConfig.mockResolvedValue({ endpoints: {} });

    await expect(getModelsConfig(req)).resolves.toEqual({
      openAI: ['gpt-4o'],
      anthropic: ['claude'],
      'Allowed Provider': ['allowed-model'],
      'Restricted Provider': ['restricted-model'],
    });
    expect(mockGetAppConfig).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));
  });

  it('filters models only when an explicit user allowlist matches', async () => {
    const req = { user: { id: 'user-1', username: 'restricted-user' } };
    mockLoadDefaultModels.mockResolvedValue({ openAI: ['gpt-4o'] });
    mockLoadConfigModels.mockResolvedValue({
      'Allowed Provider': ['allowed-model'],
      'Restricted Provider': ['restricted-model'],
    });
    mockGetAppConfig.mockResolvedValue({
      endpoints: {
        userAccess: [{ username: 'restricted-user', allowedEndpoints: ['Allowed Provider'] }],
      },
    });

    await expect(getModelsConfig(req)).resolves.toEqual({
      'Allowed Provider': ['allowed-model'],
    });
  });
});
