const mockGetEnabledEndpoints = jest.fn();
const mockLoadAsyncEndpoints = jest.fn();

function mockOptionalModule(moduleName, factory) {
  try {
    require.resolve(moduleName);
    jest.doMock(moduleName, factory);
  } catch {
    jest.doMock(moduleName, factory, { virtual: true });
  }
}

function mockDependencies() {
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
    getEnabledEndpoints: mockGetEnabledEndpoints,
  }));

  jest.doMock('./loadAsyncEndpoints', () => mockLoadAsyncEndpoints);

  jest.doMock('./EndpointService', () => ({
    config: {
      agents: { userProvide: false },
      anthropic: false,
      assistants: false,
      azureAssistants: false,
      azureOpenAI: false,
      bedrock: false,
      openAI: { userProvide: false },
    },
  }));
}

describe('loadDefaultEndpointsConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockDependencies();
  });

  it('does not probe async Google credentials when Google is excluded from enabled endpoints', async () => {
    mockGetEnabledEndpoints.mockReturnValue(['openAI']);
    const loadDefaultEndpointsConfig = require('./loadDefaultEConfig');

    const result = await loadDefaultEndpointsConfig();

    expect(mockLoadAsyncEndpoints).not.toHaveBeenCalled();
    expect(result).toEqual({
      openAI: { userProvide: false, order: 0 },
    });
  });

  it('loads async Google credentials when Google is enabled', async () => {
    mockGetEnabledEndpoints.mockReturnValue(['google']);
    mockLoadAsyncEndpoints.mockResolvedValue({ google: { userProvide: false } });
    const loadDefaultEndpointsConfig = require('./loadDefaultEConfig');

    const result = await loadDefaultEndpointsConfig();

    expect(mockLoadAsyncEndpoints).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      google: { userProvide: false, order: 0 },
    });
  });
});
