import { createElement } from 'react';
import { getDefaultStore } from 'jotai';
import { dataService, QueryKeys } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  ConversationListResponse,
  TConversationTag,
  TConversation,
} from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  removeConvoFromAllQueries,
  updateConvoInAllQueries,
  upsertConvoInAllQueries,
  collectPinnedConversations,
  withoutListFlags,
} from '~/utils/convos';
import {
  useConversationTagMutation,
  useDeleteConversationMutation,
  useDeleteConversationTagMutation,
  usePinConversationMutation,
} from '../mutations';
import {
  pinnedConversationsPageSize,
  useConversationsInfiniteQuery,
  usePinnedConversationsQuery,
} from '../queries';
import { chatFilterTagsAtom } from '~/components/Conversations/chatFilters';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      listConversations: jest.fn(),
      pinConversation: jest.fn(),
      deleteConversation: jest.fn(),
      updateConversationTag: jest.fn(),
      deleteConversationTag: jest.fn(),
    },
  };
});

const listConversations = dataService.listConversations as jest.MockedFunction<
  typeof dataService.listConversations
>;
const pinConversation = dataService.pinConversation as jest.MockedFunction<
  typeof dataService.pinConversation
>;
const deleteConversation = dataService.deleteConversation as jest.MockedFunction<
  typeof dataService.deleteConversation
>;
const updateConversationTag = dataService.updateConversationTag as jest.MockedFunction<
  typeof dataService.updateConversationTag
>;
const deleteConversationTag = dataService.deleteConversationTag as jest.MockedFunction<
  typeof dataService.deleteConversationTag
>;

const pinnedConversationId = 'convo-pinned';

const pinnedConvo = {
  conversationId: pinnedConversationId,
  title: 'Initial Greeting',
  endpoint: 'openAI',
  pinned: true,
} as TConversation;

const listResponse = (conversations: TConversation[]): ConversationListResponse => ({
  conversations,
  nextCursor: null,
});

const createQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const createWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };

const readPinnedCache = (queryClient: QueryClient) =>
  queryClient.getQueryData<ConversationListResponse>([QueryKeys.pinnedConversations]);

beforeEach(() => {
  jest.clearAllMocks();
  getDefaultStore().set(chatFilterTagsAtom, []);
});

