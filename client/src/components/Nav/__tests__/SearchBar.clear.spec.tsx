import { getDefaultStore } from 'jotai';
import { isSubmittingFamily } from '@librechat/chat/react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TConversation } from 'librechat-data-provider';

type SearchState = {
  query: string;
  debouncedQuery: string;
  isTyping: boolean;
  enabled: boolean;
};

let mockSearchState: SearchState = {
  query: '',
  debouncedQuery: '',
  isTyping: false,
  enabled: true,
};

jest.mock('recoil', () => ({
  useRecoilState: () => [
    mockSearchState,
    (update: SearchState | ((prev: SearchState) => SearchState)) => {
      mockSearchState = typeof update === 'function' ? update(mockSearchState) : update;
    },
  ],
}));

let mockPathname = '/c/new';
const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: mockPathname }),
  useNavigate: () => mockNavigate,
}));

const mockRemoveQueries = jest.fn();

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ removeQueries: mockRemoveQueries, invalidateQueries: jest.fn() }),
}));

let mockConversation: Partial<TConversation> | null = null;
const mockNewConversation = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useNewConvo: () => ({ newConversation: mockNewConversation }),
  useGetConversation: () => () => mockConversation,
}));

jest.mock('~/hooks/useKeyboardShortcuts', () => ({
  useShortcutAriaKey: () => 'Meta+/',
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

/** Types a query, then dismisses it with the field's clear button. */
const searchAndClear = () => {
  fireEvent.change(input(), { target: { value: 'quarterly report' } });
  fireEvent.click(screen.getByLabelText('com_ui_clear_search'));
};

describe('SearchBar clearing the search', () => {
  afterEach(() => {
    mockSearchState = { query: '', debouncedQuery: '', isTyping: false, enabled: true };
    mockPathname = '/c/new';
    mockConversation = null;
    getDefaultStore().set(isSubmittingFamily(0), false);
    jest.clearAllMocks();
  });

  describe('while the open chat is the unsent one', () => {
    it('returns from the results to that chat instead of starting a new one', () => {
      mockPathname = '/search';
      mockConversation = { conversationId: 'new', endpoint: 'agents' } as Partial<TConversation>;
      render(<SearchBar />);

      searchAndClear();

      expect(mockNewConversation).not.toHaveBeenCalled();
      expect(mockRemoveQueries).toHaveBeenCalledWith(['messages']);
      expect(mockNavigate).toHaveBeenLastCalledWith('/c/new', { replace: false });
    });

    it('keeps the project the chat is scoped to', () => {
      mockPathname = '/search';
      mockConversation = { conversationId: 'new', chatProjectId: 'project 1' };
      render(<SearchBar />);

      searchAndClear();

      expect(mockNewConversation).not.toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenLastCalledWith('/c/new?projectId=project+1', {
        replace: false,
      });
    });

    it('treats a chat the app has not set up yet as unsent', () => {
      mockPathname = '/search';
      render(<SearchBar />);

      searchAndClear();

      expect(mockNewConversation).not.toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenLastCalledWith('/c/new', { replace: false });
    });

    /** Still navigates, so a move to the results page a query just started cannot land after
     *  the field was emptied; replacing keeps that from adding a history entry. */
    it('stays on the chat on Backspace in the empty field', () => {
      mockConversation = { conversationId: 'new' };
      render(<SearchBar />);

      fireEvent.keyUp(input(), { key: 'Backspace' });

      expect(mockNewConversation).not.toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('/c/new', { replace: true });
    });
  });

  describe('otherwise, as before', () => {
    it('starts a new chat when the results were opened from a conversation', () => {
      mockPathname = '/search';
      mockConversation = { conversationId: 'convo-1' };
      render(<SearchBar />);

      searchAndClear();

      expect(mockNewConversation).toHaveBeenCalledWith({ disableFocus: true });
      expect(mockNavigate).toHaveBeenLastCalledWith('/c/new');
    });

    /** A chat whose first run is in flight is no longer unsent, as for a model switch. */
    it('starts a new chat while the first run of the new chat is in flight', () => {
      mockConversation = { conversationId: 'new' };
      getDefaultStore().set(isSubmittingFamily(0), true);
      render(<SearchBar />);

      fireEvent.keyUp(input(), { key: 'Backspace' });

      expect(mockNewConversation).toHaveBeenCalledWith({ disableFocus: true });
      expect(mockNavigate).toHaveBeenLastCalledWith('/c/new');
    });

    it('leaves the page alone on a route that is neither the results nor the new chat', () => {
      mockPathname = '/c/convo-1';
      mockConversation = { conversationId: 'convo-1' };
      render(<SearchBar />);

      searchAndClear();

      expect(input().value).toBe('');
      expect(mockNewConversation).not.toHaveBeenCalled();
      expect(mockRemoveQueries).not.toHaveBeenCalled();
      /** Only the move to the results page that typing made. */
      expect(mockNavigate.mock.calls.map(([to]) => to)).toEqual(['/search']);
    });
  });
});
