import React, { forwardRef, useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useStore } from 'jotai';
import debounce from 'lodash/debounce';
import { useRecoilState } from 'recoil';
import { Search, X } from 'lucide-react';
import { buttonVariants } from '@librechat/client';
import { useQueryClient } from '@tanstack/react-query';
import { isSubmittingFamily } from '@librechat/chat/react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Constants, QueryKeys } from 'librechat-data-provider';
import { useShortcutAriaKey, useShortcutDisplay } from '~/hooks/useKeyboardShortcuts';
import { useLocalize, useNewConvo, useGetConversation } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

type SearchBarProps = {
  isSmallScreen?: boolean;
};

const SearchBar = forwardRef((props: SearchBarProps, ref: React.Ref<HTMLDivElement>) => {
  const localize = useLocalize();
  const location = useLocation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { isSmallScreen } = props;

  const jotaiStore = useStore();
  const getConversation = useGetConversation(0);
  const { newConversation: newConvo } = useNewConvo();
  const [search, setSearchState] = useRecoilState(store.search);

  /**
   * Seeded from the stored query rather than blank. The field is mounted in
   * two places — the list on a pointer device, the drawer's bottom bar on
   * touch — so crossing the breakpoint mid-search destroys one instance and
   * builds another. Starting empty would leave the results still filtered by a
   * query the box no longer shows, with no clear affordance to undo it.
   */
  const [text, setText] = useState(() => search.query ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const [showClearIcon, setShowClearIcon] = useState(() => (search.query ?? '').length > 0);
  const focusSearchAriaKey = useShortcutAriaKey('focusSearch');
  const shortcutDisplay = useShortcutDisplay('focusSearch');

  const clearSearch = useCallback(
    (pathname?: string) => {
      const onChat = pathname === '/c/new';
      if (!onChat && pathname?.includes('/search') !== true) {
        return;
      }
      queryClient.removeQueries([QueryKeys.messages]);
      const conversation = getConversation();
      const conversationId = conversation?.conversationId;
      /** The query is not part of the chat. An unsent chat is the one the user left for the
       *  results, or never left, so it comes back as it was: attachments, model and project. Once
       *  its first run is in flight it is no longer unsent, and clearing starts a new chat. */
      const unsent =
        (!conversationId || conversationId === Constants.NEW_CONVO) &&
        !jotaiStore.get(isSubmittingFamily(0));
      if (!unsent) {
        newConvo({ disableFocus: true });
        navigate('/c/new');
        return;
      }
      const projectId = conversation?.chatProjectId;
      const query = projectId ? `?${new URLSearchParams({ projectId })}` : '';
      /** Navigates even when already on the chat, to supersede a move to the results page that a
       *  query typed a moment ago may still have in flight; replacing adds no history entry. */
      navigate(`/c/new${query}`, { replace: onChat });
    },
    [newConvo, navigate, queryClient, jotaiStore, getConversation],
  );

  const sendRequest = useCallback(
    (value: string) => {
      if (!value) {
        return;
      }
      queryClient.invalidateQueries([QueryKeys.messages]);
    },
    [queryClient],
  );

  const commitQuery = useRef<(value: string) => void>(() => undefined);
  commitQuery.current = (value: string) => {
    setSearchState((prev) => ({ ...prev, debouncedQuery: value, isTyping: false }));
    sendRequest(value);
  };

  /**
   * One instance for the lifetime of the field, reading the current handlers
   * through the ref, so `cancel` always reaches the timer that is actually
   * pending. Rebuilding the debounce whenever its dependencies changed would
   * leave the previous instance's timer running past the cancel meant to stop
   * it, and cancelling on that rebuild would instead discard live keystrokes.
   */
  const debouncedSetDebouncedQuery = useMemo(
    () => debounce((value: string) => commitQuery.current(value), 500),
    [],
  );

  /**
   * The commit writes to shared state, so a timer left running outlives the
   * field that scheduled it. This one publishes instead of discarding, because
   * the field can leave with work pending and no successor to inherit it: the
   * bottom bar drops the search entirely when you switch panels, and abandoning
   * the commit there would strand `isTyping` with results the box no longer
   * matches. Flushing is synchronous with the unmount, so it lands before any
   * edit a replacement field might make and cannot overwrite one.
   */
  useEffect(() => () => debouncedSetDebouncedQuery.flush(), [debouncedSetDebouncedQuery]);

  const clearText = useCallback(
    (pathname?: string) => {
      debouncedSetDebouncedQuery.cancel();
      setShowClearIcon(false);
      setText('');
      setSearchState((prev) => ({
        ...prev,
        query: '',
        debouncedQuery: '',
        isTyping: false,
      }));
      clearSearch(pathname);
      inputRef.current?.focus();
    },
    [setSearchState, clearSearch, debouncedSetDebouncedQuery],
  );

  /** Escape empties the field rather than only leaving it: a stale query keeps the
   *  results route mounted, so dismissing the search has to dismiss what it found.
   *  Stopped here so it does not also close the drawer the field sits in. An IME
   *  composing text owns Escape, which cancels the composition, not the search. */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.code === 'Space') {
        e.stopPropagation();
        return;
      }
      if (e.key === 'Escape' && text !== '' && !e.nativeEvent.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        clearText(location.pathname);
      }
    },
    [clearText, location.pathname, text],
  );

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const { value } = e.target as HTMLInputElement;
      if (e.key === 'Backspace' && value === '') {
        clearText(location.pathname);
      }
    },
    [clearText, location.pathname],
  );

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setShowClearIcon(value.length > 0);
    setText(value);
    setSearchState((prev) => ({
      ...prev,
      query: value,
      isTyping: true,
    }));
    debouncedSetDebouncedQuery(value);
    if (value.length > 0 && location.pathname !== '/search') {
      navigate('/search', { replace: true });
    }
  };

  // Automatically set isTyping to false when loading is done and debouncedQuery matches query
  // (prevents stuck loading state if input is still focused)
  useEffect(() => {
    if (search.isTyping && !search.isSearching && search.debouncedQuery === search.query) {
      setSearchState((prev) => ({ ...prev, isTyping: false }));
    }
  }, [search.isTyping, search.isSearching, search.debouncedQuery, search.query, setSearchState]);

  return (
    <div
      ref={ref}
      /** A field, resting on a fill of its own: the sidebar and the content beside
       *  it share one surface now, so a transparent box with nothing in it read as
       *  empty space rather than as somewhere to type.
       *
       *  No edge on focus, by request. What marks the focused field is its caret and
       *  the chord appearing in the trailing slot. */
      className="group bg-surface-search text-text-primary theme-field-fill:border theme-field-fill:border-border-control flex h-9 min-w-0 flex-1 cursor-text items-center gap-2 rounded-lg ps-2.5 pe-1"
    >
      <Search aria-hidden="true" className="text-text-secondary size-4 shrink-0" />
      <input
        type="text"
        data-testid="nav-search-input"
        ref={inputRef}
        className="placeholder-text-secondary m-0 min-w-0 flex-1 border-none bg-transparent p-0 text-sm leading-tight focus-visible:outline-hidden"
        value={text}
        onChange={onChange}
        onKeyDown={handleKeyDown}
        aria-label={localize('com_nav_search_placeholder')}
        aria-keyshortcuts={focusSearchAriaKey}
        placeholder={localize('com_nav_search_placeholder')}
        onKeyUp={handleKeyUp}
        onFocus={() => setSearchState((prev) => ({ ...prev, isSearching: true }))}
        onBlur={() => setSearchState((prev) => ({ ...prev, isSearching: false }))}
        autoComplete="off"
        dir="auto"
      />
      {showClearIcon ? (
        <button
          type="button"
          aria-label={localize('com_ui_clear_search')}
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'icon-xs' }),
            /** One radius step inside the field it sits in, and the same 4px from
             *  the top, the bottom and the trailing edge, so the field's corner and
             *  the button's corner are concentric. */
            'text-text-secondary hover:text-text-primary shrink-0 rounded-md',
          )}
          onClick={() => clearText(location.pathname)}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      ) : (
        /** The chord that reaches this field, shown once the field has focus and not
         *  in the resting sidebar, where it would be one more thing printed on a
         *  surface meant to be quiet. It keeps its width either way, so nothing
         *  shifts as it appears. Absent on touch, where there is no chord to press,
         *  and while there is a query, where the clear takes the slot. */
        shortcutDisplay !== '' &&
        isSmallScreen !== true && (
          <kbd
            aria-hidden="true"
            className="bg-surface-tertiary text-text-secondary pointer-events-none shrink-0 rounded-md px-1.5 py-0.5 font-sans text-xs font-medium opacity-0 group-focus-within:opacity-100"
          >
            {shortcutDisplay}
          </kbd>
        )
      )}
    </div>
  );
});

export default SearchBar;
