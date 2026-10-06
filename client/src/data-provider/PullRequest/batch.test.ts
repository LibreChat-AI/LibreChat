import type { TConversationPullRequest } from 'librechat-data-provider';
import { PullRequestBatchError, createBatchFetcher, createPullRequestBatcher } from './batch';

const pr: TConversationPullRequest = {
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

describe('createPullRequestBatcher', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('asks once for every conversation requested in the same moment', async () => {
    const fetchMany = jest.fn().mockResolvedValue({
      results: [
        { conversationId: 'a', pullRequest: pr },
        { conversationId: 'b', pullRequest: null },
      ],
    });
    const { load } = createPullRequestBatcher({ fetchMany });
    const first = load('a');
    const second = load('b');
    await jest.advanceTimersByTimeAsync(50);
    expect(fetchMany).toHaveBeenCalledTimes(1);
    expect(fetchMany).toHaveBeenCalledWith(['a', 'b'], expect.any(AbortSignal));
    await expect(first).resolves.toEqual({ pullRequest: pr });
    await expect(second).resolves.toEqual({ pullRequest: null });
  });

  it('shares one entry between callers asking for the same conversation', async () => {
    const fetchMany = jest
      .fn()
      .mockResolvedValue({ results: [{ conversationId: 'a', pullRequest: pr }] });
    const { load } = createPullRequestBatcher({ fetchMany });
    const calls = [load('a'), load('a')];
    await jest.advanceTimersByTimeAsync(50);
    expect(fetchMany).toHaveBeenCalledWith(['a'], expect.any(AbortSignal));
    await expect(Promise.all(calls)).resolves.toEqual([{ pullRequest: pr }, { pullRequest: pr }]);
  });

  it('answers no pull request for a conversation the server left out', async () => {
    const fetchMany = jest.fn().mockResolvedValue({ results: [] });
    const { load } = createPullRequestBatcher({ fetchMany });
    const answer = load('a');
    await jest.advanceTimersByTimeAsync(50);
    await expect(answer).resolves.toEqual({ pullRequest: null });
  });

  it('splits a crowd into requests the server accepts', async () => {
    const fetchMany = jest.fn(async (ids: string[]) => ({
      results: ids.map((conversationId) => ({ conversationId, pullRequest: null })),
    }));
    const { load } = createPullRequestBatcher({ fetchMany, maxBatch: 2 });
    const all = ['a', 'b', 'c', 'd', 'e'].map(load);
    await jest.advanceTimersByTimeAsync(50);
    await Promise.all(all);
    expect(fetchMany.mock.calls.map(([ids]) => ids)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  describe('requests in flight', () => {
    /** A server that answers only when told to, so overlap is visible. */
    const slowServer = () => {
      let active = 0;
      let peak = 0;
      const releases: Array<() => void> = [];
      const fetchMany = jest.fn(
        (ids: string[]) =>
          new Promise<{ results: Array<{ conversationId: string; pullRequest: null }> }>(
            (resolve) => {
              active += 1;
              peak = Math.max(peak, active);
              releases.push(() => {
                active -= 1;
                resolve({
                  results: ids.map((conversationId) => ({ conversationId, pullRequest: null })),
                });
              });
            },
          ),
      );
      return { fetchMany, releases, peak: () => peak };
    };

    it('sends the chunks of a crowd one at a time, so the server limit is not multiplied', async () => {
      const { fetchMany, releases, peak } = slowServer();
      const { load } = createPullRequestBatcher({ fetchMany, maxBatch: 2 });
      const all = ['a', 'b', 'c', 'd', 'e'].map(load);
      await jest.advanceTimersByTimeAsync(50);
      expect(fetchMany).toHaveBeenCalledTimes(1);
      releases.shift()?.();
      await jest.advanceTimersByTimeAsync(0);
      expect(fetchMany).toHaveBeenCalledTimes(2);
      releases.shift()?.();
      await jest.advanceTimersByTimeAsync(0);
      expect(fetchMany).toHaveBeenCalledTimes(3);
      releases.shift()?.();
      await Promise.all(all);
      expect(peak()).toBe(1);
      expect(fetchMany.mock.calls.map(([ids]) => ids)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    });

    it('does not start a later flush while an earlier request is still out', async () => {
      const { fetchMany, releases, peak } = slowServer();
      const { load } = createPullRequestBatcher({ fetchMany });
      const first = load('a');
      await jest.advanceTimersByTimeAsync(50);
      const second = load('b');
      await jest.advanceTimersByTimeAsync(50);
      expect(fetchMany).toHaveBeenCalledTimes(1);
      releases.shift()?.();
      await jest.advanceTimersByTimeAsync(0);
      expect(fetchMany).toHaveBeenCalledTimes(2);
      releases.shift()?.();
      await Promise.all([first, second]);
      expect(peak()).toBe(1);
    });

    it('moves on when a request never answers, failing only the callers it carried', async () => {
      const fetchMany = jest
        .fn()
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockResolvedValue({ results: [{ conversationId: 'b', pullRequest: null }] });
      const { load } = createPullRequestBatcher({ fetchMany, requestTimeoutMs: 1000 });
      const hung = load('a').catch((error) => error);
      await jest.advanceTimersByTimeAsync(50);
      const later = load('b');
      await jest.advanceTimersByTimeAsync(50);
      expect(fetchMany).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1000);
      const error = await hung;
      expect(error).toBeInstanceOf(PullRequestBatchError);
      expect(error.code).toBe('TIMEOUT');
      await jest.advanceTimersByTimeAsync(50);
      await expect(later).resolves.toEqual({ pullRequest: null });
    });

    it('waits longer than the longest server deadline a deployment can configure by default', async () => {
      const fetchMany = jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ results: [{ conversationId: 'a', pullRequest: null }] }),
                125_000,
              ),
            ),
        )
        .mockResolvedValue({ results: [{ conversationId: 'b', pullRequest: null }] });
      const { load } = createPullRequestBatcher({ fetchMany });
      const slow = load('a');
      await jest.advanceTimersByTimeAsync(50);
      const queued = load('b');
      await jest.advanceTimersByTimeAsync(124_000);
      /** A 120 s server batch has not finished at 124 s of waiting, and the next must not have started. */
      expect(fetchMany).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(2_000);
      await expect(slow).resolves.toEqual({ pullRequest: null });
      await jest.advanceTimersByTimeAsync(50);
      await expect(queued).resolves.toEqual({ pullRequest: null });
      expect(fetchMany).toHaveBeenCalledTimes(2);
    });

    it('does not time out a request that answers in time', async () => {
      const fetchMany = jest
        .fn()
        .mockResolvedValue({ results: [{ conversationId: 'a', pullRequest: null }] });
      const { load } = createPullRequestBatcher({ fetchMany, requestTimeoutMs: 1000 });
      const answer = load('a');
      await jest.advanceTimersByTimeAsync(50);
      await expect(answer).resolves.toEqual({ pullRequest: null });
      await jest.advanceTimersByTimeAsync(5000);
    });

    it.each([
      ['no body', undefined],
      ['a body without results', {}],
      ['results that are not a list', { results: 'nope' }],
      ['a result that is not an entry', { results: [null] }],
    ])(
      'fails its callers, and not the queue, when the server answers with %s',
      async (_label, body) => {
        const fetchMany = jest
          .fn()
          .mockResolvedValueOnce(body)
          .mockResolvedValue({ results: [{ conversationId: 'b', pullRequest: null }] });
        const { load } = createPullRequestBatcher({ fetchMany, maxBatch: 1 });
        const bad = load('a').then(
          () => 'resolved',
          () => 'rejected',
        );
        const good = load('b');
        await jest.advanceTimersByTimeAsync(50);
        await expect(bad).resolves.toBe('rejected');
        await expect(good).resolves.toEqual({ pullRequest: null });
        expect(fetchMany).toHaveBeenCalledTimes(2);
      },
    );

    it('keeps sending after a request fails', async () => {
      const fetchMany = jest
        .fn()
        .mockRejectedValueOnce(new Error('503'))
        .mockResolvedValue({ results: [{ conversationId: 'c', pullRequest: null }] });
      const { load } = createPullRequestBatcher({ fetchMany, maxBatch: 1 });
      const failed = load('a').catch((error) => error.message);
      const fine = load('c');
      await jest.advanceTimersByTimeAsync(50);
      await expect(failed).resolves.toBe('503');
      await expect(fine).resolves.toEqual({ pullRequest: null });
    });
  });

  it('rejects only the conversation whose entry failed, carrying its code', async () => {
    const fetchMany = jest.fn().mockResolvedValue({
      results: [
        { conversationId: 'a', error: { code: 'RATE_LIMITED' } },
        { conversationId: 'b', pullRequest: pr },
      ],
    });
    const { load } = createPullRequestBatcher({ fetchMany });
    const failed = load('a');
    const fine = load('b');
    const outcome = failed.catch((error) => error);
    await jest.advanceTimersByTimeAsync(50);
    const error = await outcome;
    expect(error).toBeInstanceOf(PullRequestBatchError);
    expect(error.code).toBe('RATE_LIMITED');
    await expect(fine).resolves.toEqual({ pullRequest: pr });
  });

  it('rejects every caller of a request that fails outright', async () => {
    const fetchMany = jest.fn().mockRejectedValue(new Error('503'));
    const { load } = createPullRequestBatcher({ fetchMany });
    const outcomes = [load('a'), load('b')].map((promise) =>
      promise.catch((error) => error.message),
    );
    await jest.advanceTimersByTimeAsync(50);
    await expect(Promise.all(outcomes)).resolves.toEqual(['503', '503']);
  });

  it('starts a new request for a conversation asked for after the last went out', async () => {
    const fetchMany = jest.fn(async (ids: string[]) => ({
      results: ids.map((conversationId) => ({ conversationId, pullRequest: null })),
    }));
    const { load } = createPullRequestBatcher({ fetchMany });
    const first = load('a');
    await jest.advanceTimersByTimeAsync(50);
    await first;
    const second = load('b');
    await jest.advanceTimersByTimeAsync(50);
    await second;
    expect(fetchMany.mock.calls.map(([ids]) => ids)).toEqual([['a'], ['b']]);
  });
});

