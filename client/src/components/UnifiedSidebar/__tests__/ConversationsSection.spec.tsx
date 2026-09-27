import React from 'react';
import { DndProvider } from 'react-dnd';
import { BrowserRouter } from 'react-router-dom';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { render, act, screen, fireEvent } from '@testing-library/react';
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
  data: { pages: [{ conversations: [] as unknown[], nextCursor: null }] } as
    | { pages: Array<{ conversations: unknown[]; nextCursor: string | null }> }
    | undefined,
  fetchNextPage: jest.fn(),
  refetch: jest.fn(),
  isFetchingNextPage: false,
  isLoading: false,
  isFetching: false,
  isPreviousData: false,
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
  useFavorites: () => mockUseFavorites(),
  useShowMarketplace: () => false,
  useNewConvo: () => ({ newConversation: jest.fn() }),
  useGetConversation: () => () => null,
}));

jest.mock('~/data-provider', () => ({
  __esModule: true,
  useConversationsInfiniteQuery: () => mockConversationsResult,
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
  const ConversationsStub = memo(function ConversationsStub({
    conversations,
    isSearchLoading,
    isError,
    onRetry,
  }: {
    conversations: Array<{ conversationId: string; title: string }>;
    isSearchLoading: boolean;
    isError: boolean;
    onRetry: () => void;
  }) {
    mockConversationsRender();
    const localize: (key: string) => string = jest.requireMock('~/hooks').useLocalize();
    let body: React.ReactNode = conversations.map((convo) => (
      <span key={convo.conversationId}>{convo.title}</span>
    ));
    if (isError && conversations.length === 0) {
      body = (
        <button type="button" onClick={onRetry}>
          {localize('com_ui_retry')}
        </button>
      );
    }
    if (isSearchLoading) {
      body = <div data-testid="search-spinner" />;
    }
    return <div data-testid="conversations-stub">{body}</div>;
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
let setSearchState: SetterOrUpdater<SearchState>;

function TickController() {
  setStreamTick = useSetRecoilState(streamTickAtom);
  setSearchState = useSetRecoilState(store.search);
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

const renderSection = (searchQuery = '') =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RecoilRoot
        initializeState={({ set }) => {
          if (searchQuery) {
            set(store.search, {
              query: searchQuery,
              debouncedQuery: searchQuery,
              enabled: true,
              isTyping: false,
              isSearching: false,
            });
          }
        }}
      >
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

describe('ConversationsSection search refetch', () => {
  it('does not display old matches as unfiltered chats while clearing the search', async () => {
    const previousData = mockConversationsResult.data;
    mockConversationsResult.data = {
      pages: [
        {
          conversations: [{ conversationId: 'chat-1', title: 'Old search match' }],
          nextCursor: null,
        },
      ],
    };

    try {
      renderSection('draft');
      await settleRenders();
      expect(screen.getByText('Old search match')).toBeInTheDocument();

      act(() => {
        setSearchState({
          query: '',
          debouncedQuery: 'draft',
          enabled: true,
          isTyping: true,
          isSearching: false,
        });
      });

      expect(screen.getByTestId('projects-stub')).toBeInTheDocument();
      expect(screen.queryByText('Old search match')).not.toBeInTheDocument();
      expect(screen.getByTestId('search-spinner')).toBeInTheDocument();
    } finally {
      mockConversationsResult.data = previousData;
    }
  });

  it('shows progress while retrying a failed cached search with no results', async () => {
    const previousData = mockConversationsResult.data;
    mockConversationsResult.isError = true;

    try {
      renderSection('draft');
      await settleRenders();
      expect(screen.getByRole('button', { name: 'com_ui_retry' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
      expect(mockConversationsResult.refetch).toHaveBeenCalledTimes(1);

      act(() => {
        mockConversationsResult.isFetching = true;
        setStreamTick((prev) => prev + 1);
      });

      expect(screen.getByTestId('search-spinner')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'com_ui_retry' })).not.toBeInTheDocument();

      act(() => {
        mockConversationsResult.isFetching = false;
        mockConversationsResult.isError = false;
        mockConversationsResult.data = {
          pages: [
            {
              conversations: [{ conversationId: 'chat-1', title: 'Found match' }],
              nextCursor: null,
            },
          ],
        };
        setStreamTick((prev) => prev + 1);
      });

      expect(screen.getByText('Found match')).toBeInTheDocument();
      expect(screen.queryByTestId('search-spinner')).not.toBeInTheDocument();
    } finally {
      mockConversationsResult.data = previousData;
      mockConversationsResult.isError = false;
      mockConversationsResult.isFetching = false;
      mockConversationsResult.refetch.mockClear();
    }
  });

  it('shows loading for an uncached search', async () => {
    const previousData = mockConversationsResult.data;
    mockConversationsResult.data = undefined;
    mockConversationsResult.isLoading = true;

    try {
      renderSection('draft');
      await settleRenders();
      expect(screen.getByTestId('search-spinner')).toBeInTheDocument();
    } finally {
      mockConversationsResult.data = previousData;
      mockConversationsResult.isLoading = false;
    }
  });

  it('does not show results from the previous search while the next one loads', async () => {
    const previousData = mockConversationsResult.data;
    mockConversationsResult.data = {
      pages: [
        {
          conversations: [{ conversationId: 'chat-1', title: 'Previous match' }],
          nextCursor: null,
        },
      ],
    };
    mockConversationsResult.isPreviousData = true;

    try {
      renderSection('new term');
      await settleRenders();
      expect(screen.getByTestId('search-spinner')).toBeInTheDocument();
      expect(screen.queryByText('Previous match')).not.toBeInTheDocument();
    } finally {
      mockConversationsResult.data = previousData;
      mockConversationsResult.isPreviousData = false;
    }
  });

  it('keeps cached results visible when a message triggers a background list refetch', async () => {
    const previousData = mockConversationsResult.data;
    mockConversationsResult.data = {
      pages: [
        {
          conversations: [{ conversationId: 'chat-1', title: 'Matching chat' }],
          nextCursor: null,
        },
      ],
    };

    try {
      renderSection('draft');
      await settleRenders();
      expect(screen.getByText('Matching chat')).toBeInTheDocument();

      act(() => {
        mockConversationsResult.isFetching = true;
        setStreamTick((prev) => prev + 1);
      });

      expect(screen.getByText('Matching chat')).toBeInTheDocument();
      expect(screen.queryByTestId('search-spinner')).not.toBeInTheDocument();
    } finally {
      mockConversationsResult.isFetching = false;
      mockConversationsResult.data = previousData;
    }
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
