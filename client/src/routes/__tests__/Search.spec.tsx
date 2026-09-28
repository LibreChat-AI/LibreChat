import React from 'react';
import { useRecoilValue } from 'recoil';
import { render, screen } from '@testing-library/react';
import { useMessagesInfiniteQuery } from '~/data-provider';
import Search from '../Search';

/* react-virtualized measures nothing in jsdom; render every row flatly so the
   list contents are exercised. */
jest.mock('react-virtualized', () => ({
  __esModule: true,
  CellMeasurerCache: class {
    getHeight() {
      return 100;
    }

    clearAll() {}
  },
  CellMeasurer: ({
    children,
  }: {
    children: (a: { registerChild: () => void }) => React.ReactNode;
  }) => children({ registerChild: () => {} }),
  List: ({
    rowCount,
    rowRenderer,
    onRowsRendered,
    className,
  }: {
    rowCount: number;
    rowRenderer: (p: {
      index: number;
      key: string;
      parent: unknown;
      style: object;
    }) => React.ReactNode;
    onRowsRendered?: (p: { startIndex: number; stopIndex: number }) => void;
    className?: string;
  }) => {
    // expose the near-bottom trigger for the pagination test
    (globalThis as Record<string, unknown>).__triggerRowsRendered = () =>
      onRowsRendered?.({ startIndex: 0, stopIndex: rowCount - 1 });
    return (
      <div data-testid="virtual-list" className={className}>
        {Array.from({ length: rowCount }, (_, i) =>
          rowRenderer({ index: i, key: String(i), parent: {}, style: {} }),
        )}
      </div>
    );
  },
}));

jest.mock('recoil', () => ({ useRecoilValue: jest.fn() }));
jest.mock('~/data-provider', () => ({ useMessagesInfiniteQuery: jest.fn() }));
jest.mock('~/Providers', () => ({ useFileMapContext: () => ({}) }));
jest.mock('@librechat/client', () => ({
  Spinner: () => <div data-testid="spinner" />,
  useToastContext: () => ({ showToast: jest.fn() }),
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ isAuthenticated: true }),
  useElementSize: () => ({ ref: () => {}, width: 800, height: 600 }),
}));
jest.mock('~/store', () => ({ __esModule: true, default: { search: 'search-atom' } }));
jest.mock('~/components/Chat/Messages/SearchMessage', () => ({
  __esModule: true,
  default: ({ message }: { message: { text: string } }) => (
    <div className="search-row">{message.text}</div>
  ),
}));
jest.mock('~/utils', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }));
jest.mock('jotai', () => ({ useAtomValue: () => 'text-base' }));
jest.mock('~/store/fontSize', () => ({ fontSizeAtom: {} }));

const mockUseRecoilValue = useRecoilValue as jest.Mock;
const mockUseQuery = useMessagesInfiniteQuery as jest.Mock;

const searchState = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  query: 'zephyrine',
  debouncedQuery: 'zephyrine',
  isSearching: false,
  isTyping: false,
  ...over,
});

const queryResult = (over: Record<string, unknown> = {}) => ({
  data: { pages: [{ messages: [{ messageId: 'm1', text: 'row one' }], nextCursor: null }] },
  isLoading: false,
  isError: false,
  fetchNextPage: jest.fn(),
  isFetchingNextPage: false,
  hasNextPage: false,
  isPreviousData: false,
  ...over,
});