describe('createPullRequestBatcher dispose', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('rejects ids that have not gone out, and sends nothing for them', async () => {
    const fetchMany = jest.fn();
    const batcher = createPullRequestBatcher({ fetchMany });
    const waiting = batcher.load('a').catch((error) => error);
    batcher.dispose();
    await jest.advanceTimersByTimeAsync(100);
    const error = await waiting;
    expect(error).toBeInstanceOf(PullRequestBatchError);
    expect(error.code).toBe('DISPOSED');
    expect(fetchMany).not.toHaveBeenCalled();
  });

  it('does not send chunks that were still queued behind a request in flight', async () => {
    const releases: Array<() => void> = [];
    const fetchMany = jest.fn(
      (ids: string[]) =>
        new Promise<{ results: Array<{ conversationId: string; pullRequest: null }> }>((resolve) =>
          releases.push(() =>
            resolve({
              results: ids.map((conversationId) => ({ conversationId, pullRequest: null })),
            }),
          ),
        ),
    );
    const batcher = createPullRequestBatcher({ fetchMany, maxBatch: 1 });
    const outcomes = ['a', 'b', 'c'].map((id) =>
      batcher.load(id).then(
        () => 'sent',
        (error) => error.code,
      ),
    );
    await jest.advanceTimersByTimeAsync(50);
    expect(fetchMany).toHaveBeenCalledTimes(1);
    batcher.dispose();
    releases.shift()?.();
    await jest.advanceTimersByTimeAsync(50);
    /** The request on the wire is aborted with the batcher, and the queued chunks never go out. */
    expect(await Promise.all(outcomes)).toEqual(['ABORTED', 'DISPOSED', 'DISPOSED']);
    expect(fetchMany).toHaveBeenCalledTimes(1);
  });

  it('refuses new work once disposed', async () => {
    const batcher = createPullRequestBatcher({ fetchMany: jest.fn() });
    batcher.dispose();
    await expect(batcher.load('a')).rejects.toMatchObject({ code: 'DISPOSED' });
  });
});

