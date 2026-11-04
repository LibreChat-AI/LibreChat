import { EModelEndpoint, normalizeEndpointName } from 'librechat-data-provider';
import type { TConfig } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import { filterManagedEndpoints, withholdEmptyEndpoints } from './availability';
import { createLoadConfigModels } from './models';

const GATEWAY = {
  baseURL: 'https://gateway.example.com/v1',
  apiKey: 'gateway-key',
};

/** One gateway, several endpoints over it — the shape `filter` exists for. */
const buildAppConfig = (endpoints: Record<string, unknown>[]) => ({
  endpoints: {
    [EModelEndpoint.custom]: endpoints.map((endpoint) => ({ ...GATEWAY, ...endpoint })),
  },
});

const buildRequest = () =>
  ({ user: { id: 'user-1' }, config: undefined }) as unknown as ServerRequest;

const load = (endpoints: Record<string, unknown>[], fetchModels: jest.Mock) =>
  createLoadConfigModels({
    getAppConfig: jest.fn().mockResolvedValue(buildAppConfig(endpoints)),
    getUserKeyValues: jest.fn().mockResolvedValue(null),
    fetchModels,
  })(buildRequest());

describe('loadConfigModels – declared ∩ fetched', () => {
  let fetchModels: jest.Mock;

  beforeEach(() => {
    fetchModels = jest.fn();
  });

  it('serves only declared models the gateway actually has, in declared order', async () => {
    fetchModels.mockResolvedValue(['gpt-5.6', 'claude-sonnet-5', 'cohere-rerank']);

    const result = await load(
      [
        {
          name: 'Claude',
          models: { default: ['claude-opus-5', 'claude-sonnet-5'], fetch: true, filter: true },
        },
      ],
      fetchModels,
    );

    expect(result.Claude).toEqual(['claude-sonnet-5']);
  });

  it('gives endpoints over one gateway their own slice from a single fetch', async () => {
    fetchModels.mockResolvedValue(['claude-sonnet-5', 'gpt-5.6', 'gemini-3.7-flash']);

    const result = await load(
      [
        { name: 'Claude', models: { default: ['claude-sonnet-5'], fetch: true, filter: true } },
        { name: 'OpenAI', models: { default: ['gpt-5.6'], fetch: true, filter: true } },
      ],
      fetchModels,
    );

    expect(result.Claude).toEqual(['claude-sonnet-5']);
    expect(result.OpenAI).toEqual(['gpt-5.6']);
    /* Same baseURL, apiKey and headers: one coalesced fetch serves both. */
    expect(fetchModels).toHaveBeenCalledTimes(1);
  });

  it('serves nothing when the gateway offers none of the declared models', async () => {
    fetchModels.mockResolvedValue(['gpt-5.6']);

    const result = await load(
      [{ name: 'Claude', models: { default: ['claude-sonnet-5'], fetch: true, filter: true } }],
      fetchModels,
    );

    expect(result.Claude).toEqual([]);
  });

  it('falls back to the declared list when the fetch fails or answers empty', async () => {
    fetchModels.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('gateway unreachable'));

    const declared = { default: ['claude-opus-5', 'claude-sonnet-5'], fetch: true, filter: true };
    const emptyAnswer = await load([{ name: 'Claude', models: declared }], fetchModels);
    const failed = await load([{ name: 'Claude', models: declared }], fetchModels);

    expect(emptyAnswer.Claude).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(failed.Claude).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });
});

describe('loadConfigModels – endpoints without `filter` are unchanged', () => {
  let fetchModels: jest.Mock;

  beforeEach(() => {
    fetchModels = jest.fn();
  });

  it('replaces the declared list with the fetched catalog', async () => {
    fetchModels.mockResolvedValue(['gpt-5.6', 'cohere-rerank']);

    const result = await load(
      [{ name: 'LiteLLM', models: { default: ['stale-name'], fetch: true } }],
      fetchModels,
    );

    expect(result.LiteLLM).toEqual(['gpt-5.6', 'cohere-rerank']);
  });

  it('keeps the fallback to declared models on an empty answer', async () => {
    fetchModels.mockResolvedValue([]);

    const result = await load(
      [{ name: 'LiteLLM', models: { default: ['claude-sonnet-5'], fetch: true } }],
      fetchModels,
    );

    expect(result.LiteLLM).toEqual(['claude-sonnet-5']);
  });
});

