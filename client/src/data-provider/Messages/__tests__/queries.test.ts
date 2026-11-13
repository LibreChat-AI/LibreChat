import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { Constants, QueryKeys, dataService } from 'librechat-data-provider';
import {
  QueryClient,
  focusManager,
  useQueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  useCachedMessages,
  getStableMessages,
  loadConversationMessages,
  shouldPreserveMessagesOnNotFound,
  retryMessagesOnMount,
  refetchMessagesOnMount,
  useSubagentAttachmentCallsQueries,
  useGetMessagesByConvoId,
  usePrefetchConversationMessages,
} from '../queries';
import { clearMessagesCache, hasServerFetchedReply, logger } from '~/utils';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getMessagesByConvoId: jest.fn(),
      getSubagentAttachmentCalls: jest.fn(),
    },
  };
});

jest.mock('~/utils', () => {
  const actual = jest.requireActual('~/utils');
  return {
    ...actual,
    logger: {
      ...actual.logger,
      warn: jest.fn(),
    },
  };
});

const message = (overrides: Partial<TMessage>): TMessage =>
  ({
    messageId: 'message-id',
    conversationId: 'convo-id',
    parentMessageId: '00000000-0000-0000-0000-000000000000',
    text: '',
    sender: 'User',
    isCreatedByUser: true,
    createdAt: '2026-05-21T12:00:00.000Z',
    updatedAt: '2026-05-21T12:00:00.000Z',
    ...overrides,
  }) as TMessage;

function createWrapper(queryClient: QueryClient, initialEntry: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(MemoryRouter, { initialEntries: [initialEntry] }, children),
    );
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('getStableMessages', () => {
  it('keeps cache when an empty result races with unhydrated stream messages', () => {
    const currentMessages = [
      message({ messageId: 'persisted-1' }),
      message({ messageId: 'user-2', createdAt: undefined, updatedAt: undefined }),
      message({
        messageId: 'user-2_',
        parentMessageId: 'user-2',
        isCreatedByUser: false,
        createdAt: undefined,
        updatedAt: undefined,
      }),
    ];

    const result = getStableMessages({
      pathname: '/c/convo-id',
      result: [],
      currentMessages,
      isStreaming: true,
    });

    expect(result).toBe(currentMessages);
  });

  it('keeps cache when a prefix result races with a pending assistant tail', () => {
    const currentMessages = [
      message({ messageId: 'persisted-1' }),
      message({ messageId: 'user-2', createdAt: undefined, updatedAt: undefined }),
      message({
        messageId: 'user-2_',
        parentMessageId: 'user-2',
        isCreatedByUser: false,
        createdAt: undefined,
        updatedAt: undefined,
      }),
    ];

    const result = getStableMessages({
      pathname: '/c/convo-id',
      result: [currentMessages[0]],
      currentMessages,
      isStreaming: true,
    });

    expect(result).toBe(currentMessages);
  });

  it('accepts a shorter result when the app is not streaming', () => {
    const currentMessages = [
      message({ messageId: 'persisted-1' }),
      message({
        messageId: 'user-2_',
        parentMessageId: 'user-2',
        isCreatedByUser: false,
        createdAt: undefined,
        updatedAt: undefined,
      }),
    ];
    const serverMessages = [currentMessages[0]];

    const result = getStableMessages({
      pathname: '/c/convo-id',
      result: serverMessages,
      currentMessages,
      isStreaming: false,
    });

    expect(result).toBe(serverMessages);
  });

  it('accepts a shorter result when an unhydrated message is not the assistant tail', () => {
    const currentMessages = [
      message({ messageId: 'persisted-1' }),
      message({ messageId: 'old-unhydrated', createdAt: undefined, updatedAt: undefined }),
      message({ messageId: 'persisted-3' }),
    ];
    const serverMessages = [currentMessages[0]];

    const result = getStableMessages({
      pathname: '/c/convo-id',
      result: serverMessages,
      currentMessages,
      isStreaming: true,
    });

    expect(result).toBe(serverMessages);
  });

  it('accepts a shorter result when the server result is not a prefix of cache', () => {
    const currentMessages = [
      message({ messageId: 'persisted-1' }),
      message({ messageId: 'persisted-2' }),
      message({
        messageId: 'persisted-2_',
        parentMessageId: 'persisted-2',
        isCreatedByUser: false,
        createdAt: undefined,
        updatedAt: undefined,
      }),
    ];
    const serverMessages = [message({ messageId: 'different-1' })];

    const result = getStableMessages({
      pathname: '/c/convo-id',
      result: serverMessages,
      currentMessages,
      isStreaming: true,
    });

    expect(result).toBe(serverMessages);
  });

  it('accepts a shorter result when an unhydrated assistant tail has no parent turn', () => {
    const currentMessages = [
      message({ messageId: 'persisted-1' }),
      message({
        messageId: 'orphaned-response_',
        isCreatedByUser: false,
        createdAt: undefined,
        updatedAt: undefined,
      }),
    ];
    const serverMessages = [currentMessages[0]];

    const result = getStableMessages({
      pathname: '/c/convo-id',
      result: serverMessages,
      currentMessages,
      isStreaming: true,
    });

    expect(result).toBe(serverMessages);
  });

  it('accepts fewer persisted messages when the cache is fully hydrated', () => {
    const currentMessages = [
      message({ messageId: 'persisted-1' }),
      message({ messageId: 'persisted-2' }),
      message({ messageId: 'persisted-3' }),
    ];
    const serverMessages = [currentMessages[0], currentMessages[1]];

    const result = getStableMessages({
      pathname: '/c/convo-id',
      result: serverMessages,
      currentMessages,
      isStreaming: true,
    });

    expect(result).toBe(serverMessages);
  });

  it('does not preserve cache on the new conversation route', () => {
    const currentMessages = [message({ messageId: 'user-1', createdAt: undefined })];

    const result = getStableMessages({
      pathname: '/c/new',
      result: [],
      currentMessages,
      isStreaming: true,
    });

    expect(result).toEqual([]);
  });
});

