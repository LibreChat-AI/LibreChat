import React from 'react';
import { DndProvider } from 'react-dnd';
import { BrowserRouter } from 'react-router-dom';
import { render, act } from '@testing-library/react';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { atom, RecoilRoot, useRecoilValue, useSetRecoilState } from 'recoil';
import type { SetterOrUpdater } from 'recoil';
import type { SearchState } from '~/store/search';

/**
 * Real recoil atom used to force ConversationsSection to re-render on demand,
 * standing in for the conversation-list / title-generation cache churn that
 * happens while a message is streaming. The mocked `useTitleGeneration`
 * subscribes to it, so bumping it re-renders ConversationsSection (and only
 * ConversationsSection) exactly like a streaming update would.
 */
const streamTickAtom = atom<number>({ key: 'conversations-section-stream-tick', default: 0 });

const TEST_TIMEOUT = 30_000;

const mockUseFavorites = jest.fn(() => ({
  favorites: [] as unknown[],
  reorderFavorites: jest.fn(),
  isLoading: false,
}));
const mockUseGetConversationTags = jest.fn(() => ({ data: [] as unknown[] }));
const mockConversationsRender = jest.fn();
/** What the chats list asks the server for, captured per render. */
const mockListParams = jest.fn();
const mockSetChatsExpanded = jest.fn();
const mockMoveToTop = jest.fn();
const mockUseTitleGeneration = jest.fn(() => {
  useRecoilValue(streamTickAtom);
});

/** One stable identity across renders, like react-query's cached data: the
 *  section's derived `conversations` memo (and so the PinnedSection props)
 *  keeps referential stability mid-stream, which is what the memoized-children
 *  guarantee below depends on. */
const mockConversationsResult = {
  data: { pages: [{ conversations: [] as unknown[], nextCursor: null }] },
  fetchNextPage: jest.fn(),
  refetch: jest.fn(),
  isFetchingNextPage: false,
  isLoading: false,
  isFetching: false,
  isError: false,
};

/** Same identity rule as above: a fresh `pinnedData.conversations` array would
 *  rebuild `pinnedConversations` and re-render PinnedSection on every tick. */
const mockPinnedResult = { data: { conversations: [] as unknown[], nextCursor: null } };

jest.mock('~/store', () => {
  const { atom: recoilAtom } = jest.requireActual('recoil');
  return {
    __esModule: true,
    default: {
      sidebarExpanded: recoilAtom({ key: 'mock-cs-sidebarExpanded', default: false }),
      search: recoilAtom({
        key: 'mock-cs-search',
        default: { query: '', debouncedQuery: '', enabled: false, isTyping: false },
      }),
    },
  };
});

jest.mock('~/hooks', () => ({
  __esModule: true,
  useLocalize: () => (key: string) => key,
  useHasAccess: () => true,
  useAuthContext: () => ({ isAuthenticated: true }),
  useLocalStorage: () => [true, mockSetChatsExpanded],
  useNavScrolling: () => ({ moveToTop: mockMoveToTop }),
  useScrollFade: () => ({ attach: jest.fn(), hasMore: false }),
  useFavorites: () => mockUseFavorites(),
  useShowMarketplace: () => false,
  useNewConvo: () => ({ newConversation: jest.fn() }),
  useGetConversation: () => () => null,
}));

jest.mock('~/data-provider', () => ({
  __esModule: true,
  useConversationsInfiniteQuery: (params: Record<string, unknown>) => {
    mockListParams(params);
    return mockConversationsResult;
  },
  usePinnedConversationsQuery: () => mockPinnedResult,
  useTitleGeneration: () => mockUseTitleGeneration(),
  useGetEndpointsQuery: () => ({ data: {}, isLoading: false }),
  useGetStartupConfig: () => ({ data: { modelSpecs: { list: [] } } }),
  useGetConversationTags: () => mockUseGetConversationTags(),
}));

jest.mock('~/Providers', () => ({
  __esModule: true,
  useAssistantsMapContext: () => ({}),
  useAgentsMapContext: () => ({}),
}));

jest.mock('~/hooks/Input/useSelectMention', () => ({
  __esModule: true,
  default: () => ({ onSelectEndpoint: jest.fn(), onSelectSpec: jest.fn() }),
}));

jest.mock('~/components/Conversations', () => {
  const { memo } = jest.requireActual('react');
  const ConversationsStub = memo(function ConversationsStub() {
    mockConversationsRender();
    return <div data-testid="conversations-stub" />;
  });
  return { __esModule: true, Conversations: ConversationsStub };
});

jest.mock('~/components/Conversations/ProjectsSection', () => ({
  __esModule: true,
  default: () => <div data-testid="projects-stub" />,
}));

jest.mock('~/components/Conversations/PinnedSection', () => {
  const { memo } = jest.requireActual('react');
  /** Mirrors the real merged section closely enough for the streaming test:
   *  memoized like it, and its first act is the same `useFavorites` call
   *  through the ~/hooks mock, so that hook's call count tracks its renders. */
  const PinnedSectionStub = memo(function PinnedSectionStub() {
    mockUseFavorites();
    return <div data-testid="pinned-stub" />;
  });
  PinnedSectionStub.displayName = 'PinnedSectionStub';
  return { __esModule: true, default: PinnedSectionStub };
});

jest.mock('~/components/Nav/SearchBar', () => ({
  __esModule: true,
  default: () => <div data-testid="searchbar-stub" />,
}));

jest.mock('~/components/Nav/Favorites/FavoriteItem', () => ({
  __esModule: true,
  default: () => <div data-testid="favorite-item-stub" />,
}));

import ConversationsSection from '../ConversationsSection';
import store from '~/store';

let setStreamTick: SetterOrUpdater<number>;

