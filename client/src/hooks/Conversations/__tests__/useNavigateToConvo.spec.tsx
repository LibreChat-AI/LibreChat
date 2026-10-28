import { RecoilRoot, useRecoilValue } from 'recoil';
import { QueryKeys } from 'librechat-data-provider';
import { render, screen, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, useLocation, useNavigate } from 'react-router-dom';
import type { TConversation, TEndpointsConfig } from 'librechat-data-provider';
import useNavigateToConvo, { supersedeNavigation } from '../useNavigateToConvo';
import { useRunningConversationsQuery } from '~/data-provider/queries';
import { SetConvoProvider } from '~/Providers';
import store from '~/store';

/** The one thing a test cannot own: the HTTP call. Deferred per conversation
 *  so the assertions can observe the window before a record lands, and can
 *  settle two in-flight requests out of order. */
const mockPending = new Map<
  string,
  { resolve: (conversation: TConversation) => void; reject: (error: unknown) => void }
>();
const mockGetConversationById = jest.fn(
  (id: string) =>
    new Promise<TConversation>((resolve, reject) => {
      mockPending.set(id, { resolve, reject });
    }),
);

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: {
    ...jest.requireActual('librechat-data-provider').dataService,
    getConversationById: (...args: unknown[]) => mockGetConversationById(...(args as [string])),
    getSharedLink: jest.fn().mockResolvedValue({ shareId: null, success: true }),
  },
}));

const B = 'convo-b';
const C = 'convo-c';

/** What `getConvosByCursor` projects into the sidebar: no prompt prefix, no
 *  sampling params. Navigating from a row must never expose these as absent. */
const rowB = {
  conversationId: B,
  title: 'Bravo',
  endpoint: 'openAI',
  model: 'gpt-4o-mini',
} as TConversation;

const rowC = {
  conversationId: C,
  title: 'Charlie',
  endpoint: 'openAI',
  model: 'gpt-4o-mini',
} as TConversation;

const recordB = {
  conversationId: B,
  title: 'Bravo (stale title)',
  endpoint: 'openAI',
  model: 'gpt-4o',
  promptPrefix: 'You are terse.',
  temperature: 0.2,
} as TConversation;

const recordC = {
  conversationId: C,
  title: 'Charlie (full)',
  endpoint: 'openAI',
  model: 'gpt-4o',
  promptPrefix: 'You are verbose.',
  temperature: 0.9,
} as TConversation;

const endpointsConfig = { openAI: {} } as unknown as TEndpointsConfig;

const notFound = () => ({ status: 404, message: 'not found' });

function Harness({ runningIds = [] }: { runningIds?: string[] }) {
  const runningRows = useRunningConversationsQuery(runningIds);
  const { navigateToConvo } = useNavigateToConvo();
  const conversation = useRecoilValue(store.conversationByIndex(0));
  const { setConversation } = store.useSetConversationAtom(0);
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div>
      <button
        data-testid="go-b"
        onClick={() => navigateToConvo(rowB, { currentConvoId: 'convo-a' })}
      />
      <button data-testid="go-c" onClick={() => navigateToConvo(rowC, { currentConvoId: B })} />
      <button
        data-testid="go-running-b"
        disabled={runningRows.length === 0}
        onClick={() => navigateToConvo(runningRows[0], { currentConvoId: 'convo-a' })}
      />
      {/* Every other way out of a conversation — "New chat", a link, a
          redirect, the back button — moves the route without going through
          `navigateToConvo`, exactly like `useNewConvo` does. */}
      <button data-testid="go-elsewhere" onClick={() => navigate('/c/new')} />
      {/* Picking a model, endpoint or spec reaches the same atom through
          `newConversation` and stays on the same route — the case no route or
          ordering guard can see. */}
      <button
        data-testid="pick-model"
        onClick={() =>
          setConversation({ ...(conversation as TConversation), model: 'user-picked-model' })
        }
      />
      {/* What `ProjectLandingChip` does: re-scopes the draft and rewrites the
          query string in place. The pathname never moves. */}
      <button
        data-testid="scope-draft"
        onClick={() => {
          setConversation({ ...(conversation as TConversation), chatProjectId: 'project-x' });
          navigate('/c/new?projectId=project-x', { replace: true });
        }}
      />
      {/* What `useNewConvo` does on "New chat": records that the user wants a
          different conversation, then navigates — to the SAME pathname when
          they are already on `/c/new`. */}
      <button
        data-testid="new-chat"
        onClick={() => {
          supersedeNavigation();
          navigate('/c/new');
        }}
      />
      <div data-testid="path">{location.pathname}</div>
      <div data-testid="convo">{JSON.stringify(conversation ?? null)}</div>
    </div>
  );
}

/** A real history, not `MemoryRouter`: the hook abandons superseded work by
 *  reading the browser's own location, so the test has to move it for real. */