describe('usePinnedConversationsQuery', () => {
  it('fetches pins directly instead of filtering the paginated chats list', async () => {
    listConversations.mockResolvedValue(listResponse([pinnedConvo]));
    const queryClient = createQueryClient();

    const { result } = renderHook(() => usePinnedConversationsQuery(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listConversations).toHaveBeenCalledTimes(1);
    expect(listConversations).toHaveBeenCalledWith({
      pinned: true,
      limit: pinnedConversationsPageSize,
      cursor: undefined,
    });
    expect(result.current.data?.conversations).toEqual([pinnedConvo]);
  });

  it('does not fetch while the user is unauthenticated', async () => {
    listConversations.mockResolvedValue(listResponse([]));
    const queryClient = createQueryClient();

    const { result } = renderHook(() => usePinnedConversationsQuery({ enabled: false }), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.data).toBeUndefined();
    expect(listConversations).not.toHaveBeenCalled();
  });

  it('refetches the pinned list after a chat is pinned', async () => {
    listConversations.mockResolvedValue(listResponse([]));
    pinConversation.mockResolvedValue(pinnedConvo);
    const queryClient = createQueryClient();

    const { result } = renderHook(
      () => ({
        query: usePinnedConversationsQuery(),
        pin: usePinConversationMutation(),
      }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.query.data?.conversations).toEqual([]);

    listConversations.mockResolvedValue(listResponse([pinnedConvo]));
    await act(async () => {
      await result.current.pin.mutateAsync({
        conversationId: pinnedConvo.conversationId as string,
        pinned: true,
      });
    });

    await waitFor(() => expect(listConversations).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.query.data?.conversations).toEqual([pinnedConvo]));
  });

  /** `groupConversations` keeps pins out of the chats groups, so a pin this query
   * drops is invisible everywhere, not merely further down a list. */
  it('drains the cursor instead of truncating at one page', async () => {
    const second = { ...pinnedConvo, conversationId: 'convo-pinned-2' } as TConversation;
    listConversations
      .mockResolvedValueOnce({ conversations: [pinnedConvo], nextCursor: 'cursor-2' })
      .mockResolvedValueOnce({ conversations: [second], nextCursor: null });
    const queryClient = createQueryClient();

    const { result } = renderHook(() => usePinnedConversationsQuery(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listConversations).toHaveBeenCalledTimes(2);
    expect(listConversations).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'cursor-2' }),
    );
    expect(result.current.data?.conversations).toEqual([pinnedConvo, second]);
    expect(result.current.data?.nextCursor).toBeNull();
  });

  /** The drain rejects as a whole, so without publishing what it already has the
   * section would fall back to an empty list for every pin past the first page. */
  it('keeps the pages already drained when a later one fails', async () => {
    listConversations
      .mockResolvedValueOnce({ conversations: [pinnedConvo], nextCursor: 'cursor-2' })
      .mockRejectedValueOnce(new Error('network'));
    const queryClient = createQueryClient();

    const { result } = renderHook(() => usePinnedConversationsQuery(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(readPinnedCache(queryClient)?.conversations).toEqual([pinnedConvo]);
    expect(readPinnedCache(queryClient)?.nextCursor).toBe('cursor-2');
    expect(result.current.data?.conversations).toEqual([pinnedConvo]);
  });

  it('reports the failure when the very first page fails', async () => {
    listConversations.mockRejectedValueOnce(new Error('network'));
    const queryClient = createQueryClient();

    const { result } = renderHook(() => usePinnedConversationsQuery(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(readPinnedCache(queryClient)).toBeUndefined();
  });

  /** The Chats list's bookmark, status and sort choices narrow that list alone: a
   * curated shortcut row that emptied itself under a filter would stop being one. */
  it('ignores the chats list filters and keys one cache for every view', async () => {
    listConversations.mockResolvedValue(listResponse([pinnedConvo]));
    const queryClient = createQueryClient();

    const { result } = renderHook(() => usePinnedConversationsQuery(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listConversations).toHaveBeenCalledWith(
      expect.not.objectContaining({ tags: expect.anything() }),
    );
    expect(listConversations).toHaveBeenCalledWith(
      expect.not.objectContaining({ isArchived: expect.anything() }),
    );
    expect(queryClient.getQueryData([QueryKeys.pinnedConversations])).toBeDefined();
  });
});

describe('useConversationsInfiniteQuery', () => {
  /** A row's own `isArchived` decides what its menu offers. A backend that predates that
   *  field in the list projection would otherwise have archived rows offering Archive. */
  it('fills a missing archive state from what the variant asked for', async () => {
    listConversations.mockResolvedValue(
      listResponse([{ conversationId: 'convo-1', title: 'Archived roadmap' } as TConversation]),
    );
    const queryClient = createQueryClient();

    const { result } = renderHook(() => useConversationsInfiniteQuery({ isArchived: true }), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.pages[0].conversations[0].isArchived).toBe(true);
  });

  it('leaves an explicit archive state alone', async () => {
    listConversations.mockResolvedValue(
      listResponse([
        { conversationId: 'convo-1', title: 'Unarchived pin', isArchived: false } as TConversation,
      ]),
    );
    const queryClient = createQueryClient();

    const { result } = renderHook(() => useConversationsInfiniteQuery({ isArchived: true }), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.pages[0].conversations[0].isArchived).toBe(false);
  });
});

describe('pinned list cache synchronization', () => {
  it('drops a chat from the pinned cache as soon as it is unpinned', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData([QueryKeys.pinnedConversations], listResponse([pinnedConvo]));

    updateConvoInAllQueries(queryClient, pinnedConvo.conversationId as string, (convo) => ({
      ...convo,
      pinned: false,
    }));

    expect(readPinnedCache(queryClient)?.conversations).toEqual([]);
  });

  it('keeps a renamed pin in the section with its new title', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData([QueryKeys.pinnedConversations], listResponse([pinnedConvo]));

    updateConvoInAllQueries(queryClient, pinnedConvo.conversationId as string, (convo) => ({
      ...convo,
      title: 'Renamed',
    }));

    expect(readPinnedCache(queryClient)?.conversations).toEqual([
      { ...pinnedConvo, title: 'Renamed' },
    ]);
  });

  it('removes a deleted or archived pin from the section', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData([QueryKeys.pinnedConversations], listResponse([pinnedConvo]));

    removeConvoFromAllQueries(queryClient, pinnedConvo.conversationId as string);

    expect(readPinnedCache(queryClient)?.conversations).toEqual([]);
  });

  /** A pin that just received a message must lead the section the way it leads the
   * chats list, since the server returns pins newest-first. */
  it('moves a pin to the top when the caller asks for it', () => {
    const other = { ...pinnedConvo, conversationId: 'convo-other' } as TConversation;
    const queryClient = createQueryClient();
    queryClient.setQueryData([QueryKeys.pinnedConversations], listResponse([other, pinnedConvo]));

    updateConvoInAllQueries(
      queryClient,
      pinnedConvo.conversationId as string,
      (convo) => ({ ...convo, title: 'Replied' }),
      true,
    );

    expect(readPinnedCache(queryClient)?.conversations.map((c) => c.conversationId)).toEqual([
      'convo-pinned',
      'convo-other',
    ]);
  });

  /** The SSE payload can still carry the previous turn's timestamp, and the section is
   * sorted newest-first downstream, so the move has to refresh it or the sort undoes it. */
  it('refreshes the timestamp of a pin it moves to the top', () => {
    const stale = '2026-03-01T12:00:00.000Z';
    const other = {
      ...pinnedConvo,
      conversationId: 'convo-other',
      updatedAt: '2026-08-16T12:00:00.000Z',
    } as TConversation;
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      [QueryKeys.pinnedConversations],
      listResponse([other, { ...pinnedConvo, updatedAt: stale } as TConversation]),
    );

    updateConvoInAllQueries(
      queryClient,
      pinnedConvo.conversationId as string,
      (convo) => ({ ...convo, title: 'Replied', updatedAt: stale }),
      true,
    );

    const moved = readPinnedCache(queryClient)?.conversations[0];
    expect(moved?.conversationId).toBe('convo-pinned');
    expect(Date.parse(moved?.updatedAt ?? '')).toBeGreaterThan(Date.parse(other.updatedAt ?? ''));
    expect(
      collectPinnedConversations(readPinnedCache(queryClient)?.conversations, []).map(
        (c) => c.conversationId,
      ),
    ).toEqual(['convo-pinned', 'convo-other']);
  });

  /** A chat pinned while it is open never hears about the pin in its own conversation
   * state, so the state the SSE handlers write back still says `pinned: false`. Sending
   * a message then dropped the chat out of Pinned and back into the date groups. */
  it('keeps a pin in the section when a new turn writes back stale chat state', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData([QueryKeys.pinnedConversations], listResponse([pinnedConvo]));

    const staleChatState = { ...pinnedConvo, title: 'Replied', pinned: false } as TConversation;
    updateConvoInAllQueries(
      queryClient,
      pinnedConversationId,
      () => withoutListFlags(staleChatState),
      true,
    );

    const conversations = readPinnedCache(queryClient)?.conversations;
    expect(conversations?.map((c) => c.conversationId)).toEqual([pinnedConversationId]);
    expect(conversations?.[0].pinned).toBe(true);
    expect(conversations?.[0].title).toBe('Replied');
  });

  /** The date groups skip pinned chats, so losing the flag on the chats row put the same
   * conversation back under Today beside the section it had just left. */
  it('keeps the flag on the chats row when a new turn writes back stale chat state', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData([QueryKeys.allConversations, { tags: undefined }], {
      pages: [{ conversations: [pinnedConvo], nextCursor: null }],
      pageParams: [],
    });

    const staleChatState = { ...pinnedConvo, title: 'Replied', pinned: false } as TConversation;
    updateConvoInAllQueries(
      queryClient,
      pinnedConversationId,
      () => withoutListFlags(staleChatState),
      true,
    );

    const data = queryClient.getQueryData<{
      pages: Array<{ conversations: TConversation[] }>;
    }>([QueryKeys.allConversations, { tags: undefined }]);
    expect(data?.pages[0].conversations[0].pinned).toBe(true);
  });

  /** Root-level SSE updates take the upsert path, and an older pin may be outside the
   * loaded chats pages. The dedicated row has to supply the sidebar-owned flags when
   * upsert inserts the conversation into that cache. */
  it('keeps list flags when an older pin upserts into the chats cache', () => {
    const queryClient = createQueryClient();
    const cachedPin = { ...pinnedConvo, isShared: true } as TConversation;
    queryClient.setQueryData([QueryKeys.pinnedConversations], listResponse([cachedPin]));
    queryClient.setQueryData([QueryKeys.allConversations, { tags: undefined }], {
      pages: [
        {
          conversations: [
            {
              conversationId: 'other-recent',
              title: 'Recent',
              endpoint: 'openAI',
            } as TConversation,
          ],
          nextCursor: 'cursor-2',
        },
      ],
      pageParams: [undefined],
    });

    const staleChatState = {
      ...cachedPin,
      title: 'Replied',
      pinned: false,
      isShared: false,
    } as TConversation;
    upsertConvoInAllQueries(queryClient, withoutListFlags(staleChatState));

    expect(readPinnedCache(queryClient)?.conversations[0]).toEqual(
      expect.objectContaining({ pinned: true, isShared: true, title: 'Replied' }),
    );
    const chats = queryClient.getQueryData<{
      pages: Array<{ conversations: TConversation[] }>;
    }>([QueryKeys.allConversations, { tags: undefined }]);
    expect(chats?.pages[0].conversations[0]).toEqual(
      expect.objectContaining({
        conversationId: pinnedConversationId,
        pinned: true,
        isShared: true,
        title: 'Replied',
      }),
    );
  });

  it('withoutListFlags drops only the sidebar-owned flags', () => {
    const stripped = withoutListFlags({
      ...pinnedConvo,
      pinned: false,
      isShared: true,
    } as TConversation);

    expect('pinned' in stripped).toBe(false);
    expect('isShared' in stripped).toBe(false);
    expect(stripped.conversationId).toBe(pinnedConversationId);
    expect(stripped.title).toBe(pinnedConvo.title);
  });

  it('leaves the pinned cache untouched for an unrelated conversation', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData([QueryKeys.pinnedConversations], listResponse([pinnedConvo]));

    updateConvoInAllQueries(queryClient, 'some-other-convo', (convo) => ({
      ...convo,
      title: 'Renamed',
    }));

    expect(readPinnedCache(queryClient)?.conversations).toEqual([pinnedConvo]);
  });

  /** Root-level SSE updates and resumable settlement call upsert rather than
   * update, so the independently cached pin has to follow that path too. */
  it('updates an existing pin when the conversation is upserted', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData([QueryKeys.pinnedConversations], listResponse([pinnedConvo]));

    upsertConvoInAllQueries(queryClient, {
      ...pinnedConvo,
      title: 'Settled title',
    });

    expect(readPinnedCache(queryClient)?.conversations).toEqual([
      expect.objectContaining({ ...pinnedConvo, title: 'Settled title' }),
    ]);
  });

  it('moves an upserted pin to the top of the pinned cache', () => {
    const other = { ...pinnedConvo, conversationId: 'convo-other' } as TConversation;
    const queryClient = createQueryClient();
    queryClient.setQueryData([QueryKeys.pinnedConversations], listResponse([other, pinnedConvo]));

    upsertConvoInAllQueries(queryClient, {
      ...pinnedConvo,
      title: 'Replied',
    });

    expect(readPinnedCache(queryClient)?.conversations.map((c) => c.conversationId)).toEqual([
      'convo-pinned',
      'convo-other',
    ]);
  });

  it('does not insert a conversation that is not already in the pinned cache', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData([QueryKeys.pinnedConversations], listResponse([pinnedConvo]));

    upsertConvoInAllQueries(queryClient, {
      conversationId: 'convo-new',
      title: 'Brand new',
      endpoint: 'openAI',
      pinned: true,
    } as TConversation);

    expect(readPinnedCache(queryClient)?.conversations).toEqual([pinnedConvo]);
  });

  it('keeps the cached pinned flag when the upsert payload omits it', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData([QueryKeys.pinnedConversations], listResponse([pinnedConvo]));

    upsertConvoInAllQueries(queryClient, {
      conversationId: pinnedConvo.conversationId,
      title: 'Root turn',
      endpoint: 'openAI',
    } as TConversation);

    expect(readPinnedCache(queryClient)?.conversations).toEqual([
      expect.objectContaining({ ...pinnedConvo, title: 'Root turn' }),
    ]);
  });
});

