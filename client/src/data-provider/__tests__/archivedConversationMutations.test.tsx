import React from 'react';
import { dataService, QueryKeys } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useInfiniteQuery, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConversationListResponse, TConversation } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  useArchiveConvoMutation,
  usePinConversationMutation,
  useUpdateConversationMutation,
} from '../mutations';
import useUpdateTagsInConvo from '~/hooks/Conversations/useUpdateTagsInConvo';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      updateConversation: jest.fn(),
      pinConversation: jest.fn(),
      archiveConversation: jest.fn(),
      listConversations: jest.fn(),
    },
  };
});

const updateConversation = dataService.updateConversation as jest.MockedFunction<
  typeof dataService.updateConversation
>;
const pinConversation = dataService.pinConversation as jest.MockedFunction<
  typeof dataService.pinConversation
>;
const archiveConversation = dataService.archiveConversation as jest.MockedFunction<
  typeof dataService.archiveConversation
>;

const archivedKey = [QueryKeys.archivedConversations, { isArchived: true }];

const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

const createWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };

const archivedConversation = {
  conversationId: 'archived-1',
  title: 'Old title',
  isArchived: true,
  pinned: false,
} as TConversation;

const listResponse = (conversations: TConversation[], nextCursor: string | null = null) => ({
  conversations,
  nextCursor,
});

describe('archived conversation mutation cache reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('invalidates archived variants after a rename changes title ordering', async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(archivedKey, {
      pages: [listResponse([archivedConversation])],
      pageParams: [undefined],
    });
    updateConversation.mockResolvedValue({
      ...archivedConversation,
      title: 'New title',
      updatedAt: '2026-09-12T00:00:00.000Z',
    });

    const { result } = renderHook(() => useUpdateConversationMutation('archived-1'), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ conversationId: 'archived-1', title: 'New title' });
    });

    expect(queryClient.getQueryState(archivedKey)?.isInvalidated).toBe(true);
  });

  it('invalidates archived variants when pin state changes', async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(archivedKey, {
      pages: [listResponse([archivedConversation])],
      pageParams: [undefined],
    });
    pinConversation.mockResolvedValue({ ...archivedConversation, pinned: true });

    const { result } = renderHook(() => usePinConversationMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ conversationId: 'archived-1', pinned: true });
    });

    expect(queryClient.getQueryState(archivedKey)?.isInvalidated).toBe(true);
  });

  it('updates and invalidates archived variants when a tag removal changes membership', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData([QueryKeys.conversation, archivedConversation.conversationId], {
      ...archivedConversation,
      tags: ['bookmark'],
    });
    queryClient.setQueryData(archivedKey, {
      pages: [listResponse([{ ...archivedConversation, tags: ['bookmark'] } as TConversation])],
      pageParams: [undefined],
    });

    const { result } = renderHook(() => useUpdateTagsInConvo(), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.updateTagsInConversation('archived-1', []);
    });

    const cached = queryClient.getQueryData<{
      pages: Array<{ conversations: TConversation[] }>;
    }>(archivedKey);
    expect(cached?.pages[0].conversations[0].tags).toEqual([]);
    expect(queryClient.getQueryState(archivedKey)?.isInvalidated).toBe(true);
  });

  it('marks inactive archived variants stale without refetching them', async () => {
    const queryClient = createQueryClient();
    const firstPage = listResponse(
      [
        { ...archivedConversation, conversationId: 'archived-first', title: 'A' },
      ] as TConversation[],
      'cursor-2',
    );
    const oldSecondPage = listResponse([
      { ...archivedConversation, conversationId: 'archived-second', title: 'B' },
    ] as TConversation[]);
    const archivedQuery = jest.fn(({ pageParam }: { pageParam?: string }) =>
      Promise.resolve(pageParam === 'cursor-2' ? oldSecondPage : firstPage),
    );

    await queryClient.fetchInfiniteQuery(archivedKey, archivedQuery, {
      getNextPageParam: (page: ConversationListResponse) => page.nextCursor,
    });
    queryClient.setQueryData(archivedKey, {
      pages: [firstPage, oldSecondPage],
      pageParams: [undefined, 'cursor-2'],
    });
    archiveConversation.mockResolvedValue({ ...archivedConversation, isArchived: true });

    const { result } = renderHook(() => useArchiveConvoMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ conversationId: 'archived-1', isArchived: true });
    });

    expect(archivedQuery).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(archivedKey)?.isInvalidated).toBe(true);
  });

  it('refetches every loaded active page when restoring a row onto a later page', async () => {
    const queryClient = createQueryClient();
    const activeKey = [
      QueryKeys.allConversations,
      {
        isArchived: false,
        sortBy: 'title',
        sortDirection: 'asc',
        tags: [],
        search: undefined,
        projectId: undefined,
      },
    ];
    const firstPage = listResponse(
      [{ ...archivedConversation, conversationId: 'active-first', title: 'A' }] as TConversation[],
      'cursor-2',
    );
    const staleSecondPage = listResponse([
      { ...archivedConversation, conversationId: 'active-second', title: 'B' },
    ] as TConversation[]);
    const restored = { ...archivedConversation, isArchived: false };
    const restoredSecondPage = listResponse([restored], null);
    const activeQuery = jest.fn(({ pageParam }: { pageParam?: string }) =>
      Promise.resolve(pageParam === 'cursor-2' ? restoredSecondPage : firstPage),
    );

    const { result: activeResult } = renderHook(
      () =>
        useInfiniteQuery<ConversationListResponse>({
          queryKey: activeKey,
          queryFn: ({ pageParam }) => activeQuery({ pageParam: pageParam as string | undefined }),
          getNextPageParam: (page) => page.nextCursor,
        }),
      { wrapper: createWrapper(queryClient) },
    );
    await waitFor(() => expect(activeResult.current.isSuccess).toBe(true));
    queryClient.setQueryData(activeKey, {
      pages: [firstPage, staleSecondPage],
      pageParams: [undefined, 'cursor-2'],
    });
    archiveConversation.mockResolvedValue(restored);

    const { result } = renderHook(() => useArchiveConvoMutation(), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await result.current.mutateAsync({
        conversationId: restored.conversationId!,
        isArchived: false,
      });
    });

    await waitFor(() => {
      const cached = queryClient.getQueryData<{
        pages: Array<{ conversations: TConversation[] }>;
      }>(activeKey);
      expect(cached?.pages[1].conversations).toEqual([restored]);
    });
  });
});
