import React, { createRef } from 'react';
import { getDefaultStore } from 'jotai';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { RecoilRoot } from 'recoil';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CellMeasurerCache, List } from 'react-virtualized';
import type { TConversation } from 'librechat-data-provider';
import { hasAttachmentsAtom, resetFacetsAtom } from '../facets';
import { chatSortAtom } from '../chatFilters';
import Conversations from '../Conversations';
import store from '~/store';

/* The section resolves a conversation's project from the query cache, so the
 * tree needs a client even though the data hooks themselves are mocked. */
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let mockActiveJobIds: string[] = [];
let mockRunningRows: TConversation[] = [];
const mockRunningConversationsQuery = jest.fn((ids: readonly string[]) =>
  mockRunningRows.filter((row) => ids.includes(row.conversationId ?? '')),
);

jest.mock('react-virtualized', () => {
  const actual = jest.requireActual('react-virtualized');
  return {
    ...actual,
    CellMeasurer: ({
      children,
    }: {
      children: (opts: { registerChild: () => void }) => React.ReactNode;
    }) => children({ registerChild: () => {} }),
    List: ({
      rowRenderer,
      rowCount,
      _deferredMeasurementCache,
    }: {
      rowRenderer: (opts: {
        index: number;
        key: string;
        style: object;
        parent: object;
      }) => React.ReactNode;
      rowCount: number;
      deferredMeasurementCache: CellMeasurerCache;
      [key: string]: unknown;
    }) => {
      return (
        <div data-testid="virtual-list" data-row-count={rowCount}>
          {Array.from({ length: Math.min(rowCount, 10) }, (_, i) =>
            rowRenderer({ index: i, key: `row-${i}`, style: {}, parent: {} }),
          )}
        </div>
      );
    },
  };
});

jest.mock('~/store', () => {
  const { atom } = jest.requireActual('recoil');
  return {
    __esModule: true,
    default: {
      search: atom({ key: 'test-conversations-search', default: { query: '' } }),
    },
  };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useElementSize: () => ({ ref: jest.fn(), width: 300, height: 600 }),
  useOuterScrollWindow: () => ({
    ref: jest.fn(),
    height: 600,
    scrollTop: 0,
    isOnScreen: () => true,
  }),
  TranslationKeys: {},
}));

jest.mock('@librechat/client', () => ({
  /* The section headers compose through the shared variant recipe. */
  buttonVariants: () => '',
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
  /* The empty and error states are the shared panel state, rendered here with the
     glyph dropped: what these tests read is the line and its action. */
  EmptyState: ({
    title,
    description,
    action,
  }: {
    title?: string;
    description?: string;
    action?: React.ReactNode;
  }) => (
    <div>
      {title != null && <p>{title}</p>}
      {description != null && <p>{description}</p>}
      {action}
    </div>
  ),
  Spinner: () => <div data-testid="spinner" />,
  useMediaQuery: () => false,
  useToastContext: () => ({ showToast: jest.fn() }),
}));

jest.mock('~/data-provider', () => ({
  useActiveJobs: () => ({ data: { activeJobIds: mockActiveJobIds } }),
  useRunningConversationsQuery: (ids: readonly string[]) => mockRunningConversationsQuery(ids),
  useAssignConversationToProjectMutation: () => ({ mutate: jest.fn() }),
  usePinConversationMutation: () => ({ mutate: jest.fn() }),
}));

