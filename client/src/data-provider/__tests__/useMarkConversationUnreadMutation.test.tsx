import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { EModelEndpoint, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import type { ConversationCursorData } from '~/utils/convos';
import { useMarkConversationSeenMutation, useMarkConversationUnreadMutation } from '../mutations';
import { isConversationUnseen, updateConvoInAllQueries } from '~/utils';

const mockMarkUnread = jest.fn();
const mockMarkSeen = jest.fn();
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      markConversationUnread: (...args: unknown[]) => mockMarkUnread(...args),
      markConversationSeen: (...args: unknown[]) => mockMarkSeen(...args),
    },
  };
});

const CONVO_ID = 'convo-unread';
const listKey = [QueryKeys.allConversations, { isArchived: false }];
const archivedKey = [QueryKeys.archivedConversations, { isArchived: true }];
const RESPONDED_AT = '2026-08-16T10:00:00.000Z';
const SEEN_AT = '2026-08-16T11:00:00.000Z';

/** Stands in for a list refetch committing whatever the server last told it. */
function seedList(queryClient: QueryClient, lastResponseAt?: string, lastSeenAt?: string) {
  queryClient.setQueryData<InfiniteData<ConversationCursorData>>(listKey, {
    pages: [
      {
        conversations: [
          {
            conversationId: CONVO_ID,
            title: 'Flagged',
            endpoint: EModelEndpoint.openAI,
            createdAt: RESPONDED_AT,
            updatedAt: SEEN_AT,
            lastResponseAt,
            lastResponseMessageId: lastResponseAt == null ? undefined : 'original-reply',
            lastSeenAt,
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [null],
  });
}

function setup(lastResponseAt?: string, lastSeenAt?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedList(queryClient, lastResponseAt, lastSeenAt);

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  const view = renderHook(() => useMarkConversationUnreadMutation(), { wrapper });
  const cached = () =>
    queryClient.getQueryData<InfiniteData<ConversationCursorData>>(listKey)?.pages[0]
      .conversations[0];

  return { ...view, cached, queryClient, wrapper };
}

describe('useMarkConversationUnreadMutation', () => {
  beforeEach(() => {
    mockMarkUnread.mockReset();
    mockMarkSeen.mockReset();
  });

  it('reasserts the unread state when a refetch lands on top of it', async () => {
    /* A list refetch already in flight can have read the old catch-up and commit after the
       optimistic clear, quietly taking the dot back off a conversation the server did flag. */
    mockMarkUnread.mockResolvedValue({ modified: true, lastResponseAt: RESPONDED_AT });
    const { result, cached, queryClient } = setup(RESPONDED_AT, SEEN_AT);

    await act(async () => {
      const pending = result.current.mutateAsync({ conversationId: CONVO_ID });
      seedList(queryClient, RESPONDED_AT, SEEN_AT);
      await pending;
    });

    await waitFor(() => expect(isConversationUnseen(cached())).toBe(true));
    expect(cached()?.lastSeenAt).toBeUndefined();
  });

  it('preserves a later seen operation even when its stamp equals the original catch-up', async () => {
    const request = deferred();
    mockMarkUnread.mockReturnValue(request.promise);
    mockMarkSeen.mockResolvedValue({ modified: true });
    const { result, cached, wrapper } = setup(RESPONDED_AT, RESPONDED_AT);
    const seen = renderHook(() => useMarkConversationSeenMutation(), { wrapper });

    await act(async () => {
      const unread = result.current.mutateAsync({ conversationId: CONVO_ID });
      await flush();
      await seen.result.current.mutateAsync({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_AT,
      });
      request.resolve({ modified: true, lastResponseAt: RESPONDED_AT });
      await unread;
    });

    expect(cached()?.lastSeenAt).toBe(RESPONDED_AT);
    expect(isConversationUnseen(cached())).toBe(false);
  });

  it('preserves an acknowledgement that landed while the unread request was open', async () => {
    /* The user flags the conversation, then opens and reads the reply before the request
       settles. Clearing that newer catch-up would show a dot the server no longer backs,
       with the seen trigger's attempt guard suppressing the re-send. */
    const request = deferred();
    mockMarkUnread.mockReturnValue(request.promise);
    const { result, cached, queryClient } = setup(RESPONDED_AT, SEEN_AT);

    await act(async () => {
      const pending = result.current.mutateAsync({ conversationId: CONVO_ID });
      /* After the optimistic clear: the seen mutation acknowledges the observed reply. */
      await flush();
      updateConvoInAllQueries(queryClient, CONVO_ID, (convo) => ({
        ...convo,
        lastSeenAt: RESPONDED_AT,
      }));
      request.resolve({ modified: true, lastResponseAt: RESPONDED_AT });
      await pending;
    });

    expect(cached()?.lastSeenAt).toBe(RESPONDED_AT);
    expect(isConversationUnseen(cached())).toBe(false);
  });

  it('refetches when a catch-up it did not write settles alongside the unread', async () => {
    /* The read may have been accepted before the unread write, in which case the server holds
       the conversation unread while this tab shows it read; the cache alone cannot tell, so
       the row is refetched rather than guessed at. */
    const request = deferred();
    mockMarkUnread.mockReturnValue(request.promise);
    const { result, queryClient } = setup(RESPONDED_AT, SEEN_AT);
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    await act(async () => {
      const pending = result.current.mutateAsync({ conversationId: CONVO_ID });
      await flush();
      updateConvoInAllQueries(queryClient, CONVO_ID, (convo) => ({
        ...convo,
        lastSeenAt: RESPONDED_AT,
      }));
      request.resolve({ modified: true, lastResponseAt: RESPONDED_AT });
      await pending;
    });

    expect(invalidate).toHaveBeenCalledWith([QueryKeys.allConversations]);
  });

  it('keeps a newer reply that arrived while the unread request was open', async () => {
    /* The server read the marker on the way in; a reply landing after that is newer than what
       it can return, and overwriting it would strand the dot behind a spent completion. */
    const NEWER_RESPONDED_AT = '2026-08-16T12:00:00.000Z';
    const request = deferred();
    mockMarkUnread.mockReturnValue(request.promise);
    const { result, cached, queryClient } = setup(RESPONDED_AT, SEEN_AT);

    await act(async () => {
      const pending = result.current.mutateAsync({ conversationId: CONVO_ID });
      /* After the optimistic pass, so the merge is genuinely a later arrival. */
      await flush();
      updateConvoInAllQueries(queryClient, CONVO_ID, (convo) => ({
        ...convo,
        lastResponseAt: NEWER_RESPONDED_AT,
        lastResponseMessageId: 'newer-reply',
      }));
      request.resolve({ modified: true, lastResponseAt: RESPONDED_AT });
      await pending;
    });

    expect(cached()?.lastResponseAt).toBe(NEWER_RESPONDED_AT);
    expect(cached()?.lastResponseMessageId).toBe('newer-reply');
    expect(isConversationUnseen(cached())).toBe(true);
  });

  it('does not roll back over a newer reply that arrived mid-flight', async () => {
    /* The watcher or the SSE path can merge a newer reply while the request is open; restoring
       the pre-mutation stamps over it would make that reply read as seen with its completion
       signal already spent. */
    const NEWER_RESPONDED_AT = '2026-08-16T12:00:00.000Z';
    const request = deferred();
    mockMarkUnread.mockReturnValue(request.promise);
    const { result, cached, queryClient } = setup(RESPONDED_AT, SEEN_AT);

    await act(async () => {
      const pending = result.current
        .mutateAsync({ conversationId: CONVO_ID })
        .catch(() => undefined);
      await flush();
      updateConvoInAllQueries(queryClient, CONVO_ID, (convo) => ({
        ...convo,
        lastResponseAt: NEWER_RESPONDED_AT,
        lastResponseMessageId: 'newer-reply',
      }));
      request.reject(new Error('network down'));
      await pending;
    });

    expect(cached()?.lastResponseAt).toBe(NEWER_RESPONDED_AT);
    expect(cached()?.lastResponseMessageId).toBe('newer-reply');
    expect(isConversationUnseen(cached())).toBe(true);
  });

  it('removes a conversation the server no longer has', async () => {
    /* Deleted on another device, or between the access check and the write. The server's
       owner-scoped update returns the row even when it changes nothing, so no match means the
       row is gone: rolling back its read state would keep a conversation that does not exist in
       the sidebar and the badge. */
    mockMarkUnread.mockResolvedValue({ modified: false });
    const { result, queryClient } = setup(RESPONDED_AT, SEEN_AT);
    const listed = () =>
      (
        queryClient.getQueryData<InfiniteData<ConversationCursorData>>(listKey)?.pages ?? []
      ).flatMap((page) => page.conversations.map((convo) => convo.conversationId));

    await act(async () => {
      await result.current.mutateAsync({ conversationId: CONVO_ID });
    });

    await waitFor(() => expect(listed()).not.toContain(CONVO_ID));
  });

  it('caches the server marker for a conversation that had no reply', async () => {
    const serverStamp = '2026-08-16T12:00:00.000Z';
    mockMarkUnread.mockResolvedValue({ modified: true, lastResponseAt: serverStamp });
    const { result, cached } = setup(undefined, undefined);

    await act(async () => {
      await result.current.mutateAsync({ conversationId: CONVO_ID });
    });

    await waitFor(() => expect(cached()?.lastResponseAt).toBe(serverStamp));
    expect(isConversationUnseen(cached())).toBe(true);
  });

  it('settles a concurrently discovered real reply with its server message identity', async () => {
    const serverStamp = '2026-08-16T12:00:00.000Z';
    mockMarkUnread.mockResolvedValue({
      modified: true,
      lastResponseAt: serverStamp,
      lastResponseMessageId: 'server-reply',
      lastResponseIsManual: false,
    });
    const { result, cached } = setup();
    await act(async () => {
      await result.current.mutateAsync({ conversationId: CONVO_ID });
    });

    expect(cached()?.lastResponseAt).toBe(serverStamp);
    expect(cached()?.lastResponseMessageId).toBe('server-reply');
    expect(isConversationUnseen(cached())).toBe(true);
  });

  it('optimistically flags a read conversation unread while the request is in flight', async () => {
    mockMarkUnread.mockReturnValue(new Promise(() => undefined));
    const { result, cached } = setup(RESPONDED_AT, SEEN_AT);

    await act(async () => {
      result.current.mutate({ conversationId: CONVO_ID });
    });

    expect(isConversationUnseen(cached())).toBe(true);
    expect(mockMarkUnread).toHaveBeenCalledWith({ conversationId: CONVO_ID });
  });

  it('stamps lastResponseAt for a never-replied conversation so the dot lights', async () => {
    mockMarkUnread.mockReturnValue(new Promise(() => undefined));
    const { result, cached } = setup();

    await act(async () => {
      result.current.mutate({ conversationId: CONVO_ID });
    });

    expect(cached()?.lastResponseAt).toBeDefined();
    expect(isConversationUnseen(cached())).toBe(true);
  });

  it('restores the previous state when the request fails', async () => {
    mockMarkUnread.mockRejectedValue(new Error('network down'));
    const { result, cached } = setup(RESPONDED_AT, SEEN_AT);

    await act(async () => {
      await result.current.mutateAsync({ conversationId: CONVO_ID }).catch(() => undefined);
    });

    await waitFor(() => expect(cached()?.lastSeenAt).toBe(SEEN_AT));
    await waitFor(() => expect(isConversationUnseen(cached())).toBe(false));
  });

  it('keeps the row unread when an earlier request fails and the later one succeeds', async () => {
    /* Activating the menu action twice before the first request settles: both write the same
       optimistic state, so only the later request owns the row. A rollback from the first would
       restore the catch-up, and the second's settlement would read that as a newer
       acknowledgement and leave the row seen although the server marked it unread. */
    const first = deferred();
    const second = deferred();
    mockMarkUnread.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, cached } = setup(RESPONDED_AT, SEEN_AT);

    await act(async () => {
      const firstPending = result.current
        .mutateAsync({ conversationId: CONVO_ID })
        .catch(() => undefined);
      await flush();
      const secondPending = result.current.mutateAsync({ conversationId: CONVO_ID });
      await flush();
      first.reject(new Error('network down'));
      second.resolve({ modified: true, lastResponseAt: RESPONDED_AT });
      await Promise.all([firstPending, secondPending]);
    });

    expect(cached()?.lastSeenAt).toBeUndefined();
    expect(isConversationUnseen(cached())).toBe(true);
  });
  it('keeps an accepted unread when the successor request fails', async () => {
    const first = deferred();
    const second = deferred();
    mockMarkUnread.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, cached } = setup(RESPONDED_AT, SEEN_AT);

    await act(async () => {
      const firstPending = result.current.mutateAsync({ conversationId: CONVO_ID });
      await flush();
      const secondPending = result.current
        .mutateAsync({ conversationId: CONVO_ID })
        .catch(() => undefined);
      await flush();
      first.resolve({ modified: true, lastResponseAt: RESPONDED_AT });
      await firstPending;
      second.reject(new Error('network down'));
      await secondPending;
    });

    expect(cached()?.lastSeenAt).toBeUndefined();
    expect(isConversationUnseen(cached())).toBe(true);
  });

  it('reasserts an earlier accepted unread when the failed successor settles first', async () => {
    const first = deferred();
    const second = deferred();
    mockMarkUnread.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, cached } = setup(RESPONDED_AT, SEEN_AT);

    await act(async () => {
      const firstPending = result.current
        .mutateAsync({ conversationId: CONVO_ID })
        .catch(() => undefined);
      await flush();
      const secondPending = result.current
        .mutateAsync({ conversationId: CONVO_ID })
        .catch(() => undefined);
      await flush();
      second.reject(new Error('network down'));
      await secondPending;
      first.resolve({ modified: true, lastResponseAt: RESPONDED_AT });
      await firstPending;
    });

    expect(cached()?.lastSeenAt).toBeUndefined();
    expect(isConversationUnseen(cached())).toBe(true);
  });

  it('restores the original read state when overlapping unread requests both fail', async () => {
    const first = deferred();
    const second = deferred();
    mockMarkUnread.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, cached } = setup();

    await act(async () => {
      const firstPending = result.current
        .mutateAsync({ conversationId: CONVO_ID })
        .catch(() => undefined);
      await flush();
      const secondPending = result.current
        .mutateAsync({ conversationId: CONVO_ID })
        .catch(() => undefined);
      await flush();
      /* The successor owns the optimistic row but must still roll back to the first baseline. */
      second.reject(new Error('network down'));
      first.reject(new Error('network down'));
      await Promise.all([firstPending, secondPending]);
    });

    expect(cached()?.lastResponseAt).toBeUndefined();
    expect(cached()?.lastResponseIsManual).toBeUndefined();
    expect(cached()?.lastSeenAt).toBeUndefined();
    expect(isConversationUnseen(cached())).toBe(false);
  });

  /* The older call no longer owns the row once a newer one has started, but its no-match is
     still the server saying the conversation is gone. Dropping it with the other non-owning
     answers would leave a deleted conversation restored to the list by the newer failure. */
  it('removes the conversation when an older overlapping call reports no match', async () => {
    const first = deferred();
    const second = deferred();
    mockMarkUnread.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, queryClient } = setup(RESPONDED_AT, SEEN_AT);
    const listed = () =>
      (
        queryClient.getQueryData<InfiniteData<ConversationCursorData>>(listKey)?.pages ?? []
      ).flatMap((page) => page.conversations.map((convo) => convo.conversationId));

    await act(async () => {
      const firstPending = result.current
        .mutateAsync({ conversationId: CONVO_ID })
        .catch(() => undefined);
      await flush();
      const secondPending = result.current
        .mutateAsync({ conversationId: CONVO_ID })
        .catch(() => undefined);
      await flush();
      second.reject(new Error('network down'));
      first.resolve({ modified: false });
      await Promise.all([firstPending, secondPending]);
    });

    expect(listed()).not.toContain(CONVO_ID);
  });

  it('rolls an archived row back when the server refuses the unread write', async () => {
    /* Mark as unread is offered from the archived view, where the row lives in its own list
       cache: a baseline read that skipped it left the failed write's dot on screen. */
    const request = deferred();
    mockMarkUnread.mockReturnValue(request.promise);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData<InfiniteData<ConversationCursorData>>(archivedKey, {
      pages: [
        {
          conversations: [
            {
              conversationId: CONVO_ID,
              title: 'Archived',
              endpoint: EModelEndpoint.openAI,
              createdAt: RESPONDED_AT,
              updatedAt: SEEN_AT,
              isArchived: true,
              lastResponseAt: RESPONDED_AT,
              lastResponseMessageId: 'original-reply',
              lastSeenAt: SEEN_AT,
            },
          ],
          nextCursor: null,
        },
      ],
      pageParams: [null],
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useMarkConversationUnreadMutation(), { wrapper });
    const archived = () =>
      queryClient.getQueryData<InfiniteData<ConversationCursorData>>(archivedKey)?.pages[0]
        .conversations[0];

    await act(async () => {
      const pending = result.current
        .mutateAsync({ conversationId: CONVO_ID })
        .catch(() => undefined);
      await flush();
      expect(isConversationUnseen(archived())).toBe(true);
      request.reject(new Error('network down'));
      await pending;
    });

    expect(archived()?.lastSeenAt).toBe(SEEN_AT);
    expect(isConversationUnseen(archived())).toBe(false);
  });

  it('abandons an unread write that the user superseded by opening the conversation', async () => {
    /* The unread write suspends while list fetches are cancelled; the read that starts in that
       window is the newer intent, and sending the unread request afterwards would leave the
       server flagged against it. */
    mockMarkSeen.mockResolvedValue({ modified: true });
    const { result, cached, wrapper } = setup(RESPONDED_AT, SEEN_AT);
    const seen = renderHook(() => useMarkConversationSeenMutation(), { wrapper });

    await act(async () => {
      const unread = result.current
        .mutateAsync({ conversationId: CONVO_ID })
        .catch(() => undefined);
      const read = seen.result.current
        .mutateAsync({ conversationId: CONVO_ID, lastResponseAt: RESPONDED_AT })
        .catch(() => undefined);
      await Promise.all([unread, read]);
    });

    expect(mockMarkUnread).not.toHaveBeenCalled();
    expect(mockMarkSeen).toHaveBeenCalledTimes(1);
    expect(isConversationUnseen(cached())).toBe(false);
  });
});

/** Lets a test place work between the optimistic pass and the response callback. */
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  /* Swallowed here so a rejection scheduled for the mutation does not surface as unhandled. */
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