describe('delete mutation failure recovery', () => {
  it('reports a failed delete without removing cached chats and allows a successful retry', async () => {
    const error = new Error('Request failed with status code 500');
    deleteConversation.mockRejectedValueOnce(error).mockResolvedValueOnce({
      acknowledged: true,
      deletedCount: 1,
      messages: { acknowledged: true, deletedCount: 0 },
    });
    const queryClient = createQueryClient();
    const conversationKey = [QueryKeys.conversation, pinnedConversationId];
    const pinnedKey = [QueryKeys.pinnedConversations];
    const listKeys = [QueryKeys.allConversations, QueryKeys.archivedConversations];
    queryClient.setQueryData(conversationKey, pinnedConvo);
    queryClient.setQueryData(pinnedKey, listResponse([pinnedConvo]));
    for (const key of listKeys) {
      queryClient.setQueryData([key], {
        pages: [listResponse([pinnedConvo])],
        pageParams: [undefined],
      });
    }
    const onError = jest.fn();
    const onSuccess = jest.fn();
    const payload = { conversationId: pinnedConversationId };
    const { result } = renderHook(() => useDeleteConversationMutation({ onError, onSuccess }), {
      wrapper: createWrapper(queryClient),
    });

    act(() => result.current.mutate(payload));
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error, payload, undefined);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(conversationKey)).toEqual(pinnedConvo);
    expect(queryClient.getQueryData(pinnedKey)).toEqual(listResponse([pinnedConvo]));
    for (const key of listKeys) {
      expect(queryClient.getQueryData([key])).toMatchObject({
        pages: [listResponse([pinnedConvo])],
      });
    }

    act(() => result.current.mutate(payload));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(conversationKey)).toBeUndefined();
    expect(queryClient.getQueryData(pinnedKey)).toEqual(listResponse([]));
  });
});

