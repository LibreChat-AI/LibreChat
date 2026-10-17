import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversationPullRequest } from 'librechat-data-provider';
import type { TStartupConfig } from 'librechat-data-provider';
import {
  endPullRequestSession,
  pullRequestRefetchInterval,
  useRowPullRequestQuery,
  useConversationPullRequestQuery,
} from './queries';
import store from '~/store';

const mockGet = jest.fn();
const mockGetMany = jest.fn();
const mockStartup: { current: Partial<TStartupConfig> | undefined } = {
  current: { pullRequestsEnabled: true },
};

jest.mock('../Endpoints', () => ({
  useGetStartupConfig: () => ({ data: mockStartup.current }),
}));

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getConversationPullRequest: (...args: unknown[]) => mockGet(...args),
      getConversationPullRequests: (...args: unknown[]) => mockGetMany(...args),
    },
  };
});

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

const wrap = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
};

describe('pullRequestRefetchInterval', () => {
  it('polls quickly only while checks or mergeability can still change', () => {
    expect(pullRequestRefetchInterval({ pullRequest: { ...pr, checks: 'running' } })).toBe(20_000);
    expect(pullRequestRefetchInterval({ pullRequest: { ...pr, mergeable: 'unknown' } })).toBe(
      20_000,
    );
  });

  it('polls a settled open pull request slowly and a missing one slowly enough to notice a new one', () => {
    expect(pullRequestRefetchInterval({ pullRequest: pr })).toBe(60_000);
    expect(pullRequestRefetchInterval({ pullRequest: null })).toBe(60_000);
    expect(pullRequestRefetchInterval(undefined)).toBe(60_000);
  });

  it('stops polling a merged or closed pull request once its checks are not running', () => {
    for (const checks of ['passing', 'failing', 'none'] as const) {
      expect(pullRequestRefetchInterval({ pullRequest: { ...pr, state: 'merged', checks } })).toBe(
        false,
      );
      expect(pullRequestRefetchInterval({ pullRequest: { ...pr, state: 'closed', checks } })).toBe(
        false,
      );
    }
  });

  it('keeps polling a merged or closed pull request while its checks are still running', () => {
    expect(
      pullRequestRefetchInterval({ pullRequest: { ...pr, state: 'merged', checks: 'running' } }),
    ).toBe(20_000);
    expect(
      pullRequestRefetchInterval({ pullRequest: { ...pr, state: 'closed', checks: 'running' } }),
    ).toBe(20_000);
  });
});