jest.mock('~/utils', () => ({
  groupConversations: jest.fn(jest.requireActual('~/utils/convos').groupConversations),
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

jest.mock('../Convo', () => ({
  __esModule: true,
  default: ({
    conversation,
    showProjectBadge,
  }: {
    conversation: TConversation;
    showProjectBadge?: boolean;
  }) => (
    <div data-testid="convo" data-project-badge={String(showProjectBadge === true)}>
      {conversation.title}
    </div>
  ),
}));

const pinnedConvo = {
  conversationId: 'pinned-1',
  title: 'Pinned Chat',
  pinned: true,
  endpoint: 'openAI',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} as TConversation;

describe('Conversations: live running order', () => {
  const containerRef = createRef<List>();
  const newer = {
    conversationId: 'newer',
    title: 'Newer idle chat',
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
  } as TConversation;
  const running = {
    conversationId: 'running',
    title: 'Older running chat',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  } as TConversation;

  afterEach(() => {
    mockActiveJobIds = [];
  });

  it('promotes and restores a chat without changing its paged input', () => {
    const conversations = [newer, running];
    const renderList = () => (
      <QueryClientProvider client={queryClient}>
        <DndProvider backend={HTML5Backend}>
          <RecoilRoot>
            <Conversations
              conversations={conversations}
              moveToTop={jest.fn()}
              toggleNav={jest.fn()}
              containerRef={containerRef}
              loadMoreConversations={jest.fn()}
              isLoading={false}
              isSearchLoading={false}
              isChatsExpanded={true}
              setIsChatsExpanded={jest.fn()}
              scrollViewport={null}
              scrollContent={null}
            />
          </RecoilRoot>
        </DndProvider>
      </QueryClientProvider>
    );
    const rowOrder = () => screen.getAllByTestId('convo').map((row) => row.textContent);

    const view = render(renderList());
    const groupConversationsMock = jest.requireMock('~/utils').groupConversations as jest.Mock;
    groupConversationsMock.mockClear();
    expect(rowOrder()).toEqual(['Newer idle chat', 'Older running chat']);
    expect(screen.queryByRole('heading', { name: 'com_a11y_chats_running_section' })).toBeNull();

    mockActiveJobIds = ['running'];
    view.rerender(renderList());
    expect(
      screen.getByRole('heading', { name: 'com_a11y_chats_running_section' }),
    ).toBeInTheDocument();
    expect(rowOrder()).toEqual(['Older running chat', 'Newer idle chat']);
    expect(groupConversationsMock).not.toHaveBeenCalled();

    mockActiveJobIds = ['running'];
    view.rerender(renderList());
    expect(groupConversationsMock).not.toHaveBeenCalled();
    expect(rowOrder()).toEqual(['Older running chat', 'Newer idle chat']);

    mockActiveJobIds = [];
    view.rerender(renderList());
    expect(screen.queryByRole('heading', { name: 'com_a11y_chats_running_section' })).toBeNull();
    expect(rowOrder()).toEqual(['Newer idle chat', 'Older running chat']);
    expect(conversations).toEqual([newer, running]);
  });
});

describe('Conversations: pinned chats live in PinnedSection', () => {
  const containerRef = createRef<List>();

  const renderConversations = (conversations: TConversation[], searchQuery = '') =>
    render(
      <QueryClientProvider client={queryClient}>
        <DndProvider backend={HTML5Backend}>
          <RecoilRoot
            initializeState={({ set }) => {
              set(store.search, {
                query: searchQuery,
                enabled: true,
                debouncedQuery: searchQuery,
                isSearching: true,
                isTyping: false,
              });
            }}
          >
            <Conversations
              conversations={conversations}
              moveToTop={jest.fn()}
              toggleNav={jest.fn()}
              containerRef={containerRef}
              loadMoreConversations={jest.fn()}
              isLoading={false}
              isSearchLoading={false}
              isChatsExpanded={true}
              setIsChatsExpanded={jest.fn()}
              scrollViewport={null}
              scrollContent={null}
            />
          </RecoilRoot>
        </DndProvider>
      </QueryClientProvider>,
    );

  it('does not render a pinned header inside the chats list', () => {
    const { queryByText, queryByTestId } = renderConversations([pinnedConvo]);
    expect(queryByText('com_ui_pinned')).not.toBeInTheDocument();
    expect(queryByTestId('convo')).not.toBeInTheDocument();
  });

  it('shows pinned search matches in Chats while the Pinned section is hidden', () => {
    renderConversations([pinnedConvo, pinnedConvo], 'Pinned Chat');

    expect(screen.getAllByTestId('convo')).toHaveLength(1);
    expect(screen.getByTestId('convo')).toHaveTextContent('Pinned Chat');
    expect(screen.queryByText('com_ui_no_search_results')).not.toBeInTheDocument();
  });

  it('keeps running matches promoted when search includes pinned chats', () => {
    mockActiveJobIds = ['running'];
    const running = {
      ...pinnedConvo,
      conversationId: 'running',
      title: 'Running match',
      pinned: false,
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as TConversation;

    try {
      renderConversations([pinnedConvo, running], 'match');

      expect(screen.getAllByTestId('convo').map((row) => row.textContent)).toEqual([
        'Running match',
        'Pinned Chat',
      ]);
      expect(
        screen.getByRole('heading', { name: 'com_a11y_chats_running_section' }),
      ).toBeInTheDocument();
    } finally {
      mockActiveJobIds = [];
    }
  });

  it('does not render a duplicate new chat button in the chats header', () => {
    const { queryByRole } = renderConversations([]);
    expect(queryByRole('button', { name: 'com_ui_new_chat' })).not.toBeInTheDocument();
  });
});

describe('Conversations: all-pin pages still paginate', () => {
  const containerRef = createRef<List>();

  const renderList = ({
    conversations,
    loadMoreConversations,
    isChatsExpanded = true,
    isLoading = false,
    isError = false,
    onRetry,
    hasNextPage = false,
  }: {
    conversations: TConversation[];
    loadMoreConversations: () => void;
    isChatsExpanded?: boolean;
    isLoading?: boolean;
    isError?: boolean;
    onRetry?: () => void;
    hasNextPage?: boolean;
  }) =>
    render(
      <QueryClientProvider client={queryClient}>
        <DndProvider backend={HTML5Backend}>
          <RecoilRoot>
            <Conversations
              conversations={conversations}
              moveToTop={jest.fn()}
              toggleNav={jest.fn()}
              containerRef={containerRef}
              loadMoreConversations={loadMoreConversations}
              isLoading={isLoading}
              isSearchLoading={false}
              isError={isError}
              onRetry={onRetry}
              isChatsExpanded={isChatsExpanded}
              setIsChatsExpanded={jest.fn()}
              hasNextPage={hasNextPage}
              scrollViewport={null}
              scrollContent={null}
            />
          </RecoilRoot>
        </DndProvider>
      </QueryClientProvider>,
    );
  it('renders a retryable load error instead of the empty state', () => {
    const onRetry = jest.fn();
    renderList({
      conversations: [],
      loadMoreConversations: jest.fn(),
      isError: true,
      onRetry,
    });

    expect(screen.getByTestId('convo-list-error')).toHaveTextContent('com_ui_chats_load_error');
    expect(screen.queryByTestId('convo-list-empty')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('requests another page when grouping leaves the chats list empty', () => {
    const loadMoreConversations = jest.fn();
    renderList({ conversations: [pinnedConvo], loadMoreConversations });
    expect(loadMoreConversations).toHaveBeenCalled();
  });

  it('does not show no chats when a drained unfiltered page contains only pinned rows', () => {
    renderList({
      conversations: [pinnedConvo],
      loadMoreConversations: jest.fn(),
      hasNextPage: false,
    });

    expect(screen.queryByText('com_ui_no_chats')).not.toBeInTheDocument();
  });

  it('does not request another page while chats are collapsed', () => {
    const loadMoreConversations = jest.fn();
    renderList({
      conversations: [pinnedConvo],
      loadMoreConversations,
      isChatsExpanded: false,
    });
    expect(loadMoreConversations).not.toHaveBeenCalled();
  });

  it('does not request another page while a fetch is already in flight', () => {
    const loadMoreConversations = jest.fn();
    renderList({
      conversations: [pinnedConvo],
      loadMoreConversations,
      isLoading: true,
    });
    expect(loadMoreConversations).not.toHaveBeenCalled();
  });

  it('does not retry when an empty-page fetch fails without new data', () => {
    const loadMoreConversations = jest.fn();
    const conversations = [pinnedConvo];
    const { rerender } = renderList({ conversations, loadMoreConversations });
    expect(loadMoreConversations).toHaveBeenCalledTimes(1);

    rerender(
      <QueryClientProvider client={queryClient}>
        <DndProvider backend={HTML5Backend}>
          <RecoilRoot>
            <Conversations
              conversations={conversations}
              moveToTop={jest.fn()}
              toggleNav={jest.fn()}
              containerRef={containerRef}
              loadMoreConversations={loadMoreConversations}
              isLoading={true}
              isSearchLoading={false}
              isChatsExpanded={true}
              setIsChatsExpanded={jest.fn()}
              scrollViewport={null}
              scrollContent={null}
            />
          </RecoilRoot>
        </DndProvider>
      </QueryClientProvider>,
    );
    rerender(
      <QueryClientProvider client={queryClient}>
        <DndProvider backend={HTML5Backend}>
          <RecoilRoot>
            <Conversations
              conversations={conversations}
              moveToTop={jest.fn()}
              toggleNav={jest.fn()}
              containerRef={containerRef}
              loadMoreConversations={loadMoreConversations}
              isLoading={false}
              isSearchLoading={false}
              isChatsExpanded={true}
              setIsChatsExpanded={jest.fn()}
              scrollViewport={null}
              scrollContent={null}
            />
          </RecoilRoot>
        </DndProvider>
      </QueryClientProvider>,
    );

    expect(loadMoreConversations).toHaveBeenCalledTimes(1);
  });
});

describe('Conversations: the empty state offers the way back', () => {
  const containerRef = createRef<List>();
  const jotaiStore = getDefaultStore();

  afterEach(() => {
    jotaiStore.set(resetFacetsAtom);
  });

  const renderEmpty = () =>
    render(
      <QueryClientProvider client={queryClient}>
        <DndProvider backend={HTML5Backend}>
          <RecoilRoot>
            <Conversations
              conversations={[]}
              moveToTop={jest.fn()}
              toggleNav={jest.fn()}
              containerRef={containerRef}
              loadMoreConversations={jest.fn()}
              isLoading={false}
              isSearchLoading={false}
              isChatsExpanded={true}
              setIsChatsExpanded={jest.fn()}
              scrollViewport={null}
              scrollContent={null}
            />
          </RecoilRoot>
        </DndProvider>
      </QueryClientProvider>,
    );

  it('says the account is empty, with nothing to clear', () => {
    const { getByTestId, queryByRole } = renderEmpty();

    expect(getByTestId('convo-list-empty')).toHaveTextContent('com_ui_no_chats');
    expect(queryByRole('button', { name: 'com_ui_clear_filters' })).not.toBeInTheDocument();
  });

  /** A facet narrows the same list the bookmark tags do, so an empty result under one
   *  has to read as "nothing matched" and carry the same way out. */
  it('offers to clear a facet that matched nothing', () => {
    jotaiStore.set(hasAttachmentsAtom, true);
    const { getByTestId, getByRole } = renderEmpty();

    expect(getByTestId('convo-list-empty')).toHaveTextContent('com_ui_no_chats_match_filters');

    fireEvent.click(getByRole('button', { name: 'com_ui_clear_filters' }));

    expect(jotaiStore.get(hasAttachmentsAtom)).toBe(false);
  });
});

describe('Conversations: Running lists chats outside the Chats list', () => {
  const containerRef = createRef<List>();
  const idle = {
    conversationId: 'idle',
    title: 'Idle chat',
    endpoint: 'openAI',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
  } as TConversation;
  const projectChat = {
    ...idle,
    conversationId: 'project-chat',
    title: 'Project chat',
    chatProjectId: 'project-1',
    updatedAt: '2026-01-02T00:00:00.000Z',
  } as TConversation;

  const renderList = (searchQuery = '') =>
    render(
      <QueryClientProvider client={queryClient}>
        <DndProvider backend={HTML5Backend}>
          <RecoilRoot
            initializeState={({ set }) => {
              set(store.search, {
                query: searchQuery,
                enabled: true,
                debouncedQuery: searchQuery,
                isSearching: searchQuery.length > 0,
                isTyping: false,
              });
            }}
          >
            <Conversations
              conversations={[idle]}
              moveToTop={jest.fn()}
              toggleNav={jest.fn()}
              containerRef={containerRef}
              loadMoreConversations={jest.fn()}
              isLoading={false}
              isSearchLoading={false}
              isChatsExpanded={true}
              setIsChatsExpanded={jest.fn()}
              scrollViewport={null}
              scrollContent={null}
            />
          </RecoilRoot>
        </DndProvider>
      </QueryClientProvider>,
    );

  beforeEach(() => {
    mockActiveJobIds = ['project-chat'];
    mockRunningRows = [projectChat];
    mockRunningConversationsQuery.mockClear();
  });

  afterEach(() => {
    mockActiveJobIds = [];
    mockRunningRows = [];
  });

  it('shows a running project chat in Running with its project badge', () => {
    renderList();

    expect(mockRunningConversationsQuery).toHaveBeenLastCalledWith(['project-chat']);
    expect(
      screen.getByRole('heading', { name: 'com_a11y_chats_running_section' }),
    ).toBeInTheDocument();
    const rows = screen.getAllByTestId('convo');
    expect(rows.map((row) => row.textContent)).toEqual(['Project chat', 'Idle chat']);
    expect(rows.map((row) => row.getAttribute('data-project-badge'))).toEqual(['true', 'false']);
  });

  it('fetches nothing under a sort that has no Running group', () => {
    const jotaiStore = getDefaultStore();
    const previous = jotaiStore.get(chatSortAtom);
    jotaiStore.set(chatSortAtom, { field: 'title', direction: 'asc' });
    try {
      renderList();

      expect(mockRunningConversationsQuery).toHaveBeenLastCalledWith([]);
      expect(screen.queryByRole('heading', { name: 'com_a11y_chats_running_section' })).toBeNull();
    } finally {
      jotaiStore.set(chatSortAtom, previous);
    }
  });

  it('keeps a search result to its own matches', () => {
    renderList('Idle');

    expect(mockRunningConversationsQuery).toHaveBeenLastCalledWith([]);
    expect(screen.queryByRole('heading', { name: 'com_a11y_chats_running_section' })).toBeNull();
    expect(screen.getAllByTestId('convo').map((row) => row.textContent)).toEqual(['Idle chat']);
  });
});
