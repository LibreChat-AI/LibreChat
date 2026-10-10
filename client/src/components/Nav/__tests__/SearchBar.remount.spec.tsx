import { act, fireEvent, render, screen } from '@testing-library/react';

type SearchState = {
  query: string;
  debouncedQuery: string;
  isTyping: boolean;
  enabled: boolean;
};

const initialState = (): SearchState => ({
  query: '',
  debouncedQuery: '',
  isTyping: false,
  enabled: true,
});

let mockSearchState = initialState();

const mockSetSearchState = jest.fn((update: SearchState | ((prev: SearchState) => SearchState)) => {
  mockSearchState = typeof update === 'function' ? update(mockSearchState) : update;
});

jest.mock('recoil', () => ({
  useRecoilState: () => [mockSearchState, mockSetSearchState],
}));

jest.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/c/new' }),
  useNavigate: () => jest.fn(),
}));

const newQueryClient = () => ({ removeQueries: jest.fn(), invalidateQueries: jest.fn() });

let mockQueryClient = newQueryClient();

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => mockQueryClient,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useNewConvo: () => ({ newConversation: jest.fn() }),
}));

jest.mock('~/hooks/useKeyboardShortcuts', () => ({
  useShortcutAriaKey: () => 'Meta+/',
  /** The chord the field prints while it is empty. */
  useShortcutDisplay: () => '⌘/',
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: { search: 'search' },
}));

jest.mock('~/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));

import SearchBar from '../SearchBar';

const input = () => screen.getByTestId('nav-search-input') as HTMLInputElement;

const type = (value: string) => fireEvent.change(input(), { target: { value } });

const settle = () =>
  act(() => {
    jest.advanceTimersByTime(1000);
  });

/**
 * The field is mounted in two places — the list on a pointer device, the
 * drawer's bottom bar on touch — so crossing the breakpoint mid-search destroys
 * one instance and builds another against the same shared search state.
 */
describe('SearchBar across a breakpoint remount', () => {
  afterEach(() => {
    mockSearchState = initialState();
    mockQueryClient = newQueryClient();
    mockSetSearchState.mockClear();
  });

  describe('what the arriving instance shows', () => {
    it('shows the active query when mounted fresh', () => {
      mockSearchState = { ...mockSearchState, query: 'mobile nav', debouncedQuery: 'mobile nav' };

      render(<SearchBar />);

      expect(input().value).toBe('mobile nav');
    });

    it('offers the clear affordance for a query it inherited', () => {
      mockSearchState = { ...mockSearchState, query: 'mobile nav', debouncedQuery: 'mobile nav' };

      render(<SearchBar />);

      expect(screen.getByLabelText('com_ui_clear_search')).toBeEnabled();
    });

    it('starts empty when no search is active', () => {
      render(<SearchBar />);

      expect(input().value).toBe('');
    });
  });

  describe('what the field offers while it rests', () => {
    /** The chord is painted under the pointer only, which is CSS; what is checked
     *  here is which of the two the trailing slot holds. */
    it('holds the chord until there is something to clear', () => {
      render(<SearchBar />);

      expect(screen.getByText('⌘/')).toBeInTheDocument();
      expect(screen.queryByLabelText('com_ui_clear_search')).not.toBeInTheDocument();

      type('mobile nav');

      expect(screen.queryByText('⌘/')).not.toBeInTheDocument();
      expect(screen.getByLabelText('com_ui_clear_search')).toBeInTheDocument();
    });

    /** A query left behind keeps the results route mounted, so the key that
     *  dismisses the search has to dismiss what it found. */
    it('empties itself on Escape', () => {
      render(<SearchBar />);
      type('mobile nav');

      fireEvent.keyDown(input(), { key: 'Escape' });

      expect(input().value).toBe('');
      expect(mockSearchState.query).toBe('');
    });
  });

  describe('what the departing instance owes the search state', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    /** Without this the cases below could pass on a debounce that never fires. */
    it('commits the typed query once typing settles', () => {
      render(<SearchBar />);

      type('mobile nav');
      settle();

      expect(mockSearchState.debouncedQuery).toBe('mobile nav');
    });

    /** The flush must be bound to unmount, not to the debounce being rebuilt. */
    it('keeps its pending query when its dependencies are rebuilt mid-keystroke', () => {
      const { rerender } = render(<SearchBar />);

      type('mobile nav');
      mockQueryClient = newQueryClient();
      rerender(<SearchBar />);
      settle();

      expect(mockSearchState.debouncedQuery).toBe('mobile nav');
    });

    /**
     * Switching panels drops the bottom bar's field with no replacement, so a
     * discarded commit would leave results stale and `isTyping` stuck on.
     */
    it('publishes its pending query on the way out', () => {
      const { unmount } = render(<SearchBar />);

      type('mobile nav');
      unmount();

      expect(mockSearchState.debouncedQuery).toBe('mobile nav');
      expect(mockSearchState.isTyping).toBe(false);
    });

    /**
     * The original defect: a timer surviving its instance and landing on top of
     * whatever the replacement field has since typed. Flushing at unmount is
     * synchronous, so the later edit is always last.
     */
    it('cannot overwrite what the field replacing it typed', () => {
      const { unmount } = render(<SearchBar />);

      type('mobile nav');
      unmount();

      render(<SearchBar />);
      type('full width');
      settle();

      expect(mockSearchState.debouncedQuery).toBe('full width');
    });

    it('leaves a settled query alone on arrival', () => {
      mockSearchState = {
        ...mockSearchState,
        query: 'mobile nav',
        debouncedQuery: 'mobile nav',
      };

      render(<SearchBar />);
      settle();

      expect(mockSetSearchState).not.toHaveBeenCalled();
    });

    it('drops its pending query when the field is cleared', () => {
      render(<SearchBar />);

      type('mobile nav');
      fireEvent.click(screen.getByLabelText('com_ui_clear_search'));
      settle();

      expect(mockSearchState.debouncedQuery).toBe('');
    });

    /** A cleared field has nothing pending, so leaving must not resurrect it. */
    it('publishes nothing after the field was cleared', () => {
      const { unmount } = render(<SearchBar />);

      type('mobile nav');
      fireEvent.click(screen.getByLabelText('com_ui_clear_search'));
      unmount();

      expect(mockSearchState.debouncedQuery).toBe('');
    });
  });

  /** An IME uses Escape to cancel the text it is composing, not the search. */
  describe('Escape while an IME is composing', () => {
    it('keeps the query during composition and clears it after', () => {
      render(<SearchBar />);
      type('konnichiwa');

      fireEvent.keyDown(input(), { key: 'Escape', isComposing: true });
      expect(input().value).toBe('konnichiwa');

      fireEvent.keyDown(input(), { key: 'Escape' });
      expect(input().value).toBe('');
    });
  });
});