describe('shouldPreserveMessagesOnNotFound', () => {
  it('keeps cache when a transient 404 races with a pending assistant tail', () => {
    const currentMessages = [
      message({ messageId: 'persisted-1' }),
      message({ messageId: 'user-2' }),
      message({
        messageId: 'user-2_',
        parentMessageId: 'user-2',
        isCreatedByUser: false,
        createdAt: undefined,
        updatedAt: undefined,
      }),
    ];

    expect(
      shouldPreserveMessagesOnNotFound({
        pathname: '/c/convo-id',
        currentMessages,
        isStreaming: true,
      }),
    ).toBe(true);
  });

  it('does not preserve cache when no stream or active job is live', () => {
    const currentMessages = [
      message({ messageId: 'persisted-1' }),
      message({ messageId: 'user-2' }),
      message({
        messageId: 'user-2_',
        parentMessageId: 'user-2',
        isCreatedByUser: false,
        createdAt: undefined,
        updatedAt: undefined,
      }),
    ];

    expect(
      shouldPreserveMessagesOnNotFound({
        pathname: '/c/convo-id',
        currentMessages,
        isStreaming: false,
      }),
    ).toBe(false);
  });

  it('does not preserve cache on the new conversation route', () => {
    const currentMessages = [
      message({ messageId: 'user-1' }),
      message({
        messageId: 'user-1_',
        parentMessageId: 'user-1',
        isCreatedByUser: false,
        createdAt: undefined,
        updatedAt: undefined,
      }),
    ];

    expect(
      shouldPreserveMessagesOnNotFound({
        pathname: '/c/new',
        currentMessages,
        isStreaming: true,
      }),
    ).toBe(false);
  });

  it('does not preserve cache when there is no pending assistant tail', () => {
    const currentMessages = [message({ messageId: 'persisted-1' })];

    expect(
      shouldPreserveMessagesOnNotFound({
        pathname: '/c/convo-id',
        currentMessages,
        isStreaming: true,
      }),
    ).toBe(false);
  });
});

