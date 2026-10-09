const mockAccess = jest.fn();
const mockLoadServiceKey = jest.fn();
const mockIsUserProvided = jest.fn((value) => value === 'user_provided');
const mockLogger = {
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
};

function mockOptionalModule(moduleName, factory) {
  try {
    require.resolve(moduleName);
    jest.doMock(moduleName, factory);
  } catch {
    jest.doMock(moduleName, factory, { virtual: true });
  }
}

function mockDependencies() {
  jest.doMock('fs/promises', () => ({
    access: mockAccess,
  }));

  mockOptionalModule('@librechat/api', () => ({
    isEnabled: (value) => value === true || value === 'true' || value === '1',
    isUserProvided: mockIsUserProvided,
    loadServiceKey: mockLoadServiceKey,
  }));

  mockOptionalModule('@librechat/data-schemas', () => ({
    logger: mockLogger,
  }));

  mockOptionalModule('librechat-data-provider', () => ({
    EModelEndpoint: {
      agents: 'agents',
      anthropic: 'anthropic',
      assistants: 'assistants',
      azureAssistants: 'azureAssistants',
      azureOpenAI: 'azureOpenAI',
      bedrock: 'bedrock',
      google: 'google',
      openAI: 'openAI',
    },
  }));

  jest.doMock('~/server/utils/handleText', () => ({
    generateConfig: (key) => (key ? { userProvide: key === 'user_provided' } : false),
  }));
}

describe('loadAsyncEndpoints', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockDependencies();
    process.env = { ...originalEnv };
    delete process.env.GOOGLE_KEY;
    delete process.env.GOOGLE_SERVICE_KEY_FILE;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function loadModule(env = {}) {
    process.env = { ...process.env, ...env };
    return require('./loadAsyncEndpoints');
  }

  it('does not load the default Google service key when the default file is missing', async () => {
    mockAccess.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const loadAsyncEndpoints = loadModule();

    const result = await loadAsyncEndpoints();

    expect(result).toEqual({ google: false });
    expect(mockLoadServiceKey).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('loads the default Google service key when the default file exists', async () => {
    const serviceKey = { project_id: 'test-project' };
    mockAccess.mockResolvedValue();
    mockLoadServiceKey.mockResolvedValue(serviceKey);
    const loadAsyncEndpoints = loadModule();

    const result = await loadAsyncEndpoints();

    expect(result).toEqual({ google: { userProvide: false } });
    expect(mockLoadServiceKey).toHaveBeenCalledWith(expect.stringContaining('api/data/auth.json'));
  });

  it('loads an explicitly configured Google service key path without probing the default file', async () => {
    const serviceKey = { project_id: 'test-project' };
    mockLoadServiceKey.mockResolvedValue(serviceKey);
    const loadAsyncEndpoints = loadModule({
      GOOGLE_SERVICE_KEY_FILE: '/secrets/google-service-account.json',
    });

    const result = await loadAsyncEndpoints();

    expect(result).toEqual({ google: { userProvide: false } });
    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockLoadServiceKey).toHaveBeenCalledWith('/secrets/google-service-account.json');
  });

  it('uses GOOGLE_KEY without probing for a service key', async () => {
    const loadAsyncEndpoints = loadModule({ GOOGLE_KEY: 'user_provided' });

    const result = await loadAsyncEndpoints();

    expect(result).toEqual({ google: { userProvide: true } });
    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockLoadServiceKey).not.toHaveBeenCalled();
  });
});
