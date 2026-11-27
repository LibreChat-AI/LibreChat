import React from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversation, TSharedLinkGetResponse } from 'librechat-data-provider';
import type { InfiniteData } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCreateSharedLinkMutation, useDeleteSharedLinkMutation } from '../mutations';

const mockCreateSharedLink = jest.fn();
const mockDeleteSharedLink = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      createSharedLink: (...args: unknown[]) => mockCreateSharedLink(...args),
      deleteSharedLink: (...args: unknown[]) => mockDeleteSharedLink(...args),
    },
  };
});

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

const createWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };

type ConversationPages = InfiniteData<{
  conversations: TConversation[];
  nextCursor: string | null;
}>;

const seedConversationList = (queryClient: QueryClient, isShared?: boolean) => {
  queryClient.setQueryData<ConversationPages>([QueryKeys.allConversations], {
    pages: [
      {
        conversations: [{ conversationId: 'conversation-1', isShared } as TConversation],
        nextCursor: null,
      },
    ],
    pageParams: [],
  });
};

const readSharedFlag = (queryClient: QueryClient) =>
  queryClient.getQueryData<ConversationPages>([QueryKeys.allConversations])?.pages[0]
    .conversations[0].isShared;

describe('shared-link mutation cache updates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('marks the sidebar conversation as shared after creating a link', async () => {
    const queryClient = createQueryClient();
    seedConversationList(queryClient, false);
    mockCreateSharedLink.mockResolvedValue({
      _id: 'shared-link-id',
      shareId: 'share-1',
      conversationId: 'conversation-1',
    });
    const { result } = renderHook(() => useCreateSharedLinkMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ conversationId: 'conversation-1' });
    });

    expect(readSharedFlag(queryClient)).toBe(true);
    queryClient.clear();
  });

  it('clears the sidebar shared flag after deleting a link', async () => {
    const queryClient = createQueryClient();
    seedConversationList(queryClient, true);
    queryClient.setQueryData<TSharedLinkGetResponse>([QueryKeys.sharedLinks, 'conversation-1'], {
      shareId: 'share-1',
      conversationId: 'conversation-1',
      success: true,
    });
    mockDeleteSharedLink.mockResolvedValue({
      success: true,
      shareId: 'share-1',
      message: 'Share deleted successfully',
    });
    const { result } = renderHook(() => useDeleteSharedLinkMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ shareId: 'share-1' });
    });

    expect(readSharedFlag(queryClient)).toBe(false);
    queryClient.clear();
  });

  it('restores the sidebar shared flag when deleting a link fails', async () => {
    const queryClient = createQueryClient();
    seedConversationList(queryClient, true);
    queryClient.setQueryData<TSharedLinkGetResponse>([QueryKeys.sharedLinks, 'conversation-1'], {
      shareId: 'share-1',
      conversationId: 'conversation-1',
      success: true,
    });
    mockDeleteSharedLink.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useDeleteSharedLinkMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ shareId: 'share-1' }).catch(() => undefined);
    });

    // The link is still live, so the badge has to come back with it.
    expect(readSharedFlag(queryClient)).toBe(true);
    queryClient.clear();
  });

  it('keeps the file opt-out in the cached link after creating it', async () => {
    const queryClient = createQueryClient();
    mockCreateSharedLink.mockResolvedValue({
      _id: 'shared-link-id',
      shareId: 'share-1',
      conversationId: 'conversation-1',
    });
    const { result } = renderHook(() => useCreateSharedLinkMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ conversationId: 'conversation-1', snapshotFiles: false });
    });

    // The response never echoes the choice; without it the dialog reads the entry as
    // the enabled default and flips the switch back on.
    expect(
      queryClient.getQueryData<TSharedLinkGetResponse>([QueryKeys.sharedLinks, 'conversation-1'])
        ?.snapshotFiles,
    ).toBe(false);
    queryClient.clear();
  });

  it('updates the active conversation link query after creating a link', async () => {
    const queryClient = createQueryClient();
    mockCreateSharedLink.mockResolvedValue({
      _id: 'shared-link-id',
      shareId: 'share-1',
      conversationId: 'conversation-1',
    });
    const { result } = renderHook(() => useCreateSharedLinkMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ conversationId: 'conversation-1' });
    });

    expect(
      queryClient.getQueryData<TSharedLinkGetResponse>([QueryKeys.sharedLinks, 'conversation-1']),
    ).toMatchObject({ shareId: 'share-1', success: true });
    queryClient.clear();
  });

  it('preserves the stored file-sharing choice and marks the settings list stale', async () => {
    const queryClient = createQueryClient();
    const listKey = [QueryKeys.sharedLinks, { pageSize: 25, sortBy: 'createdAt' }];
    queryClient.setQueryData<TSharedLinkGetResponse>([QueryKeys.sharedLinks, 'conversation-1'], {
      shareId: 'share-0',
      conversationId: 'conversation-1',
      success: true,
      snapshotFiles: false,
    });
    queryClient.setQueryData(listKey, { pages: [], pageParams: [] });
    mockCreateSharedLink.mockResolvedValue({
      _id: 'shared-link-id',
      shareId: 'share-1',
      conversationId: 'conversation-1',
    });
    const { result } = renderHook(() => useCreateSharedLinkMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ conversationId: 'conversation-1' });
    });

    expect(
      queryClient.getQueryData<TSharedLinkGetResponse>([QueryKeys.sharedLinks, 'conversation-1']),
    ).toMatchObject({ shareId: 'share-1', success: true, snapshotFiles: false });
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
    queryClient.clear();
  });

  it('clears the active conversation indicator after deleting a link', async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData<TSharedLinkGetResponse>([QueryKeys.sharedLinks, 'conversation-1'], {
      shareId: 'share-1',
      conversationId: 'conversation-1',
      success: true,
    });
    mockDeleteSharedLink.mockResolvedValue({
      success: true,
      shareId: 'share-1',
      message: 'Share deleted successfully',
    });
    const { result } = renderHook(() => useDeleteSharedLinkMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ shareId: 'share-1' });
    });

    expect(
      queryClient.getQueryData<TSharedLinkGetResponse>([QueryKeys.sharedLinks, 'conversation-1']),
    ).toMatchObject({ shareId: null, success: false });
    queryClient.clear();
  });
});
