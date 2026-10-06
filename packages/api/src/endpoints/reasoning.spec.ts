import type { TEndpoint } from 'librechat-data-provider';
import type { ReasoningCapabilityDeps } from './reasoning';
import { loadReasoningCapabilities, withSupportedEffort } from './reasoning';

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

function makeDeps(fetchPage?: ReasoningCapabilityDeps['fetchPage']) {
  const store = new Map<string, unknown>();
  const fetchSpy = jest.fn(fetchPage ?? (async () => catalog));
  const deps: ReasoningCapabilityDeps = {
    fetchPage: fetchSpy,
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

describe('loadReasoningCapabilities: pagination', () => {
  const page = (id: string, next: string | null) => ({
    data: [{ id, reasoning: { supported_efforts: ['low'] } }],
    links: { next },
  });

  it('follows the next link until the catalog is exhausted', async () => {
    const { deps, fetchSpy } = makeDeps(async ({ url }) =>
      url.includes('offset=1')
        ? page('b/second', null)
        : page('a/first', '/api/v1/models?offset=1'),
    );

    const map = await loadReasoningCapabilities([endpoint()], deps);

    expect(Object.keys(map.OpenRouter)).toEqual(['a/first', 'b/second']);
    expect(fetchSpy.mock.calls.map(([params]) => params.url)).toEqual([
      `${OPENROUTER}/models`,
      'https://openrouter.ai/api/v1/models?offset=1',
    ]);
  });

  it('leaves the endpoint out, uncached, when a later page fails', async () => {
    const { deps, store } = makeDeps(async ({ url }) => {
      if (url.includes('offset=1')) {
        throw new Error('page 2 down');
      }
      return page('a/first', '/api/v1/models?offset=1');
    });

    await expect(loadReasoningCapabilities([endpoint()], deps)).resolves.toEqual({});
    expect(store.size).toBe(0);
  });

  it('refuses a next link that leaves the provider host', async () => {
    const { deps, fetchSpy } = makeDeps(async () =>
      page('a/first', 'https://attacker.example.com/api/v1/models?offset=1'),
    );

    await expect(loadReasoningCapabilities([endpoint()], deps)).resolves.toEqual({});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses a next link that loops back to a page already read', async () => {
    const { deps, fetchSpy } = makeDeps(async () => page('a/first', '/api/v1/models'));

    await expect(loadReasoningCapabilities([endpoint()], deps)).resolves.toEqual({});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('gives up on a catalog with more pages than the limit', async () => {
    let offset = 0;
    const { deps, fetchSpy } = makeDeps(async () => {
      offset += 1;
      return page(`m/${offset}`, `/api/v1/models?offset=${offset}`);
    });

    await expect(loadReasoningCapabilities([endpoint()], deps)).resolves.toEqual({});
    expect(fetchSpy).toHaveBeenCalledTimes(20);
  });
});

describe('loadReasoningCapabilities: timeout', () => {
  it('uses 5000 ms when the endpoint does not set one', async () => {
    const { deps, fetchSpy } = makeDeps();

    await loadReasoningCapabilities([endpoint()], deps);

    expect(fetchSpy).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 5000 }));
  });

  it('uses the timeout the endpoint configures', async () => {
    const { deps, fetchSpy } = makeDeps();

    await loadReasoningCapabilities(
      [endpoint({ customParams: { reasoningCatalogTimeoutMs: 12000 } })],
      deps,
    );

    expect(fetchSpy).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 12000 }));
  });
});

describe('withSupportedEffort', () => {
  const sol = 'openai/gpt-6.1-sol';
  const options = (reasoning_effort?: string, model = sol) => ({
    model,
    ...(reasoning_effort != null && { reasoning_effort }),
  });

  it('keeps an effort the model supports', async () => {
    const { deps } = makeDeps();
    const stored = options('low');

    await expect(withSupportedEffort(stored, endpoint(), deps)).resolves.toBe(stored);
  });

  it('drops an effort the model does not support', async () => {
    const { deps } = makeDeps();

    const result = await withSupportedEffort(options('max'), endpoint(), deps);

    expect(result).toEqual({ model: sol });
  });

  it('drops none for a model whose reasoning is mandatory', async () => {
    const { deps } = makeDeps();

    const result = await withSupportedEffort(
      options('none', 'google/gemini-3.5-flash'),
      endpoint(),
      deps,
    );

    expect(result).toEqual({ model: 'google/gemini-3.5-flash' });
  });

  it('drops any effort for a model the catalog lists without reasoning', async () => {
    const { deps } = makeDeps();

    const result = await withSupportedEffort(options('low', 'meta/no-reasoning'), endpoint(), deps);

    expect(result).toEqual({ model: 'meta/no-reasoning' });
  });

  it('keeps the effort while the catalog cannot be read', async () => {
    const { deps } = makeDeps(async () => {
      throw new Error('upstream down');
    });
    const stored = options('max');

    await expect(withSupportedEffort(stored, endpoint(), deps)).resolves.toBe(stored);
  });

  it('keeps an effort the administrator defined for the endpoint', async () => {
    const { deps } = makeDeps();
    const stored = options('max');

    const result = await withSupportedEffort(
      stored,
      endpoint({ customParams: { paramDefinitions: [{ key: 'reasoning_effort' }] } }),
      deps,
    );

    expect(result).toBe(stored);
  });

  it('does not fetch when no effort is stored', async () => {
    const { deps, fetchSpy } = makeDeps();

    await withSupportedEffort(options(), endpoint(), deps);
    await withSupportedEffort(options(''), endpoint(), deps);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not fetch for an endpoint that is not on OpenRouter', async () => {
    const { deps, fetchSpy } = makeDeps();
    const stored = options('max');

    const result = await withSupportedEffort(
      stored,
      endpoint({ baseURL: 'https://api.openai.com/v1' }),
      deps,
    );

    expect(result).toBe(stored);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
