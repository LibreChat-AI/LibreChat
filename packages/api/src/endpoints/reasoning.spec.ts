import type { TEndpoint } from 'librechat-data-provider';
import type { ReasoningCapabilityDeps } from './reasoning';
import { loadReasoningCapabilities } from './reasoning';

const OPENROUTER = 'https://openrouter.ai/api/v1';

const catalog = {
  data: [
    {
      id: 'openai/gpt-6.1-sol',
      reasoning: { supported_efforts: ['high', 'low', 'none'], mandatory: false },
    },
    { id: 'google/gemini-3.5-flash', reasoning: { supported_efforts: ['low'], mandatory: true } },
    { id: 'meta/no-reasoning' },
    { id: 'meta/empty-efforts', reasoning: { supported_efforts: [] } },
    { id: 'meta/malformed', reasoning: 'yes' },
  ],
};

const endpoint = (overrides: Record<string, unknown> = {}): TEndpoint =>
  ({ name: 'OpenRouter', baseURL: OPENROUTER, apiKey: 'sk-test', ...overrides }) as TEndpoint;

function makeDeps(fetchCatalog?: ReasoningCapabilityDeps['fetchCatalog']) {
  const store = new Map<string, unknown>();
  const fetchSpy = jest.fn(fetchCatalog ?? (async () => catalog));
  const deps: ReasoningCapabilityDeps = {
    fetchCatalog: fetchSpy,
    cache: {
      get: async (key) => store.get(key),
      set: async (key, value) => {
        store.set(key, value);
        return true;
      },
    },
  };
  return { deps, fetchSpy, store };
}

describe('loadReasoningCapabilities', () => {
  it('maps the efforts and mandatory flag of each model that reports reasoning', async () => {
    const { deps } = makeDeps();

    const map = await loadReasoningCapabilities([endpoint()], deps);

    expect(map.OpenRouter).toEqual({
      'openai/gpt-6.1-sol': { efforts: ['high', 'low', 'none'], mandatory: false },
      'google/gemini-3.5-flash': { efforts: ['low'], mandatory: true },
    });
  });

  it('omits models that report no usable reasoning', async () => {
    const { deps } = makeDeps();

    const map = await loadReasoningCapabilities([endpoint()], deps);

    expect(Object.keys(map.OpenRouter)).not.toEqual(
      expect.arrayContaining(['meta/no-reasoning', 'meta/empty-efforts', 'meta/malformed']),
    );
  });

  it('keys the result by the normalized endpoint name', async () => {
    const { deps } = makeDeps();

    const map = await loadReasoningCapabilities([endpoint({ name: 'Open Router' })], deps);

    expect(Object.keys(map)).toEqual(['Open Router']);
  });

  it('does not fetch for hosts other than OpenRouter', async () => {
    const { deps, fetchSpy } = makeDeps();

    const map = await loadReasoningCapabilities(
      [
        endpoint({ name: 'Local', baseURL: 'http://localhost:8080/v1' }),
        endpoint({ name: 'Proxy', baseURL: 'https://gateway.example.com/openrouter.ai/v1' }),
      ],
      deps,
    );

    expect(map).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not fetch for a user-provided base URL', async () => {
    const { deps, fetchSpy } = makeDeps();

    const map = await loadReasoningCapabilities([endpoint({ baseURL: 'user_provided' })], deps);

    expect(map).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches once for endpoints that share a base URL', async () => {
    const { deps, fetchSpy } = makeDeps();

    const map = await loadReasoningCapabilities(
      [endpoint({ name: 'OpenRouter' }), endpoint({ name: 'OpenRouter Staging' })],
      deps,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(Object.keys(map)).toEqual(['OpenRouter', 'OpenRouter Staging']);
  });

  it('serves a later call from the cache', async () => {
    const { deps, fetchSpy } = makeDeps();

    await loadReasoningCapabilities([endpoint()], deps);
    const map = await loadReasoningCapabilities([endpoint()], deps);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(map.OpenRouter['google/gemini-3.5-flash']).toEqual({
      efforts: ['low'],
      mandatory: true,
    });
  });

  it('leaves an endpoint out when the catalog cannot be fetched', async () => {
    const { deps } = makeDeps(async () => {
      throw new Error('upstream down');
    });

    await expect(loadReasoningCapabilities([endpoint()], deps)).resolves.toEqual({});
  });

  it('does not cache a failed fetch', async () => {
    const { deps, fetchSpy, store } = makeDeps(async () => {
      throw new Error('upstream down');
    });

    await loadReasoningCapabilities([endpoint()], deps);
    await loadReasoningCapabilities([endpoint()], deps);

    expect(store.size).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('leaves an endpoint out when the catalog is not a model list', async () => {
    const { deps } = makeDeps(async () => ({ error: 'nope' }));

    await expect(loadReasoningCapabilities([endpoint()], deps)).resolves.toEqual({});
  });

  it('returns an empty map without custom endpoints', async () => {
    const { deps } = makeDeps();

    await expect(loadReasoningCapabilities(undefined, deps)).resolves.toEqual({});
  });
});
