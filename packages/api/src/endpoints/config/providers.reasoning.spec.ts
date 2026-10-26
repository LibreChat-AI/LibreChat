import { Providers } from '@librechat/agents';
import type { ProviderInitializeParams } from '~/types';

const mockInitializeCustom = jest.fn(async (_params: ProviderInitializeParams) => ({
  llmConfig: {},
}));
jest.mock('../custom/initialize', () => ({
  initializeCustom: (params: ProviderInitializeParams) => mockInitializeCustom(params),
}));

import { providerConfigMap, getProviderConfig } from './providers';

const params = { endpoint: 'OpenRouter', db: {} } as unknown as ProviderInitializeParams;

describe('custom endpoint initializers are wired with the reasoning dependencies', () => {
  beforeEach(() => {
    mockInitializeCustom.mockClear();
  });

  it.each([Providers.OPENROUTER, Providers.XAI, Providers.DEEPSEEK, Providers.MOONSHOT])(
    'supplies the production dependencies to the %s initializer',
    async (provider) => {
      await providerConfigMap[provider](params);

      const passed = mockInitializeCustom.mock.calls[0][0];
      expect(passed.reasoningCapabilityDeps).toEqual(
        expect.objectContaining({ fetchPage: expect.any(Function), cache: expect.anything() }),
      );
    },
  );

  it('supplies them to a user-defined custom endpoint', async () => {
    const { getOptions } = getProviderConfig({
      provider: 'MyGateway',
      appConfig: {
        endpoints: { custom: [{ name: 'MyGateway', baseURL: 'https://x/v1', apiKey: 'k' }] },
      } as never,
    });

    await getOptions(params);

    expect(mockInitializeCustom.mock.calls[0][0].reasoningCapabilityDeps).toBeDefined();
  });

  it('keeps dependencies a caller supplies', async () => {
    const supplied = { fetchPage: jest.fn(), cache: { get: jest.fn(), set: jest.fn() } };

    await providerConfigMap[Providers.OPENROUTER]({
      ...params,
      reasoningCapabilityDeps: supplied,
    } as ProviderInitializeParams);

    expect(mockInitializeCustom.mock.calls[0][0].reasoningCapabilityDeps).toBe(supplied);
  });
});