describe('delete mutation project lookup', () => {
  const projectId = 'project-pinned';

  it('invalidates the project when the deleted pin is only in the pinned cache', async () => {
    deleteConversation.mockResolvedValue({
      acknowledged: true,
      deletedCount: 1,
      messages: { acknowledged: true, deletedCount: 0 },
    });
    const queryClient = createQueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    queryClient.setQueryData(
      [QueryKeys.pinnedConversations],
      listResponse([{ ...pinnedConvo, chatProjectId: projectId }]),
    );

    const { result } = renderHook(() => useDeleteConversationMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      result.current.mutate({ conversationId: pinnedConversationId });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.project, projectId]);
  });
});

const tagResponse: TConversationTag = {
  _id: 'tag-office',
  user: 'user-1',
  tag: 'office',
  count: 1,
  position: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('bookmark mutations invalidate the pinned cache', () => {
  it('invalidates pins and carries a selected bookmark filter across a rename', async () => {
    updateConversationTag.mockResolvedValue(tagResponse);
    const jotaiStore = getDefaultStore();
    jotaiStore.set(chatFilterTagsAtom, ['work', 'other']);
    const queryClient = createQueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(
      () => useConversationTagMutation({ context: 'test', tag: 'work' }),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      result.current.mutate({ tag: 'office' });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.pinnedConversations]);
    expect(jotaiStore.get(chatFilterTagsAtom)).toEqual(['office', 'other']);
  });

  it('invalidates pins and removes a selected bookmark filter on delete', async () => {
    deleteConversationTag.mockResolvedValue({ ...tagResponse, tag: 'work' });
    const jotaiStore = getDefaultStore();
    jotaiStore.set(chatFilterTagsAtom, ['work', 'other']);
    const queryClient = createQueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteConversationTagMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      result.current.mutate('work');
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.pinnedConversations]);
    expect(jotaiStore.get(chatFilterTagsAtom)).toEqual(['other']);
  });
});