function TickController() {
  setStreamTick = useSetRecoilState(streamTickAtom);
  return null;
}

const createQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const renderCount = () =>
  mockUseFavorites.mock.calls.length + mockUseTitleGeneration.mock.calls.length;

/**
 * Yield a full event-loop turn inside act, so follow-up work that lands in the real
 * scheduler as a macrotask is flushed before render counts are compared.
 */
const flushEventLoopTurn = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/** Flush event-loop turns until two consecutive turns add no renders (bounded). */
const settleRenders = async () => {
  let stableTurns = 0;
  for (let turn = 0; turn < 20 && stableTurns < 2; turn++) {
    const before = renderCount();
    await flushEventLoopTurn();
    stableTurns = renderCount() === before ? stableTurns + 1 : 0;
  }
};

const renderSection = () =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RecoilRoot>
        <BrowserRouter>
          <DndProvider backend={HTML5Backend}>
            <TickController />
            <ConversationsSection />
          </DndProvider>
        </BrowserRouter>
      </RecoilRoot>
    </QueryClientProvider>,
  );

describe('ConversationsSection section order', () => {
  it('renders Pinned between Projects and Chats', async () => {
    const { getByTestId } = renderSection();
    await settleRenders();

    const projects = getByTestId('projects-stub');
    const pinned = getByTestId('pinned-stub');
    const chats = getByTestId('conversations-stub');

    expect(
      projects.compareDocumentPosition(pinned) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(pinned.compareDocumentPosition(chats) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('ConversationsSection streaming re-renders', () => {
  beforeEach(() => {
    mockConversationsRender.mockClear();
    mockUseFavorites.mockImplementation(() => ({
      favorites: [],
      reorderFavorites: jest.fn(),
      isLoading: false,
    }));
    mockUseGetConversationTags.mockImplementation(() => ({ data: [] }));
    mockUseTitleGeneration.mockImplementation(() => {
      useRecoilValue(streamTickAtom);
    });
  });

  it(
    'does not re-render memoized children when the section re-renders mid-stream',
    async () => {
      renderSection();
      await settleRenders();

      expect(mockUseFavorites.mock.calls.length).toBeGreaterThan(0);

      const favBaseline = mockUseFavorites.mock.calls.length;
      const conversationsBaseline = mockConversationsRender.mock.calls.length;
      const titleBaseline = mockUseTitleGeneration.mock.calls.length;

      // Simulate a stream: repeatedly re-render ConversationsSection.
      for (let i = 0; i < 5; i++) {
        act(() => {
          setStreamTick((prev) => prev + 1);
        });
      }

      // Sanity check: the section genuinely re-rendered each tick.
      expect(mockUseTitleGeneration.mock.calls.length).toBeGreaterThan(titleBaseline);

      // The memoized children, fed referentially stable props, did not re-render.
      expect(mockUseFavorites.mock.calls.length).toBe(favBaseline);
      expect(mockConversationsRender.mock.calls.length).toBe(conversationsBaseline);
    },
    TEST_TIMEOUT,
  );
});

describe('ConversationsSection project chats', () => {
  beforeEach(() => {
    mockListParams.mockClear();
  });

  /** A chat that belongs to a project is shown under that project. Listing it in
   *  Chats as well puts the same conversation in two places in one sidebar. */
  it('asks only for chats that belong to no project', async () => {
    renderSection();
    await settleRenders();

    expect(mockListParams).toHaveBeenCalled();
    expect(mockListParams.mock.calls.at(-1)?.[0]).toMatchObject({ projectId: 'unassigned' });
  });

  /** Searching is how a chat is found, and Projects is not rendered while a search
   *  is on: excluding project chats there would make them unreachable. */
  it('searches across every chat, project or not', async () => {
    let setSearch: SetterOrUpdater<SearchState>;

    function SearchController() {
      setSearch = useSetRecoilState(store.search);
      return null;
    }

    render(
      <QueryClientProvider client={createQueryClient()}>
        <RecoilRoot>
          <BrowserRouter>
            <DndProvider backend={HTML5Backend}>
              <SearchController />
              <ConversationsSection />
            </DndProvider>
          </BrowserRouter>
        </RecoilRoot>
      </QueryClientProvider>,
    );
    await settleRenders();

    act(() => {
      setSearch({
        query: 'draft',
        debouncedQuery: 'draft',
        enabled: true,
        isTyping: false,
        isSearching: true,
      });
    });

    expect(mockListParams.mock.calls.at(-1)?.[0]).toMatchObject({
      search: 'draft',
      projectId: undefined,
    });
  });
});

describe('ConversationsSection shared scroll surface', () => {
  /** Searching swaps what the one surface holds — Projects and Pinned leave,
   *  the chats become results — and a position kept from the previous contents
   *  would open those results partway down. */
  it('returns the surface to the top when a search replaces its contents', async () => {
    let setSearch: SetterOrUpdater<SearchState>;

    function SearchController() {
      setSearch = useSetRecoilState(store.search);
      return null;
    }

    const { container } = render(
      <QueryClientProvider client={createQueryClient()}>
        <RecoilRoot>
          <BrowserRouter>
            <DndProvider backend={HTML5Backend}>
              <SearchController />
              <ConversationsSection />
            </DndProvider>
          </BrowserRouter>
        </RecoilRoot>
      </QueryClientProvider>,
    );
    await settleRenders();

    const surface = container.querySelector<HTMLElement>('.overflow-y-auto');
    expect(surface).not.toBeNull();
    surface!.scrollTop = 420;

    act(() => {
      setSearch({
        query: 'draft',
        debouncedQuery: 'draft',
        enabled: true,
        isTyping: false,
        isSearching: true,
      });
    });

    expect(surface!.scrollTop).toBe(0);
  });
});
