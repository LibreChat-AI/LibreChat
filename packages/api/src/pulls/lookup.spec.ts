import type { TConversationPullRequest } from 'librechat-data-provider';
import type { PullRequestSource, PullRequestLookupStore, PullRequestSharedValue } from './types';
import { createPullRequestLookup } from './lookup';
import { PullRequestSourceError } from './types';

const value: TConversationPullRequest = {
  number: 1,
  title: 't',
  url: 'https://github.com/o/r/pull/1',
  additions: 1,
  deletions: 0,
  state: 'open',
  isDraft: false,
  mergeable: 'clean',
  checks: 'passing',
};
const input = { repo: 'o/r', branch: 'main', token: 't', ttlMs: 30_000 };

describe('createPullRequestLookup', () => {
  it('reuses a result within its lifetime and asks again after it', async () => {
    let clock = 0;
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find }, now: () => clock });
    await expect(lookup(input)).resolves.toEqual({ ok: true, value });
    clock = 29_999;
    await lookup(input);
    expect(find).toHaveBeenCalledTimes(1);
    clock = 30_001;
    await lookup(input);
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('caches a documented absence', async () => {
    const find = jest.fn().mockResolvedValue(null);
    const lookup = createPullRequestLookup({ source: { find } });
    await expect(lookup(input)).resolves.toEqual({ ok: true, value: null });
    await lookup(input);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('shares one request between concurrent callers', async () => {
    let release: (pr: TConversationPullRequest) => void = () => undefined;
    const find = jest.fn(
      () =>
        new Promise<TConversationPullRequest>((resolve) => {
          release = resolve;
        }),
    );
    const lookup = createPullRequestLookup({ source: { find } });
    const first = lookup(input);
    const second = lookup(input);
    release(value);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, value },
      { ok: true, value },
    ]);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('keys by repository and branch', async () => {
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find } });
    await lookup(input);
    await lookup({ ...input, branch: 'other' });
    await lookup({ ...input, repo: 'o/other' });
    expect(find).toHaveBeenCalledTimes(3);
  });

  it('keys by host, so one GitHub never answers for another', async () => {
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find } });
    await lookup(input);
    await lookup({ ...input, host: 'ghe.example.com' });
    await lookup({ ...input, host: 'ghe.example.com' });
    expect(find).toHaveBeenCalledTimes(2);
    expect(find).toHaveBeenLastCalledWith(expect.objectContaining({ host: 'ghe.example.com' }));
  });

  it('keys by the linked pull request and hands it to the source', async () => {
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find } });
    await lookup(input);
    await lookup({ ...input, pullRequest: 1 });
    await lookup({ ...input, pullRequest: 1 });
    expect(find).toHaveBeenCalledTimes(2);
    expect(find).toHaveBeenLastCalledWith(expect.objectContaining({ pullRequest: 1 }));
  });

  it('returns a failure as a coded result and retries it sooner than a success', async () => {
    let clock = 0;
    const find = jest
      .fn()
      .mockRejectedValueOnce(new PullRequestSourceError('RATE_LIMITED'))
      .mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find }, now: () => clock });
    await expect(lookup(input)).resolves.toEqual({
      ok: false,
      error: { code: 'RATE_LIMITED' },
    });
    clock = 5_000;
    await expect(lookup(input)).resolves.toMatchObject({ ok: false });
    expect(find).toHaveBeenCalledTimes(1);
    clock = 10_001;
    await expect(lookup(input)).resolves.toEqual({ ok: true, value });
  });

  it('turns an unexpected exception into UPSTREAM_ERROR without its text', async () => {
    const source: PullRequestSource = {
      find: jest.fn().mockRejectedValue(new Error('mongodb://user:secret@host')),
    };
    const result = await createPullRequestLookup({ source })(input);
    expect(result).toEqual({ ok: false, error: { code: 'UPSTREAM_ERROR' } });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('evicts the oldest entry past its bound', async () => {
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find }, maxEntries: 2 });
    await lookup({ ...input, branch: 'a' });
    await lookup({ ...input, branch: 'b' });
    await lookup({ ...input, branch: 'c' });
    await lookup({ ...input, branch: 'a' });
    expect(find).toHaveBeenCalledTimes(4);
  });
});