function renderHarness(cached: TConversation[] = [], runningIds: string[] = []) {
  window.history.pushState({}, '', '/c/convo-a');

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData([QueryKeys.endpoints], endpointsConfig);
  queryClient.setQueryData([QueryKeys.allConversations], {
    pages: [{ conversations: [rowB, rowC], nextCursor: null }],
    pageParams: [undefined],
  });
  for (const record of cached) {
    queryClient.setQueryData([QueryKeys.conversation, record.conversationId], record);
  }

  render(
    <BrowserRouter>
      <RecoilRoot>
        <QueryClientProvider client={queryClient}>
          <SetConvoProvider>
            <Harness runningIds={runningIds} />
          </SetConvoProvider>
        </QueryClientProvider>
      </RecoilRoot>
    </BrowserRouter>,
  );

  return queryClient;
}

const currentConvo = (): TConversation | null =>
  JSON.parse(screen.getByTestId('convo').textContent ?? 'null');
const currentPath = () => screen.getByTestId('path').textContent;

const sidebarRow = (queryClient: QueryClient, id: string) =>
  queryClient
    .getQueryData<{ pages: { conversations: TConversation[] }[] }>([QueryKeys.allConversations])
    ?.pages[0].conversations.find((c) => c.conversationId === id);

const click = (testId: string) => {
  act(() => {
    screen.getByTestId(testId).click();
  });
};

const settle = async (id: string, outcome: TConversation | { status: number }) => {
  const deferred = mockPending.get(id);
  if (!deferred) {
    throw new Error(`no in-flight request for ${id}`);
  }
  await act(async () => {
    if ('conversationId' in outcome) {
      deferred.resolve(outcome as TConversation);
    } else {
      deferred.reject(outcome);
    }
  });
};

