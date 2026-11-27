import { logger, encryptV3 } from '@librechat/data-schemas';
import { FileSources, EModelEndpoint } from 'librechat-data-provider';
import type {
  TCustomConfig,
  TEndpoint,
  TAzureConfig,
  TAzureGroupMap,
  TAzureModelGroupMap,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import {
  getBalanceConfig,
  getCustomEndpointConfig,
  getTransactionsConfig,
  getEndpointsDropParamsMap,
} from './config';

// Helper function to create a minimal AppConfig for testing
const createTestAppConfig = (overrides: Partial<AppConfig> = {}): AppConfig => {
  const minimalConfig: TCustomConfig = {
    version: '1.0.0',
    cache: true,
    interface: {
      modelSelect: true,
    },
    registration: {
      socialLogins: [],
    },
    endpoints: {},
  };

  return {
    config: minimalConfig,
    paths: {
      uploads: '',
      imageOutput: '',
      publicPath: '',
    },
    fileStrategy: FileSources.local,
    fileStrategies: {},
    imageOutputType: 'png',
    ...overrides,
  };
};

/** Builds azureOpenAI `groupMap` entries with the required `apiKey`/`models` fields. */
const createAzureGroupMap = (groups: Record<string, string[] | undefined>): TAzureGroupMap =>
  Object.fromEntries(
    Object.entries(groups).map(([groupName, dropParams]) => [
      groupName,
      {
        apiKey: 'test-key',
        models: {},
        ...(dropParams ? { dropParams } : {}),
      },
    ]),
  );

/** Builds a minimal, valid azureOpenAI endpoint config for testing `getEndpointsDropParamsMap`. */
const createAzureConfig = (
  groupMap: TAzureGroupMap,
  modelGroupMap: TAzureModelGroupMap,
): TAzureConfig => ({
  isValid: true,
  errors: [],
  modelNames: Object.keys(modelGroupMap),
  groupMap,
  modelGroupMap,
});

jest.mock('@librechat/data-schemas', () => {
  process.env.CREDS_KEY =
    process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const actual = jest.requireActual('@librechat/data-schemas');
  return {
    encryptV3: actual.encryptV3,
    decryptV3: actual.decryptV3,
    logger: {
      warn: jest.fn(),
      error: jest.fn(),
    },
  };
});

jest.mock('~/utils', () => ({
  isEnabled: jest.fn((value) => value === 'true'),
}));

describe('getTransactionsConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CHECK_BALANCE;
    delete process.env.START_BALANCE;
  });

  describe('when appConfig is not provided', () => {
    it('should return default config with enabled: true', () => {
      const result = getTransactionsConfig();
      expect(result).toEqual({ enabled: true });
    });
  });

  describe('when appConfig is provided', () => {
    it('should return transactions config when explicitly set to false', () => {
      const appConfig = createTestAppConfig({
        transactions: { enabled: false },
        balance: { enabled: false },
      });
      const result = getTransactionsConfig(appConfig);
      expect(result).toEqual({ enabled: false });
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('should return transactions config when explicitly set to true', () => {
      const appConfig = createTestAppConfig({
        transactions: { enabled: true },
        balance: { enabled: false },
      });
      const result = getTransactionsConfig(appConfig);
      expect(result).toEqual({ enabled: true });
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('should return default config when transactions is not defined', () => {
      const appConfig = createTestAppConfig({
        balance: { enabled: false },
      });
      const result = getTransactionsConfig(appConfig);
      expect(result).toEqual({ enabled: true });
      expect(logger.warn).not.toHaveBeenCalled();
    });

    describe('balance and transactions interaction', () => {
      it('should force transactions to be enabled when balance is enabled but transactions is disabled', () => {
        const appConfig = createTestAppConfig({
          transactions: { enabled: false },
          balance: { enabled: true },
        });
        const result = getTransactionsConfig(appConfig);
        expect(result).toEqual({ enabled: true });
        expect(logger.warn).toHaveBeenCalledWith(
          'Configuration warning: transactions.enabled=false is incompatible with balance.enabled=true. ' +
            'Transactions will be enabled to ensure balance tracking works correctly.',
        );
      });

      it('should not override transactions when balance is enabled and transactions is enabled', () => {
        const appConfig = createTestAppConfig({
          transactions: { enabled: true },
          balance: { enabled: true },
        });
        const result = getTransactionsConfig(appConfig);
        expect(result).toEqual({ enabled: true });
        expect(logger.warn).not.toHaveBeenCalled();
      });

      it('should allow transactions to be disabled when balance is disabled', () => {
        const appConfig = createTestAppConfig({
          transactions: { enabled: false },
          balance: { enabled: false },
        });
        const result = getTransactionsConfig(appConfig);
        expect(result).toEqual({ enabled: false });
        expect(logger.warn).not.toHaveBeenCalled();
      });

      it('should use default when balance is enabled but transactions is not defined', () => {
        const appConfig = createTestAppConfig({
          balance: { enabled: true },
        });
        const result = getTransactionsConfig(appConfig);
        expect(result).toEqual({ enabled: true });
        expect(logger.warn).not.toHaveBeenCalled();
      });
    });

    describe('with environment variables for balance', () => {
      it('should force transactions enabled when CHECK_BALANCE env is true and transactions is false', () => {
        process.env.CHECK_BALANCE = 'true';
        const appConfig = createTestAppConfig({
          transactions: { enabled: false },
        });
        const result = getTransactionsConfig(appConfig);
        expect(result).toEqual({ enabled: true });
        expect(logger.warn).toHaveBeenCalledWith(
          'Configuration warning: transactions.enabled=false is incompatible with balance.enabled=true. ' +
            'Transactions will be enabled to ensure balance tracking works correctly.',
        );
      });

      it('should allow transactions disabled when CHECK_BALANCE env is false', () => {
        process.env.CHECK_BALANCE = 'false';
        const appConfig = createTestAppConfig({
          transactions: { enabled: false },
        });
        const result = getTransactionsConfig(appConfig);
        expect(result).toEqual({ enabled: false });
        expect(logger.warn).not.toHaveBeenCalled();
      });
    });

    describe('edge cases', () => {
      it('should handle empty appConfig object', () => {
        const appConfig = createTestAppConfig();
        const result = getTransactionsConfig(appConfig);
        expect(result).toEqual({ enabled: true });
        expect(logger.warn).not.toHaveBeenCalled();
      });

      it('should handle appConfig with null balance', () => {
        const appConfig = createTestAppConfig({
          transactions: { enabled: false },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          balance: null as any,
        });
        const result = getTransactionsConfig(appConfig);
        expect(result).toEqual({ enabled: false });
        expect(logger.warn).not.toHaveBeenCalled();
      });

      it('should handle appConfig with undefined balance', () => {
        const appConfig = createTestAppConfig({
          transactions: { enabled: false },
          balance: undefined,
        });
        const result = getTransactionsConfig(appConfig);
        expect(result).toEqual({ enabled: false });
        expect(logger.warn).not.toHaveBeenCalled();
      });

      it('should handle appConfig with balance enabled undefined', () => {
        const appConfig = createTestAppConfig({
          transactions: { enabled: false },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          balance: { enabled: undefined as any },
        });
        const result = getTransactionsConfig(appConfig);
        expect(result).toEqual({ enabled: false });
        expect(logger.warn).not.toHaveBeenCalled();
      });
    });
  });
});

describe('getBalanceConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CHECK_BALANCE;
    delete process.env.START_BALANCE;
  });

  describe('when appConfig is not provided', () => {
    it('should return config based on environment variables', () => {
      process.env.CHECK_BALANCE = 'true';
      process.env.START_BALANCE = '1000';
      const result = getBalanceConfig();
      expect(result).toEqual({
        enabled: true,
        startBalance: 1000,
      });
    });

    it('should return empty config when no env vars are set', () => {
      const result = getBalanceConfig();
      expect(result).toEqual({ enabled: false });
    });

    it('should handle CHECK_BALANCE true without START_BALANCE', () => {
      process.env.CHECK_BALANCE = 'true';
      const result = getBalanceConfig();
      expect(result).toEqual({
        enabled: true,
      });
    });

    it('should handle START_BALANCE without CHECK_BALANCE', () => {
      process.env.START_BALANCE = '5000';
      const result = getBalanceConfig();
      expect(result).toEqual({
        enabled: false,
        startBalance: 5000,
      });
    });
  });

  describe('when appConfig is provided', () => {
    it('should merge appConfig balance with env config', () => {
      process.env.CHECK_BALANCE = 'true';
      process.env.START_BALANCE = '1000';
      const appConfig = createTestAppConfig({
        balance: {
          enabled: false,
          startBalance: 2000,
          autoRefillEnabled: true,
        },
      });
      const result = getBalanceConfig(appConfig);
      expect(result).toEqual({
        enabled: false,
        startBalance: 2000,
        autoRefillEnabled: true,
      });
    });

    it('should use env config when appConfig balance is not provided', () => {
      process.env.CHECK_BALANCE = 'true';
      process.env.START_BALANCE = '3000';
      const appConfig = createTestAppConfig();
      const result = getBalanceConfig(appConfig);
      expect(result).toEqual({
        enabled: true,
        startBalance: 3000,
      });
    });

    it('should handle appConfig with null balance', () => {
      process.env.CHECK_BALANCE = 'true';
      const appConfig = createTestAppConfig({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        balance: null as any,
      });
      const result = getBalanceConfig(appConfig);
      expect(result).toEqual({
        enabled: true,
      });
    });
  });
});