describe('credential scoping', () => {
  it('never serves a result fetched with one credential to another', async () => {
    const find = jest.fn(async ({ token }: { token: string }) =>
      token === 'tenant-a' ? value : null,
    );
    const lookup = createPullRequestLookup({ source: { find } });
    await expect(lookup({ ...input, token: 'tenant-a' })).resolves.toEqual({ ok: true, value });
    await expect(lookup({ ...input, token: 'tenant-b' })).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('still reuses a result for the same credential', async () => {
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find } });
    await lookup({ ...input, token: 'tenant-a' });
    await lookup({ ...input, token: 'tenant-a' });
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('does not share an in-flight request between credentials', async () => {
    const releases: Array<() => void> = [];
    const find = jest.fn(
      ({ token }: { token: string }) =>
        new Promise<TConversationPullRequest | null>((resolve) => {
          releases.push(() => resolve(token === 'a' ? value : null));
        }),
    );
    const lookup = createPullRequestLookup({ source: { find } });
    const a = lookup({ ...input, token: 'a' });
    const b = lookup({ ...input, token: 'b' });
    expect(find).toHaveBeenCalledTimes(2);
    releases.forEach((release) => release());
    await expect(a).resolves.toEqual({ ok: true, value });
    await expect(b).resolves.toEqual({ ok: true, value: null });
  });
});

describe('rate limit cooldown', () => {
  const limited = (retryAfterMs?: number) =>
    new PullRequestSourceError('RATE_LIMITED', retryAfterMs);
  const rateLimited = { ok: false, error: { code: 'RATE_LIMITED' } };

  it('stops asking GitHub for every branch of the credential until the retry time', async () => {
    let clock = 0;
    const find = jest.fn().mockRejectedValueOnce(limited(60_000)).mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find }, now: () => clock });
    await expect(lookup(input)).resolves.toEqual(rateLimited);
    clock = 30_000;
    await expect(lookup({ ...input, branch: 'other' })).resolves.toEqual(rateLimited);
    expect(find).toHaveBeenCalledTimes(1);
    clock = 60_001;
    await expect(lookup({ ...input, branch: 'other' })).resolves.toEqual({ ok: true, value });
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('does not block a different credential', async () => {
    const find = jest.fn().mockRejectedValueOnce(limited(60_000)).mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find } });
    await lookup({ ...input, token: 'a' });
    await expect(lookup({ ...input, token: 'b', branch: 'other' })).resolves.toEqual({
      ok: true,
      value,
    });
  });

  it('does not block the same credential on another host', async () => {
    const find = jest.fn().mockRejectedValueOnce(limited(60_000)).mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find } });
    await lookup(input);
    await expect(lookup({ ...input, host: 'ghe.example.com' })).resolves.toEqual({
      ok: true,
      value,
    });
    await expect(lookup({ ...input, provider: 'gitlab' })).resolves.toEqual({ ok: true, value });
    await expect(lookup({ ...input, branch: 'other' })).resolves.toEqual(rateLimited);
  });

  it('waits at least a short floor when GitHub gives no retry time', async () => {
    let clock = 0;
    const find = jest.fn().mockRejectedValueOnce(limited()).mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find }, now: () => clock });
    await lookup(input);
    clock = 9_999;
    await expect(lookup({ ...input, branch: 'other' })).resolves.toEqual(rateLimited);
    clock = 10_001;
    await expect(lookup({ ...input, branch: 'other' })).resolves.toEqual({ ok: true, value });
  });

  it('honors a reset GitHub reports well beyond ten minutes', async () => {
    let clock = 0;
    const find = jest
      .fn()
      .mockRejectedValueOnce(limited(40 * 60_000))
      .mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find }, now: () => clock });
    await lookup(input);
    clock = 39 * 60_000;
    await expect(lookup({ ...input, branch: 'other' })).resolves.toEqual(rateLimited);
    expect(find).toHaveBeenCalledTimes(1);
    clock = 40 * 60_000 + 1;
    await expect(lookup({ ...input, branch: 'other' })).resolves.toEqual({ ok: true, value });
  });

  it('caps a hint past the hour GitHub resets within, so one bad header cannot silence the feature for a day', async () => {
    let clock = 0;
    const find = jest
      .fn()
      .mockRejectedValueOnce(limited(24 * 60 * 60_000))
      .mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find }, now: () => clock });
    await lookup(input);
    clock = 60 * 60_000 - 1;
    await expect(lookup({ ...input, branch: 'other' })).resolves.toEqual(rateLimited);
    clock = 60 * 60_000 + 1;
    await expect(lookup({ ...input, branch: 'other' })).resolves.toEqual({ ok: true, value });
  });

  it('keeps serving a cached result while the credential is cooling down', async () => {
    let clock = 0;
    const find = jest.fn().mockResolvedValueOnce(value).mockRejectedValueOnce(limited(60_000));
    const lookup = createPullRequestLookup({ source: { find }, now: () => clock });
    await lookup(input);
    await lookup({ ...input, branch: 'other' });
    clock = 5_000;
    await expect(lookup(input)).resolves.toEqual({ ok: true, value });
    expect(find).toHaveBeenCalledTimes(2);
  });
});

