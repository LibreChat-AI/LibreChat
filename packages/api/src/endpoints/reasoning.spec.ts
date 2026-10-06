import type { TEndpoint } from 'librechat-data-provider';
import type { ReasoningCapabilityDeps } from './reasoning';
import { loadReasoningCapabilities, withSupportedEffort } from './reasoning';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

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

    const { capabilities: map } = await loadReasoningCapabilities([endpoint()], deps);

    expect(map.OpenRouter).toEqual({
      'openai/gpt-6.1-sol': { efforts: ['high', 'low', 'none'], mandatory: false },
      'google/gemini-3.5-flash': { efforts: ['low'], mandatory: true },
    });
  });

  it('omits models that report no usable reasoning', async () => {
    const { deps } = makeDeps();

    const { capabilities: map } = await loadReasoningCapabilities([endpoint()], deps);

    expect(Object.keys(map.OpenRouter)).not.toEqual(
      expect.arrayContaining(['meta/no-reasoning', 'meta/empty-efforts', 'meta/malformed']),
    );
  });

  it('keys the result by the normalized endpoint name', async () => {
    const { deps } = makeDeps();

    const { capabilities: map } = await loadReasoningCapabilities(
      [endpoint({ name: 'Open Router' })],
      deps,
    );

    expect(Object.keys(map)).toEqual(['Open Router']);
  });

  it('does not fetch for hosts other than OpenRouter', async () => {
    const { deps, fetchSpy } = makeDeps();

    const { capabilities: map } = await loadReasoningCapabilities(
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

    const { capabilities: map } = await loadReasoningCapabilities(
      [endpoint({ baseURL: 'user_provided' })],
      deps,
    );

    expect(map).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches once for endpoints that share a base URL', async () => {
    const { deps, fetchSpy } = makeDeps();

    const { capabilities: map } = await loadReasoningCapabilities(
      [endpoint({ name: 'OpenRouter' }), endpoint({ name: 'OpenRouter Staging' })],
      deps,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(Object.keys(map)).toEqual(['OpenRouter', 'OpenRouter Staging']);
  });

  it('serves a later call from the cache', async () => {
    const { deps, fetchSpy } = makeDeps();

    await loadReasoningCapabilities([endpoint()], deps);
    const { capabilities: map } = await loadReasoningCapabilities([endpoint()], deps);

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

    await expect(loadReasoningCapabilities([endpoint()], deps)).resolves.toMatchObject({
      capabilities: {},
    });
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

    await expect(loadReasoningCapabilities([endpoint()], deps)).resolves.toMatchObject({
      capabilities: {},
    });
  });

  it('returns an empty map without custom endpoints', async () => {
    const { deps } = makeDeps();

    await expect(loadReasoningCapabilities(undefined, deps)).resolves.toMatchObject({
      capabilities: {},
    });
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

    const { capabilities: map } = await loadReasoningCapabilities([endpoint()], deps);

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

    await expect(loadReasoningCapabilities([endpoint()], deps)).resolves.toMatchObject({
      capabilities: {},
    });
    expect(store.size).toBe(0);
  });

  it('refuses a next link that leaves the provider host', async () => {
    const { deps, fetchSpy } = makeDeps(async () =>
      page('a/first', 'https://attacker.example.com/api/v1/models?offset=1'),
    );

    await expect(loadReasoningCapabilities([endpoint()], deps)).resolves.toMatchObject({
      capabilities: {},
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses a next link that loops back to a page already read', async () => {
    const { deps, fetchSpy } = makeDeps(async () => page('a/first', '/api/v1/models'));

    await expect(loadReasoningCapabilities([endpoint()], deps)).resolves.toMatchObject({
      capabilities: {},
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('gives up on a catalog with more pages than the limit', async () => {
    let offset = 0;
    const { deps, fetchSpy } = makeDeps(async () => {
      offset += 1;
      return page(`m/${offset}`, `/api/v1/models?offset=${offset}`);
    });

    await expect(loadReasoningCapabilities([endpoint()], deps)).resolves.toMatchObject({
      capabilities: {},
    });
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

describe('loadReasoningCapabilities: availability', () => {
  const down = async () => {
    throw new Error('upstream down');
  };

  it('reports an endpoint whose catalog cannot be read as unavailable', async () => {
    const { deps } = makeDeps(down);

    const result = await loadReasoningCapabilities([endpoint()], deps);

    expect(result).toEqual({ capabilities: {}, unavailable: ['OpenRouter'] });
  });

  it('reports every endpoint that shares a failed catalog', async () => {
    const { deps } = makeDeps(down);

    const result = await loadReasoningCapabilities(
      [endpoint({ name: 'OpenRouter' }), endpoint({ name: 'OpenRouter Staging' })],
      deps,
    );

    expect(result.unavailable).toEqual(['OpenRouter', 'OpenRouter Staging']);
  });

  it('reports nothing unavailable when every catalog was read', async () => {
    const { deps } = makeDeps();

    const result = await loadReasoningCapabilities([endpoint()], deps);

    expect(result.unavailable).toEqual([]);
  });

  it('does not report an endpoint that was never eligible as unavailable', async () => {
    const { deps } = makeDeps(down);

    const result = await loadReasoningCapabilities(
      [endpoint({ baseURL: 'user_provided' }), endpoint({ name: 'Local', baseURL: 'http://x/v1' })],
      deps,
    );

    expect(result).toEqual({ capabilities: {}, unavailable: [] });
  });

  it('keeps a readable catalog when another endpoint fails', async () => {
    const { deps } = makeDeps(async ({ apiKey }) => {
      if (apiKey === 'sk-bad') {
        throw new Error('rejected');
      }
      return catalog;
    });

    const result = await loadReasoningCapabilities(
      [endpoint({ name: 'Good' }), endpoint({ name: 'Bad', apiKey: 'sk-bad' })],
      deps,
    );

    expect(Object.keys(result.capabilities)).toEqual(['Good']);
    expect(result.unavailable).toEqual(['Bad']);
  });
});

describe('loadReasoningCapabilities: direct endpoints', () => {
  it('skips catalog discovery because the base URL is the exact inference URL', async () => {
    const { deps, fetchSpy } = makeDeps();

    const result = await loadReasoningCapabilities(
      [endpoint({ baseURL: `${OPENROUTER}/chat/completions`, directEndpoint: true })],
      deps,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ capabilities: {}, unavailable: [] });
  });
});

describe('loadReasoningCapabilities: page limit', () => {
  const endless = () => {
    let offset = 0;
    return async () => {
      offset += 1;
      return {
        data: [{ id: `m/${offset}`, reasoning: { supported_efforts: ['low'] } }],
        links: { next: `/api/v1/models?offset=${offset}` },
      };
    };
  };

  it('stops at the page limit the endpoint configures', async () => {
    const { deps, fetchSpy } = makeDeps(endless());

    await loadReasoningCapabilities(
      [endpoint({ customParams: { reasoningCatalogMaxPages: 3 } })],
      deps,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('reads a catalog longer than the default when the endpoint raises the limit', async () => {
    const pages = 25;
    let offset = 0;
    const { deps } = makeDeps(async () => {
      offset += 1;
      return {
        data: [{ id: `m/${offset}`, reasoning: { supported_efforts: ['low'] } }],
        links: { next: offset < pages ? `/api/v1/models?offset=${offset}` : null },
      };
    });

    const { capabilities } = await loadReasoningCapabilities(
      [endpoint({ customParams: { reasoningCatalogMaxPages: 30 } })],
      deps,
    );

    expect(Object.keys(capabilities.OpenRouter)).toHaveLength(pages);
  });
});

describe('catalog lookups are shared across callers', () => {
  it('walks the catalog once for concurrent loads', async () => {
    const { deps, fetchSpy } = makeDeps(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return catalog;
    });

    await Promise.all([
      loadReasoningCapabilities([endpoint()], deps),
      loadReasoningCapabilities([endpoint()], deps),
      loadReasoningCapabilities([endpoint()], deps),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('shares the lookup between a load and a stored-effort check', async () => {
    const { deps, fetchSpy } = makeDeps(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return catalog;
    });

    await Promise.all([
      loadReasoningCapabilities([endpoint()], deps),
      withSupportedEffort(
        { model: 'openai/gpt-6.1-sol', reasoning_effort: 'low' },
        endpoint(),
        deps,
      ),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries after a lookup that failed', async () => {
    let calls = 0;
    const { deps, fetchSpy } = makeDeps(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('first attempt fails');
      }
      return catalog;
    });

    await loadReasoningCapabilities([endpoint()], deps);
    const second = await loadReasoningCapabilities([endpoint()], deps);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(second.unavailable).toEqual([]);
  });
});

describe('lookup identity includes the configured policy', () => {
  const pages = (count: number) => {
    let read = 0;
    return async () => {
      read += 1;
      return {
        data: [{ id: `m/${read}`, reasoning: { supported_efforts: ['low'] } }],
        links: { next: read < count ? `/api/v1/models?offset=${read}` : null },
      };
    };
  };

  it('does not let a one-page endpoint decide the result of a five-page endpoint', async () => {
    const { deps } = makeDeps(pages(3));

    const result = await loadReasoningCapabilities(
      [
        endpoint({ name: 'Short', customParams: { reasoningCatalogMaxPages: 1 } }),
        endpoint({ name: 'Long', customParams: { reasoningCatalogMaxPages: 5 } }),
      ],
      deps,
    );

    expect(result.unavailable).toEqual(['Short']);
    expect(Object.keys(result.capabilities)).toEqual(['Long']);
  });

  it('still shares one walk between endpoints with the same policy', async () => {
    const { deps, fetchSpy } = makeDeps();

    await loadReasoningCapabilities(
      [
        endpoint({ name: 'A', customParams: { reasoningCatalogMaxPages: 5 } }),
        endpoint({ name: 'B', customParams: { reasoningCatalogMaxPages: 5 } }),
      ],
      deps,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('failure logging', () => {
  it('logs the origin of a failed catalog and never the configured URL or credentials', async () => {
    const { logger } = jest.requireMock('@librechat/data-schemas');
    const { deps } = makeDeps(async () => {
      throw new Error('upstream down');
    });

    await loadReasoningCapabilities(
      [endpoint({ baseURL: 'https://user:s3cret@openrouter.ai/api/v1?key=abc123' })],
      deps,
    );

    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('https://openrouter.ai');
    expect(logged).not.toContain('s3cret');
    expect(logged).not.toContain('abc123');
    expect(logged).not.toContain('user:');
  });
});

describe('withSupportedEffort: addParams', () => {
  const sol = 'openai/gpt-6.1-sol';

  it('checks the model an addParams override sends the request to', async () => {
    const { deps } = makeDeps();

    const result = await withSupportedEffort(
      { model: sol, reasoning_effort: 'high' },
      endpoint({ addParams: { model: 'google/gemini-3.5-flash' } }),
      deps,
    );

    expect(result).toEqual({ model: sol });
  });

  it('leaves an effort alone when addParams replaces it', async () => {
    const { deps, fetchSpy } = makeDeps();
    const stored = { model: sol, reasoning_effort: 'max' };

    const result = await withSupportedEffort(
      stored,
      endpoint({ addParams: { reasoning_effort: 'low' } }),
      deps,
    );

    expect(result).toBe(stored);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
