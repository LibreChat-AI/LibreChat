import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { EModelEndpoint, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import type { ConversationCursorData } from '~/utils/convos';
import { useMarkConversationSeenMutation, useMarkConversationUnreadMutation } from '../mutations';
import { isConversationUnseen, updateConvoInAllQueries } from '~/utils';

const mockMarkSeen = jest.fn();
const mockMarkUnread = jest.fn();
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      markConversationSeen: (...args: unknown[]) => mockMarkSeen(...args),
      markConversationUnread: (...args: unknown[]) => mockMarkUnread(...args),
    },
  };
});

const CONVO_ID = 'convo-mark';
const listKey = [QueryKeys.allConversations, { isArchived: false }];
const RESPONDED_AT = '2026-08-16T10:00:00.000Z';
const SEEN_AT = '2026-08-16T09:00:00.000Z';

/** Stands in for a list refetch committing whatever the server last told it. */
function seedList(queryClient: QueryClient, lastResponseAt = RESPONDED_AT, lastSeenAt?: string) {
  queryClient.setQueryData<InfiniteData<ConversationCursorData>>(listKey, {
    pages: [
      {
        conversations: [
          {
            conversationId: CONVO_ID,
            title: 'Marked',
            endpoint: EModelEndpoint.openAI,
            createdAt: SEEN_AT,
            updatedAt: SEEN_AT,
            lastResponseAt,
            lastSeenAt,
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [null],
  });
}

function setup(lastSeenAt?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedList(queryClient, RESPONDED_AT, lastSeenAt);

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  const view = renderHook(() => useMarkConversationSeenMutation(), { wrapper });
  const cached = () =>
    queryClient.getQueryData<InfiniteData<ConversationCursorData>>(listKey)?.pages[0]
      .conversations[0];

  return { ...view, cached, queryClient, wrapper };
}

describe('useMarkConversationSeenMutation', () => {
  beforeEach(() => {
    mockMarkSeen.mockReset();
    mockMarkUnread.mockReset();
  });

  it('optimistically marks the conversation seen while the request is in flight', async () => {
    mockMarkSeen.mockReturnValue(new Promise(() => undefined));
    const { result, cached } = setup();

    await act(async () => {
      result.current.mutate({ conversationId: CONVO_ID, lastResponseAt: RESPONDED_AT });
    });

    expect(cached()?.lastSeenAt).toBeDefined();
    expect(mockMarkSeen).toHaveBeenCalledWith({
      conversationId: CONVO_ID,
      lastResponseAt: RESPONDED_AT,
    });
  });

  it('acknowledges the observed reply rather than the browser clock', async () => {
    /* A clock behind the server would leave the row unseen, and the cache write feeding the
       seen triggers would restart the mutation on every pass. */
    mockMarkSeen.mockReturnValue(new Promise(() => undefined));
    const { result, cached } = setup();

    await act(async () => {
      result.current.mutate({ conversationId: CONVO_ID, lastResponseAt: RESPONDED_AT });
    });

    expect(cached()?.lastSeenAt).toBe(RESPONDED_AT);
    expect(isConversationUnseen(cached())).toBe(false);
  });

  it('falls back to the cached reply stamp when the caller names none', async () => {
    mockMarkSeen.mockReturnValue(new Promise(() => undefined));
    const { result, cached } = setup();

    await act(async () => {
      result.current.mutate({ conversationId: CONVO_ID });
    });

    expect(cached()?.lastSeenAt).toBe(RESPONDED_AT);
  });

  it('does not reapply a stale seen acknowledgement after a later unread write clears it', async () => {
    const seenRequest = deferred();
    mockMarkSeen.mockReturnValue(seenRequest.promise);
    mockMarkUnread.mockResolvedValue({ modified: true, lastResponseAt: RESPONDED_AT });
    const { result, cached, queryClient, wrapper } = setup(SEEN_AT);
    const unread = renderHook(() => useMarkConversationUnreadMutation(), { wrapper });

    await act(async () => {
      const seenPending = result.current.mutateAsync({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_AT,
      });
      await flush();
      await unread.result.current.mutateAsync({ conversationId: CONVO_ID });
      /* A server refresh after the unread settles carries the cleared catch-up. */
      seedList(queryClient, RESPONDED_AT);
      seenRequest.resolve({ modified: true });
      await seenPending;
    });

    expect(cached()?.lastSeenAt).toBeUndefined();
    expect(isConversationUnseen(cached())).toBe(true);
  });

  it('cancels list fetches already reading the old catch-up', async () => {
    /* One of them can deliver after the acknowledgement has settled and put the stale value
       back, and the caller's attempt guard would not send it again. */
    const request = deferred();
    mockMarkSeen.mockReturnValue(request.promise);
    const { result, queryClient } = setup(SEEN_AT);
    const cancel = jest.spyOn(queryClient, 'cancelQueries');

    await act(async () => {
      const pending = result.current.mutateAsync({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_AT,
      });
      await flush();
      request.resolve({ modified: true });
      await pending;
    });

    expect(cancel).toHaveBeenCalledWith([QueryKeys.allConversations]);
    expect(cancel).toHaveBeenCalledWith([QueryKeys.pinnedConversations]);
  });

  it('cancels a point-query fetch already reading the old catch-up', async () => {
    /* A conversation opened by URL resolves into its own point query, which the read and
       write helpers both consult. A refetch delivering after settlement would land the stale
       row as the freshest copy and read as unseen again. */
    const request = deferred();
    mockMarkSeen.mockReturnValue(request.promise);
    const { result, queryClient } = setup(SEEN_AT);
    queryClient.setQueryData([QueryKeys.conversation, CONVO_ID], {
      conversationId: CONVO_ID,
      title: 'Marked',
      lastResponseAt: RESPONDED_AT,
      lastSeenAt: SEEN_AT,
    });
    const cancel = jest.spyOn(queryClient, 'cancelQueries');

    await act(async () => {
      const pending = result.current.mutateAsync({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_AT,
      });
      await flush();
      request.resolve({ modified: true });
      await pending;
    });

    expect(cancel).toHaveBeenCalledWith([QueryKeys.conversation, CONVO_ID]);
  });

  it('leaves an unloaded point query alone so its initial load can deliver', async () => {
    /* Cancelling ChatRoute's first conversation fetch would revert it to empty with its
       refetches disabled, leaving the route waiting on data nothing restarts. */
    const request = deferred();
    mockMarkSeen.mockReturnValue(request.promise);
    const { result, queryClient } = setup(SEEN_AT);
    const cancel = jest.spyOn(queryClient, 'cancelQueries');

    await act(async () => {
      const pending = result.current.mutateAsync({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_AT,
      });
      await flush();
      request.resolve({ modified: true });
      await pending;
    });

    expect(cancel).not.toHaveBeenCalledWith([QueryKeys.conversation, CONVO_ID]);
  });

  it('restores the real state when the server declines the observed reply', async () => {
    /* A newer reply landed mid-flight, so the acknowledgement did not apply and the row is
       genuinely still unseen. */
    mockMarkSeen.mockResolvedValue({ modified: false });
    const { result, cached } = setup(SEEN_AT);

    await act(async () => {
      await result.current.mutateAsync({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_AT,
      });
    });

    await waitFor(() => expect(cached()?.lastSeenAt).toBe(SEEN_AT));
  });

  it('restarts the reads it cancelled when the server declines the acknowledgement', async () => {
    /* The rejection means the server holds a reply this tab has not read, and the refetch that
       would have delivered it was cancelled on the way in. The optimistic write refreshed
       `dataUpdatedAt`, so nothing refetches on its own and the newer reply would stay out of
       the dot, the badge and the alerts. */
    mockMarkSeen.mockResolvedValue({ modified: false });
    const { result, queryClient } = setup(SEEN_AT);
    queryClient.setQueryData([QueryKeys.conversation, CONVO_ID], {
      conversationId: CONVO_ID,
      title: 'Marked',
      lastResponseAt: RESPONDED_AT,
      lastSeenAt: SEEN_AT,
    });
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    await act(async () => {
      await result.current.mutateAsync({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_AT,
      });
    });

    expect(invalidate).toHaveBeenCalledWith([QueryKeys.allConversations]);
    expect(invalidate).toHaveBeenCalledWith([QueryKeys.pinnedConversations]);
    expect(invalidate).toHaveBeenCalledWith([QueryKeys.conversation, CONVO_ID]);
  });

  it('leaves untouched caches alone when the acknowledgement is accepted', async () => {
    mockMarkSeen.mockResolvedValue({ modified: true });
    const { result, queryClient } = setup(SEEN_AT);
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    await act(async () => {
      await result.current.mutateAsync({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_AT,
      });
    });

    expect(invalidate).not.toHaveBeenCalled();
  });

  it('restarts a read it interrupted even when the acknowledgement is accepted', async () => {
    /* The cancelled response was carrying rows this mutation never asked about, and the
       optimistic write refreshed `dataUpdatedAt`, so nothing would refetch it. */
    mockMarkSeen.mockResolvedValue({ modified: true });
    const { result, queryClient } = setup(SEEN_AT);
    const listQuery = queryClient.getQueryCache().find(listKey);
    listQuery?.setState({ fetchStatus: 'fetching' } as never);
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    await act(async () => {
      await result.current.mutateAsync({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_AT,
      });
    });

    expect(invalidate).toHaveBeenCalledWith(listKey, { exact: true, refetchType: 'all' });
  });

  it('does not undo a newer acknowledgement when an older request fails last', async () => {
    /* Same ordering hazard as the success path: reply A's request can fail after reply B has
       already been acknowledged, and an unconditional rollback would take B with it. */
    const NEWER_RESPONDED_AT = '2026-08-16T10:05:00.000Z';
    const request = deferred();
    mockMarkSeen.mockReturnValue(request.promise);
    const { result, cached, queryClient } = setup(SEEN_AT);

    await act(async () => {
      const stale = result.current
        .mutateAsync({ conversationId: CONVO_ID, lastResponseAt: RESPONDED_AT })
        .catch(() => undefined);
      await flush();
      seedList(queryClient, NEWER_RESPONDED_AT);
      updateConvoInAllQueries(queryClient, CONVO_ID, (convo) => ({
        ...convo,
        lastSeenAt: NEWER_RESPONDED_AT,
      }));
      request.reject(new Error('network down'));
      await stale;
    });

    expect(cached()?.lastSeenAt).toBe(NEWER_RESPONDED_AT);
  });

  it('restores the previous catch-up state when the request fails', async () => {
    mockMarkSeen.mockRejectedValue(new Error('network down'));
    const { result, cached } = setup(SEEN_AT);

    await act(async () => {
      await result.current.mutateAsync({ conversationId: CONVO_ID }).catch(() => undefined);
    });

    /* Restoring the old value re-arms the seen triggers, which gate on the cache. */
    await waitFor(() => expect(cached()?.lastSeenAt).toBe(SEEN_AT));
  });

  it('restores never-seen when a first catch-up fails', async () => {
    mockMarkSeen.mockRejectedValue(new Error('network down'));
    const { result, cached } = setup();

    await act(async () => {
      await result.current.mutateAsync({ conversationId: CONVO_ID }).catch(() => undefined);
    });

    await waitFor(() => expect(cached()?.lastSeenAt).toBeUndefined());
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