describe('lookup policy scoping', () => {
  it('does not serve a result read under a tighter page limit to a caller allowing more', async () => {
    const incomplete = { ...value, checks: 'running' as const };
    const find = jest.fn(async ({ limits }: { limits?: { maxCheckRunPages?: number } }) =>
      limits?.maxCheckRunPages === 1 ? incomplete : { ...value, checks: 'failing' as const },
    );
    const lookup = createPullRequestLookup({ source: { find } });
    await expect(lookup({ ...input, limits: { maxCheckRunPages: 1 } })).resolves.toEqual({
      ok: true,
      value: incomplete,
    });
    await expect(lookup({ ...input, limits: { maxCheckRunPages: 50 } })).resolves.toMatchObject({
      value: { checks: 'failing' },
    });
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('honors the shorter freshness of a caller instead of the longer one another set', async () => {
    let clock = 0;
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find }, now: () => clock });
    await lookup({ ...input, ttlMs: 3_600_000 });
    clock = 6_000;
    await lookup({ ...input, ttlMs: 5_000 });
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('does not share an in-flight request between different policies', async () => {
    const find = jest.fn(() => new Promise<null>(() => undefined));
    const lookup = createPullRequestLookup({ source: { find } });
    void lookup({ ...input, limits: { maxCheckRunPages: 1 } });
    void lookup({ ...input, limits: { maxCheckRunPages: 2 } });
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('keys by the recorded head, so a reused branch name does not share a result', async () => {
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find } });
    await lookup({ ...input, head: 'a'.repeat(40) });
    await lookup({ ...input, head: 'b'.repeat(40) });
    await lookup({ ...input, head: 'a'.repeat(40) });
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('treats an unchanged policy as the same entry', async () => {
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find } });
    await lookup({ ...input, limits: { maxCheckRunPages: 3, requestTimeoutMs: 5_000 } });
    await lookup({ ...input, limits: { requestTimeoutMs: 5_000, maxCheckRunPages: 3 } });
    expect(find).toHaveBeenCalledTimes(1);
  });
});

describe('lookup policy scoping of the history search', () => {
  it.each([['maxCandidatePullRequests'], ['maxHeadComparisons']])(
    'does not share a result between callers with different %s',
    async (field) => {
      const find = jest.fn().mockResolvedValue(value);
      const lookup = createPullRequestLookup({ source: { find } });
      await lookup({ ...input, limits: { [field]: 3 } });
      await lookup({ ...input, limits: { [field]: 30 } });
      expect(find).toHaveBeenCalledTimes(2);
    },
  );
});

