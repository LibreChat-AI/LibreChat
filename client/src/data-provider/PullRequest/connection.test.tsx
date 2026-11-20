import React from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryObserver, QueryClientProvider } from '@tanstack/react-query';
import type { TPullRequestConnection, TStartupConfig } from 'librechat-data-provider';
import {
  syncPullRequestConnection,
  resetPullRequestCredentials,
  usePullRequestConnectionQuery,
  usePullRequestConnectionStatus,
  useDisconnectPullRequestAccountMutation,
} from './connection';

const mockGetConnection = jest.fn();
const mockDisconnect = jest.fn();
const mockStartup: { current: Partial<TStartupConfig> | undefined } = {
  current: { pullRequestsConnect: 'github' },
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
      getPullRequestConnection: (...args: unknown[]) => mockGetConnection(...args),
      disconnectPullRequestAccount: (...args: unknown[]) => mockDisconnect(...args),
    },
  };
});

const connection = (connected: boolean): TPullRequestConnection => ({
  configured: true,
  provider: 'github',
  connected,
});

const setup = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, invalidate, wrapper };
};

describe('pull request connection hooks', () => {
  beforeEach(() => {
    mockStartup.current = { pullRequestsConnect: 'github' };
    mockGetConnection.mockReset();
    mockDisconnect.mockReset();
  });

  it('never asks a deployment with pull requests off', () => {
    mockStartup.current = {};
    const { wrapper } = setup();
    const { result } = renderHook(() => usePullRequestConnectionQuery(), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(mockGetConnection).not.toHaveBeenCalled();
  });

  it('asks a deployment with pull requests on that no longer offers an app', async () => {
    mockStartup.current = { pullRequestsEnabled: true };
    mockGetConnection.mockResolvedValueOnce({ configured: false, connected: true });
    const { wrapper } = setup();
    const { result } = renderHook(() => usePullRequestConnectionQuery(), { wrapper });
    await waitFor(() => expect(result.current.data?.connected).toBe(true));
    expect(mockGetConnection).toHaveBeenCalledTimes(1);
  });

  it('refetches cached pull requests once a connection made elsewhere shows up', async () => {
    mockGetConnection.mockResolvedValueOnce(connection(false));
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => usePullRequestConnectionQuery(), { wrapper });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));

    mockGetConnection.mockResolvedValueOnce(connection(true));
    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
    expect(invalidate).toHaveBeenLastCalledWith([QueryKeys.conversationPullRequest]);
  });

  it('refetches cached pull requests when the first status shows the user connected', async () => {
    mockGetConnection.mockResolvedValueOnce(connection(true));
    const { wrapper, invalidate } = setup();
    renderHook(() => usePullRequestConnectionQuery(), { wrapper });
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith([QueryKeys.conversationPullRequest]),
    );
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('refetches cached pull requests once on a first status showing the server token', async () => {
    mockGetConnection.mockResolvedValue(connection(false));
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => usePullRequestConnectionQuery(), { wrapper });
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith([QueryKeys.conversationPullRequest]),
    );
    expect(invalidate).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.refetch();
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('refetches cached pull requests from the visibility status alone, with the row hidden', async () => {
    mockStartup.current = { pullRequestsEnabled: true };
    mockGetConnection.mockResolvedValue({ configured: false, connected: true });
    const { client, wrapper, invalidate } = setup();
    renderHook(() => usePullRequestConnectionStatus(), { wrapper });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));

    /** Disconnected in another tab: the section hides, and only this observer sees it. */
    mockGetConnection.mockResolvedValue({ configured: false, connected: false });
    await act(async () => {
      await client.refetchQueries([QueryKeys.pullRequestConnection]);
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
    expect(invalidate).toHaveBeenLastCalledWith([QueryKeys.conversationPullRequest]);
  });

  it('refreshes pull requests once per change, not on every Settings visit', async () => {
    mockGetConnection.mockResolvedValue(connection(true));
    const { wrapper, invalidate } = setup();
    const first = renderHook(() => usePullRequestConnectionQuery(), { wrapper });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    first.unmount();

    const second = renderHook(() => usePullRequestConnectionQuery(), { wrapper });
    await act(async () => {
      await second.result.current.refetch();
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('refetches cached pull requests when a connection moves to another provider', async () => {
    mockGetConnection.mockResolvedValueOnce(connection(true));
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => usePullRequestConnectionQuery(), { wrapper });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));

    mockGetConnection.mockResolvedValueOnce({ ...connection(true), provider: 'gitlab' });
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
  });

  it('refetches cached pull requests when the deployment moves a disconnected user to another provider', async () => {
    mockGetConnection.mockResolvedValueOnce(connection(false));
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => usePullRequestConnectionQuery(), { wrapper });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));

    mockGetConnection.mockResolvedValueOnce({ ...connection(false), provider: 'gitlab' });
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
  });

  it('starts over with the next session, so its first status follows the first-status rule', async () => {
    mockGetConnection.mockResolvedValue(connection(true));
    const { wrapper, invalidate } = setup();
    const first = renderHook(() => usePullRequestConnectionQuery(), { wrapper });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    first.unmount();

    resetPullRequestCredentials();
    const second = renderHook(() => usePullRequestConnectionQuery(), { wrapper });
    await act(async () => {
      await second.result.current.refetch();
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
  });

  it('refetches cached pull requests when another sign-in replaces the grant', async () => {
    mockGetConnection.mockResolvedValueOnce({ ...connection(true), flowId: 'flow-a' });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => usePullRequestConnectionQuery(), { wrapper });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));

    mockGetConnection.mockResolvedValueOnce({ ...connection(true), flowId: 'flow-b' });
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
  });

  it('restarts a pull request still on its first load when the credential changes', async () => {
    const { client } = setup();
    syncPullRequestConnection(client, connection(false));
    const loads: Array<(value: unknown) => void> = [];
    const queryFn = jest.fn(() => new Promise((resolve) => loads.push(resolve)));
    const observer = new QueryObserver(client, {
      queryKey: [QueryKeys.conversationPullRequest, 'convo'],
      queryFn,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
      /** Connected while the first load, under the server's token, is still running. */
      syncPullRequestConnection(client, { ...connection(true), flowId: 'flow-a' });
      await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
      /** The cancelled load answers last, and does not replace the answer under the new token. */
      loads[1]('new');
      await waitFor(() =>
        expect(client.getQueryData([QueryKeys.conversationPullRequest, 'convo'])).toBe('new'),
      );
      loads[0]('old');
      await act(async () => {
        await Promise.resolve();
      });
      expect(client.getQueryData([QueryKeys.conversationPullRequest, 'convo'])).toBe('new');
    } finally {
      unsubscribe();
    }
  });

  it('marks the account disconnected and refetches the status and pull requests', async () => {
    mockDisconnect.mockResolvedValue(undefined);
    const { client, wrapper, invalidate } = setup();
    client.setQueryData([QueryKeys.pullRequestConnection], connection(true));
    const { result } = renderHook(() => useDisconnectPullRequestAccountMutation(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(
      client.getQueryData<TPullRequestConnection>([QueryKeys.pullRequestConnection])?.connected,
    ).toBe(false);
    expect(invalidate).toHaveBeenCalledWith([QueryKeys.pullRequestConnection]);
    expect(invalidate).toHaveBeenCalledWith([QueryKeys.conversationPullRequest]);
  });

  it('reads the status after a failed disconnect even with Settings closed', async () => {
    mockDisconnect.mockRejectedValue(new Error('500'));
    const { client, wrapper, invalidate } = setup();
    /** Pull requests were last refreshed under the user's own grant. */
    syncPullRequestConnection(client, { ...connection(true), flowId: 'flow-a' });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    /** No status observer is mounted: only the mutation is. */
    const { result } = renderHook(() => useDisconnectPullRequestAccountMutation(), { wrapper });
    mockGetConnection.mockResolvedValue(connection(false));

    await act(async () => {
      await result.current.mutateAsync().catch(() => undefined);
    });

    await waitFor(() => expect(mockGetConnection).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
    expect(invalidate).toHaveBeenLastCalledWith([QueryKeys.conversationPullRequest]);
  });

  it("resets the leaving account's cached status when the session ends", async () => {
    const { client } = setup();
    client.setQueryData([QueryKeys.pullRequestConnection], connection(true));
    syncPullRequestConnection(client, connection(true));
    resetPullRequestCredentials();
    await waitFor(() =>
      expect(client.getQueryData([QueryKeys.pullRequestConnection])).toBeUndefined(),
    );
  });

  it('resets a status that arrived after Settings closed when the account changes', async () => {
    mockStartup.current = { pullRequestsEnabled: true };
    let answer: (status: TPullRequestConnection) => void = () => undefined;
    mockGetConnection.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const { client, wrapper } = setup();
    const { unmount } = renderHook(() => usePullRequestConnectionStatus(), { wrapper });
    await waitFor(() => expect(mockGetConnection).toHaveBeenCalledTimes(1));
    /** Settings closes before the first status arrives; the answer is cached with no observer. */
    unmount();
    await act(async () => {
      answer(connection(true));
    });
    expect(client.getQueryData([QueryKeys.pullRequestConnection])).toEqual(connection(true));

    resetPullRequestCredentials();
    await waitFor(() =>
      expect(client.getQueryData([QueryKeys.pullRequestConnection])).toBeUndefined(),
    );
  });

  it('leaves the next session alone when a disconnect answers after the session ended', async () => {
    let answer: (value?: unknown) => void = () => undefined;
    mockDisconnect.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { client, wrapper, invalidate } = setup();
    const { result } = renderHook(() => useDisconnectPullRequestAccountMutation(), { wrapper });

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.mutateAsync();
    });
    await waitFor(() => expect(mockDisconnect).toHaveBeenCalledTimes(1));
    /** Signed out, and the next user's status is cached, before the old disconnect answers. */
    resetPullRequestCredentials();
    client.setQueryData([QueryKeys.pullRequestConnection], connection(true));
    invalidate.mockClear();
    await act(async () => {
      answer();
      await pending;
    });

    expect(
      client.getQueryData<TPullRequestConnection>([QueryKeys.pullRequestConnection])?.connected,
    ).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
