import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Constants, QueryKeys, dataService } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  getStableMessages,
  shouldPreserveMessagesOnNotFound,
  useGetMessagesByConvoId,
} from '../queries';
import { clearMessagesCache, logger } from '~/utils';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getMessagesByConvoId: jest.fn(),
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
  jest.resetAllMocks();
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
  it('aborts the message request when the query is no longer observed', async () => {
    const conversationId = 'convo-id';
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let requestSignal: AbortSignal | undefined;
    const mockGetMessagesByConvoId = dataService.getMessagesByConvoId as jest.MockedFunction<
      typeof dataService.getMessagesByConvoId
    >;
    mockGetMessagesByConvoId.mockImplementation((_conversationId, signal) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });

    const { unmount } = renderHook(() => useGetMessagesByConvoId(conversationId), {
      wrapper: createWrapper(queryClient, `/c/${conversationId}`),
    });

    await waitFor(() => {
      expect(requestSignal).toBeInstanceOf(AbortSignal);
    });
    unmount();

    expect(requestSignal?.aborted).toBe(true);
  });

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
    expect(mockGetMessagesByConvoId).toHaveBeenCalledWith(conversationId, expect.any(AbortSignal));

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
      expect(mockGetMessagesByConvoId).toHaveBeenCalledWith(
        conversationId,
        expect.any(AbortSignal),
      );
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
      expect(mockGetMessagesByConvoId).toHaveBeenCalledWith(
        conversationId,
        expect.any(AbortSignal),
      );
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
      expect(mockGetMessagesByConvoId).toHaveBeenCalledWith(
        conversationId,
        expect.any(AbortSignal),
      );
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
    expect(dataService.getMessagesByConvoId).toHaveBeenCalledWith(
      conversationId,
      expect.any(AbortSignal),
    );
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
    expect(dataService.getMessagesByConvoId).toHaveBeenCalledWith(
      conversationId,
      expect.any(AbortSignal),
    );
    expect(queryClient.getQueryData([QueryKeys.messages, conversationId])).toBe(currentMessages);
    expect(logger.warn).toHaveBeenCalledWith(
      'messages',
      expect.stringContaining('returned 404 while cache has a pending assistant tail'),
      currentMessages,
    );

    unmount();
  });
});