describe('cache capacity from the caller', () => {
  const branches = ['a', 'b', 'c'];
  const fill = async (
    lookup: ReturnType<typeof createPullRequestLookup>,
    cacheMaxEntries?: number,
  ) => {
    for (const branch of branches) await lookup({ ...input, branch, cacheMaxEntries });
    await lookup({ ...input, branch: 'a', cacheMaxEntries });
  };

  it('evicts fresh entries once the configured capacity is exceeded', async () => {
    const find = jest.fn().mockResolvedValue(value);
    await fill(createPullRequestLookup({ source: { find } }), 2);
    expect(find).toHaveBeenCalledTimes(4);
  });

  it('keeps them while the configured capacity is large enough', async () => {
    const find = jest.fn().mockResolvedValue(value);
    await fill(createPullRequestLookup({ source: { find } }), 10);
    expect(find).toHaveBeenCalledTimes(3);
  });

  it('falls back to its own default capacity when the caller gives none', async () => {
    const find = jest.fn().mockResolvedValue(value);
    await fill(createPullRequestLookup({ source: { find } }));
    expect(find).toHaveBeenCalledTimes(3);
  });

  it('does not treat the capacity as part of the answer, so callers with different ones share an entry', async () => {
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find } });
    await lookup({ ...input, cacheMaxEntries: 5 });
    await lookup({ ...input, cacheMaxEntries: 50 });
    expect(find).toHaveBeenCalledTimes(1);
  });
});

describe('cache capacity per credential', () => {
  it("does not let one credential's small capacity evict another credential's entries", async () => {
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find } });
    await lookup({ ...input, token: 'big', branch: 'keep', cacheMaxEntries: 100 });
    for (const branch of ['a', 'b', 'c', 'd']) {
      await lookup({ ...input, token: 'small', branch, cacheMaxEntries: 2 });
    }
    const before = find.mock.calls.length;
    await lookup({ ...input, token: 'big', branch: 'keep', cacheMaxEntries: 100 });
    expect(find).toHaveBeenCalledTimes(before);
  });

  it('bounds the credentials it keeps, dropping the one idle longest', async () => {
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find } });
    await lookup({ ...input, token: 'first' });
    for (let index = 0; index < 256; index += 1) {
      await lookup({ ...input, token: `other-${index}` });
    }
    const before = find.mock.calls.length;
    await lookup({ ...input, token: 'first' });
    expect(find).toHaveBeenCalledTimes(before + 1);
  });

  it('keeps more credentials when the caller configures a larger bound', async () => {
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find } });
    const call = (token: string) => lookup({ ...input, token, cacheMaxCredentials: 300 });
    await call('first');
    for (let index = 0; index < 256; index += 1) await call(`other-${index}`);
    const before = find.mock.calls.length;
    await call('first');
    expect(find).toHaveBeenCalledTimes(before);
  });

  it('drops credentials past the configured bound', async () => {
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find } });
    const call = (token: string) => lookup({ ...input, token, cacheMaxCredentials: 2 });
    await call('a');
    await call('b');
    await call('c');
    const before = find.mock.calls.length;
    await call('a');
    expect(find).toHaveBeenCalledTimes(before + 1);
  });

  it('does not let a caller with a small bound evict the credentials of one with a large bound', async () => {
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find } });
    for (const token of ['a', 'b', 'c']) {
      await lookup({ ...input, token, cacheMaxCredentials: 100 });
    }
    await lookup({ ...input, token: 'small', cacheMaxCredentials: 1 });
    const before = find.mock.calls.length;
    for (const token of ['a', 'b', 'c']) {
      await lookup({ ...input, token, cacheMaxCredentials: 100 });
    }
    expect(find).toHaveBeenCalledTimes(before);
  });

  it('counts a cache hit as use, so an active credential is not the one dropped', async () => {
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find } });
    const call = (token: string) => lookup({ ...input, token, cacheMaxCredentials: 2 });
    await call('active');
    await call('idle');
    await call('active');
    await call('newcomer');
    const before = find.mock.calls.length;
    await call('active');
    expect(find).toHaveBeenCalledTimes(before);
  });
});

describe('cache capacity shared by principals with one token', () => {
  it('keeps the largest capacity seen, so a smaller one does not trim what a larger keeps', async () => {
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find } });
    for (const branch of ['a', 'b', 'c', 'd']) {
      await lookup({ ...input, branch, cacheMaxEntries: 100 });
    }
    await lookup({ ...input, branch: 'e', cacheMaxEntries: 2 });
    const before = find.mock.calls.length;
    for (const branch of ['a', 'b', 'c', 'd']) {
      await lookup({ ...input, branch, cacheMaxEntries: 2 });
    }
    expect(find).toHaveBeenCalledTimes(before);
  });

  it('does not let a larger capacity of one token raise the bound of another', async () => {
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find } });
    await lookup({ ...input, token: 'big', branch: 'x', cacheMaxEntries: 100 });
    for (const branch of ['a', 'b', 'c']) {
      await lookup({ ...input, token: 'small', branch, cacheMaxEntries: 2 });
    }
    const before = find.mock.calls.length;
    await lookup({ ...input, token: 'small', branch: 'a', cacheMaxEntries: 2 });
    expect(find).toHaveBeenCalledTimes(before + 1);
  });
});

