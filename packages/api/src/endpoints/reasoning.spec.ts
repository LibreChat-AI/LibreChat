import { getModelReasoning } from 'librechat-data-provider';
import type { TEndpoint } from 'librechat-data-provider';
import type { ReasoningCapabilityDeps } from '~/types';
import { loadReasoningCapabilities, withSupportedEffort, catalogRequestHeaders } from './reasoning';

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
    { id: 'openrouter/auto' },
    { id: 'openrouter/free' },
    { id: 'meta/empty-efforts', reasoning: { supported_efforts: [] } },
    { id: 'meta/malformed', reasoning: 'yes' },
    { id: 'meta/no-efforts', reasoning: { mandatory: true } },
    { id: 'meta/unrestricted', reasoning: { supported_efforts: null, mandatory: false } },
    { id: 'meta/unrestricted-mandatory', reasoning: { supported_efforts: null, mandatory: true } },
  ],
};

const endpoint = (overrides: Record<string, unknown> = {}): TEndpoint =>
  ({
    name: 'OpenRouter',
    baseURL: OPENROUTER,
    apiKey: 'sk-test',
    models: { default: ['seed/model'], fetch: true },
    ...overrides,
  }) as TEndpoint;

function makeDeps(fetchPage?: ReasoningCapabilityDeps['fetchPage']) {
  const store = new Map<string, unknown>();
  const ttls = new Map<string, number | undefined>();
  const fetchSpy = jest.fn(fetchPage ?? (async () => catalog));
  const deps: ReasoningCapabilityDeps = {
    fetchPage: fetchSpy,
    cache: {
      get: async (key) => store.get(key),
      set: async (key, value, ttl) => {
        store.set(key, value);
        ttls.set(key, ttl);
        return true;
      },
    },
  };
  return { deps, fetchSpy, store, ttls };
}

