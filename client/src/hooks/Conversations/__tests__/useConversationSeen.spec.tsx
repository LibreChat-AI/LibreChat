import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryKeys, tMessageSchema } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import {
  markLocallyCommittedReply,
  markServerFetchedReply,
  updateConvoInAllQueries,
} from '~/utils';
import { useGetMessagesByConvoId } from '~/data-provider/Messages/queries';
import { suppressFocusAcknowledgement } from '../notificationNavigation';
import useConversationSeen from '../useConversationSeen';

const mockMarkSeen = jest.fn();
const mockGetMessages = jest.fn();
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getMessagesByConvoId: (...args: string[]) => mockGetMessages(...args),
    },
  };
});
jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useMarkConversationSeenMutation: () => ({ mutate: mockMarkSeen }),
}));

const CONVO_ID = 'convo-seen';
const OTHER_CONVO_ID = 'convo-other';
const RESPONDED_AT = '2026-08-16T10:00:00.000Z';
const RESPONDED_LATER_AT = '2026-08-16T10:05:00.000Z';

type ConvoFixture = {
  lastResponseAt?: string;
  lastResponseMessageId?: string;
  lastResponseIsManual?: boolean;
  lastSeenAt?: string;
};

type SeededConvo = {
  conversationId: string;
  title: string;
  lastResponseAt?: string;
  lastResponseMessageId?: string;
  lastResponseIsManual?: boolean;
  lastSeenAt?: string;
};

type SeenProps = { id: string; submitting: boolean };

function createClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function seedUnseen(
  queryClient: QueryClient,
  lastResponseAt = RESPONDED_AT,
  conversationId = CONVO_ID,
) {
  queryClient.setQueryData([QueryKeys.allConversations, { isArchived: false }], {
    pages: [
      {
        conversations: [
          {
            conversationId,
            title: 'Test',
            lastResponseAt,
            lastResponseMessageId: 'server-reply',
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [null],
  });
}

function setup(
  fixture: ConvoFixture | null,
  initialProps: SeenProps = { id: CONVO_ID, submitting: false },
  measureNearBottom?: () => boolean | null,
  isResponseRendered?: (messageId: string) => boolean,
) {
  const queryClient = createClient();
  if (fixture !== null) {
    const conversations: SeededConvo[] = [
      {
        conversationId: initialProps.id,
        title: 'Test',
        lastResponseAt: fixture.lastResponseAt,
        lastResponseMessageId: fixture.lastResponseMessageId ?? 'server-reply',
        lastResponseIsManual: fixture.lastResponseIsManual,
        lastSeenAt: fixture.lastSeenAt,
      },
    ];
    if (initialProps.id !== OTHER_CONVO_ID) {
      conversations.push({
        conversationId: OTHER_CONVO_ID,
        title: 'Other',
        lastResponseAt: RESPONDED_AT,
      });
    }
    queryClient.setQueryData([QueryKeys.allConversations, { isArchived: false }], {
      pages: [{ conversations, nextCursor: null }],
      pageParams: [null],
    });
  }

  const renderedResponseId = fixture?.lastResponseMessageId ?? 'server-reply';
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <div id={renderedResponseId}>
      <div data-testid="message-body">{renderedResponseId}</div>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </div>
  );

  const view = renderHook(
    ({ id, submitting }: SeenProps) =>
      useConversationSeen(id, submitting, measureNearBottom, isResponseRendered),
    {
      initialProps,
      wrapper,
    },
  );

  return { ...view, queryClient };
}

async function renderMessages(queryClient: QueryClient, conversationId = CONVO_ID) {
  await act(async () => {
    await queryClient.fetchQuery([QueryKeys.messages, conversationId], async () => []);
  });
}

describe('useConversationSeen', () => {
  let hasFocus: jest.SpyInstance;

  beforeEach(() => {
    mockMarkSeen.mockClear();
    hasFocus = jest.spyOn(document, 'hasFocus').mockReturnValue(true);
  });

  afterEach(() => {
    hasFocus.mockRestore();
  });

  it('records the conversation as seen once the newest message is reached', async () => {
    const { result, queryClient } = setup({ lastResponseAt: RESPONDED_AT });
    mockMarkSeen.mockClear();

    act(() => result.current(true));
    expect(mockMarkSeen).not.toHaveBeenCalled();

    await renderMessages(queryClient);
    await waitFor(() =>
      expect(mockMarkSeen).toHaveBeenCalledWith({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_AT,
      }),
    );
  });
  it.each([false, true])(
    'reuses a cold fetch only for the reply known when it started (newer reply: %s)',
    async (newerReply) => {
      const queryClient = createClient();
      seedUnseen(queryClient);
      const history = [
        tMessageSchema.parse({
          messageId: 'server-reply',
          conversationId: CONVO_ID,
          parentMessageId: 'server-user',
          sender: 'Assistant',
          text: 'Server reply',
          isCreatedByUser: false,
        }),
      ];
      let resolveInitial!: (messages: typeof history) => void;
      let resolveLatest!: (messages: typeof history) => void;
      const initial = new Promise<typeof history>((resolve) => {
        resolveInitial = resolve;
      });
      const latest = new Promise<typeof history>((resolve) => {
        resolveLatest = resolve;
      });
      const getMessages = mockGetMessages
        .mockReset()
        .mockRejectedValue(new Error('unexpected history request'))
        .mockReturnValueOnce(initial)
        .mockReturnValueOnce(latest);
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <MemoryRouter initialEntries={[`/c/${CONVO_ID}`]}>
          <div id="server-reply">
            <div data-testid="message-body">{history[0].text}</div>
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
          </div>
        </MemoryRouter>
      );
      try {
        const messages = renderHook(() => useGetMessagesByConvoId(CONVO_ID), { wrapper });
        await waitFor(() => expect(getMessages).toHaveBeenCalledTimes(1));
        await act(async () => {
          if (newerReply) {
            seedUnseen(queryClient, RESPONDED_LATER_AT);
          }
          resolveInitial(history);
        });
        await waitFor(() => expect(messages.result.current.isSuccess).toBe(true));

        const seen = renderHook(() => useConversationSeen(CONVO_ID, false), { wrapper });
        act(() => seen.result.current(true));
        if (newerReply) {
          await waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2));
          expect(mockMarkSeen).not.toHaveBeenCalled();
          await act(async () => {
            resolveLatest([...history, { ...history[0], messageId: 'newer-reply' }]);
          });
        }
        await waitFor(() =>
          expect(mockMarkSeen).toHaveBeenCalledWith({
            conversationId: CONVO_ID,
            lastResponseAt: newerReply ? RESPONDED_LATER_AT : RESPONDED_AT,
          }),
        );
        expect(getMessages).toHaveBeenCalledTimes(newerReply ? 2 : 1);
      } finally {
        getMessages.mockReset();
      }
    },
  );

  it('acknowledges a locally committed final without refetching message history', async () => {
    const { result, queryClient } = setup({ lastResponseAt: RESPONDED_AT });
    queryClient.setQueryData([QueryKeys.messages, CONVO_ID], [{ messageId: 'final-reply' }]);
    markLocallyCommittedReply(queryClient, CONVO_ID, RESPONDED_AT);
    const invalidateMessages = jest.spyOn(queryClient, 'invalidateQueries');

    act(() => result.current(true));

    await waitFor(() =>
      expect(mockMarkSeen).toHaveBeenCalledWith({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_AT,
      }),
    );
    expect(invalidateMessages).not.toHaveBeenCalled();
  });
  it('does not acknowledge a fetched hidden sibling until that response branch is visible', async () => {
    let responseVisible = false;
    const { result, queryClient } = setup(
      { lastResponseAt: RESPONDED_AT, lastResponseMessageId: 'hidden-reply' },
      { id: CONVO_ID, submitting: false },
      undefined,
      () => responseVisible,
    );
    const hiddenReply = tMessageSchema.parse({
      messageId: 'hidden-reply',
      conversationId: CONVO_ID,
      parentMessageId: 'hidden-user',
      sender: 'Assistant',
      text: 'Hidden reply',
      isCreatedByUser: false,
    }) as TMessage;
    const stored = queryClient.setQueryData([QueryKeys.messages, CONVO_ID], [hiddenReply]);
    markServerFetchedReply(queryClient, CONVO_ID, RESPONDED_AT, stored!);

    act(() => result.current(true));
    expect(mockMarkSeen).not.toHaveBeenCalled();

    responseVisible = true;
    act(() => result.current(true));
    await waitFor(() =>
      expect(mockMarkSeen).toHaveBeenCalledWith({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_AT,
      }),
    );
  });

  it('acknowledges a synthetic manual marker from the settled route without refetching history', async () => {
    const queryClient = createClient();
    seedUnseen(queryClient);
    updateConvoInAllQueries(queryClient, CONVO_ID, (convo) => ({
      ...convo,
      lastResponseIsManual: true,
      lastResponseMessageId: undefined,
    }));
    const getHistory = jest.fn(async () => []);
    await queryClient.fetchQuery({
      queryKey: [QueryKeys.messages, CONVO_ID],
      queryFn: getHistory,
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const invalidateMessages = jest.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useConversationSeen(CONVO_ID, false), { wrapper });
    act(() => result.current(true));
    await waitFor(() =>
      expect(mockMarkSeen).toHaveBeenCalledWith({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_AT,
      }),
    );
    expect(invalidateMessages).not.toHaveBeenCalled();
    expect(getHistory).toHaveBeenCalledTimes(1);
  });

  it('acknowledges a warm synthetic manual marker without a metadata refetch', async () => {
    const { result, queryClient } = setup({
      lastResponseAt: RESPONDED_AT,
      lastResponseIsManual: true,
    });
    queryClient.setQueryData([QueryKeys.messages, CONVO_ID], [{ messageId: 'existing-reply' }]);
    const invalidateMessages = jest.spyOn(queryClient, 'invalidateQueries');

    act(() => result.current(true));

    await waitFor(() =>
      expect(mockMarkSeen).toHaveBeenCalledWith({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_AT,
      }),
    );
    expect(invalidateMessages).not.toHaveBeenCalled();
  });

  it('acknowledges a real reply stamped before reply identity existed', async () => {
    /* A row written by an older server carries no `lastResponseMessageId`; requiring one would
       leave its dot unclearable for the life of the conversation. */
    const queryClient = createClient();
    seedUnseen(queryClient);
    updateConvoInAllQueries(queryClient, CONVO_ID, (convo) => ({
      ...convo,
      lastResponseMessageId: undefined,
    }));
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useConversationSeen(CONVO_ID, false), { wrapper });
    await renderMessages(queryClient);

    act(() => result.current(true));

    await waitFor(() =>
      expect(mockMarkSeen).toHaveBeenCalledWith({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_AT,
      }),
    );
  });

  it('sends nothing while the user is scrolled away from the newest message', () => {
    const { result } = setup({ lastResponseAt: RESPONDED_AT });
    mockMarkSeen.mockClear();

    act(() => result.current(false));

    expect(mockMarkSeen).not.toHaveBeenCalled();
  });

  it('sends nothing when the tab is not focused', () => {
    hasFocus.mockReturnValue(false);
    const { result } = setup({ lastResponseAt: RESPONDED_AT });
    mockMarkSeen.mockClear();

    act(() => result.current(true));

    expect(mockMarkSeen).not.toHaveBeenCalled();
  });

  it('sends nothing when the conversation is already caught up', () => {
    const { result } = setup({
      lastResponseAt: RESPONDED_AT,
      lastSeenAt: '2026-08-16T11:00:00.000Z',
    });
    mockMarkSeen.mockClear();

    act(() => result.current(true));

    /* The cost guard: re-reading an already-seen conversation must not issue a write. */
    expect(mockMarkSeen).not.toHaveBeenCalled();
  });

  it('sends nothing for a conversation that has never been replied to', () => {
    const { result } = setup({});
    mockMarkSeen.mockClear();

    act(() => result.current(true));

    expect(mockMarkSeen).not.toHaveBeenCalled();
  });

  it('marks seen when a reply lands while the user sits at the newest message', async () => {
    /* Mirrors the real order: the user is at the bottom of a conversation with no reply yet,
       the run finishes and stamps the list cache, then the submission flips. The conversation
       the user is actively watching must not sprout a dot, and the reply is acknowledged
       exactly once rather than again on the flip. */
    const { result, rerender, queryClient } = setup(
      {},
      {
        id: CONVO_ID,
        submitting: true,
      },
    );

    act(() => result.current(true));
    expect(mockMarkSeen).not.toHaveBeenCalled();

    act(() => {
      seedUnseen(queryClient);
    });
    rerender({ id: CONVO_ID, submitting: false });
    expect(mockMarkSeen).not.toHaveBeenCalled();

    await renderMessages(queryClient);
    await waitFor(() =>
      expect(mockMarkSeen).toHaveBeenCalledWith({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_AT,
      }),
    );
    expect(mockMarkSeen).toHaveBeenCalledTimes(1);
  });

  it('marks seen once the list cache loads with the conversation still unread', async () => {
    /* Direct-URL open: the initial intersection fires before the list query resolves,
       so nothing marks seen until both the message tree and list cache report the conversation. */
    const { result, queryClient } = setup(null);

    act(() => result.current(true));
    mockMarkSeen.mockClear();

    act(() => {
      seedUnseen(queryClient);
    });
    expect(mockMarkSeen).not.toHaveBeenCalled();

    await renderMessages(queryClient);
    await waitFor(() =>
      expect(mockMarkSeen).toHaveBeenCalledWith({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_AT,
      }),
    );
  });

  it('refreshes idle messages before acknowledging a list-only remote reply', async () => {
    /* A focused list refetch can discover a reply while the active messages query still reports
       successful old data. The old end marker must not be enough to acknowledge that stamp. */
    const { result, queryClient } = setup({
      lastResponseAt: RESPONDED_AT,
      lastSeenAt: RESPONDED_AT,
    });
    queryClient.setQueryData([QueryKeys.messages, CONVO_ID], [{ messageId: 'old-reply' }]);
    act(() => result.current(true));
    mockMarkSeen.mockClear();

    const invalidateMessages = jest.spyOn(queryClient, 'invalidateQueries');
    act(() => {
      seedUnseen(queryClient, RESPONDED_LATER_AT);
    });

    expect(mockMarkSeen).not.toHaveBeenCalled();
    expect(invalidateMessages).toHaveBeenCalledWith([QueryKeys.messages, CONVO_ID]);

    await act(async () => {
      await queryClient.fetchQuery([QueryKeys.messages, CONVO_ID], async () => [
        { messageId: 'new-reply' },
      ]);
    });

    /* The successful fetch is not enough by itself: acknowledgement waits for the post-render
       measurement scheduled by the messages cache event. */
    expect(mockMarkSeen).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mockMarkSeen).toHaveBeenCalledWith({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_LATER_AT,
      }),
    );
    expect(invalidateMessages).toHaveBeenCalledTimes(1);

    /* Repeated list notifications for the same stamp do not start another messages request. */
    act(() => {
      seedUnseen(queryClient, RESPONDED_LATER_AT);
    });
    expect(invalidateMessages).toHaveBeenCalledTimes(1);
  });

  it('ignores a successful messages event for another conversation', async () => {
    const { result, queryClient } = setup({
      lastResponseAt: RESPONDED_AT,
      lastSeenAt: RESPONDED_AT,
    });
    queryClient.setQueryData([QueryKeys.messages, CONVO_ID], [{ messageId: 'old-reply' }]);
    act(() => result.current(true));
    mockMarkSeen.mockClear();

    act(() => {
      seedUnseen(queryClient, RESPONDED_LATER_AT);
    });

    await act(async () => {
      await queryClient.fetchQuery([QueryKeys.messages, OTHER_CONVO_ID], async () => [
        { messageId: 'other-reply' },
      ]);
    });

    expect(mockMarkSeen).not.toHaveBeenCalled();
  });

  it('keeps a list-only reply unseen when its messages refresh fails', async () => {
    const { result, queryClient } = setup({
      lastResponseAt: RESPONDED_AT,
      lastSeenAt: RESPONDED_AT,
    });
    queryClient.setQueryData([QueryKeys.messages, CONVO_ID], [{ messageId: 'old-reply' }]);
    act(() => result.current(true));
    mockMarkSeen.mockClear();

    const invalidateMessages = jest.spyOn(queryClient, 'invalidateQueries');
    act(() => {
      seedUnseen(queryClient, RESPONDED_LATER_AT);
    });

    await act(async () => {
      await expect(
        queryClient.fetchQuery([QueryKeys.messages, CONVO_ID], () =>
          Promise.reject(new Error('network down')),
        ),
      ).rejects.toThrow('network down');
    });

    expect(invalidateMessages).toHaveBeenCalledTimes(1);
    expect(mockMarkSeen).not.toHaveBeenCalled();
    act(() => {
      seedUnseen(queryClient, RESPONDED_LATER_AT);
    });
    expect(invalidateMessages).toHaveBeenCalledTimes(1);
  });

  it('waits out a messages revalidation before acknowledging', async () => {
    /* A warm-cache open renders the old tree and reports its bottom while the messages query
       refetches in the background; acknowledging then would clear the indicator for a reply
       that has not rendered. The fetch settling is itself a cache event, so the reply is
       credited once it has actually arrived. */
    const { result, queryClient } = setup({ lastResponseAt: RESPONDED_AT });
    mockMarkSeen.mockClear();

    let resolveFetch!: (messages: unknown[]) => void;
    const fetching = queryClient.prefetchQuery(
      [QueryKeys.messages, CONVO_ID],
      () =>
        new Promise<unknown[]>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    act(() => result.current(true));
    expect(mockMarkSeen).not.toHaveBeenCalled();

    await act(async () => {
      resolveFetch([]);
      await fetching;
    });

    /* The re-check is deferred past the commit, so it lands a couple of frames later. */
    await waitFor(() =>
      expect(mockMarkSeen).toHaveBeenCalledWith({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_AT,
      }),
    );
  });

  it('withholds the acknowledgement when the messages revalidation failed', async () => {
    /* A failed refetch returns the query to `idle` while the stale tree stays on screen, so
       waiting only for the fetch to stop would credit a reply that never loaded. */
    const { result, queryClient } = setup({ lastResponseAt: RESPONDED_AT });
    mockMarkSeen.mockClear();

    await act(async () => {
      await queryClient
        .prefetchQuery([QueryKeys.messages, CONVO_ID], () =>
          Promise.reject(new Error('network down')),
        )
        .catch(() => undefined);
    });

    expect(queryClient.getQueryState([QueryKeys.messages, CONVO_ID])?.status).toBe('error');

    act(() => result.current(true));

    expect(mockMarkSeen).not.toHaveBeenCalled();
  });

  it('re-measures the committed tree instead of trusting the old bottom report', async () => {
    /* The revalidated reply can extend past the viewport, and the fetch settles before React
       commits it: the stale near-bottom flag belongs to the old tree and must not acknowledge
       a reply whose end the user has not reached. */
    const measure = jest.fn<boolean | null, []>(() => false);
    const { result, queryClient } = setup(
      { lastResponseAt: RESPONDED_AT },
      { id: CONVO_ID, submitting: false },
      measure,
    );
    mockMarkSeen.mockClear();

    let resolveFetch!: (messages: unknown[]) => void;
    const fetching = queryClient.prefetchQuery(
      [QueryKeys.messages, CONVO_ID],
      () =>
        new Promise<unknown[]>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    act(() => result.current(true));

    await act(async () => {
      resolveFetch([]);
      await fetching;
    });

    await waitFor(() => expect(measure).toHaveBeenCalled());
    expect(mockMarkSeen).not.toHaveBeenCalled();
  });

  it('does not re-send the same acknowledgement when a failed write re-arms the cache', async () => {
    /* A rejected `/seen` rolls the row back to unseen, and that rollback is itself a cache
       event this hook listens to. Without a guard an offline tab would spin requests for as
       long as the network keeps refusing them. */
    const { result, queryClient } = setup({ lastResponseAt: RESPONDED_AT });

    act(() => result.current(true));
    await renderMessages(queryClient);
    await waitFor(() => expect(mockMarkSeen).toHaveBeenCalledTimes(1));
    mockMarkSeen.mockClear();

    act(() => {
      seedUnseen(queryClient);
    });

    expect(mockMarkSeen).not.toHaveBeenCalled();
  });

  it('acknowledges again once a genuinely newer reply arrives', async () => {
    const { result, queryClient } = setup({ lastResponseAt: RESPONDED_AT });

    act(() => result.current(true));
    await renderMessages(queryClient);
    await waitFor(() => expect(mockMarkSeen).toHaveBeenCalledTimes(1));
    mockMarkSeen.mockClear();

    act(() => {
      seedUnseen(queryClient, RESPONDED_LATER_AT);
    });
    expect(mockMarkSeen).not.toHaveBeenCalled();

    await renderMessages(queryClient);
    await waitFor(() =>
      expect(mockMarkSeen).toHaveBeenCalledWith({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_LATER_AT,
      }),
    );
  });

  it('acknowledges once the point query for a directly opened conversation resolves', async () => {
    /* An old conversation opened by URL can be in neither list; the initial intersection and
       point query can both arrive before the messages query, so acknowledgement waits for the
       rendered tree. */
    const { result, queryClient } = setup(null);

    act(() => result.current(true));
    mockMarkSeen.mockClear();

    act(() => {
      queryClient.setQueryData([QueryKeys.conversation, CONVO_ID], {
        conversationId: CONVO_ID,
        title: 'Test',
        lastResponseAt: RESPONDED_AT,
        lastResponseMessageId: 'server-reply',
      });
    });

    expect(mockMarkSeen).not.toHaveBeenCalled();
    await renderMessages(queryClient);
    await waitFor(() =>
      expect(mockMarkSeen).toHaveBeenCalledWith({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_AT,
      }),
    );
  });

  it('re-arms a failed acknowledgement when the route leaves and returns', async () => {
    /* The hook outlives the route, so without this a write that failed here would stay
       suppressed until the window happened to blur and refocus. */
    const { result, rerender, queryClient } = setup({ lastResponseAt: RESPONDED_AT });

    act(() => result.current(true));
    await renderMessages(queryClient);
    await waitFor(() => expect(mockMarkSeen).toHaveBeenCalledTimes(1));
    mockMarkSeen.mockClear();

    rerender({ id: OTHER_CONVO_ID, submitting: false });
    rerender({ id: CONVO_ID, submitting: false });
    act(() => result.current(true));
    await renderMessages(queryClient);

    await waitFor(() =>
      expect(mockMarkSeen).toHaveBeenCalledWith({
        conversationId: CONVO_ID,
        lastResponseAt: RESPONDED_AT,
      }),
    );
  });

  it('ignores the focus a notification click raises on its way elsewhere', async () => {
    /* The click is navigation to another conversation; the one still open behind it was never
       read and must keep its indicator. */
    const { result, queryClient } = setup({ lastResponseAt: RESPONDED_AT });

    act(() => result.current(true));
    await renderMessages(queryClient);
    await waitFor(() => expect(mockMarkSeen).toHaveBeenCalledTimes(1));
    mockMarkSeen.mockClear();

    act(() => {
      hasFocus.mockReturnValue(false);
      suppressFocusAcknowledgement();
      hasFocus.mockReturnValue(true);
      window.dispatchEvent(new Event('focus'));
    });

    expect(mockMarkSeen).not.toHaveBeenCalled();
  });

  it('acknowledges on the next genuine focus after a suppressed one', async () => {
    const { result, queryClient } = setup({ lastResponseAt: RESPONDED_AT });

    act(() => result.current(true));
    await renderMessages(queryClient);
    await waitFor(() => expect(mockMarkSeen).toHaveBeenCalledTimes(1));
    mockMarkSeen.mockClear();

    act(() => {
      hasFocus.mockReturnValue(false);
      suppressFocusAcknowledgement();
      hasFocus.mockReturnValue(true);
      window.dispatchEvent(new Event('focus'));
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(mockMarkSeen).toHaveBeenCalledWith({
      conversationId: CONVO_ID,
      lastResponseAt: RESPONDED_AT,
    });
  });

  it('expires a suppression whose focus event never arrived', async () => {
    /* `window.focus()` is a request: a browser that leaves the window in the background raises
       no focus event, and an unbounded flag would then be spent on the next genuine focus,
       withholding that conversation's acknowledgement for no reason. */
    const { result, queryClient } = setup({ lastResponseAt: RESPONDED_AT });

    act(() => result.current(true));
    await renderMessages(queryClient);
    await waitFor(() => expect(mockMarkSeen).toHaveBeenCalledTimes(1));
    mockMarkSeen.mockClear();

    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000);
      act(() => {
        hasFocus.mockReturnValue(false);
        suppressFocusAcknowledgement();
      });
      now.mockReturnValue(1_000 + 5_000);
      act(() => {
        hasFocus.mockReturnValue(true);
        window.dispatchEvent(new Event('focus'));
      });
    } finally {
      now.mockRestore();
    }

    expect(mockMarkSeen).toHaveBeenCalledWith({
      conversationId: CONVO_ID,
      lastResponseAt: RESPONDED_AT,
    });
  });

  it('retries a failed acknowledgement when the user returns to the tab', async () => {
    const { result, queryClient } = setup({ lastResponseAt: RESPONDED_AT });

    act(() => result.current(true));
    await renderMessages(queryClient);
    await waitFor(() => expect(mockMarkSeen).toHaveBeenCalledTimes(1));
    mockMarkSeen.mockClear();

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(mockMarkSeen).toHaveBeenCalledWith({
      conversationId: CONVO_ID,
      lastResponseAt: RESPONDED_AT,
    });
  });

  it('does not carry the previous conversation’s scroll position into a new one', () => {
    const { result, rerender } = setup(
      { lastResponseAt: RESPONDED_AT },
      {
        id: CONVO_ID,
        submitting: false,
      },
    );

    act(() => result.current(true));
    mockMarkSeen.mockClear();

    /* Switching conversations recreates the observer; until it reports, the new
       conversation's position is unknown and must not inherit "near bottom". */
    rerender({ id: OTHER_CONVO_ID, submitting: false });

    expect(mockMarkSeen).not.toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: OTHER_CONVO_ID }),
    );
  });
});
