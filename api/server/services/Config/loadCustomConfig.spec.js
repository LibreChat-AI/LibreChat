jest.mock('axios');
jest.mock('~/cache/getLogStores');
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  loadYaml: jest.fn(),
}));
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    paramSettings: {
      foo: {},
      bar: {},
      custom: [],
      openrouter: [
        {
          key: 'promptCache',
          type: 'boolean',
          component: 'switch',
          default: true,
        },
      ],
    },
    agentParamSettings: {
      custom: [],
      google: [
        {
          key: 'pressure',
          type: 'string',
          component: 'input',
        },
        {
          key: 'temperature',
          type: 'number',
          component: 'slider',
          default: 0.5,
          range: {
            min: 0,
            max: 2,
            step: 0.01,
          },
        },
      ],
    },
  };
});

jest.mock('@librechat/data-schemas', () => {
  return {
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    },
    runAsSystem: jest.fn((fn) => fn()),
  };
});

jest.mock('~/server/utils/agentCategory', () => ({
  syncCategories: jest.fn(),
}));

const axios = require('axios');
const { loadYaml } = require('@librechat/api');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const { syncCategories } = require('~/server/utils/agentCategory');
const { ReasoningParameterFormat, ReasoningResponseKey } = require('librechat-data-provider');
const loadCustomConfig = require('./loadCustomConfig');