describe('useNavigateToConvo', () => {
  afterEach(() => {
    mockGetConversationById.mockClear();
    mockPending.clear();
  });

  describe('with a fetched Running row', () => {
    it('keeps a newer approval choice when reopening a running project chat', async () => {
      const queryClient = renderHarness([], [B]);
      await waitFor(() =>
        expect(mockGetConversationById).toHaveBeenCalledWith(B, expect.any(AbortSignal)),
      );
      await settle(B, { ...recordB, chatProjectId: 'project-1', codeApprovalMode: 'fullAccess' });
      await waitFor(() => expect(screen.getByTestId('go-running-b')).not.toBeDisabled());

      act(() =>
        queryClient.setQueryData<TConversation>([QueryKeys.conversation, B], (record) => ({
          ...record!,
          codeApprovalMode: 'ask',
        })),
      );
      click('go-running-b');

      expect(currentPath()).toBe(`/c/${B}`);
      expect(currentConvo()?.codeApprovalMode).toBe('ask');
      expect(currentConvo()?.chatProjectId).toBe('project-1');
    });

    it('keeps chat-owned prompt, sampling and workspace choices while accepting fresh row metadata', async () => {
      const queryClient = renderHarness([], [B]);
      await waitFor(() => expect(mockGetConversationById).toHaveBeenCalled());
      await settle(B, {
        ...recordB,
        title: 'Fresh running title',
        codeEnvironmentMode: 'without_attached',
      });
      await waitFor(() => expect(screen.getByTestId('go-running-b')).not.toBeDisabled());
      act(() =>
        queryClient.setQueryData<TConversation>([QueryKeys.conversation, B], (record) => ({
          ...record!,
          promptPrefix: 'New local instructions',
          temperature: 0.7,
          codeEnvironmentMode: 'attached',
        })),
      );
      click('go-running-b');

      expect(currentConvo()).toMatchObject({
        title: 'Fresh running title',
        promptPrefix: 'New local instructions',
        temperature: 0.7,
        codeEnvironmentMode: 'attached',
      });
    });
  });

  describe('with the full record already cached', () => {
    it('changes the route and the conversation together, without waiting on the fetch', () => {
      renderHarness([recordB]);
      click('go-b');

      /** The refresh is in flight and deliberately unresolved: the route and
       *  the conversation state must already be on the target. Awaiting the
       *  response here is what left the previous conversation on screen. */
      expect(mockGetConversationById).toHaveBeenCalledWith(B);
      expect(currentPath()).toBe(`/c/${B}`);
      expect(currentConvo()?.conversationId).toBe(B);
    });

    it('underlays the cached record so the sidebar projection cannot drop settings', () => {
      renderHarness([recordB]);
      click('go-b');

      const optimistic = currentConvo();
      /** Fields only the record carries survive the switch, so a send during
       *  the refresh window still uses this conversation's real settings. */
      expect(optimistic?.promptPrefix).toBe('You are terse.');
      expect(optimistic?.temperature).toBe(0.2);
      /** ...while the row stays authoritative for what it does carry. */
      expect(optimistic?.title).toBe('Bravo');
      expect(optimistic?.model).toBe('gpt-4o-mini');
    });

    it('refreshes the cached record for the next switch', async () => {
      const queryClient = renderHarness([recordB]);
      click('go-b');
      await settle(B, { ...recordB, title: 'Bravo (server)' });

      await waitFor(() =>
        expect(queryClient.getQueryData<TConversation>([QueryKeys.conversation, B])?.title).toBe(
          'Bravo (server)',
        ),
      );
    });

    it('does not write the refreshed record into conversation state', async () => {
      renderHarness([recordB]);
      click('go-b');
      await settle(B, { ...recordB, title: 'Bravo (server)' });

      /** Conversation state is the user's — model, endpoint, prompt prefix,
       *  sampling params — and the target is interactive the moment the route
       *  changes. A background write of a server snapshot into it races the
       *  user and every other writer, so this navigation's last write is the
       *  optimistic one. */
      expect(currentConvo()?.title).toBe('Bravo');
      expect(currentConvo()?.promptPrefix).toBe('You are terse.');
    });

    it('updates the sidebar row so it cannot reinstate settings the refresh replaced', async () => {
      const queryClient = renderHarness([recordB]);
      click('go-b');
      /** `endpoint`, `model` and `spec` are in the sidebar projection, so a row
       *  from before a change made on another device would spread back over the
       *  refreshed record on every switch — until the list itself refetched. */
      await settle(B, { ...recordB, model: 'gpt-4o-elsewhere' });

      await waitFor(() => expect(sidebarRow(queryClient, B)?.model).toBe('gpt-4o-elsewhere'));
    });

    it('leaves list-owned row state alone when the refresh lands', async () => {
      const queryClient = renderHarness([recordB]);
      click('go-b');

      /** Renaming and pinning land in the list while this request is in flight.
       *  The response is a snapshot from before either happened. */
      queryClient.setQueryData([QueryKeys.allConversations], {
        pages: [{ conversations: [{ ...rowB, title: 'Renamed', pinned: true }, rowC] }],
        pageParams: [undefined],
      });
      await settle(B, { ...recordB, model: 'gpt-4o-elsewhere' });

      await waitFor(() => expect(sidebarRow(queryClient, B)?.model).toBe('gpt-4o-elsewhere'));
      expect(sidebarRow(queryClient, B)?.title).toBe('Renamed');
      expect(sidebarRow(queryClient, B)?.pinned).toBe(true);
    });

    it('keeps a setting the user picks while the refresh is in flight', async () => {
      renderHarness([recordB]);
      click('go-b');

      /** Same conversation, same route, same navigation: no ordering or route
       *  guard can tell this apart from an untouched screen. */
      click('pick-model');
      expect(currentConvo()?.model).toBe('user-picked-model');

      await settle(B, recordB);

      /** `recordB.model` is `gpt-4o`. Restoring it here would visibly revert
       *  the pick and make the next send carry settings the user did not
       *  choose. */
      expect(currentConvo()?.model).toBe('user-picked-model');
    });
  });

  describe('on the first visit, with no cached record', () => {
    it('holds the route until the record that a send needs is in hand', async () => {
      renderHarness();
      click('go-b');

      /** The sidebar row alone would expose a usable composer whose sends
       *  silently carry default prompt prefix and sampling params. */
      expect(mockGetConversationById).toHaveBeenCalledWith(B);
      expect(currentPath()).toBe('/c/convo-a');

      await settle(B, recordB);

      await waitFor(() => expect(currentPath()).toBe(`/c/${B}`));
      expect(currentConvo()?.promptPrefix).toBe('You are terse.');
      expect(currentConvo()?.temperature).toBe(0.2);
    });

    it('still lands on the conversation when the record fetch fails', async () => {
      const queryClient = renderHarness();
      queryClient.setQueryData([QueryKeys.messages, B], [{ messageId: 'stale' }]);
      click('go-b');
      await settle(B, notFound());

      await waitFor(() => expect(currentPath()).toBe(`/c/${B}`));
      expect(currentConvo()?.conversationId).toBe(B);
      /** Cleared before the route moved, so the target mounts a fresh query. */
      expect(queryClient.getQueryData([QueryKeys.messages, B])).toBeUndefined();
    });
  });

  describe('when a later navigation supersedes an in-flight one', () => {
    it('does not restore a conversation whose refresh resolves after the user moved on', async () => {
      renderHarness([recordB, recordC]);
      click('go-b');
      click('go-c');
      expect(currentPath()).toBe(`/c/${C}`);

      /** B's refresh lands last. Writing it would restore B into state while
       *  the route and transcript show C — and sends read from state. The
       *  refresh writes only the query cache, so there is nothing to restore. */
      await settle(B, { ...recordB, title: 'Bravo (late)' });

      expect(currentPath()).toBe(`/c/${C}`);
      expect(currentConvo()?.conversationId).toBe(C);
      expect(currentConvo()?.title).toBe('Charlie');
    });

    it('abandons a refresh when the user left through a path that bypasses this hook', async () => {
      renderHarness([recordB]);
      click('go-b');
      expect(currentPath()).toBe(`/c/${B}`);

      /** `useNewConvo` and every link, redirect or back-button press move the
       *  route without calling `navigateToConvo`, so nothing this hook tracks
       *  for itself would notice — only the browser's own location does. */
      click('go-elsewhere');
      expect(currentPath()).toBe('/c/new');

      await settle(B, { ...recordB, title: 'Bravo (late)' });

      expect(currentPath()).toBe('/c/new');
      expect(currentConvo()?.title).not.toBe('Bravo (late)');
    });

    it('does not pull the user back when they leave before the first-visit record lands', async () => {
      renderHarness();
      click('go-b');
      /** Uncached, so the route has not moved yet — B is still only pending. */
      expect(currentPath()).toBe('/c/convo-a');

      click('go-elsewhere');
      expect(currentPath()).toBe('/c/new');

      await settle(B, recordB);

      /** Completing the navigation here would yank the user out of the chat
       *  they deliberately opened and into one they had already left. */
      expect(currentPath()).toBe('/c/new');
    });

    it('does not land a first-visit record after the user starts a new chat', async () => {
      renderHarness();
      /** Start where "New chat" also lands, so the pathname genuinely cannot
       *  distinguish before from after. */
      click('go-elsewhere');
      expect(currentPath()).toBe('/c/new');

      click('go-b');
      /** Uncached, so the route has not moved — still `/c/new`. */
      expect(currentPath()).toBe('/c/new');

      click('new-chat');
      /** "New chat" from `/c/new` lands on `/c/new`: the pathname is unchanged,
       *  so only the recorded intent can tell that B is no longer wanted. */
      expect(currentPath()).toBe('/c/new');

      await settle(B, recordB);

      expect(currentPath()).toBe('/c/new');
      expect(currentConvo()?.conversationId).not.toBe(B);
    });

    it('does not land a first-visit record after the user re-scopes the draft', async () => {
      renderHarness();
      click('go-elsewhere');
      expect(currentPath()).toBe('/c/new');

      click('go-b');
      click('scope-draft');
      /** Only the query string moved, so a pathname-only comparison sees
       *  nothing — and this action never goes through a conversation hook, so
       *  no intent is recorded either. */
      expect(currentPath()).toBe('/c/new');

      await settle(B, recordB);

      expect(currentConvo()?.chatProjectId).toBe('project-x');
      expect(currentConvo()?.conversationId).not.toBe(B);
    });

    it('lands on the last conversation clicked, not the first record to arrive', async () => {
      renderHarness();
      click('go-b');
      click('go-c');
      /** Neither has moved the route yet — the first-visit path waits for its
       *  record — so both requests started from the same pathname and only
       *  click order can say which one the user actually wants. */
      expect(currentPath()).toBe('/c/convo-a');

      /** B answers first, but C was clicked last. */
      await settle(B, recordB);
      await settle(C, recordC);

      expect(currentPath()).toBe(`/c/${C}`);
      expect(currentConvo()?.conversationId).toBe(C);
    });

    it('discards a first-visit navigation that resolves after the user moved on', async () => {
      renderHarness([recordC]);
      click('go-b');
      click('go-c');
      expect(currentPath()).toBe(`/c/${C}`);

      await settle(B, recordB);

      expect(currentPath()).toBe(`/c/${C}`);
      expect(currentConvo()?.conversationId).toBe(C);
    });
  });

  describe('when the refresh fails after the route already moved', () => {
    it('keeps the mounted message cache on a transient failure', async () => {
      const queryClient = renderHarness([recordB]);
      queryClient.setQueryData([QueryKeys.messages, B], [{ messageId: 'loaded' }]);
      click('go-b');
      await settle(B, { status: 500 });

      /** The messages query is already mounted, so dropping it here would
       *  cancel or discard a history fetch with no remount left to retry it. */
      expect(queryClient.getQueryData([QueryKeys.messages, B])).toEqual([{ messageId: 'loaded' }]);
      expect(currentPath()).toBe(`/c/${B}`);
    });

    it('drops the message cache when the conversation is confirmed gone', async () => {
      const queryClient = renderHarness([recordB]);
      queryClient.setQueryData([QueryKeys.messages, B], [{ messageId: 'stale' }]);
      click('go-b');
      await settle(B, notFound());

      await waitFor(() =>
        expect(queryClient.getQueryData([QueryKeys.messages, B])).toBeUndefined(),
      );
    });
  });
});