describe('createBatchFetcher', () => {
  const entry = (conversationId: string) => ({ conversationId, pullRequest: null });
  const notFound = () => Object.assign(new Error('Not Found'), { response: { status: 404 } });

  it('uses the batch route when the server has it', async () => {
    const fetchMany = jest.fn().mockResolvedValue({ results: [entry('a')] });
    const fetchOne = jest.fn();
    await expect(
      createBatchFetcher({ fetchMany, fetchOne })(['a'], new AbortController().signal),
    ).resolves.toEqual({
      results: [entry('a')],
    });
    expect(fetchOne).not.toHaveBeenCalled();
  });

  it('asks the single route for each conversation when the replica has no batch route', async () => {
    const fetchMany = jest.fn().mockRejectedValue(notFound());
    const fetchOne = jest.fn(async (id: string) => ({ pullRequest: id === 'a' ? pr : null }));
    const results = await createBatchFetcher({ fetchMany, fetchOne })(
      ['a', 'b'],
      new AbortController().signal,
    );
    expect(results).toEqual({
      results: [
        { conversationId: 'a', pullRequest: pr },
        { conversationId: 'b', pullRequest: null },
      ],
    });
    expect(fetchOne.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
  });

  it("keeps one conversation's failure to itself and reports its code", async () => {
    const fetchMany = jest.fn().mockRejectedValue(notFound());
    const fetchOne = jest.fn(async (id: string) => {
      if (id === 'a') {
        throw Object.assign(new Error('x'), {
          response: { status: 503, data: { code: 'RATE_LIMITED' } },
        });
      }
      return { pullRequest: pr };
    });
    const { results } = await createBatchFetcher({ fetchMany, fetchOne })(
      ['a', 'b'],
      new AbortController().signal,
    );
    expect(results).toEqual([
      { conversationId: 'a', error: { code: 'RATE_LIMITED' } },
      { conversationId: 'b', pullRequest: pr },
    ]);
  });

  it('answers a failure with no code as an upstream error, never with its text', async () => {
    const fetchMany = jest.fn().mockRejectedValue(notFound());
    const fetchOne = jest.fn().mockRejectedValue(new Error('secret host name'));
    const { results } = await createBatchFetcher({ fetchMany, fetchOne })(
      ['a'],
      new AbortController().signal,
    );
    expect(results).toEqual([{ conversationId: 'a', error: { code: 'UPSTREAM_ERROR' } }]);
    expect(JSON.stringify(results)).not.toContain('secret');
  });

  it.each([
    ['a server error', { response: { status: 503 } }],
    ['a rate limit', { response: { status: 429 } }],
    ['an expired session', { response: { status: 401 } }],
    ['a network failure', new Error('Network Error')],
  ])(
    'does not fall back on %s, since the route exists and really failed',
    async (_label, failure) => {
      const error = failure instanceof Error ? failure : Object.assign(new Error('x'), failure);
      const fetchMany = jest.fn().mockRejectedValue(error);
      const fetchOne = jest.fn();
      await expect(
        createBatchFetcher({ fetchMany, fetchOne })(['a'], new AbortController().signal),
      ).rejects.toBe(error);
      expect(fetchOne).not.toHaveBeenCalled();
    },
  );

  it('runs the single-route calls a few at a time, not all at once', async () => {
    let active = 0;
    let peak = 0;
    const fetchMany = jest.fn().mockRejectedValue(notFound());
    const fetchOne = jest.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { pullRequest: null };
    });
    jest.useRealTimers();
    const ids = Array.from({ length: 12 }, (_, i) => `c${i}`);
    const { results } = await createBatchFetcher({ fetchMany, fetchOne })(
      ids,
      new AbortController().signal,
    );
    expect(results.map((r) => r.conversationId)).toEqual(ids);
    expect(peak).toBe(4);
  });
});