describe('loadCustomConfig', () => {
  const originalExit = process.exit;
  const mockExit = jest.fn((code) => {
    throw new Error(`process.exit called with "${code}"`);
  });

  beforeAll(() => {
    process.exit = mockExit;
  });

  afterAll(() => {
    process.exit = originalExit;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    // Re-apply the exit mock implementation after resetAllMocks
    mockExit.mockImplementation((code) => {
      throw new Error(`process.exit called with "${code}"`);
    });
    delete process.env.CONFIG_PATH;
  });

  it('should return null and log error if remote config fetch fails', async () => {
    process.env.CONFIG_PATH = 'http://example.com/config.yaml';
    axios.get.mockRejectedValue(new Error('Network error'));
    const result = await loadCustomConfig();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it('should return null for an invalid local config file', async () => {
    process.env.CONFIG_PATH = 'localConfig.yaml';
    loadYaml.mockReturnValueOnce(null);
    const result = await loadCustomConfig();
    expect(result).toBeNull();
  });

  it('should parse, validate, and cache a valid local configuration', async () => {
    const mockConfig = {
      version: '1.0',
      cache: true,
      endpoints: {
        custom: [
          {
            name: 'mistral',
            apiKey: 'user_provided',
            baseURL: 'https://api.mistral.ai/v1',
          },
        ],
      },
    };
    process.env.CONFIG_PATH = 'validConfig.yaml';
    loadYaml.mockReturnValueOnce(mockConfig);
    const result = await loadCustomConfig();

    expect(result).toEqual(mockConfig);
  });

  it('runs marketplace category sync within a system tenant context', async () => {
    runAsSystem.mockImplementation((fn) => fn());
    const config = {
      version: '1.0',
      cache: true,
      interface: {
        marketplace: {
          use: true,
          categories: {
            enableDefaultCategories: true,
            list: [{ value: 'Education', description: 'Educational agents.' }],
          },
        },
      },
    };
    process.env.CONFIG_PATH = 'marketplaceConfig.yaml';
    loadYaml.mockReturnValueOnce(config);

    await loadCustomConfig();

    expect(runAsSystem).toHaveBeenCalledTimes(1);
    expect(syncCategories).toHaveBeenCalledWith(
      [{ value: 'Education', description: 'Educational agents.' }],
      true,
    );
  });

  it('should return null and log if config schema validation fails', async () => {
    const invalidConfig = { invalidField: true };
    process.env.CONFIG_PATH = 'invalidConfig.yaml';
    process.env.CONFIG_BYPASS_VALIDATION = 'true';
    loadYaml.mockReturnValueOnce(invalidConfig);

    const result = await loadCustomConfig();

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      'CONFIG_BYPASS_VALIDATION is enabled. Continuing with default configuration despite validation errors.',
    );
    delete process.env.CONFIG_BYPASS_VALIDATION;
  });

  it('should call process.exit(1) when config validation fails without bypass', async () => {
    const invalidConfig = { invalidField: true };
    process.env.CONFIG_PATH = 'invalidConfig.yaml';
    loadYaml.mockReturnValueOnce(invalidConfig);

    await expect(loadCustomConfig()).rejects.toThrow('process.exit called with "1"');
    expect(logger.error).toHaveBeenCalledWith(
      'Exiting due to invalid configuration. Set CONFIG_BYPASS_VALIDATION=true to bypass this check.',
    );
  });

  it('does not exit when config validation fails during reload', async () => {
    process.env.CONFIG_PATH = 'invalidConfig.yaml';
    loadYaml.mockReturnValueOnce({ invalidField: true });

    await expect(loadCustomConfig(true, { mode: 'reload' })).rejects.toMatchObject({
      name: 'ConfigReloadError',
      validationErrors: expect.any(Array),
    });
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('rejects a reload when the local config file is missing', async () => {
    process.env.CONFIG_PATH = 'missingConfig.yaml';
    loadYaml.mockReturnValueOnce(null);

    await expect(loadCustomConfig(true, { mode: 'reload' })).rejects.toMatchObject({
      name: 'ConfigReloadError',
    });
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('rejects malformed local YAML during reload without exiting', async () => {
    process.env.CONFIG_PATH = 'invalidConfig.yaml';
    loadYaml.mockReturnValueOnce(new Error('Malformed YAML'));

    await expect(loadCustomConfig(true, { mode: 'reload' })).rejects.toMatchObject({
      name: 'ConfigReloadError',
    });
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('rejects malformed remote YAML during reload without exiting', async () => {
    process.env.CONFIG_PATH = 'https://example.com/config.yaml';
    axios.get.mockResolvedValueOnce({ data: 'version: [unterminated' });

    await expect(loadCustomConfig(true, { mode: 'reload' })).rejects.toMatchObject({
      name: 'ConfigReloadError',
    });
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('rejects a reload when the remote config fetch fails', async () => {
    process.env.CONFIG_PATH = 'https://example.com/config.yaml';
    axios.get.mockRejectedValueOnce(new Error('Network error'));

    await expect(loadCustomConfig(true, { mode: 'reload' })).rejects.toMatchObject({
      name: 'ConfigReloadError',
    });
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('should handle and return null on YAML parse error for a string response from remote', async () => {
    process.env.CONFIG_PATH = 'http://example.com/config.yaml';
    process.env.CONFIG_BYPASS_VALIDATION = 'true';
    axios.get.mockResolvedValue({ data: 'invalidYAMLContent' });

    const result = await loadCustomConfig();

    expect(result).toBeNull();
    delete process.env.CONFIG_BYPASS_VALIDATION;
  });

  it('should return the custom config object for a valid remote config file', async () => {
    const mockConfig = {
      version: '1.0',
      cache: true,
      endpoints: {
        custom: [
          {
            name: 'mistral',
            apiKey: 'user_provided',
            baseURL: 'https://api.mistral.ai/v1',
          },
        ],
      },
    };
    process.env.CONFIG_PATH = 'http://example.com/config.yaml';
    axios.get.mockResolvedValue({ data: mockConfig });
    const result = await loadCustomConfig();
    expect(result).toEqual(mockConfig);
  });

  it('should return null if the remote config file is not found', async () => {
    process.env.CONFIG_PATH = 'http://example.com/config.yaml';
    axios.get.mockRejectedValue({ response: { status: 404 } });
    const result = await loadCustomConfig();
    expect(result).toBeNull();
  });

  it('should return null if the local config file is not found', async () => {
    process.env.CONFIG_PATH = 'nonExistentConfig.yaml';
    loadYaml.mockReturnValueOnce(null);
    const result = await loadCustomConfig();
    expect(result).toBeNull();
  });

  it('should not cache the config if cache is set to false', async () => {
    const mockConfig = {
      version: '1.0',
      cache: false,
      endpoints: {
        custom: [
          {
            name: 'mistral',
            apiKey: 'user_provided',
            baseURL: 'https://api.mistral.ai/v1',
          },
        ],
      },
    };
    process.env.CONFIG_PATH = 'validConfig.yaml';
    loadYaml.mockReturnValueOnce(mockConfig);
    const result = await loadCustomConfig();
    expect(result).toEqual(mockConfig);
  });

  it('should log the loaded custom config', async () => {
    const mockConfig = {
      version: '1.0',
      cache: true,
      endpoints: {
        custom: [
          {
            name: 'mistral',
            apiKey: 'user_provided',
            baseURL: 'https://api.mistral.ai/v1',
          },
        ],
      },
    };
    process.env.CONFIG_PATH = 'validConfig.yaml';
    loadYaml.mockReturnValueOnce(mockConfig);
    await loadCustomConfig();
    expect(logger.info).toHaveBeenCalledWith('Custom config file loaded:');
    expect(logger.info).toHaveBeenCalledWith(JSON.stringify(mockConfig, null, 2));
    expect(logger.debug).toHaveBeenCalledWith('Custom config:', mockConfig);
  });

  it('masks literal Langfuse header credentials in the startup log', async () => {
    const mockConfig = {
      version: '1.0',
      cache: true,
      langfuse: {
        enabled: true,
        publicKey: 'pk-lf-1',
        headers: {
          'CF-Access-Client-Id': 'client-id',
          'CF-Access-Client-Secret': 'gateway-credential',
        },
      },
    };
    process.env.CONFIG_PATH = 'validConfig.yaml';
    loadYaml.mockReturnValueOnce(mockConfig);

    const result = await loadCustomConfig();

    const logged = logger.info.mock.calls.map(([value]) => value).join('\n');
    const debugged = JSON.stringify(logger.debug.mock.calls);
    expect(logged).not.toContain('gateway-credential');
    expect(debugged).not.toContain('gateway-credential');
    expect(logged).toContain('***');
    // The masking is for logging only — the live config keeps real values.
    expect(result.langfuse.headers['CF-Access-Client-Secret']).toBe('gateway-credential');
  });

  describe('parseCustomParams', () => {
    const mockConfig = {
      version: '1.0',
      cache: false,
      endpoints: {
        custom: [
          {
            name: 'Google',
            apiKey: 'user_provided',
            customParams: {},
          },
        ],
      },
    };

    async function loadCustomParams(customParams) {
      mockConfig.endpoints.custom[0].customParams = customParams;
      loadYaml.mockReturnValue(mockConfig);
      return await loadCustomConfig();
    }

    beforeEach(() => {
      jest.resetAllMocks();
      process.env.CONFIG_PATH = 'validConfig.yaml';
    });

    it('returns no error when customParams is undefined', async () => {
      const result = await loadCustomParams(undefined);
      expect(result).toEqual(mockConfig);
    });

    it('returns no error when customParams is valid', async () => {
      const result = await loadCustomParams({
        defaultParamsEndpoint: 'google',
        paramDefinitions: [
          {
            key: 'temperature',
            default: 0.5,
          },
        ],
      });
      expect(result).toEqual(mockConfig);
    });

    it('throws an error when paramDefinitions contain unsupported keys', async () => {
      const malformedCustomParams = {
        defaultParamsEndpoint: 'google',
        paramDefinitions: [
          { key: 'temperature', default: 0.5 },
          { key: 'unsupportedKey', range: 0.5 },
        ],
      };
      await expect(loadCustomParams(malformedCustomParams)).rejects.toThrow(
        'paramDefinitions of "Google" endpoint contains invalid key(s). Valid parameter keys are pressure, temperature',
      );
    });

    it('throws an error when paramDefinitions is malformed', async () => {
      const malformedCustomParams = {
        defaultParamsEndpoint: 'google',
        paramDefinitions: [
          {
            key: 'temperature',
            type: 'noomba',
            component: 'inpoot',
            optionType: 'custom',
          },
        ],
      };
      await expect(loadCustomParams(malformedCustomParams)).rejects.toThrow(
        /Custom parameter definitions for "Google" endpoint is malformed:/,
      );
    });

    it('defaults defaultParamsEndpoint when only reasoningFormat is provided', async () => {
      const parsedConfig = await loadCustomParams({
        reasoningFormat: ReasoningParameterFormat.reasoningObject,
      });

      expect(parsedConfig.endpoints.custom[0].customParams).toEqual({
        defaultParamsEndpoint: 'custom',
        reasoningFormat: ReasoningParameterFormat.reasoningObject,
        paramDefinitions: [],
      });
    });

    it('defaults defaultParamsEndpoint when only reasoningKey is provided', async () => {
      const parsedConfig = await loadCustomParams({
        reasoningKey: ReasoningResponseKey.reasoning,
      });

      expect(parsedConfig.endpoints.custom[0].customParams).toEqual({
        defaultParamsEndpoint: 'custom',
        reasoningKey: ReasoningResponseKey.reasoning,
        paramDefinitions: [],
      });
    });

    it('fills the paramDefinitions with missing values', async () => {
      const customParams = {
        defaultParamsEndpoint: 'google',
        paramDefinitions: [
          { key: 'temperature', default: 0.7, range: { min: 0.1, max: 0.9, step: 0.1 } },
          { key: 'pressure', component: 'textarea' },
        ],
      };

      const parsedConfig = await loadCustomParams(customParams);
      const paramDefinitions = parsedConfig.endpoints.custom[0].customParams.paramDefinitions;
      expect(paramDefinitions).toEqual([
        {
          columnSpan: 1,
          component: 'slider',
          default: 0.7, // overridden
          includeInput: true,
          key: 'temperature',
          label: 'temperature',
          optionType: 'custom',
          range: {
            // overridden
            max: 0.9,
            min: 0.1,
            step: 0.1,
          },
          type: 'number',
        },
        {
          columnSpan: 1,
          component: 'textarea', // overridden
          key: 'pressure',
          label: 'pressure',
          optionType: 'custom',
          placeholder: '',
          type: 'string',
        },
      ]);
    });

    it('adds OpenRouter promptCache defaults when custom endpoint name is OpenRouter', async () => {
      const openRouterConfig = {
        version: '1.0',
        cache: false,
        endpoints: {
          custom: [
            {
              name: 'OpenRouter',
              apiKey: 'user_provided',
              baseURL: 'https://proxy.example.com/v1',
              models: {
                default: ['anthropic/claude-sonnet-4.6'],
              },
            },
          ],
        },
      };
      loadYaml.mockReturnValue(openRouterConfig);

      const parsedConfig = await loadCustomConfig();
      expect(parsedConfig.endpoints.custom[0].customParams).toEqual({
        defaultParamsEndpoint: 'openrouter',
        paramDefinitions: [
          {
            columnSpan: 1,
            component: 'switch',
            default: true,
            key: 'promptCache',
            label: 'promptCache',
            optionType: 'custom',
            type: 'boolean',
          },
        ],
      });
    });

    it('adds OpenRouter promptCache defaults when custom endpoint URL is OpenRouter', async () => {
      const openRouterConfig = {
        version: '1.0',
        cache: false,
        endpoints: {
          custom: [
            {
              name: 'Company Gateway',
              apiKey: 'user_provided',
              baseURL: 'https://openrouter.ai/api/v1',
              models: {
                default: ['anthropic/claude-sonnet-4.6'],
              },
            },
          ],
        },
      };
      loadYaml.mockReturnValue(openRouterConfig);

      const parsedConfig = await loadCustomConfig();
      expect(parsedConfig.endpoints.custom[0].customParams).toMatchObject({
        defaultParamsEndpoint: 'openrouter',
        paramDefinitions: [
          {
            default: true,
            key: 'promptCache',
          },
        ],
      });
    });

    it('treats an empty defaultParamsEndpoint as absent for OpenRouter', async () => {
      const config = {
        version: '1.0',
        endpoints: {
          custom: [
            {
              name: 'OpenRouter',
              apiKey: 'user_provided',
              baseURL: 'https://openrouter.ai/api/v1',
              models: { default: ['test-model'] },
              customParams: { defaultParamsEndpoint: '' },
            },
          ],
        },
      };
      loadYaml.mockReturnValueOnce(config);

      const loaded = await loadCustomConfig();
      expect(loaded.endpoints.custom[0].customParams.defaultParamsEndpoint).toBe('openrouter');
    });

    it('preserves explicit OpenRouter promptCache defaults', async () => {
      const openRouterConfig = {
        version: '1.0',
        cache: false,
        endpoints: {
          custom: [
            {
              name: 'OpenRouter',
              apiKey: 'user_provided',
              baseURL: 'https://openrouter.ai/api/v1',
              models: {
                default: ['anthropic/claude-sonnet-4.6'],
              },
              customParams: {
                defaultParamsEndpoint: 'openrouter',
                paramDefinitions: [{ key: 'promptCache', default: false }],
              },
            },
          ],
        },
      };
      loadYaml.mockReturnValue(openRouterConfig);

      const parsedConfig = await loadCustomConfig();
      expect(parsedConfig.endpoints.custom[0].customParams.paramDefinitions).toEqual([
        {
          columnSpan: 1,
          component: 'switch',
          default: false,
          key: 'promptCache',
          label: 'promptCache',
          optionType: 'custom',
          type: 'boolean',
        },
      ]);
    });
  });
});