describe('useGetMessagesByConvoId', () => {
  it('observes optimistic new-chat messages without requesting them from the API', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const optimisticMessages = [message({ conversationId: Constants.NEW_CONVO as string })];

    const { result, unmount } = renderHook(() => useGetMessagesByConvoId(Constants.NEW_CONVO), {
      wrapper: createWrapper(queryClient, '/c/new'),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([]);
    });
    expect(dataService.getMessagesByConvoId).not.toHaveBeenCalled();

    act(() => {
      queryClient.setQueryData([QueryKeys.messages, Constants.NEW_CONVO], optimisticMessages);
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(optimisticMessages);
    });

    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.data).toEqual(optimisticMessages);
    expect(dataService.getMessagesByConvoId).not.toHaveBeenCalled();

    unmount();
  });

  it('loads server history after a cleared empty cache is removed', async () => {
    const conversationId = 'convo-id';
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const serverMessages = [message({ messageId: 'persisted-1' })];
    const mockGetMessagesByConvoId = dataService.getMessagesByConvoId as jest.MockedFunction<
      typeof dataService.getMessagesByConvoId
    >;
    mockGetMessagesByConvoId.mockResolvedValue(serverMessages);
    queryClient.setQueryData([QueryKeys.messages, conversationId], []);

    clearMessagesCache(queryClient, conversationId);
    expect(queryClient.getQueryData([QueryKeys.messages, conversationId])).toBeUndefined();

    const { result, unmount } = renderHook(() => useGetMessagesByConvoId(conversationId), {
      wrapper: createWrapper(queryClient, `/c/${conversationId}`),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(serverMessages);
    });
    expect(mockGetMessagesByConvoId).toHaveBeenCalledTimes(1);
    expect(mockGetMessagesByConvoId).toHaveBeenCalledWith(conversationId, { toolPreviews: true });

    unmount();
  });

  it('does not discard server history when an empty cache changes during the initial request', async () => {
    const conversationId = 'convo-id';
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const request = deferred<TMessage[]>();
    const serverMessages = [message({ messageId: 'persisted-1' })];
    const interveningMessages = [
      message({ messageId: 'intervening-user', createdAt: undefined, updatedAt: undefined }),
    ];
    const mockGetMessagesByConvoId = dataService.getMessagesByConvoId as jest.MockedFunction<
      typeof dataService.getMessagesByConvoId
    >;
    mockGetMessagesByConvoId.mockReturnValue(request.promise);

    const { result, unmount } = renderHook(() => useGetMessagesByConvoId(conversationId), {
      wrapper: createWrapper(queryClient, `/c/${conversationId}`),
    });

    await waitFor(() => {
      expect(mockGetMessagesByConvoId).toHaveBeenCalledWith(conversationId, { toolPreviews: true });
    });

    act(() => {
      queryClient.setQueryData([QueryKeys.messages, conversationId], interveningMessages);
    });

    await act(async () => {
      request.resolve(serverMessages);
      await request.promise;
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(serverMessages);
    });
    expect(queryClient.getQueryData([QueryKeys.messages, conversationId])).toEqual(serverMessages);

    unmount();
  });

  it('keeps a concurrent cache write during a warm refetch', async () => {
    const conversationId = 'convo-id';
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const request = deferred<TMessage[]>();
    const cachedMessages = [message({ messageId: 'persisted-1' })];
    const staleServerMessages = [message({ messageId: 'persisted-1', text: 'stale' })];
    const concurrentMessages = [
      ...cachedMessages,
      message({ messageId: 'new-user', createdAt: undefined, updatedAt: undefined }),
    ];
    queryClient.setQueryData([QueryKeys.messages, conversationId], cachedMessages);
    const mockGetMessagesByConvoId = dataService.getMessagesByConvoId as jest.MockedFunction<
      typeof dataService.getMessagesByConvoId
    >;
    mockGetMessagesByConvoId.mockReturnValue(request.promise);

    const { result, unmount } = renderHook(
      () => useGetMessagesByConvoId(conversationId, { enabled: false }),
      { wrapper: createWrapper(queryClient, `/c/${conversationId}`) },
    );

    const refetchPromise = result.current.refetch();

    await waitFor(() => {
      expect(mockGetMessagesByConvoId).toHaveBeenCalledWith(conversationId, { toolPreviews: true });
    });

    act(() => {
      queryClient.setQueryData([QueryKeys.messages, conversationId], concurrentMessages);
    });

    let refetchData: TMessage[] | undefined;
    await act(async () => {
      request.resolve(staleServerMessages);
      refetchData = (await refetchPromise).data;
    });

    expect(refetchData).toEqual(concurrentMessages);
    expect(queryClient.getQueryData([QueryKeys.messages, conversationId])).toEqual(
      concurrentMessages,
    );

    unmount();
  });

  it('applies fresh server data when a warm cache is unchanged during refetch', async () => {
    const conversationId = 'convo-id';
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const cachedMessages = [message({ messageId: 'persisted-1', text: 'cached' })];
    const freshServerMessages = [message({ messageId: 'persisted-1', text: 'fresh' })];
    queryClient.setQueryData([QueryKeys.messages, conversationId], cachedMessages);
    const mockGetMessagesByConvoId = dataService.getMessagesByConvoId as jest.MockedFunction<
      typeof dataService.getMessagesByConvoId
    >;
    mockGetMessagesByConvoId.mockResolvedValue(freshServerMessages);

    const { result, unmount } = renderHook(
      () => useGetMessagesByConvoId(conversationId, { enabled: false }),
      { wrapper: createWrapper(queryClient, `/c/${conversationId}`) },
    );

    let refetchData: TMessage[] | undefined;
    await act(async () => {
      refetchData = (await result.current.refetch()).data;
    });

    expect(refetchData).toEqual(freshServerMessages);
    expect(queryClient.getQueryData([QueryKeys.messages, conversationId])).toEqual(
      freshServerMessages,
    );

    unmount();
  });

  it('keeps a concurrent warm cache write when the refetch fails', async () => {
    const conversationId = 'convo-id';
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const request = deferred<TMessage[]>();
    const cachedMessages = [message({ messageId: 'persisted-1' })];
    const concurrentMessages = [
      ...cachedMessages,
      message({ messageId: 'new-user', createdAt: undefined, updatedAt: undefined }),
    ];
    queryClient.setQueryData([QueryKeys.messages, conversationId], cachedMessages);
    const mockGetMessagesByConvoId = dataService.getMessagesByConvoId as jest.MockedFunction<
      typeof dataService.getMessagesByConvoId
    >;
    mockGetMessagesByConvoId.mockReturnValue(request.promise);

    const { result, unmount } = renderHook(
      () => useGetMessagesByConvoId(conversationId, { enabled: false }),
      { wrapper: createWrapper(queryClient, `/c/${conversationId}`) },
    );

    const refetchPromise = result.current.refetch();

    await waitFor(() => {
      expect(mockGetMessagesByConvoId).toHaveBeenCalledWith(conversationId, { toolPreviews: true });
    });

    act(() => {
      queryClient.setQueryData([QueryKeys.messages, conversationId], concurrentMessages);
      request.reject({ status: 500 });
    });

    let refetchData: TMessage[] | undefined;
    await act(async () => {
      refetchData = (await refetchPromise).data;
    });

    expect(refetchData).toEqual(concurrentMessages);
    expect(queryClient.getQueryData([QueryKeys.messages, conversationId])).toEqual(
      concurrentMessages,
    );
    expect(result.current.isError).toBe(false);

    unmount();
  });

  it('keeps cache during submitting cleanup when active job cache still marks the stream active', async () => {
    const conversationId = 'convo-id';
    const currentMessages = [
      message({ messageId: 'persisted-1' }),
      message({ messageId: 'user-2', createdAt: undefined, updatedAt: undefined }),
      message({
        messageId: 'user-2_',
        parentMessageId: 'user-2',
        isCreatedByUser: false,
        createdAt: undefined,
        updatedAt: undefined,
      }),
    ];
    const serverMessages = [currentMessages[0]];
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData([QueryKeys.messages, conversationId], currentMessages);
    queryClient.setQueryData([QueryKeys.activeJobs], { activeJobIds: [conversationId] });

    const mockGetMessagesByConvoId = dataService.getMessagesByConvoId as jest.MockedFunction<
      typeof dataService.getMessagesByConvoId
    >;
    mockGetMessagesByConvoId.mockResolvedValue(serverMessages);

    const { result, unmount } = renderHook(
      () => useGetMessagesByConvoId(conversationId, undefined, { isStreaming: false }),
      { wrapper: createWrapper(queryClient, `/c/${conversationId}`) },
    );

    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.data).toBe(currentMessages);
    });
    expect(dataService.getMessagesByConvoId).toHaveBeenCalledWith(conversationId, {
      toolPreviews: true,
    });
    expect(queryClient.getQueryData([QueryKeys.messages, conversationId])).toBe(currentMessages);

    unmount();
  });

  it('keeps cache when a transient 404 races with a regenerated pending assistant tail', async () => {
    const conversationId = 'convo-id';
    const currentMessages = [
      message({ messageId: 'persisted-1' }),
      message({
        messageId: 'user-2',
        parentMessageId: 'persisted-1',
      }),
      message({
        messageId: 'user-2_',
        parentMessageId: 'user-2',
        isCreatedByUser: false,
        createdAt: undefined,
        updatedAt: undefined,
      }),
    ];
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData([QueryKeys.messages, conversationId], currentMessages);

    const mockGetMessagesByConvoId = dataService.getMessagesByConvoId as jest.MockedFunction<
      typeof dataService.getMessagesByConvoId
    >;
    mockGetMessagesByConvoId.mockRejectedValueOnce({ status: 404 });

    const { result, unmount } = renderHook(
      () => useGetMessagesByConvoId(conversationId, { enabled: false }, { isStreaming: true }),
      { wrapper: createWrapper(queryClient, `/c/${conversationId}`) },
    );

    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.data).toBe(currentMessages);
    });
    expect(dataService.getMessagesByConvoId).toHaveBeenCalledWith(conversationId, {
      toolPreviews: true,
    });
    expect(queryClient.getQueryData([QueryKeys.messages, conversationId])).toBe(currentMessages);
    expect(logger.warn).toHaveBeenCalledWith(
      'messages',
      expect.stringContaining('returned 404 while cache has a pending assistant tail'),
      currentMessages,
    );

    unmount();
  });
});