describe('Search route', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders result rows when data is present', () => {
    mockUseRecoilValue.mockReturnValue(searchState());
    mockUseQuery.mockReturnValue(queryResult());
    const { container } = render(<Search />);
    expect(screen.getByText('row one')).toBeInTheDocument();
    expect(screen.queryByTestId('spinner')).not.toBeInTheDocument();
    expect(screen.getByTestId('virtual-list')).toHaveClass(
      'focus-visible:ring-2',
      'focus-visible:ring-ring-primary',
    );
    expect(container.firstElementChild).toHaveClass('bg-presentation');
    expect(container.querySelector('.bg-gradient-to-t')).toHaveClass('from-presentation');
  });

  it('keeps results mounted while typing (does NOT flash the full spinner)', () => {
    mockUseRecoilValue.mockReturnValue(searchState({ isTyping: true }));
    mockUseQuery.mockReturnValue(queryResult());
    render(<Search />);
    // The whole list must stay — this is the core regression fix.
    expect(screen.getByText('row one')).toBeInTheDocument();
  });

  it('shows the full spinner only on initial load with no results', () => {
    mockUseRecoilValue.mockReturnValue(searchState());
    mockUseQuery.mockReturnValue(queryResult({ isLoading: true, data: undefined }));
    render(<Search />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
    expect(screen.queryByText('row one')).not.toBeInTheDocument();
  });

  it('shows nothing-found when the query returned no results', () => {
    mockUseRecoilValue.mockReturnValue(searchState());
    mockUseQuery.mockReturnValue(
      queryResult({ data: { pages: [{ messages: [], nextCursor: null }] } }),
    );
    render(<Search />);
    expect(screen.getAllByText('com_ui_nothing_found').length).toBeGreaterThan(0);
  });

  it('shows the spinner (not a false nothing-found) when stale empty data is held during a refetch', () => {
    mockUseRecoilValue.mockReturnValue(searchState());
    mockUseQuery.mockReturnValue(
      queryResult({
        data: { pages: [{ messages: [], nextCursor: null }] },
        isPreviousData: true,
      }),
    );
    render(<Search />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_nothing_found')).not.toBeInTheDocument();
  });

  it('renders nothing when there is no query and the user is idle', () => {
    mockUseRecoilValue.mockReturnValue(searchState({ debouncedQuery: '' }));
    mockUseQuery.mockReturnValue(queryResult({ data: undefined }));
    const { container } = render(<Search />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the spinner during the initial debounce (query typed, not yet debounced)', () => {
    mockUseRecoilValue.mockReturnValue(
      searchState({ query: 'zephyrine', debouncedQuery: '', isTyping: true }),
    );
    mockUseQuery.mockReturnValue(queryResult({ data: undefined }));
    render(<Search />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });

  it('announces empty results through a live region', () => {
    mockUseRecoilValue.mockReturnValue(searchState());
    mockUseQuery.mockReturnValue(
      queryResult({ data: { pages: [{ messages: [], nextCursor: null }] } }),
    );
    render(<Search />);
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_nothing_found');
  });

  it('fetches the next page when scrolled near the bottom', () => {
    const fetchNextPage = jest.fn();
    mockUseRecoilValue.mockReturnValue(searchState());
    mockUseQuery.mockReturnValue(queryResult({ hasNextPage: true, fetchNextPage }));
    render(<Search />);
    (globalThis as unknown as Record<string, () => void>).__triggerRowsRendered();
    expect(fetchNextPage).toHaveBeenCalled();
  });

  it('does NOT paginate the outgoing query while the user is still typing', () => {
    const fetchNextPage = jest.fn();
    mockUseRecoilValue.mockReturnValue(searchState({ isTyping: true }));
    mockUseQuery.mockReturnValue(queryResult({ hasNextPage: true, fetchNextPage }));
    render(<Search />);
    (globalThis as unknown as Record<string, () => void>).__triggerRowsRendered();
    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  it('does NOT paginate while previous-query results are still mounted (refetch in flight)', () => {
    const fetchNextPage = jest.fn();
    mockUseRecoilValue.mockReturnValue(searchState());
    mockUseQuery.mockReturnValue(
      queryResult({ hasNextPage: true, isPreviousData: true, fetchNextPage }),
    );
    render(<Search />);
    (globalThis as unknown as Record<string, () => void>).__triggerRowsRendered();
    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  it('renders a trailing spacer row so the last result clears the bottom overlay', () => {
    mockUseRecoilValue.mockReturnValue(searchState());
    mockUseQuery.mockReturnValue(queryResult());
    render(<Search />);
    expect(screen.getByText('row one')).toBeInTheDocument();
    expect(screen.getByTestId('search-footer')).toBeInTheDocument();
  });
});