describe('filterManagedEndpoints', () => {
  const appConfig = (endpoints: Record<string, unknown>[]) =>
    ({ endpoints: { [EModelEndpoint.custom]: endpoints } }) as never;

  it('collects only endpoints that both filter and fetch', () => {
    const managed = filterManagedEndpoints(
      appConfig([
        { name: 'Claude', models: { default: ['a'], fetch: true, filter: true } },
        { name: 'Gemini', models: { default: ['b'], fetch: true, filter: true } },
        { name: 'Plain', models: { default: ['c'], fetch: true } },
        /* `filter` without `fetch` has no catalog to intersect against. */
        { name: 'NoFetch', models: { default: ['d'], filter: true } },
      ]),
    );

    expect([...managed].sort()).toEqual(['Claude', 'Gemini']);
    expect(filterManagedEndpoints(undefined).size).toBe(0);
    expect(filterManagedEndpoints({ endpoints: {} } as never).size).toBe(0);
  });

  it('keys by the normalized endpoint name, as the models config is', () => {
    const managed = filterManagedEndpoints(
      appConfig([{ name: ' Claude ', models: { default: ['a'], fetch: true, filter: true } }]),
    );

    expect(managed.has(normalizeEndpointName(' Claude '))).toBe(true);
  });
});

describe('withholdEmptyEndpoints', () => {
  const custom = (extra: Partial<TConfig> = {}): TConfig =>
    ({ order: 0, type: EModelEndpoint.custom, userProvide: false, ...extra }) as TConfig;
  const managed = (...names: string[]) => new Set(names);

  it('leaves an empty endpoint alone when it is not the one filtering', () => {
    const result = withholdEmptyEndpoints(
      { Filtered: custom(), Plain: custom() },
      { Filtered: ['claude-sonnet-5'], Plain: [] },
      managed('Filtered'),
    );

    expect(result?.Plain).toBeDefined();
  });

  it('drops a filter-managed endpoint whose model list is empty', () => {
    const result = withholdEmptyEndpoints(
      { Anthropic: custom(), Google: custom() },
      { Anthropic: ['claude-sonnet-5'], Google: [] },
      managed('Anthropic', 'Google'),
    );

    expect(result?.Anthropic).toBeDefined();
    expect(result).not.toHaveProperty('Google');
  });

  it('never withholds a user-provided endpoint — its empty list reflects a fixable key', () => {
    const result = withholdEmptyEndpoints(
      {
        Shared: custom(),
        BYOK: custom({ userProvide: true }),
        ByURL: custom({ userProvideURL: true }),
      },
      { Shared: [], BYOK: [], ByURL: [] },
      managed('Shared', 'BYOK', 'ByURL'),
    );

    expect(result).not.toHaveProperty('Shared');
    expect(result?.BYOK).toBeDefined();
    expect(result?.ByURL).toBeDefined();
  });

  it('never withholds a built-in endpoint, whatever the models config says', () => {
    const result = withholdEmptyEndpoints(
      { [EModelEndpoint.openAI]: { order: 0 } as TConfig, Google: custom() },
      { [EModelEndpoint.openAI]: [], Google: [] },
      managed(EModelEndpoint.openAI, 'Google'),
    );

    expect(result?.[EModelEndpoint.openAI]).toBeDefined();
    expect(result).not.toHaveProperty('Google');
  });

  it('fails open when there is no models config to judge against', () => {
    const endpointsConfig = { Google: custom() };

    expect(withholdEmptyEndpoints(endpointsConfig, null, managed('Google'))).toBe(endpointsConfig);
    expect(withholdEmptyEndpoints(endpointsConfig, undefined, managed('Google'))).toBe(
      endpointsConfig,
    );
  });

  it('fails open for an endpoint the models config has no entry for', () => {
    const result = withholdEmptyEndpoints(
      { Anthropic: custom(), Google: custom() },
      { Anthropic: ['claude-sonnet-5'] },
      managed('Anthropic', 'Google'),
    );

    expect(result?.Google).toBeDefined();
  });

  it('preserves endpoint order, which the caller has already resolved', () => {
    const result = withholdEmptyEndpoints(
      { First: custom(), Dropped: custom(), Second: custom() },
      { First: ['a'], Dropped: [], Second: ['b'] },
      managed('First', 'Dropped', 'Second'),
    );

    expect(Object.keys(result ?? {})).toEqual(['First', 'Second']);
  });
});
