import type { TConversationPullRequest } from 'librechat-data-provider';
import { PullRequestBatchError, createPullRequestBatcher } from './batch';

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
    expect(fetchMany).toHaveBeenCalledWith(['a', 'b']);
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
    expect(fetchMany).toHaveBeenCalledWith(['a']);
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