describe('getCustomEndpointConfig', () => {
  describe('when appConfig is not provided', () => {
    it('should throw an error', () => {
      expect(() => getCustomEndpointConfig({ endpoint: 'test' })).toThrow(
        'Config not found for the test custom endpoint.',
      );
    });
  });

  describe('when appConfig is provided', () => {
    it('should return undefined when no custom endpoints are configured', () => {
      const appConfig = createTestAppConfig();
      const result = getCustomEndpointConfig({ endpoint: 'test', appConfig });
      expect(result).toBeUndefined();
    });

    it('should return the matching endpoint config when found', () => {
      const appConfig = createTestAppConfig({
        endpoints: {
          [EModelEndpoint.custom]: [
            {
              name: 'TestEndpoint',
              apiKey: 'test-key',
            } as TEndpoint,
          ],
        },
      });

      const result = getCustomEndpointConfig({ endpoint: 'TestEndpoint', appConfig });
      expect(result).toEqual({
        name: 'TestEndpoint',
        apiKey: 'test-key',
      });
    });

    it('should decrypt admin-encrypted API keys without mutating the stored config', () => {
      const appConfig = createTestAppConfig({
        endpoints: {
          [EModelEndpoint.custom]: [
            {
              name: 'Encrypted',
              apiKey: encryptV3('sk-real-key'),
              baseURL: 'https://encrypted.example',
            } as TEndpoint,
          ],
        },
      });

      const result = getCustomEndpointConfig({ endpoint: 'Encrypted', appConfig });
      expect(result?.apiKey).toBe('sk-real-key');
      expect(result?.baseURL).toBe('https://encrypted.example');
      expect(appConfig.endpoints?.[EModelEndpoint.custom]?.[0].apiKey).toMatch(/^v3:/);
    });

    it('should handle case-insensitive matching for Ollama endpoint', () => {
      const appConfig = createTestAppConfig({
        endpoints: {
          [EModelEndpoint.custom]: [
            {
              name: 'Ollama',
              apiKey: 'ollama-key',
            } as TEndpoint,
          ],
        },
      });

      const result = getCustomEndpointConfig({ endpoint: 'Ollama', appConfig });
      expect(result).toEqual({
        name: 'Ollama',
        apiKey: 'ollama-key',
      });
    });

    it('should handle mixed case endpoint names', () => {
      const appConfig = createTestAppConfig({
        endpoints: {
          [EModelEndpoint.custom]: [
            {
              name: 'CustomAI',
              apiKey: 'custom-key',
            } as TEndpoint,
          ],
        },
      });

      const result = getCustomEndpointConfig({ endpoint: 'customai', appConfig });
      expect(result).toBeUndefined();
    });
  });
});