describe('useSubagentAttachmentCallsQueries', () => {
  afterEach(() => {
    jest.useRealTimers();
    focusManager.setFocused(undefined);
  });

  it('asks again on focus after the read failed, and not once it answered', async () => {
    const queryClient = new QueryClient();
    const answer = { parts: [{ toolCallId: 'subagent', calls: [{ id: 'child' }] }] };
    const params = {
      conversationId: 'convo-id',
      messageId: 'message-id',
      files: [{ toolCallId: 'child' }],
    };
    /** The first read and its three retries fail; the next one succeeds. */
    jest
      .mocked(dataService.getSubagentAttachmentCalls)
      .mockReset()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue(answer);
    jest.useFakeTimers();

    const { result, unmount } = renderHook(() => useSubagentAttachmentCallsQueries(params, true), {
      wrapper: createWrapper(queryClient, '/c/convo-id'),
    });

    await waitFor(() => expect(result.current[0].isError).toBe(true), { timeout: 20_000 });
    expect(dataService.getSubagentAttachmentCalls).toHaveBeenCalledTimes(4);
    expect(dataService.getSubagentAttachmentCalls).toHaveBeenCalledWith(params);
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(result.current[0].data).toEqual(answer));

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(dataService.getSubagentAttachmentCalls).toHaveBeenCalledTimes(5);
    unmount();
    queryClient.clear();
    jest.useRealTimers();
  });

  it('asks for more files than one lookup names in bounded batches', async () => {
    const queryClient = new QueryClient();
    jest
      .mocked(dataService.getSubagentAttachmentCalls)
      .mockReset()
      .mockResolvedValue({ parts: [] });
    const files = Array.from({ length: 40 }, (_, i) => ({ toolCallId: `child-${i}` }));

    const { result, unmount } = renderHook(
      () =>
        useSubagentAttachmentCallsQueries(
          { conversationId: 'convo-id', messageId: 'message-id', files },
          true,
        ),
      { wrapper: createWrapper(queryClient, '/c/convo-id') },
    );

    await waitFor(() => expect(result.current.every((query) => query.isSuccess)).toBe(true));
    const batches = jest
      .mocked(dataService.getSubagentAttachmentCalls)
      .mock.calls.map(([params]) => params.files.length);
    expect(batches).toEqual([32, 8]);
    unmount();
    queryClient.clear();
  });
});