describe('the single-route fallback and the queue', () => {
  const notFound = () => Object.assign(new Error('Not Found'), { response: { status: 404 } });

  /** A single-route call that ends only when released or aborted, like a stalled GET. */
  const stalledSingleRoute = () => {
    const calls: string[] = [];
    const aborted: string[] = [];
    const fetchOne = jest.fn(
      (id: string, signal: AbortSignal) =>
        new Promise<{ pullRequest: null }>((_, reject) => {
          calls.push(id);
          signal.addEventListener('abort', () => {
            aborted.push(id);
            reject(new Error('aborted'));
          });
        }),
    );
    return { fetchOne, calls, aborted };
  };

  it('stops its calls when the signal aborts, and starts no more', async () => {
    const { fetchOne, calls, aborted } = stalledSingleRoute();
    const controller = new AbortController();
    const ids = Array.from({ length: 12 }, (_, i) => `c${i}`);
    const fetcher = createBatchFetcher({
      fetchMany: jest.fn().mockRejectedValue(notFound()),
      fetchOne,
    });
    const settled = fetcher(ids, controller.signal).catch((error) => error);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toHaveLength(4);
    controller.abort();
    const error = await settled;
    expect(error).toBeInstanceOf(PullRequestBatchError);
    expect(error.code).toBe('ABORTED');
    expect(aborted).toHaveLength(4);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(4);
  });

  it('starts nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchOne = jest.fn();
    const fetcher = createBatchFetcher({
      fetchMany: jest.fn().mockRejectedValue(notFound()),
      fetchOne,
    });
    await expect(fetcher(['a', 'b'], controller.signal)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(fetchOne).not.toHaveBeenCalled();
  });

  it("does not report an aborted call as one conversation's failure", async () => {
    const controller = new AbortController();
    const fetchOne = jest.fn(
      (_id: string, signal: AbortSignal) =>
        new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('x'))),
        ),
    );
    const fetcher = createBatchFetcher({
      fetchMany: jest.fn().mockRejectedValue(notFound()),
      fetchOne,
    });
    const settled = fetcher(['a'], controller.signal).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect(await settled).toMatchObject({ code: 'ABORTED' });
  });

  it('aborts a request that runs past its timeout, so its fallback stops before the next request starts', async () => {
    jest.useFakeTimers();
    try {
      const { fetchOne, calls, aborted } = stalledSingleRoute();
      const fetchMany = jest
        .fn()
        .mockRejectedValueOnce(notFound())
        .mockResolvedValue({ results: [{ conversationId: 'z', pullRequest: null }] });
      const fetcher = createBatchFetcher({ fetchMany, fetchOne });
      const batcher = createPullRequestBatcher({
        fetchMany: fetcher,
        maxBatch: 1,
        requestTimeoutMs: 1000,
      });
      const first = batcher.load('a').catch((error) => error.code);
      const second = batcher.load('z');
      await jest.advanceTimersByTimeAsync(50);
      expect(calls).toEqual(['a']);
      expect(fetchMany).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1000);
      expect(await first).toBe('TIMEOUT');
      /** The stalled call was aborted before the queue handed the next request its turn. */
      expect(aborted).toEqual(['a']);
      await jest.advanceTimersByTimeAsync(50);
      await expect(second).resolves.toEqual({ pullRequest: null });
      expect(fetchMany).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('aborts the request on the wire when the batcher is disposed', async () => {
    const { fetchOne, calls, aborted } = stalledSingleRoute();
    const fetcher = createBatchFetcher({
      fetchMany: jest.fn().mockRejectedValue(notFound()),
      fetchOne,
    });
    const batcher = createPullRequestBatcher({ fetchMany: fetcher, delayMs: 1 });
    const outcome = batcher.load('a').catch((error) => error.code);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual(['a']);
    batcher.dispose();
    expect(aborted).toEqual(['a']);
    expect(await outcome).toBe('ABORTED');
  });

  it("hands the batcher's own signal to the fetcher, live while the request runs", async () => {
    let seen: AbortSignal | undefined;
    const fetchMany = jest.fn(async (_ids: string[], signal: AbortSignal) => {
      seen = signal;
      return { results: [{ conversationId: 'a', pullRequest: null }] };
    });
    const batcher = createPullRequestBatcher({ fetchMany, delayMs: 1 });
    await batcher.load('a');
    expect(seen).toBeDefined();
    expect(seen?.aborted).toBe(false);
  });
});