describe('getEndpointsDropParamsMap', () => {
  it('returns an empty map when endpoints is undefined', () => {
    expect(getEndpointsDropParamsMap(undefined)).toEqual({});
  });

  it('returns an empty map when no configured endpoint has dropParams', () => {
    const result = getEndpointsDropParamsMap({
      [EModelEndpoint.custom]: [{ name: 'no-drop-provider', apiKey: 'k' } as TEndpoint],
    });
    expect(result).toEqual({});
  });

  it('maps dropParams for array-configured custom endpoints', () => {
    const result = getEndpointsDropParamsMap({
      [EModelEndpoint.custom]: [
        { name: 'custom-provider', dropParams: ['temperature', 'top_p'] } as TEndpoint,
        { name: 'no-drop-provider' } as TEndpoint,
      ],
    });
    expect(result).toEqual({
      'custom-provider': ['temperature', 'top_p'],
    });
  });

  it('normalizes an ollama custom endpoint name to lowercase', () => {
    const result = getEndpointsDropParamsMap({
      [EModelEndpoint.custom]: [{ name: 'Ollama', dropParams: ['stop'] } as TEndpoint],
    });
    expect(result).toEqual({ ollama: ['stop'] });
  });

  it('keeps azureOpenAI dropParams model-specific instead of merging across groups', () => {
    const endpoints: AppConfig['endpoints'] = {
      [EModelEndpoint.azureOpenAI]: createAzureConfig(
        createAzureGroupMap({
          groupA: ['temperature'],
          groupB: ['temperature', 'top_p'],
        }),
        {
          'model-a': { group: 'groupA' },
          'model-b': { group: 'groupB' },
        },
      ),
    };

    const result = getEndpointsDropParamsMap(endpoints);

    expect(result[EModelEndpoint.azureOpenAI]).toEqual({
      'model-a': ['temperature'],
      'model-b': ['temperature', 'top_p'],
    });
  });

  it('omits an azureOpenAI model from the map when its group has no dropParams', () => {
    const endpoints: AppConfig['endpoints'] = {
      [EModelEndpoint.azureOpenAI]: createAzureConfig(
        createAzureGroupMap({
          groupA: ['temperature'],
          groupB: undefined,
        }),
        {
          'model-a': { group: 'groupA' },
          'model-b': { group: 'groupB' },
        },
      ),
    };

    expect(getEndpointsDropParamsMap(endpoints)).toEqual({
      [EModelEndpoint.azureOpenAI]: { 'model-a': ['temperature'] },
    });
  });

  it('excludes azureOpenAI when no group has dropParams', () => {
    const endpoints: AppConfig['endpoints'] = {
      [EModelEndpoint.azureOpenAI]: createAzureConfig(createAzureGroupMap({ groupA: undefined }), {
        'model-a': { group: 'groupA' },
      }),
    };

    expect(getEndpointsDropParamsMap(endpoints)).toEqual({});
  });

  it('ignores endpoint shapes without dropParams support, like agents', () => {
    const endpoints = {
      [EModelEndpoint.custom]: [{ name: 'no-drop-provider' } as TEndpoint],
      [EModelEndpoint.agents]: { titleConvo: true },
    } as AppConfig['endpoints'];

    expect(getEndpointsDropParamsMap(endpoints)).toEqual({});
  });
});