describe('the repositories the credential may be used for', () => {
  it('passes them to the source, and keeps answers for different lists apart', async () => {
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find } });
    await lookup({ ...input, allowedRepositories: ['o/r'] });
    await lookup({ ...input, allowedRepositories: ['o/r', 'fork/*'] });
    expect(find).toHaveBeenCalledTimes(2);
    expect(find.mock.calls[1][0].allowedRepositories).toEqual(['o/r', 'fork/*']);
    await lookup({ ...input, allowedRepositories: ['FORK/*', 'o/r'] });
    expect(find).toHaveBeenCalledTimes(2);
  });
});
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

describe('the shared store', () => {
  const token = 'ghp_secret_token';
  const shared = { ...input, token, sharedCache: true };
  const forever = Number.MAX_SAFE_INTEGER;

  /**
   * A Map with lifetimes, standing in for Redis between replicas, with the store's write rule: a
   * value for the same owner with an order at least as large is kept.
   */
  function createStore(clock: () => number) {
    const values = new Map<string, { value: PullRequestSharedValue; until: number }>();
    const store = {
      get: jest.fn(async (key: string, _timeoutMs: number) => {
        const held = values.get(key);
        return held != null && held.until > clock()
          ? JSON.parse(JSON.stringify(held.value))
          : undefined;
      }),
      put: jest.fn(
        async (key: string, value: PullRequestSharedValue, ttlMs: number, _timeoutMs: number) => {
          const held = values.get(key);
          if (
            held != null &&
            held.until > clock() &&
            held.value.key === value.key &&
            held.value.order >= value.order
          ) {
            return;
          }
          values.set(key, { value, until: clock() + ttlMs });
        },
      ),
    };
    return { store, values };
  }

  /** Background writes settle on the next turns of the event loop. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  /** The owner digest a lookup with `shared` writes, so a planted value differs only as labelled. */
  async function sharedKey(): Promise<string> {
    const { store } = createStore(Date.now);
    await createPullRequestLookup({ source: { find: jest.fn().mockResolvedValue(value) }, store })(
      shared,
    );
    await settle();
    return store.put.mock.calls[0][1].key;
  }

  it("serves one replica's answer to another without asking the provider again", async () => {
    const { store } = createStore(Date.now);
    const first = jest.fn().mockResolvedValue(value);
    const second = jest.fn().mockResolvedValue(value);
    const a = createPullRequestLookup({ source: { find: first }, store });
    const b = createPullRequestLookup({ source: { find: second }, store });
    await expect(a(shared)).resolves.toEqual({ ok: true, value });
    await settle();
    await expect(b(shared)).resolves.toEqual({ ok: true, value });
    expect(second).not.toHaveBeenCalled();
    /** Now in the second replica's own cache, so the store is not asked again. */
    store.get.mockClear();
    await b(shared);
    expect(store.get).not.toHaveBeenCalled();
  });

  it('shares "no pull request" as an answer too', async () => {
    const { store } = createStore(Date.now);
    const second = jest.fn().mockResolvedValue(value);
    const a = createPullRequestLookup({
      source: { find: jest.fn().mockResolvedValue(null) },
      store,
    });
    const b = createPullRequestLookup({ source: { find: second }, store });
    await a(shared);
    await settle();
    await expect(b(shared)).resolves.toEqual({ ok: true, value: null });
    expect(second).not.toHaveBeenCalled();
  });

  it('keeps a shared answer no longer than its lifetime', async () => {
    let clock = 0;
    const { store } = createStore(() => clock);
    const a = createPullRequestLookup({
      source: { find: jest.fn().mockResolvedValue(value) },
      store,
      now: () => clock,
    });
    const find = jest.fn().mockResolvedValue(null);
    const b = createPullRequestLookup({ source: { find }, store, now: () => clock });
    await a(shared);
    await settle();
    clock = 30_001;
    await expect(b(shared)).resolves.toEqual({ ok: true, value: null });
    expect(find).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an upstream error', new Error('ECONNRESET')],
    ['a source failure', new PullRequestSourceError('UPSTREAM_ERROR')],
    ['an unconfigured source', new PullRequestSourceError('NOT_CONFIGURED')],
  ])('never shares %s, so another replica tries the provider itself', async (_label, error) => {
    const { store } = createStore(Date.now);
    const find = jest.fn().mockResolvedValue(value);
    const a = createPullRequestLookup({
      source: { find: jest.fn().mockRejectedValue(error) },
      store,
    });
    const b = createPullRequestLookup({ source: { find }, store });
    await a(shared);
    await settle();
    expect(store.put).not.toHaveBeenCalled();
    await expect(b(shared)).resolves.toEqual({ ok: true, value });
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('puts every replica into the cooldown one of them was rate limited into', async () => {
    const { store } = createStore(Date.now);
    const limited = jest.fn().mockRejectedValue(new PullRequestSourceError('RATE_LIMITED', 60_000));
    const find = jest.fn().mockResolvedValue(value);
    const a = createPullRequestLookup({ source: { find: limited }, store });
    const b = createPullRequestLookup({ source: { find }, store });
    await a(shared);
    await settle();
    /** Another branch, so it is the cooldown and not a cached answer that answers. */
    await expect(b({ ...shared, branch: 'other' })).resolves.toEqual({
      ok: false,
      error: { code: 'RATE_LIMITED' },
    });
    expect(find).not.toHaveBeenCalled();
    const cooldown = store.put.mock.calls.find(([key]) => key.includes('cooldown'));
    expect(cooldown?.[2]).toBe(60_000);
  });

  it('writes a rate limit with its end, so a shorter one written later cannot end it', async () => {
    let clock = 1_000;
    const { store } = createStore(() => clock);
    const long = jest.fn().mockRejectedValue(new PullRequestSourceError('RATE_LIMITED', 3_600_000));
    const short = jest.fn().mockRejectedValue(new PullRequestSourceError('RATE_LIMITED'));
    const a = createPullRequestLookup({ source: { find: long }, store, now: () => clock });
    const b = createPullRequestLookup({ source: { find: short }, store, now: () => clock });
    /** At once, so neither has seen the other's limit; the long one is written first. */
    await Promise.all([a(shared), b({ ...shared, branch: 'other' })]);
    await settle();
    const ends = store.put.mock.calls
      .filter(([key]) => key.includes('cooldown'))
      .map(([, stored]) => stored.order);
    expect(ends).toEqual([1_000 + 3_600_000, 1_000 + 10_000]);
    /** Past the short limit, a third replica still sees the long one. */
    clock += 60_000;
    const find = jest.fn().mockResolvedValue(value);
    const c = createPullRequestLookup({ source: { find }, store, now: () => clock });
    await expect(c({ ...shared, branch: 'third' })).resolves.toEqual({
      ok: false,
      error: { code: 'RATE_LIMITED' },
    });
    expect(find).not.toHaveBeenCalled();
  });

  it('writes an answer with its end, so a slower replica cannot replace a newer one', async () => {
    const clock = 0;
    const { store } = createStore(() => clock);
    const lookup = createPullRequestLookup({
      source: { find: jest.fn().mockResolvedValue(value) },
      store,
      now: () => clock,
    });
    await lookup(shared);
    await settle();
    expect(store.put.mock.calls[0][1].order).toBe(30_000);
  });

  it('does not share a cooldown with lookups on another host', async () => {
    const { store } = createStore(Date.now);
    const limited = jest.fn().mockRejectedValue(new PullRequestSourceError('RATE_LIMITED', 60_000));
    const find = jest.fn().mockResolvedValue(value);
    const a = createPullRequestLookup({ source: { find: limited }, store });
    const b = createPullRequestLookup({ source: { find }, store });
    await a(shared);
    await settle();
    await expect(b({ ...shared, host: 'ghe.example.com' })).resolves.toEqual({ ok: true, value });
  });

  it('finds a shared answer whatever cache capacity each caller has', async () => {
    const { store } = createStore(Date.now);
    const second = jest.fn().mockResolvedValue(value);
    const a = createPullRequestLookup({
      source: { find: jest.fn().mockResolvedValue(value) },
      store,
    });
    const b = createPullRequestLookup({ source: { find: second }, store });
    await a({ ...shared, cacheMaxEntries: 10, cacheMaxCredentials: 1 });
    await settle();
    await expect(
      b({ ...shared, cacheMaxEntries: 5_000, cacheMaxCredentials: 64 }),
    ).resolves.toEqual({ ok: true, value });
    expect(second).not.toHaveBeenCalled();
  });

  it('holds no more results than its slot count, however many branches are looked up', async () => {
    const { store, values } = createStore(Date.now);
    const lookup = createPullRequestLookup({
      source: { find: jest.fn().mockResolvedValue(value) },
      store,
    });
    for (let i = 0; i < 200; i++) {
      await lookup({ ...shared, branch: `b${i}`, sharedCacheSlots: 20 });
    }
    await settle();
    expect(store.put).toHaveBeenCalledTimes(200);
    expect(values.size).toBeLessThanOrEqual(20);
  });

  it('holds no more rate limit cooldowns than its slot count', async () => {
    const { store, values } = createStore(Date.now);
    const limited = jest.fn().mockRejectedValue(new PullRequestSourceError('RATE_LIMITED', 60_000));
    const lookup = createPullRequestLookup({ source: { find: limited }, store });
    for (let i = 0; i < 50; i++) {
      await lookup({ ...shared, token: `t${i}`, sharedCacheSlots: 4 });
    }
    await settle();
    expect([...values.keys()].filter((key) => key.includes('cooldown')).length).toBeLessThanOrEqual(
      4,
    );
  });

  it('gives the store its timeout as the deadline of every call', async () => {
    const { store } = createStore(Date.now);
    const lookup = createPullRequestLookup({
      source: { find: jest.fn().mockResolvedValue(value) },
      store,
    });
    await lookup({ ...shared, sharedCacheTimeoutMs: 75 });
    await settle();
    expect(store.get.mock.calls.every((call) => call[1] === 75)).toBe(true);
    expect(store.put.mock.calls[0][3]).toBe(75);
  });

  it('never puts the token in a stored key or value', async () => {
    const { store } = createStore(Date.now);
    const find = jest
      .fn()
      .mockResolvedValueOnce(value)
      .mockRejectedValueOnce(new PullRequestSourceError('RATE_LIMITED'));
    const lookup = createPullRequestLookup({ source: { find }, store });
    await lookup(shared);
    await lookup({ ...shared, branch: 'b'.repeat(5_000) });
    await settle();
    /** The answer and the cooldown; a failed lookup is never stored. */
    expect(store.put).toHaveBeenCalledTimes(2);
    for (const [key, stored] of store.put.mock.calls) {
      expect(key).toMatch(/^pr:v2:/);
      expect(key.length).toBeLessThan(100);
      expect(key).not.toContain(token);
      expect(JSON.stringify(stored)).not.toContain(token);
    }
  });

  it('answers from the provider when the store fails', async () => {
    const store: PullRequestLookupStore = {
      get: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      put: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find }, store });
    await expect(lookup(shared)).resolves.toEqual({ ok: true, value });
    await settle();
    await lookup(shared);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('does not wait on a store that never answers for longer than its timeout', async () => {
    const hang = () => new Promise<never>(() => undefined);
    const store: PullRequestLookupStore = { get: jest.fn(hang), put: jest.fn(hang) };
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find }, store });
    const started = Date.now();
    await expect(lookup({ ...shared, sharedCacheTimeoutMs: 20 })).resolves.toEqual({
      ok: true,
      value,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('serves a well-formed value stored under its own key', async () => {
    const key = await sharedKey();
    const store: PullRequestLookupStore = {
      get: jest.fn(async (slot: string) =>
        slot.includes('cooldown') ? undefined : { key, order: forever, value },
      ),
      put: jest.fn(async () => undefined),
    };
    const find = jest.fn().mockResolvedValue(null);
    const lookup = createPullRequestLookup({ source: { find }, store });
    await expect(lookup(shared)).resolves.toEqual({ ok: true, value });
    expect(find).not.toHaveBeenCalled();
  });

  it.each([
    ['nothing', undefined],
    ['a string', 'cached'],
    ['an answer for another key in the same slot', { key: 'other', order: forever, value }],
    ['a value without an order', { value }],
    ['an order that is not a number', { order: 'later', value }],
    ['a value that has run out', { order: 0, value }],
    ['a value missing entirely', { order: forever }],
    ['a pull request missing fields', { order: forever, value: { number: 1 } }],
    [
      'a pull request with an unknown state',
      { order: forever, value: { ...value, state: 'draft' } },
    ],
    [
      'a pull request page that is not https',
      { order: forever, value: { ...value, url: 'javascript:alert(1)' } },
    ],
    [
      'a pull request from an unknown provider',
      { order: forever, value: { ...value, provider: 'gitea' } },
    ],
    [
      'a stored failure from an older replica',
      { result: { ok: false, error: { code: 'UPSTREAM_ERROR' } }, expiresAt: forever },
    ],
  ])('ignores %s in the store', async (_label, planted) => {
    const key = await sharedKey();
    const stored = isPlainObject(planted) && !('key' in planted) ? { ...planted, key } : planted;
    const store: PullRequestLookupStore = {
      get: jest.fn(async (slot: string) =>
        slot.includes('cooldown') ? { key, order: 'soon' } : stored,
      ),
      put: jest.fn(async () => undefined),
    };
    const find = jest.fn().mockResolvedValue(null);
    const lookup = createPullRequestLookup({ source: { find }, store });
    await expect(lookup(shared)).resolves.toEqual({ ok: true, value: null });
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('is never touched when the shared cache is off', async () => {
    const { store } = createStore(Date.now);
    const find = jest
      .fn()
      .mockResolvedValueOnce(value)
      .mockRejectedValueOnce(new PullRequestSourceError('RATE_LIMITED'));
    const lookup = createPullRequestLookup({ source: { find }, store });
    await lookup(input);
    await lookup({ ...input, sharedCache: false, branch: 'b' });
    await settle();
    expect(store.get).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });

  it('serves a shared answer while this replica is cooling down', async () => {
    const { store } = createStore(Date.now);
    const limited = jest.fn().mockRejectedValue(new PullRequestSourceError('RATE_LIMITED', 60_000));
    const cooled = createPullRequestLookup({ source: { find: limited }, store });
    const other = createPullRequestLookup({
      source: { find: jest.fn().mockResolvedValue(value) },
      store,
    });
    await other({ ...shared, branch: 'other' });
    await settle();
    await cooled({ ...shared, branch: 'limited' });
    await settle();
    await expect(cooled({ ...shared, branch: 'other' })).resolves.toEqual({ ok: true, value });
    /** Nothing stored for this branch, so the cooldown still answers without asking the provider. */
    await expect(cooled({ ...shared, branch: 'third' })).resolves.toEqual({
      ok: false,
      error: { code: 'RATE_LIMITED' },
    });
    expect(limited).toHaveBeenCalledTimes(1);
  });

  it('does not join a lookup running under another sharing policy', async () => {
    const { store } = createStore(Date.now);
    let release: (pr: typeof value) => void = () => undefined;
    const answer = new Promise<typeof value>((resolve) => (release = resolve));
    const find = jest.fn(() => answer);
    const lookup = createPullRequestLookup({ source: { find }, store });
    const local = lookup({ ...input, token, sharedCache: false });
    const fast = lookup({ ...shared, sharedCacheTimeoutMs: 10 });
    const slow = lookup({ ...shared, sharedCacheTimeoutMs: 5_000 });
    await settle();
    /** The local caller never reached the store; each shared deadline asked it on its own. */
    expect(store.get.mock.calls.map((call) => call[1]).sort((x, y) => x - y)).toEqual([
      10, 10, 5_000, 5_000,
    ]);
    release(value);
    await Promise.all([local, fast, slow]);
  });

  it('does not split the cache by whether it is shared', async () => {
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({
      source: { find },
      store: createStore(Date.now).store,
    });
    await lookup(input);
    await lookup({ ...input, sharedCache: true });
    expect(find).toHaveBeenCalledTimes(1);
  });
});
