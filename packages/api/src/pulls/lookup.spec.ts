import type { TConversationPullRequest } from 'librechat-data-provider';
import type { PullRequestSource } from './types';
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