describe('unpinning a pin that is not on a loaded chats page', () => {
  it('does not let an older list refresh restore a successfully removed pin', async () => {
    const queryClient = createQueryClient();
    const queryKey = [QueryKeys.allConversations];
    const stalePage = { pages: [listResponse([pinnedConvo])], pageParams: [undefined] };
    queryClient.setQueryData(queryKey, stalePage);
    queryClient.setQueryData([QueryKeys.pinnedConversations], listResponse([pinnedConvo]));
    let finishRefresh!: (data: typeof stalePage) => void;
    const refresh = queryClient
      .fetchQuery(
        queryKey,
        () =>
          new Promise<typeof stalePage>((resolve) => {
            finishRefresh = resolve;
          }),
      )
      .catch(() => undefined);
    pinConversation.mockResolvedValue({ ...pinnedConvo, pinned: false });
    const { result } = renderHook(() => usePinConversationMutation(), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await result.current.mutateAsync({ conversationId: pinnedConversationId, pinned: false });
      finishRefresh(stalePage);
      await refresh;
    });
    expect(
      queryClient.getQueryData<typeof stalePage>(queryKey)?.pages[0].conversations[0].pinned,
    ).toBe(false);
    queryClient.clear();
  });

  it('inserts the unpinned conversation at the top of the chats list', async () => {
    const unpinned = { ...pinnedConvo, pinned: false } as TConversation;
    pinConversation.mockResolvedValue(unpinned);
    const queryClient = createQueryClient();
    queryClient.setQueryData([QueryKeys.pinnedConversations], listResponse([pinnedConvo]));
    queryClient.setQueryData([QueryKeys.allConversations], {
      pages: [
        {
          conversations: [
            {
              conversationId: 'other-recent',
              title: 'Recent',
              endpoint: 'openAI',
            } as TConversation,
          ],
          nextCursor: 'cursor-2',
        },
      ],
      pageParams: [undefined],
    });

    const { result } = renderHook(() => usePinConversationMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      result.current.mutate({
        conversationId: pinnedConvo.conversationId as string,
        pinned: false,
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const chats = queryClient.getQueryData<{
      pages: { conversations: TConversation[] }[];
    }>([QueryKeys.allConversations]);
    expect(
      chats?.pages[0].conversations.map((conversation) => conversation.conversationId),
    ).toEqual(['convo-pinned', 'other-recent']);
    expect(chats?.pages[0].conversations[0].pinned).toBe(false);
  });

  /** `isShared` is derived per list request, so the pin response never carries it. The
   * reinserted row has no existing chats row to merge it from, so it has to come off
   * the cached pin or the shared badge disappears until the next list refetch. */
  it('keeps the shared badge on the reinserted row', async () => {
    const unpinned = { ...pinnedConvo, pinned: false } as TConversation;
    pinConversation.mockResolvedValue(unpinned);
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      [QueryKeys.pinnedConversations],
      listResponse([{ ...pinnedConvo, isShared: true } as TConversation]),
    );
    queryClient.setQueryData([QueryKeys.allConversations], {
      pages: [{ conversations: [], nextCursor: null }],
      pageParams: [undefined],
    });

    const { result } = renderHook(() => usePinConversationMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      result.current.mutate({
        conversationId: pinnedConvo.conversationId as string,
        pinned: false,
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const chats = queryClient.getQueryData<{
      pages: { conversations: TConversation[] }[];
    }>([QueryKeys.allConversations]);
    expect(chats?.pages[0].conversations[0].conversationId).toBe('convo-pinned');
    expect(chats?.pages[0].conversations[0].isShared).toBe(true);
  });

  /** Deleting the last loaded row drops every page, so the insert has to rebuild the
   * first one instead of reading through an empty array. */
  it('rebuilds the first page when the chats cache has been emptied', async () => {
    const unpinned = { ...pinnedConvo, pinned: false } as TConversation;
    pinConversation.mockResolvedValue(unpinned);
    const queryClient = createQueryClient();
    queryClient.setQueryData([QueryKeys.pinnedConversations], listResponse([pinnedConvo]));
    queryClient.setQueryData([QueryKeys.allConversations], {
      pages: [
        {
          conversations: [
            { conversationId: 'only-chat', title: 'Only', endpoint: 'openAI' } as TConversation,
          ],
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    });
    removeConvoFromAllQueries(queryClient, 'only-chat');
    expect(
      queryClient.getQueryData<{ pages: unknown[] }>([QueryKeys.allConversations])?.pages,
    ).toEqual([]);

    const { result } = renderHook(() => usePinConversationMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      result.current.mutate({
        conversationId: pinnedConvo.conversationId as string,
        pinned: false,
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const chats = queryClient.getQueryData<{
      pages: { conversations: TConversation[] }[];
    }>([QueryKeys.allConversations]);
    expect(
      chats?.pages[0].conversations.map((conversation) => conversation.conversationId),
    ).toEqual(['convo-pinned']);
  });

  it('does not insert the unpinned chat into an unrelated bookmark cache', async () => {
    const unpinned = { ...pinnedConvo, pinned: false, tags: [] } as TConversation;
    pinConversation.mockResolvedValue(unpinned);
    const queryClient = createQueryClient();
    queryClient.setQueryData([QueryKeys.pinnedConversations], listResponse([pinnedConvo]));
    queryClient.setQueryData([QueryKeys.allConversations, { tags: ['work'] }], {
      pages: [
        {
          conversations: [
            {
              conversationId: 'work-chat',
              title: 'Work',
              endpoint: 'openAI',
              tags: ['work'],
            } as TConversation,
          ],
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    });

    const { result } = renderHook(() => usePinConversationMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      result.current.mutate({
        conversationId: pinnedConvo.conversationId as string,
        pinned: false,
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const filtered = queryClient.getQueryData<{
      pages: { conversations: TConversation[] }[];
    }>([QueryKeys.allConversations, { tags: ['work'] }]);
    expect(
      filtered?.pages[0].conversations.map((conversation) => conversation.conversationId),
    ).toEqual(['work-chat']);
  });
});