describe('usePrefetchConversationMessages', () => {
  const mockGet = dataService.getMessagesByConvoId as jest.MockedFunction<
    typeof dataService.getMessagesByConvoId
  >;

  beforeEach(() => {
    mockGet.mockReset();
  });

  function newClient() {
    return new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  }

  /** The conversation view's observer, configured the way `useMessages` configures it. */
  function useView(conversationId: string) {
    const queryClient = useQueryClient();
    return useGetMessagesByConvoId(conversationId, {
      enabled: true,
      refetchOnMount: refetchMessagesOnMount,
      retryOnMount: retryMessagesOnMount(queryClient, conversationId),
    });
  }

  it('prefetches a pristine query created during render before the view subscribes', async () => {
    const conversationId = 'prefetch-rendered';
    const queryClient = newClient();
    const queryKey = [QueryKeys.messages, conversationId];
    const query = queryClient.getQueryCache().build(queryClient, { queryKey });
    expect(query.getObserversCount()).toBe(0);
    expect(query.state).toMatchObject({
      status: 'loading',
      fetchStatus: 'idle',
      data: undefined,
      errorUpdateCount: 0,
    });
    mockGet.mockResolvedValue([message({ conversationId })]);
    const wrapper = createWrapper(queryClient, `/c/${conversationId}`);
    renderHook(() => usePrefetchConversationMessages(conversationId, true), { wrapper });
    await waitFor(() => expect(query.state.status).toBe('success'));
    renderHook(() => useView(conversationId), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
    queryClient.clear();
  });

  it.each(['failed', 'fetching', 'observed', 'invalidated', 'cancelled', 'cancelled-view'])(
    'leaves an existing %s query untouched',
    async (kind) => {
      const conversationId = `prefetch-existing-${kind}`;
      const queryClient = newClient();
      const queryKey = [QueryKeys.messages, conversationId];
      const wrapper = createWrapper(queryClient, `/c/${conversationId}`);
      const pending = deferred<TMessage[]>();
      mockGet.mockReturnValue(pending.promise);
      if (kind === 'failed') {
        await queryClient
          .fetchQuery(queryKey, () => Promise.reject(new Error('failed')))
          .catch(() => {});
      } else if (kind === 'fetching') {
        void queryClient.fetchQuery(queryKey, () => pending.promise);
      } else if (kind === 'observed') {
        renderHook(() => useGetMessagesByConvoId(conversationId, { enabled: false }), { wrapper });
      } else if (kind === 'invalidated') {
        queryClient.getQueryCache().build(queryClient, { queryKey });
        await queryClient.invalidateQueries({ queryKey, refetchType: 'none' });
      } else if (kind === 'cancelled-view') {
        void queryClient.fetchQuery(queryKey, () => pending.promise);
        await queryClient.cancelQueries({ queryKey });
      } else {
        const first = renderHook(() => usePrefetchConversationMessages(conversationId, true), {
          wrapper,
        });
        await queryClient.cancelQueries({ queryKey });
        first.unmount();
        mockGet.mockClear();
      }
      const query = queryClient.getQueryCache().find(queryKey);
      const state = query?.state;
      renderHook(() => usePrefetchConversationMessages(conversationId, true), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockGet).not.toHaveBeenCalled();
      expect(query?.state).toBe(state);
      queryClient.clear();
    },
  );

  it('loads once when the view mounts after the prefetch settled', async () => {
    const conversationId = 'prefetch-settled';
    const queryClient = newClient();
    const serverMessages = [message({ conversationId, messageId: 'm1' })];
    mockGet.mockResolvedValue(serverMessages);
    const wrapper = createWrapper(queryClient, `/c/${conversationId}`);

    renderHook(() => usePrefetchConversationMessages(conversationId, true), { wrapper });
    await waitFor(() =>
      expect(queryClient.getQueryData([QueryKeys.messages, conversationId])).toEqual(
        serverMessages,
      ),
    );

    const { result } = renderHook(() => useView(conversationId), { wrapper });
    expect(result.current.data).toEqual(serverMessages);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith(conversationId, { toolPreviews: true });
  });

  it('keeps the prefetch for the view when another observer of the conversation mounts inside it', async () => {
    const conversationId = 'prefetch-nested';
    const queryClient = newClient();
    const serverMessages = [message({ conversationId, messageId: 'm1' })];
    mockGet.mockResolvedValue(serverMessages);
    const wrapper = createWrapper(queryClient, `/c/${conversationId}`);

    renderHook(() => usePrefetchConversationMessages(conversationId, true), { wrapper });
    await waitFor(() =>
      expect(queryClient.getQueryState([QueryKeys.messages, conversationId])?.status).toBe(
        'success',
      ),
    );

    function Child() {
      useGetMessagesByConvoId(conversationId, { enabled: true });
      return null;
    }
    function View() {
      useView(conversationId);
      return createElement(Child);
    }
    const Wrapper = wrapper;
    render(createElement(Wrapper, null, createElement(View)));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('joins the in-flight prefetch when the view mounts before it settles', async () => {
    const conversationId = 'prefetch-in-flight';
    const queryClient = newClient();
    const serverMessages = [message({ conversationId, messageId: 'm1' })];
    let resolve: (value: TMessage[]) => void = () => {};
    mockGet.mockImplementation(() => new Promise((r) => (resolve = r)));
    const wrapper = createWrapper(queryClient, `/c/${conversationId}`);

    renderHook(() => usePrefetchConversationMessages(conversationId, true), { wrapper });
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
    const { result } = renderHook(() => useView(conversationId), { wrapper });
    await act(async () => resolve(serverMessages));

    await waitFor(() => expect(result.current.data).toEqual(serverMessages));
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('skips a conversation the cache already holds, a new chat, search, and a disabled route', async () => {
    const queryClient = newClient();
    queryClient.setQueryData([QueryKeys.messages, 'prefetch-warm'], []);
    const wrapper = createWrapper(queryClient, '/c/new');

    renderHook(() => usePrefetchConversationMessages('prefetch-warm', true), { wrapper });
    renderHook(() => usePrefetchConversationMessages(Constants.NEW_CONVO as string, true), {
      wrapper,
    });
    renderHook(() => usePrefetchConversationMessages(Constants.SEARCH as string, true), {
      wrapper,
    });
    renderHook(() => usePrefetchConversationMessages('prefetch-disabled', false), { wrapper });
    renderHook(() => usePrefetchConversationMessages('', true), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockGet).not.toHaveBeenCalled();
  });

  it('shows a missing conversation without requesting its messages a second time', async () => {
    const conversationId = 'prefetch-missing';
    const queryClient = newClient();
    mockGet.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
    const wrapper = createWrapper(queryClient, `/c/${conversationId}`);

    renderHook(() => usePrefetchConversationMessages(conversationId, true), { wrapper });
    await waitFor(() =>
      expect(queryClient.getQueryState([QueryKeys.messages, conversationId])?.status).toBe('error'),
    );

    const { result } = renderHook(() => useView(conversationId), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a network failure', new Error('offline')],
    ['a rate limit', Object.assign(new Error('Too many requests'), { status: 429 })],
    ['a request timeout', Object.assign(new Error('Request timeout'), { status: 408 })],
  ])('retries %s during the prefetch the way the view would have', async (_label, failure) => {
    const conversationId = `prefetch-transient-${(failure as { status?: number }).status ?? 'network'}`;
    const queryClient = newClient();
    const serverMessages = [message({ conversationId, messageId: 'm1' })];
    mockGet.mockRejectedValueOnce(failure).mockResolvedValueOnce(serverMessages);
    const wrapper = createWrapper(queryClient, `/c/${conversationId}`);

    renderHook(() => usePrefetchConversationMessages(conversationId, true), { wrapper });
    await waitFor(() =>
      expect(queryClient.getQueryData([QueryKeys.messages, conversationId])).toEqual(
        serverMessages,
      ),
    );

    const { result } = renderHook(() => useView(conversationId), { wrapper });
    expect(result.current.data).toEqual(serverMessages);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('retries a failed entry on mount when the failure is not a fresh prefetch', async () => {
    const conversationId = 'prefetch-stale-error';
    const queryClient = newClient();
    const serverMessages = [message({ conversationId, messageId: 'm1' })];
    mockGet
      .mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }))
      .mockResolvedValueOnce(serverMessages);
    const wrapper = createWrapper(queryClient, `/c/${conversationId}`);

    renderHook(() => usePrefetchConversationMessages(conversationId, true), { wrapper });
    await waitFor(() =>
      expect(queryClient.getQueryState([QueryKeys.messages, conversationId])?.status).toBe('error'),
    );
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    try {
      const { result } = renderHook(() => useView(conversationId), { wrapper });
      await waitFor(() => expect(result.current.data).toEqual(serverMessages));
      expect(mockGet).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('refetches on mount when the prefetched payload was invalidated before the view mounted', async () => {
    const conversationId = 'prefetch-invalidated';
    const queryClient = newClient();
    mockGet.mockResolvedValue([message({ conversationId, messageId: 'm1' })]);
    const wrapper = createWrapper(queryClient, `/c/${conversationId}`);

    renderHook(() => usePrefetchConversationMessages(conversationId, true), { wrapper });
    await waitFor(() =>
      expect(queryClient.getQueryState([QueryKeys.messages, conversationId])?.status).toBe(
        'success',
      ),
    );
    await act(async () => {
      await queryClient.invalidateQueries([QueryKeys.messages, conversationId]);
    });
    expect(mockGet).toHaveBeenCalledTimes(1);

    renderHook(() => useView(conversationId), { wrapper });
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  });

  it('keeps a failed prefetch from being requested again by an observer inside the view', async () => {
    const conversationId = 'prefetch-nested-failure';
    const queryClient = newClient();
    mockGet.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
    const wrapper = createWrapper(queryClient, `/c/${conversationId}`);

    renderHook(() => usePrefetchConversationMessages(conversationId, true), { wrapper });
    await waitFor(() =>
      expect(queryClient.getQueryState([QueryKeys.messages, conversationId])?.status).toBe('error'),
    );

    function Child() {
      useGetMessagesByConvoId(conversationId, { enabled: true });
      return null;
    }
    function View() {
      useView(conversationId);
      return createElement(Child);
    }
    const Wrapper = wrapper;
    render(createElement(Wrapper, null, createElement(View)));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('proves the prefetched history against the reply the conversation record names', async () => {
    const conversationId = 'prefetch-reply-proof';
    const queryClient = newClient();
    const stamp = '2026-11-08T12:00:00.000Z';
    mockGet.mockResolvedValue([
      message({ conversationId, messageId: 'question' }),
      message({ conversationId, messageId: 'reply', isCreatedByUser: false, sender: 'Assistant' }),
    ]);
    const wrapper = createWrapper(queryClient, `/c/${conversationId}`);

    renderHook(() => usePrefetchConversationMessages(conversationId, true), { wrapper });
    await waitFor(() =>
      expect(queryClient.getQueryState([QueryKeys.messages, conversationId])?.status).toBe(
        'success',
      ),
    );
    expect(hasServerFetchedReply(queryClient, conversationId, stamp)).toBe(false);

    act(() => {
      queryClient.setQueryData([QueryKeys.conversation, conversationId], {
        conversationId,
        lastResponseAt: stamp,
        lastResponseMessageId: 'reply',
      });
    });
    expect(hasServerFetchedReply(queryClient, conversationId, stamp)).toBe(true);
  });

  it('leaves a reply newer than the prefetched history unproven', async () => {
    const conversationId = 'prefetch-newer-reply';
    const queryClient = newClient();
    const stamp = '2026-11-08T12:05:00.000Z';
    mockGet.mockResolvedValue([message({ conversationId, messageId: 'older-reply' })]);
    const wrapper = createWrapper(queryClient, `/c/${conversationId}`);

    renderHook(() => usePrefetchConversationMessages(conversationId, true), { wrapper });
    await waitFor(() =>
      expect(queryClient.getQueryState([QueryKeys.messages, conversationId])?.status).toBe(
        'success',
      ),
    );
    act(() => {
      queryClient.setQueryData([QueryKeys.conversation, conversationId], {
        conversationId,
        lastResponseAt: stamp,
        lastResponseMessageId: 'newer-reply',
      });
    });
    expect(hasServerFetchedReply(queryClient, conversationId, stamp)).toBe(false);
  });

  it('reconciles on every mount after the first, as before', async () => {
    const conversationId = 'prefetch-remount';
    const queryClient = newClient();
    mockGet.mockResolvedValue([message({ conversationId, messageId: 'm1' })]);
    const wrapper = createWrapper(queryClient, `/c/${conversationId}`);

    renderHook(() => usePrefetchConversationMessages(conversationId, true), { wrapper });
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(queryClient.getQueryState([QueryKeys.messages, conversationId])?.status).toBe(
        'success',
      ),
    );

    const first = renderHook(() => useView(conversationId), { wrapper });
    first.unmount();
    expect(mockGet).toHaveBeenCalledTimes(1);

    renderHook(() => useView(conversationId), { wrapper });
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  });

  it('refetches on mount once the prefetched payload is no longer fresh', async () => {
    const conversationId = 'prefetch-expired';
    const queryClient = newClient();
    mockGet.mockResolvedValue([message({ conversationId, messageId: 'm1' })]);
    const wrapper = createWrapper(queryClient, `/c/${conversationId}`);

    renderHook(() => usePrefetchConversationMessages(conversationId, true), { wrapper });
    await waitFor(() =>
      expect(queryClient.getQueryState([QueryKeys.messages, conversationId])?.status).toBe(
        'success',
      ),
    );
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    try {
      renderHook(() => useView(conversationId), { wrapper });
      await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    } finally {
      clock.mockRestore();
    }
  });
});

describe('useCachedMessages', () => {
  it('shares early history with readers whose conversation hydrates later', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const history = [message({ messageId: 'early-history' })];
    jest.mocked(dataService.getMessagesByConvoId).mockResolvedValue(history);
    const { result, rerender, unmount } = renderHook(
      ({ selectedId }: { selectedId: string }) => ({
        owner: useGetMessagesByConvoId('convo-id', { refetchOnMount: true }),
        reader: useCachedMessages(selectedId, (messages) =>
          messages.map((entry) => entry.messageId),
        ),
      }),
      { initialProps: { selectedId: '' }, wrapper: createWrapper(queryClient, '/c/convo-id') },
    );
    await waitFor(() => expect(result.current.owner.data).toEqual(history));
    rerender({ selectedId: 'convo-id' });
    await waitFor(() => expect(result.current.reader.data).toEqual(['early-history']));
    expect(dataService.getMessagesByConvoId).toHaveBeenCalledTimes(1);
    act(() => {
      queryClient.setQueryData(
        [QueryKeys.messages, 'convo-id'],
        [...history, message({ messageId: 'streamed' })],
      );
    });
    await waitFor(() => expect(result.current.reader.data).toEqual(['early-history', 'streamed']));
    expect(dataService.getMessagesByConvoId).toHaveBeenCalledTimes(1);
    unmount();
    queryClient.clear();
  });
});

describe('early session reply proof', () => {
  const conversationId = 'early-session-proof';
  const stamp = '2026-11-09T12:00:00.000Z';
  const queryKey = [QueryKeys.messages, conversationId];
  const history = [message({ conversationId, messageId: 'reply', isCreatedByUser: false })];
  let queryClient: QueryClient;
  const mockGet = jest.mocked(dataService.getMessagesByConvoId);

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockGet.mockReset();
    mockGet.mockResolvedValue(history);
  });

  afterEach(() => queryClient.clear());

  function record(overrides = {}) {
    queryClient.setQueryData([QueryKeys.conversation, conversationId], {
      conversationId,
      lastResponseAt: stamp,
      lastResponseMessageId: 'reply',
      ...overrides,
    });
  }

  function load() {
    return queryClient.fetchQuery(queryKey, () =>
      loadConversationMessages(queryClient, conversationId, {
        pathname: `/c/${conversationId}`,
        isStreaming: () => false,
      }),
    );
  }

  it('shares the early session load with route prefetch and readers that hydrate after the record', async () => {
    const { result, rerender, unmount } = renderHook(
      ({ selectedId }) => {
        const owner = useGetMessagesByConvoId(conversationId, {
          refetchOnMount: refetchMessagesOnMount,
        });
        usePrefetchConversationMessages(conversationId, true);
        const reader = useCachedMessages(selectedId);
        return { owner, reader };
      },
      {
        initialProps: { selectedId: '' },
        wrapper: createWrapper(queryClient, `/c/${conversationId}`),
      },
    );
    await waitFor(() => expect(result.current.owner.data).toEqual(history));
    act(() => record());
    rerender({ selectedId: conversationId });
    await waitFor(() => expect(result.current.reader.data).toEqual(history));
    expect(hasServerFetchedReply(queryClient, conversationId, stamp)).toBe(true);
    expect(mockGet).toHaveBeenCalledTimes(1);
    unmount();
  });

  it.each(['before', 'during', 'after'])(
    'proves the accepted history when the record arrives %s its fetch',
    async (arrival) => {
      const request = deferred<TMessage[]>();
      mockGet.mockReturnValue(request.promise);
      if (arrival === 'before') record();
      const pending = load();
      if (arrival === 'during') record();
      request.resolve(history);
      await pending;
      if (arrival === 'after') {
        expect(hasServerFetchedReply(queryClient, conversationId, stamp)).toBe(false);
        record();
      }
      expect(hasServerFetchedReply(queryClient, conversationId, stamp)).toBe(true);
      expect(mockGet).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { lastResponseMessageId: 'newer-absent-reply' },
    { lastResponseIsManual: true },
    { lastResponseMessageId: undefined },
  ])('leaves unmatched or manual records unproven: %o', async (overrides) => {
    await load();
    record(overrides);
    expect(hasServerFetchedReply(queryClient, conversationId, stamp)).toBe(false);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('does not prove an invalidated payload before a fresh accepted fetch', async () => {
    await load();
    await queryClient.invalidateQueries({ queryKey, refetchType: 'none' });
    record();
    expect(hasServerFetchedReply(queryClient, conversationId, stamp)).toBe(false);
    await load();
    expect(hasServerFetchedReply(queryClient, conversationId, stamp)).toBe(true);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('retires eligibility on a manual write even if structural sharing retains the array', async () => {
    await load();
    const accepted = queryClient.getQueryData(queryKey);
    queryClient.setQueryData(queryKey, accepted);
    expect(queryClient.getQueryData(queryKey)).toBe(accepted);
    record();
    expect(hasServerFetchedReply(queryClient, conversationId, stamp)).toBe(false);
  });

  it('retires the previous payload while a replacement fetch is pending', async () => {
    await load();
    const request = deferred<TMessage[]>();
    mockGet.mockReturnValue(request.promise);
    const pending = load();
    record();
    expect(hasServerFetchedReply(queryClient, conversationId, stamp)).toBe(false);
    request.resolve(history);
    await pending;
    expect(hasServerFetchedReply(queryClient, conversationId, stamp)).toBe(true);
  });

  it('does not restore eligibility after a replacement fetch fails', async () => {
    await load();
    mockGet.mockRejectedValue(new Error('offline'));
    await expect(load()).rejects.toThrow('offline');
    record();
    expect(hasServerFetchedReply(queryClient, conversationId, stamp)).toBe(false);
  });

  it('does not transfer eligibility to a replacement query', async () => {
    await load();
    queryClient.removeQueries(queryKey);
    queryClient.setQueryData(queryKey, history);
    record();
    expect(hasServerFetchedReply(queryClient, conversationId, stamp)).toBe(false);
  });

  it('does not prove a cold fetch that raced with an optimistic write', async () => {
    const request = deferred<TMessage[]>();
    mockGet.mockReturnValue(request.promise);
    const pending = load();
    queryClient.setQueryData(queryKey, [message({ conversationId, messageId: 'optimistic' })]);
    request.resolve(history);
    await pending;
    record();
    expect(hasServerFetchedReply(queryClient, conversationId, stamp)).toBe(false);
  });

  it('keeps an optimistic warm-cache winner unproven', async () => {
    queryClient.setQueryData(queryKey, [message({ conversationId, messageId: 'old' })]);
    const request = deferred<TMessage[]>();
    mockGet.mockReturnValue(request.promise);
    const pending = load();
    const optimistic = [...history, message({ conversationId, messageId: 'optimistic' })];
    queryClient.setQueryData(queryKey, optimistic);
    request.resolve(history);
    await pending;
    record();
    expect(queryClient.getQueryData(queryKey)).toEqual(optimistic);
    expect(hasServerFetchedReply(queryClient, conversationId, stamp)).toBe(false);
  });
});