describe('the batch POST receives the request signal', () => {
  it("hands the batcher's signal to the primary batch call, and aborts it on timeout", async () => {
    jest.useFakeTimers();
    try {
      const seen: AbortSignal[] = [];
      const fetchMany = jest.fn(
        (_ids: string[], signal: AbortSignal) =>
          new Promise<never>(() => {
            seen.push(signal);
          }),
      );
      const fetcher = createBatchFetcher({ fetchMany, fetchOne: jest.fn() });
      const batcher = createPullRequestBatcher({ fetchMany: fetcher, requestTimeoutMs: 1000 });
      const outcome = batcher.load('a').catch((error) => error.code);
      await jest.advanceTimersByTimeAsync(50);
      expect(seen).toHaveLength(1);
      expect(seen[0].aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1000);
      expect(await outcome).toBe('TIMEOUT');
      expect(seen[0].aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('aborts the batch call on the wire when the batcher is disposed', async () => {
    jest.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      const fetchMany = jest.fn(
        (_ids: string[], signal: AbortSignal) =>
          new Promise<never>(() => {
            seen = signal;
          }),
      );
      const batcher = createPullRequestBatcher({
        fetchMany: createBatchFetcher({ fetchMany, fetchOne: jest.fn() }),
      });
      const outcome = batcher.load('a').catch(() => 'rejected');
      await jest.advanceTimersByTimeAsync(50);
      batcher.dispose();
      expect(seen?.aborted).toBe(true);
      expect(await outcome).toBe('rejected');
    } finally {
      jest.useRealTimers();
    }
  });
});
