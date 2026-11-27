import { EModelEndpoint } from 'librechat-data-provider';
import type { TConfig, TModelSpec, TEndpointsConfig } from 'librechat-data-provider';
import { getUserKeyEndpoints } from './utils';

const cfg = (overrides: Partial<TConfig> = {}): TConfig => ({ order: 0, ...overrides });

const spec = (endpoint: string): TModelSpec => ({
  name: endpoint,
  label: endpoint,
  preset: { endpoint },
});

const endpointsConfig: TEndpointsConfig = {
  openAI: cfg({ userProvide: true }),
  anthropic: cfg({ userProvide: true }),
  google: cfg({ userProvide: false }),
  bedrock: cfg({ userProvideBearerToken: true }),
  [EModelEndpoint.agents]: cfg({ allowedProviders: ['anthropic'] }),
};

describe('getUserKeyEndpoints', () => {
  it('returns an empty list when endpoints have not loaded', () => {
    expect(getUserKeyEndpoints({ endpointsConfig: undefined, hasAgentAccess: true })).toEqual([]);
  });

  it('lists every user-provided endpoint when no modelSpecs are configured', () => {
    expect(getUserKeyEndpoints({ endpointsConfig, hasAgentAccess: true })).toEqual([
      'openAI',
      'anthropic',
      'bedrock',
    ]);
  });

  it('limits to endpoints referenced by modelSpecs', () => {
    const result = getUserKeyEndpoints({
      endpointsConfig,
      modelSpecs: { list: [spec('openAI')] },
      hasAgentAccess: true,
    });
    expect(result).toEqual(['openAI']);
  });

  it('includes addedEndpoints alongside spec endpoints', () => {
    const result = getUserKeyEndpoints({
      endpointsConfig,
      modelSpecs: { list: [spec('openAI')], addedEndpoints: ['bedrock'] },
      hasAgentAccess: true,
    });
    expect(result).toEqual(['openAI', 'bedrock']);
  });

  it('expands a reachable agents endpoint to its allowedProviders', () => {
    const result = getUserKeyEndpoints({
      endpointsConfig,
      modelSpecs: { list: [spec('openAI')], addedEndpoints: [EModelEndpoint.agents] },
      hasAgentAccess: true,
    });
    expect(result).toEqual(['openAI', 'anthropic']);
  });

  it('expands a reachable agents endpoint with no allowedProviders to all providers', () => {
    const unrestricted: TEndpointsConfig = {
      ...endpointsConfig,
      [EModelEndpoint.agents]: cfg(),
    };
    const result = getUserKeyEndpoints({
      endpointsConfig: unrestricted,
      modelSpecs: { list: [spec('openAI')], addedEndpoints: [EModelEndpoint.agents] },
      hasAgentAccess: true,
    });
    expect(result).toEqual(['openAI', 'anthropic', 'bedrock']);
  });

  it('does not expand agent providers when the user lacks agent access', () => {
    const result = getUserKeyEndpoints({
      endpointsConfig,
      modelSpecs: { list: [spec('openAI')], addedEndpoints: [EModelEndpoint.agents] },
      hasAgentAccess: false,
    });
    expect(result).toEqual(['openAI']);
  });
});
