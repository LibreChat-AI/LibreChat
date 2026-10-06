import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversationPullRequest } from 'librechat-data-provider';
import { pullRequestRefetchInterval, useConversationPullRequestQuery } from './queries';

const mockGet = jest.fn();
const mockStartup: { current: { pullRequestsEnabled?: boolean } | undefined } = {
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
