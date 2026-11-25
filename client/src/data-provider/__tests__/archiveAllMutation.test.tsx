import React from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useArchiveAllConversationsMutation } from '../mutations';

const mockArchiveAllConversations = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      archiveAllConversations: (...args: unknown[]) => mockArchiveAllConversations(...args),
    },
  };
});

const createWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };

describe('archive-all mutation cache refresh', () => {
  beforeEach(() => {
    mockArchiveAllConversations.mockReset();
  });

  /** Nothing cached survives archiving everything, but an unmounted variant is dropped
   *  rather than refetched: it reconciles from scratch when something mounts it. */
  it('drops inactive list variants and detail caches', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const archivedQuery = jest.fn().mockResolvedValue({ pages: [], pageParams: [] });
    const archivedKey = [QueryKeys.archivedConversations, { isArchived: true }];
    const projectKey = [QueryKeys.project, 'project-1'];
    const conversationKey = [QueryKeys.conversation, 'conversation-1'];

    await queryClient.fetchQuery(archivedKey, archivedQuery);
    queryClient.setQueryData(projectKey, { _id: 'project-1', conversationCount: 1 });
    queryClient.setQueryData(conversationKey, {
      conversationId: 'conversation-1',
      isArchived: false,
    });

    mockArchiveAllConversations.mockResolvedValue({ archivedCount: 1 });
    const { result } = renderHook(() => useArchiveAllConversationsMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync();
    });

    await waitFor(() => {
      expect(queryClient.getQueryData(archivedKey)).toBeUndefined();
    });
    expect(archivedQuery).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(projectKey)).toBeUndefined();
    expect(queryClient.getQueryData(conversationKey)).toBeUndefined();

    queryClient.clear();
  });

  it('refetches active project detail queries', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const projectQuery = jest.fn().mockResolvedValue({ _id: 'project-1', conversationCount: 1 });

    mockArchiveAllConversations.mockResolvedValue({ archivedCount: 1 });
    const { result } = renderHook(
      () => ({
        archiveAll: useArchiveAllConversationsMutation(),
        project: useQuery([QueryKeys.project, 'project-1'], projectQuery),
      }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.project.isSuccess).toBe(true);
      expect(projectQuery).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await result.current.archiveAll.mutateAsync();
    });

    await waitFor(() => {
      expect(projectQuery).toHaveBeenCalledTimes(2);
    });

    queryClient.clear();
  });

  it('refetches the pinned section so archived pins leave the sidebar', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 5 * 60 * 1000 },
        mutations: { retry: false },
      },
    });
    const pinnedQuery = jest.fn().mockResolvedValue({ conversations: [], nextCursor: null });

    mockArchiveAllConversations.mockResolvedValue({ archivedCount: 1 });
    const { result } = renderHook(
      () => ({
        archiveAll: useArchiveAllConversationsMutation(),
        pinned: useQuery([QueryKeys.pinnedConversations, { pinned: true }], pinnedQuery),
      }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.pinned.isSuccess).toBe(true);
      expect(pinnedQuery).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await result.current.archiveAll.mutateAsync();
    });

    await waitFor(() => {
      expect(pinnedQuery).toHaveBeenCalledTimes(2);
    });

    queryClient.clear();
  });

  it('refetches the pinned section when the request fails after a partial archive', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 5 * 60 * 1000 },
        mutations: { retry: false },
      },
    });
    const pinnedQuery = jest.fn().mockResolvedValue({ conversations: [], nextCursor: null });

    mockArchiveAllConversations.mockRejectedValue(new Error('later archive batch failed'));
    const { result } = renderHook(
      () => ({
        archiveAll: useArchiveAllConversationsMutation(),
        pinned: useQuery([QueryKeys.pinnedConversations, { pinned: true }], pinnedQuery),
      }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.pinned.isSuccess).toBe(true);
      expect(pinnedQuery).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await expect(result.current.archiveAll.mutateAsync()).rejects.toThrow(
        'later archive batch failed',
      );
    });

    await waitFor(() => {
      expect(pinnedQuery).toHaveBeenCalledTimes(2);
    });

    queryClient.clear();
  });

  it('reconciles caches when the request fails after a partial archive', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const archivedQuery = jest.fn().mockResolvedValue({ pages: [], pageParams: [] });
    const archivedKey = [QueryKeys.archivedConversations, { isArchived: true }];
    const projectKey = [QueryKeys.project, 'project-1'];
    const conversationKey = [QueryKeys.conversation, 'conversation-1'];

    await queryClient.fetchQuery(archivedKey, archivedQuery);
    queryClient.setQueryData(projectKey, { _id: 'project-1', conversationCount: 1 });
    queryClient.setQueryData(conversationKey, {
      conversationId: 'conversation-1',
      isArchived: false,
    });

    mockArchiveAllConversations.mockRejectedValue(new Error('later archive batch failed'));
    const { result } = renderHook(() => useArchiveAllConversationsMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toThrow('later archive batch failed');
    });

    await waitFor(() => {
      expect(queryClient.getQueryData(archivedKey)).toBeUndefined();
    });
    expect(queryClient.getQueryData(projectKey)).toBeUndefined();
    expect(queryClient.getQueryData(conversationKey)).toBeUndefined();

    queryClient.clear();
  });
});