describe('loadReasoningCapabilities', () => {
  it('maps the efforts and mandatory flag of each model that reports reasoning', async () => {
    const { deps } = makeDeps();

    const { capabilities: map } = await loadReasoningCapabilities([endpoint()], deps);

    expect(map.OpenRouter['openai/gpt-6.1-sol']).toEqual({
      efforts: ['high', 'low', 'none'],
      mandatory: false,
    });
    expect(map.OpenRouter['google/gemini-3.5-flash']).toEqual({
      efforts: ['low'],
      mandatory: true,
    });
  });

  it('treats a null supported_efforts as every known effort being accepted', async () => {
    const { deps } = makeDeps();

    const { capabilities } = await loadReasoningCapabilities([endpoint()], deps);

    expect(capabilities.OpenRouter['meta/unrestricted'].efforts).toEqual(
      expect.arrayContaining(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
    );
    expect(capabilities.OpenRouter['meta/unrestricted'].efforts).not.toContain('');
    expect(capabilities.OpenRouter['meta/unrestricted-mandatory'].mandatory).toBe(true);
  });

  it('records a model that exposes no effort selection as listed without reasoning', async () => {
    const { deps } = makeDeps();

    const { capabilities: map } = await loadReasoningCapabilities([endpoint()], deps);

    for (const id of ['meta/no-reasoning', 'meta/empty-efforts', 'meta/no-efforts']) {
      expect(map.OpenRouter[id]).toEqual({ efforts: [] });
    }
  });

  it('leaves a model with a malformed reasoning object unknown', async () => {
    const { deps } = makeDeps();

    const { capabilities: map } = await loadReasoningCapabilities([endpoint()], deps);

    expect(map.OpenRouter).not.toHaveProperty(['meta/malformed']);
  });

  it('leaves the dynamic router models unknown, as their reasoning depends on the route', async () => {
    const { deps } = makeDeps();

    const { capabilities: map } = await loadReasoningCapabilities([endpoint()], deps);

    expect(map.OpenRouter).not.toHaveProperty(['openrouter/auto']);
    expect(map.OpenRouter).not.toHaveProperty(['openrouter/free']);
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

    const noWindow = endpoint({ customParams: { reasoningCatalogFailureTtlMs: 0 } });

    await loadReasoningCapabilities([noWindow], deps);
    await loadReasoningCapabilities([noWindow], deps);

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
    /* Only the failure marker is stored: no partial catalog is ever cached. */
    expect([...store.keys()].every((key) => key.endsWith(':failed'))).toBe(true);
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

  it('keeps the effort for a model the catalog does not list, such as an alias', async () => {
    const { deps } = makeDeps();
    const stored = options('max', '~openai/gpt-latest');

    await expect(withSupportedEffort(stored, endpoint(), deps)).resolves.toBe(stored);
  });

  it('keeps the effort while the catalog cannot be read', async () => {
    const { deps } = makeDeps(async () => {
      throw new Error('upstream down');
    });
    const stored = options('max');

    await expect(withSupportedEffort(stored, endpoint(), deps)).resolves.toBe(stored);
  });

  it('keeps an effort the administrator defined for the endpoint', async () => {
    const { deps, fetchSpy } = makeDeps();
    const stored = options('max');

    const result = await withSupportedEffort(
      stored,
      endpoint({ customParams: { paramDefinitions: [{ key: 'reasoning_effort' }] } }),
      deps,
    );

    expect(result).toBe(stored);
    expect(fetchSpy).not.toHaveBeenCalled();
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

describe('loadReasoningCapabilities: explicit reasoning definitions', () => {
  const explicit = { customParams: { paramDefinitions: [{ key: 'reasoning_effort' }] } };

  it('skips an endpoint whose administrator defined reasoning_effort', async () => {
    const { deps, fetchSpy } = makeDeps();

    const result = await loadReasoningCapabilities([endpoint(explicit)], deps);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ capabilities: {}, unavailable: [] });
  });

  it('does not wait on a catalog outage for such an endpoint', async () => {
    const { deps, fetchSpy } = makeDeps(async () => {
      throw new Error('upstream down');
    });

    const result = await loadReasoningCapabilities([endpoint(explicit)], deps);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.unavailable).toEqual([]);
  });

  it('still reads an endpoint whose paramDefinitions do not define reasoning_effort', async () => {
    const { deps, fetchSpy } = makeDeps();

    await loadReasoningCapabilities(
      [endpoint({ customParams: { paramDefinitions: [{ key: 'promptCache' }] } })],
      deps,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('loadReasoningCapabilities: pinned model', () => {
  it('skips an endpoint that pins its model through addParams', async () => {
    const { deps, fetchSpy } = makeDeps();

    const result = await loadReasoningCapabilities(
      [endpoint({ addParams: { model: 'google/gemini-3.5-flash' } })],
      deps,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ capabilities: {}, unavailable: [] });
  });

  it('still reads an endpoint whose addParams do not pin a model', async () => {
    const { deps, fetchSpy } = makeDeps();

    await loadReasoningCapabilities([endpoint({ addParams: { temperature: 0.2 } })], deps);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('loadReasoningCapabilities: scoped to one endpoint', () => {
  const down = async ({ apiKey }: { apiKey: string }) => {
    if (apiKey === 'sk-bad') {
      throw new Error('rejected');
    }
    return catalog;
  };

  it('reads only the requested endpoint', async () => {
    const { deps, fetchSpy } = makeDeps();

    const result = await loadReasoningCapabilities(
      [endpoint({ name: 'A' }), endpoint({ name: 'B', apiKey: 'sk-b' })],
      deps,
      'B',
    );

    expect(Object.keys(result.capabilities)).toEqual(['B']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('is not affected by another endpoint whose catalog is unavailable', async () => {
    const { deps } = makeDeps(down);

    const result = await loadReasoningCapabilities(
      [endpoint({ name: 'Bad', apiKey: 'sk-bad' }), endpoint({ name: 'Good' })],
      deps,
      'Good',
    );

    expect(result.unavailable).toEqual([]);
    expect(Object.keys(result.capabilities)).toEqual(['Good']);
  });

  it('reports the requested endpoint when its own catalog is unavailable', async () => {
    const { deps } = makeDeps(down);

    const result = await loadReasoningCapabilities(
      [endpoint({ name: 'Bad', apiKey: 'sk-bad' }), endpoint({ name: 'Good' })],
      deps,
      'Bad',
    );

    expect(result.unavailable).toEqual(['Bad']);
  });

  it('returns nothing for a name that matches no endpoint', async () => {
    const { deps, fetchSpy } = makeDeps();

    const result = await loadReasoningCapabilities([endpoint()], deps, 'Missing');

    expect(result).toEqual({ capabilities: {}, unavailable: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
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

    const noWindow = endpoint({ customParams: { reasoningCatalogFailureTtlMs: 0 } });

    await loadReasoningCapabilities([noWindow], deps);
    const second = await loadReasoningCapabilities([noWindow], deps);

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

  it('does not check an endpoint that pins its model through addParams', async () => {
    const { deps, fetchSpy } = makeDeps();
    const stored = { model: sol, reasoning_effort: 'max' };

    const result = await withSupportedEffort(
      stored,
      endpoint({ addParams: { model: 'google/gemini-3.5-flash' } }),
      deps,
    );

    expect(result).toBe(stored);
    expect(fetchSpy).not.toHaveBeenCalled();
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

describe('failed catalog lookups are remembered briefly', () => {
  const down = async () => {
    throw new Error('upstream down');
  };

  it('does not walk a failed catalog again within the failure window', async () => {
    const { deps, fetchSpy } = makeDeps(down);

    await loadReasoningCapabilities([endpoint()], deps);
    const second = await loadReasoningCapabilities([endpoint()], deps);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(second.unavailable).toEqual(['OpenRouter']);
  });

  it('shares the failure with the stored-effort check of the same request', async () => {
    const { deps, fetchSpy } = makeDeps(down);
    const stored = { model: 'openai/gpt-6.1-sol', reasoning_effort: 'max' };

    await loadReasoningCapabilities([endpoint()], deps, 'OpenRouter');
    const result = await withSupportedEffort(stored, endpoint(), deps);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe(stored);
  });

  it('remembers the failure for 30 seconds by default', async () => {
    const { deps, ttls } = makeDeps(down);

    await loadReasoningCapabilities([endpoint()], deps);

    expect([...ttls.values()]).toContain(30000);
  });

  it('remembers it for the window the endpoint configures', async () => {
    const { deps, ttls } = makeDeps(down);

    await loadReasoningCapabilities(
      [endpoint({ customParams: { reasoningCatalogFailureTtlMs: 5000 } })],
      deps,
    );

    expect([...ttls.values()]).toContain(5000);
  });

  it('remembers nothing when the window is 0', async () => {
    const { deps, store } = makeDeps(down);

    await loadReasoningCapabilities(
      [endpoint({ customParams: { reasoningCatalogFailureTtlMs: 0 } })],
      deps,
    );

    expect(store.size).toBe(0);
  });

  it('remembers an unreadable catalog the same way', async () => {
    const { deps, fetchSpy } = makeDeps(async () => ({ error: 'nope' }));

    await loadReasoningCapabilities([endpoint()], deps);
    await loadReasoningCapabilities([endpoint()], deps);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not remember a successful lookup as a failure', async () => {
    const { deps, fetchSpy } = makeDeps();

    await loadReasoningCapabilities([endpoint()], deps);
    const second = await loadReasoningCapabilities([endpoint()], deps);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(second.unavailable).toEqual([]);
  });
});

describe('loadReasoningCapabilities: which endpoints use the catalog', () => {
  it('reads a proxy the administrator marks as OpenRouter, though its host is not OpenRouter', async () => {
    const { deps, fetchSpy } = makeDeps();

    const { capabilities } = await loadReasoningCapabilities(
      [
        endpoint({
          baseURL: 'https://proxy.example.com/v1',
          customParams: { defaultParamsEndpoint: 'openrouter' },
        }),
      ],
      deps,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0].url).toBe('https://proxy.example.com/v1/models');
    expect(Object.keys(capabilities)).toEqual(['OpenRouter']);
  });

  it('skips an OpenRouter host whose administrator chose another params endpoint', async () => {
    const { deps, fetchSpy } = makeDeps();

    await loadReasoningCapabilities(
      [endpoint({ customParams: { defaultParamsEndpoint: 'openAI' } })],
      deps,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips an endpoint that disables reasoning', async () => {
    const { deps, fetchSpy } = makeDeps();

    await loadReasoningCapabilities(
      [endpoint({ customParams: { reasoningFormat: 'disabled' } })],
      deps,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('catalog URL', () => {
  it('puts /models on the path of a base URL that carries a query string', async () => {
    const { deps, fetchSpy } = makeDeps();

    await loadReasoningCapabilities(
      [endpoint({ baseURL: 'https://openrouter.ai/api/v1?signature=abc' })],
      deps,
    );

    expect(fetchSpy.mock.calls[0][0].url).toBe('https://openrouter.ai/api/v1/models?signature=abc');
  });

  it('handles a trailing slash', async () => {
    const { deps, fetchSpy } = makeDeps();

    await loadReasoningCapabilities([endpoint({ baseURL: `${OPENROUTER}/` })], deps);

    expect(fetchSpy.mock.calls[0][0].url).toBe(`${OPENROUTER}/models`);
  });
});

describe('successful catalog lifetime', () => {
  it('keeps a read catalog for an hour by default', async () => {
    const { deps, ttls } = makeDeps();

    await loadReasoningCapabilities([endpoint()], deps);

    expect([...ttls.values()]).toContain(3600000);
  });

  it('keeps it for the lifetime the endpoint configures', async () => {
    const { deps, ttls } = makeDeps();

    await loadReasoningCapabilities(
      [endpoint({ customParams: { reasoningCatalogTtlMs: 120000 } })],
      deps,
    );

    expect([...ttls.values()]).toContain(120000);
  });

  it('does not let one lifetime policy serve an endpoint with another', async () => {
    const { deps, fetchSpy } = makeDeps();

    await loadReasoningCapabilities(
      [
        endpoint({ name: 'Short', customParams: { reasoningCatalogTtlMs: 120000 } }),
        endpoint({ name: 'Long', customParams: { reasoningCatalogTtlMs: 7200000 } }),
      ],
      deps,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('catalog request headers', () => {
  /** A static model list: the headers do not shape what users are offered, so the catalog is read
   *  and only the per-user headers are withheld. With `models.fetch` they would be skipped instead. */
  const headersSent = async (headers: Record<string, string>) => {
    const { deps, fetchSpy } = makeDeps();
    await loadReasoningCapabilities(
      [endpoint({ headers, models: { default: ['seed/model'] } })],
      deps,
    );
    return fetchSpy.mock.calls[0][0].headers;
  };

  afterEach(() => {
    delete process.env.PROBE_PROXY_TOKEN;
  });

  it('forwards a static configured header', async () => {
    expect(await headersSent({ 'X-Proxy-Tenant': 'acme' })).toEqual({ 'X-Proxy-Tenant': 'acme' });
  });

  it('resolves an environment variable in a header value', async () => {
    process.env.PROBE_PROXY_TOKEN = 'env-secret';

    expect(await headersSent({ 'X-Proxy-Token': '${PROBE_PROXY_TOKEN}' })).toEqual({
      'X-Proxy-Token': 'env-secret',
    });
  });

  it('never forwards a header that resolves per user, as the catalog is shared by every user', async () => {
    const sent = await headersSent({
      'X-User': '{{LIBRECHAT_USER_EMAIL}}',
      Authorization: 'Bearer {{LIBRECHAT_OPENID_ID_TOKEN}}',
      'X-Static': 'kept',
    });

    expect(sent).toEqual({ 'X-Static': 'kept' });
  });

  it('drops a header that mixes text with a per-user placeholder instead of sending the remainder', async () => {
    const sent = await headersSent({ 'X-Mixed': 'prefix-{{LIBRECHAT_USER_ID}}-suffix' });

    expect(sent).toEqual({});
  });

  it('drops a header whose environment variable is not set', async () => {
    expect(await headersSent({ 'X-Proxy-Token': '${PROBE_PROXY_TOKEN}' })).toEqual({});
  });

  it('keeps endpoints with different headers apart', async () => {
    const { deps, fetchSpy } = makeDeps();

    await loadReasoningCapabilities(
      [
        endpoint({ name: 'A', headers: { 'X-Tenant': 'a' } }),
        endpoint({ name: 'B', headers: { 'X-Tenant': 'b' } }),
      ],
      deps,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('shares a lookup between endpoints with the same headers', async () => {
    const { deps, fetchSpy } = makeDeps();

    await loadReasoningCapabilities(
      [
        endpoint({ name: 'A', headers: { 'X-Tenant': 'a' } }),
        endpoint({ name: 'B', headers: { 'X-Tenant': 'a' } }),
      ],
      deps,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('adds the API key as a Bearer token unless a configured Authorization header is present', () => {
    expect(catalogRequestHeaders('sk-key', { 'X-A': '1' })).toEqual({
      'X-A': '1',
      Authorization: 'Bearer sk-key',
    });
    expect(catalogRequestHeaders('sk-key', { authorization: 'Token proxy' })).toEqual({
      authorization: 'Token proxy',
    });
  });
});

describe('relative pagination links', () => {
  const page = (id: string, next: string | null) => ({
    data: [{ id, reasoning: { supported_efforts: ['low'] } }],
    links: { next },
  });
  const walk = async (next: string) => {
    const { deps, fetchSpy } = makeDeps(async ({ url }) =>
      url.includes('offset=') ? page('b/second', null) : page('a/first', next),
    );
    const result = await loadReasoningCapabilities([endpoint()], deps);
    return { result, urls: fetchSpy.mock.calls.map(([params]) => params.url) };
  };

  it('resolves a query-relative link against the current page', async () => {
    const { result, urls } = await walk('?offset=1');

    expect(urls[1]).toBe(`${OPENROUTER}/models?offset=1`);
    expect(Object.keys(result.capabilities.OpenRouter)).toEqual(['a/first', 'b/second']);
  });

  it('resolves a path-relative link against the current page', async () => {
    const { urls } = await walk('models?offset=1');

    expect(urls[1]).toBe(`${OPENROUTER}/models?offset=1`);
  });

  it('still follows a root-relative link and an absolute same-host link', async () => {
    expect((await walk('/api/v1/models?offset=1')).urls[1]).toBe(`${OPENROUTER}/models?offset=1`);
    expect((await walk(`${OPENROUTER}/models?offset=1`)).urls[1]).toBe(
      `${OPENROUTER}/models?offset=1`,
    );
  });
});

describe('models an endpoint exposes', () => {
  const load = async (models: Record<string, unknown>) => {
    const { deps } = makeDeps();
    const { capabilities } = await loadReasoningCapabilities([endpoint({ models })], deps);
    return Object.keys(capabilities.OpenRouter ?? {}).sort();
  };

  it('returns every catalog model when the endpoint fetches its model list', async () => {
    const ids = await load({ default: ['openai/gpt-6.1-sol'], fetch: true });

    expect(ids).toEqual(
      expect.arrayContaining([
        'openai/gpt-6.1-sol',
        'google/gemini-3.5-flash',
        'meta/unrestricted',
      ]),
    );
  });

  it('returns only the configured models when the endpoint does not fetch', async () => {
    expect(await load({ default: ['openai/gpt-6.1-sol'] })).toEqual(['openai/gpt-6.1-sol']);
    expect(await load({ default: ['openai/gpt-6.1-sol'], fetch: false })).toEqual([
      'openai/gpt-6.1-sol',
    ]);
  });

  it('accepts configured models given as objects with a name', async () => {
    expect(
      await load({ default: [{ name: 'google/gemini-3.5-flash', description: 'fast' }] }),
    ).toEqual(['google/gemini-3.5-flash']);
  });

  it('matches a configured routing variant to its base model', async () => {
    expect(await load({ default: ['openai/gpt-6.1-sol:nitro'] })).toEqual(['openai/gpt-6.1-sol']);
  });

  it('returns nothing for a configured model the catalog does not list', async () => {
    expect(await load({ default: ['meta/not-in-catalog'] })).toEqual([]);
  });

  it('returns nothing when the endpoint configures no models and does not fetch', async () => {
    expect(await load({ default: [] })).toEqual([]);
  });

  it('still reads the full catalog once and filters per endpoint', async () => {
    const { deps, fetchSpy } = makeDeps();

    const { capabilities } = await loadReasoningCapabilities(
      [
        endpoint({ name: 'Open', models: { default: ['openai/gpt-6.1-sol'] } }),
        endpoint({ name: 'Wide', models: { default: ['seed/model'], fetch: true } }),
      ],
      deps,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(Object.keys(capabilities.Open)).toEqual(['openai/gpt-6.1-sol']);
    expect(Object.keys(capabilities.Wide).length).toBeGreaterThan(1);
  });

  it('does not let the filter hide a model from the stored-effort check', async () => {
    const { deps } = makeDeps();

    const result = await withSupportedEffort(
      { model: 'google/gemini-3.5-flash', reasoning_effort: 'max' },
      endpoint({ models: { default: ['openai/gpt-6.1-sol'] } }),
      deps,
    );

    expect(result).toEqual({ model: 'google/gemini-3.5-flash' });
  });
});

describe('when the catalog entry expires', () => {
  it('reports the moment a freshly read catalog expires', async () => {
    const { deps } = makeDeps();
    const before = Date.now();

    const { expiresAt } = await loadReasoningCapabilities([endpoint()], deps);

    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3600000);
  });

  it('keeps the original moment when the entry is served from the cache', async () => {
    const { deps } = makeDeps();
    const first = await loadReasoningCapabilities([endpoint()], deps);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await loadReasoningCapabilities([endpoint()], deps);

    expect(second.expiresAt).toBe(first.expiresAt);
  });

  it('follows the configured lifetime', async () => {
    const { deps } = makeDeps();
    const before = Date.now();

    const { expiresAt } = await loadReasoningCapabilities(
      [endpoint({ customParams: { reasoningCatalogTtlMs: 120000 } })],
      deps,
    );

    expect(expiresAt).toBeGreaterThanOrEqual(before + 120000);
    expect(expiresAt).toBeLessThan(before + 3600000);
  });

  it('reports the earliest expiry across endpoints', async () => {
    const { deps } = makeDeps();
    const before = Date.now();

    const { expiresAt } = await loadReasoningCapabilities(
      [
        endpoint({ name: 'Short', customParams: { reasoningCatalogTtlMs: 120000 } }),
        endpoint({ name: 'Long', customParams: { reasoningCatalogTtlMs: 7200000 } }),
      ],
      deps,
    );

    expect(expiresAt).toBeLessThan(before + 3600000);
  });

  it('has no expiry when no endpoint was read', async () => {
    const { deps } = makeDeps(async () => {
      throw new Error('down');
    });

    const { expiresAt } = await loadReasoningCapabilities([endpoint()], deps);

    expect(expiresAt).toBeUndefined();
  });
});

describe('malformed pagination metadata', () => {
  const withLinks = (links: unknown) => ({
    data: [{ id: 'a/first', reasoning: { supported_efforts: ['low'] } }],
    links,
  });

  it.each([
    ['a numeric next', { next: 2 }],
    ['an object next', { next: { page: 2 } }],
    ['a boolean next', { next: true }],
    ['links that are not an object', 'next'],
  ])('reports the endpoint unavailable for %s', async (_label, links) => {
    const { deps, store } = makeDeps(async () => withLinks(links));

    const result = await loadReasoningCapabilities([endpoint()], deps);

    expect(result).toEqual({ capabilities: {}, unavailable: ['OpenRouter'] });
    expect([...store.keys()].every((key) => key.endsWith(':failed'))).toBe(true);
  });

  it.each([
    ['no links at all', undefined],
    ['links without next', {}],
    ['a null next', { next: null }],
    ['an empty next', { next: '' }],
  ])('accepts %s as the end of the catalog', async (_label, links) => {
    const { deps } = makeDeps(async () => withLinks(links));

    const result = await loadReasoningCapabilities([endpoint()], deps);

    expect(result.unavailable).toEqual([]);
    expect(result.capabilities.OpenRouter).toHaveProperty(['a/first']);
  });
});

describe('catalogs whose model list is scoped to the requesting user', () => {
  it('skips an endpoint that filters its fetched models by user id', async () => {
    const { deps, fetchSpy } = makeDeps();

    const result = await loadReasoningCapabilities(
      [endpoint({ models: { fetch: true, userIdQuery: true, default: ['a/b'] } })],
      deps,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ capabilities: {}, unavailable: [] });
  });

  it('skips an endpoint whose configured headers resolve per request', async () => {
    const { deps, fetchSpy } = makeDeps();

    const result = await loadReasoningCapabilities(
      [
        endpoint({
          models: { fetch: true, default: ['a/b'] },
          headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ID_TOKEN}}' },
        }),
      ],
      deps,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.unavailable).toEqual([]);
  });

  it('reads an endpoint whose only per-request header is request metadata, as in the documented example', async () => {
    const { deps, fetchSpy } = makeDeps();

    await loadReasoningCapabilities(
      [
        endpoint({
          models: { fetch: true, default: ['a/b'] },
          headers: { 'x-librechat-body-parentmessageid': '{{LIBRECHAT_BODY_PARENTMESSAGEID}}' },
        }),
      ],
      deps,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0].headers).toEqual({});
  });

  it.each([
    '{{LIBRECHAT_USER_EMAIL}}',
    'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
    '{{LIBRECHAT_GRAPH_ACCESS_TOKEN}}',
  ])('skips an endpoint with the identity-dependent header value %s', async (value) => {
    const { deps, fetchSpy } = makeDeps();

    await loadReasoningCapabilities(
      [endpoint({ models: { fetch: true, default: ['a/b'] }, headers: { 'X-Id': value } })],
      deps,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('checks a stored effort on the documented example configuration', async () => {
    const { deps, fetchSpy } = makeDeps();
    const stored = { model: 'openai/gpt-6.1-sol', reasoning_effort: 'max' };

    const result = await withSupportedEffort(
      stored,
      endpoint({
        models: { fetch: true, default: ['a/b'] },
        headers: { 'x-librechat-body-parentmessageid': '{{LIBRECHAT_BODY_PARENTMESSAGEID}}' },
      }),
      deps,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ model: 'openai/gpt-6.1-sol' });
  });

  it('still reads an endpoint that fetches models for everyone alike', async () => {
    const { deps, fetchSpy } = makeDeps();

    await loadReasoningCapabilities(
      [endpoint({ models: { fetch: true, default: ['a/b'] } })],
      deps,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not check a stored effort on a user-scoped endpoint', async () => {
    const { deps, fetchSpy } = makeDeps();
    const stored = { model: 'openai/gpt-6.1-sol', reasoning_effort: 'max' };

    const result = await withSupportedEffort(
      stored,
      endpoint({ models: { fetch: true, userIdQuery: true, default: ['a/b'] } }),
      deps,
    );

    expect(result).toBe(stored);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('model ids that name Object.prototype members', () => {
  const protoCatalog = {
    data: [
      { id: 'constructor', reasoning: { supported_efforts: ['low'] } },
      { id: '__proto__', reasoning: { supported_efforts: ['high'] } },
      { id: 'a/b', reasoning: { supported_efforts: ['low'] } },
    ],
  };

  it('records them as own entries, so none is lost to the prototype setter', async () => {
    const { deps } = makeDeps(async () => protoCatalog);

    const { capabilities: map } = await loadReasoningCapabilities([endpoint()], deps);

    expect(Object.keys(map.OpenRouter).sort()).toEqual(['__proto__', 'a/b', 'constructor']);
    expect(({} as Record<string, unknown>).efforts).toBeUndefined();
  });

  it('serves them through the JSON response and finds them on the client', async () => {
    const { deps } = makeDeps(async () => protoCatalog);
    const { capabilities: map } = await loadReasoningCapabilities([endpoint()], deps);

    const received = JSON.parse(JSON.stringify(map));

    expect(getModelReasoning(received, 'OpenRouter', '__proto__')).toEqual({
      efforts: ['high'],
      mandatory: false,
    });
    expect(getModelReasoning(received, 'OpenRouter', 'constructor')).toEqual({
      efforts: ['low'],
      mandatory: false,
    });
  });

  it('keeps an endpoint named __proto__ as an own entry', async () => {
    const { deps } = makeDeps();

    const { capabilities: map } = await loadReasoningCapabilities(
      [endpoint({ name: '__proto__' })],
      deps,
    );

    expect(Object.keys(map)).toEqual(['__proto__']);
  });

  it('does not throw when a stored effort sits on such an unlisted model', async () => {
    const { deps } = makeDeps();
    const stored = { model: 'toString', reasoning_effort: 'max' };

    await expect(withSupportedEffort(stored, endpoint(), deps)).resolves.toBe(stored);
  });
});