describe('useConversationPullRequestQuery', () => {
  beforeEach(() => {
    mockGet.mockReset().mockResolvedValue({ pullRequest: pr });
    mockStartup.current = { pullRequestsEnabled: true };
  });

  it.each([
    ['advertised off', { pullRequestsEnabled: false }],
    ['not advertised', {}],
    ['startup config not loaded', undefined],
  ])('does not call the endpoint when the feature is %s', (_label, startup) => {
    mockStartup.current = startup;
    renderHook(() => useConversationPullRequestQuery('convo-1'), { wrapper: wrap() });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('fetches the pull request of a saved conversation', async () => {
    const { result } = renderHook(() => useConversationPullRequestQuery('convo-1'), {
      wrapper: wrap(),
    });
    await waitFor(() => expect(result.current.data).toEqual({ pullRequest: pr }));
    expect(mockGet).toHaveBeenCalledWith('convo-1');
  });

  it.each(['', 'new', 'PENDING'])('does not fetch for the placeholder conversation %p', (id) => {
    renderHook(() => useConversationPullRequestQuery(id), { wrapper: wrap() });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('surfaces a failure without retrying', async () => {
    mockGet.mockReset().mockRejectedValue(new Error('503'));
    const { result } = renderHook(() => useConversationPullRequestQuery('convo-1'), {
      wrapper: wrap(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});

describe('useRowPullRequestQuery', () => {
  const rowStartup = {
    pullRequestsEnabled: true,
    pullRequestsBatchVersion: 1,
    pullRequestsMaxConcurrentLookups: 2,
  } as const;
  const answerFor = (ids: string[]) => ({
    results: ids.map((conversationId) => ({ conversationId, pullRequest: pr })),
  });

  const wrapRows = (userId = 'user-1') => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>
        <RecoilRoot initializeState={({ set }) => set(store.user, { id: userId } as never)}>
          {children}
        </RecoilRoot>
      </QueryClientProvider>
    );
    return { Wrapper, client };
  };

  beforeEach(() => {
    endPullRequestSession();
    mockGet.mockReset().mockResolvedValue({ pullRequest: null });
    mockGetMany.mockReset().mockImplementation(async (ids: string[]) => answerFor(ids));
    mockStartup.current = { ...rowStartup };
  });
  afterEach(() => endPullRequestSession());

  it('asks the batch route once for rows mounted together', async () => {
    const { Wrapper } = wrapRows();
    const a = renderHook(() => useRowPullRequestQuery('a'), { wrapper: Wrapper });
    const b = renderHook(() => useRowPullRequestQuery('b'), { wrapper: Wrapper });
    await waitFor(() => expect(a.result.current.data).toEqual({ pullRequest: pr }));
    await waitFor(() => expect(b.result.current.data).toEqual({ pullRequest: pr }));
    expect(mockGetMany).toHaveBeenCalledTimes(1);
    expect(mockGetMany.mock.calls[0][0]).toEqual(['a', 'b']);
  });

  it('does not ask for a row that unmounted before its request went out', async () => {
    const { Wrapper } = wrapRows();
    const gone = renderHook(() => useRowPullRequestQuery('gone'), { wrapper: Wrapper });
    const kept = renderHook(() => useRowPullRequestQuery('kept'), { wrapper: Wrapper });
    gone.unmount();
    await waitFor(() => expect(kept.result.current.data).toEqual({ pullRequest: pr }));
    expect(mockGetMany).toHaveBeenCalledTimes(1);
    expect(mockGetMany.mock.calls[0][0]).toEqual(['kept']);
  });

  it('aborts a request on the wire once the last row waiting for it unmounts', async () => {
    let seen: AbortSignal | undefined;
    mockGetMany.mockReset().mockImplementation(
      (_ids: string[], options?: { signal?: AbortSignal }) =>
        new Promise(() => {
          seen = options?.signal;
        }),
    );
    const { Wrapper } = wrapRows();
    const row = renderHook(() => useRowPullRequestQuery('a'), { wrapper: Wrapper });
    await waitFor(() => expect(seen).toBeDefined());
    expect(seen?.aborted).toBe(false);
    row.unmount();
    await waitFor(() => expect(seen?.aborted).toBe(true));
  });

  it('starts a fresh queue after the session ends, even for the same account', async () => {
    const stalled: Array<AbortSignal | undefined> = [];
    mockGetMany
      .mockReset()
      .mockImplementationOnce(
        (_ids: string[], options?: { signal?: AbortSignal }) =>
          new Promise(() => {
            stalled.push(options?.signal);
          }),
      )
      .mockImplementation(async (ids: string[]) => answerFor(ids));
    const first = wrapRows();
    renderHook(() => useRowPullRequestQuery('a'), { wrapper: first.Wrapper });
    await waitFor(() => expect(stalled).toHaveLength(1));
    act(() => endPullRequestSession());
    expect(stalled[0]?.aborted).toBe(true);
    const second = wrapRows();
    const row = renderHook(() => useRowPullRequestQuery('b'), { wrapper: second.Wrapper });
    await waitFor(() => expect(row.result.current.data).toEqual({ pullRequest: pr }));
    expect(mockGetMany.mock.calls.at(-1)?.[0]).toEqual(['b']);
  });

  it('falls back to the single route no faster than the limit the server advertised', async () => {
    const notFound = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    mockGetMany.mockReset().mockRejectedValue(notFound);
    let active = 0;
    let peak = 0;
    mockGet.mockReset().mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { pullRequest: null };
    });
    const { Wrapper } = wrapRows();
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) =>
      renderHook(() => useRowPullRequestQuery(id), { wrapper: Wrapper }),
    );
    await waitFor(() => rows.forEach((row) => expect(row.result.current.isSuccess).toBe(true)));
    expect(mockGet).toHaveBeenCalledTimes(6);
    expect(peak).toBe(2);
  });

  it('falls back one call at a time when the server advertised no limit', async () => {
    mockStartup.current = { pullRequestsEnabled: true, pullRequestsBatchVersion: 1 };
    const notFound = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    mockGetMany.mockReset().mockRejectedValue(notFound);
    let active = 0;
    let peak = 0;
    mockGet.mockReset().mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { pullRequest: null };
    });
    const { Wrapper } = wrapRows();
    const rows = ['a', 'b', 'c'].map((id) =>
      renderHook(() => useRowPullRequestQuery(id), { wrapper: Wrapper }),
    );
    await waitFor(() => rows.forEach((row) => expect(row.result.current.isSuccess).toBe(true)));
    expect(peak).toBe(1);
  });
});
