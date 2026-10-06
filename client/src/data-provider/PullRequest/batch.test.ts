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
