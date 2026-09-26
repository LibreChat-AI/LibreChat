import { useCallback, useEffect, useState, useMemo, memo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import { useMediaQuery } from '@librechat/client';
import type { InfiniteQueryObserverResult } from '@tanstack/react-query';
import type { ConversationListResponse } from 'librechat-data-provider';
import type { List } from 'react-virtualized';
import {
  useProjectsInfiniteQuery,
  useConversationsInfiniteQuery,
  usePinnedConversationsQuery,
  useTitleGeneration,
} from '~/data-provider';
import {
  chatFilterTagsAtom,
  chatSortAtom,
  isArchivedChatViewAtom,
} from '~/components/Conversations/chatFilters';
import {
  useLocalize,
  useAuthContext,
  useLocalStorage,
  useNavScrolling,
  useScrollFade,
} from '~/hooks';
import { chatFacetParamsAtom, useFreshLocalDay } from '~/components/Conversations/facets';
import ProjectsSection from '~/components/Conversations/ProjectsSection';
import ChatFilterMenu from '~/components/Conversations/ChatFilterMenu';
import PinnedSection from '~/components/Conversations/PinnedSection';
import useSidebarToggle from '~/hooks/Nav/useSidebarToggle';
import { Conversations } from '~/components/Conversations';
import { cn, collectPinnedConversations } from '~/utils';
import SearchBar from '~/components/Nav/SearchBar';
import store from '~/store';

const chatsHeaderTrailing = <ChatFilterMenu />;

const ConversationsSection = memo(() => {
  const localize = useLocalize();
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const { setSidebarOpen } = useSidebarToggle();
  const { isAuthenticated } = useAuthContext();
  useTitleGeneration(isAuthenticated);

  const [isChatsExpanded, setIsChatsExpanded] = useLocalStorage('chatsExpanded', true);

  const tags = useAtomValue(chatFilterTagsAtom);
  const sort = useAtomValue(chatSortAtom);
  const isArchivedView = useAtomValue(isArchivedChatViewAtom);
  /** Date, endpoint and attachment facets, already shaped as list parameters. */
  const facetParams = useAtomValue(chatFacetParamsAtom);
  /** Keeps the date facets' midnight anchor advancing while the list is mounted. */
  useFreshLocalDay();
  const search = useRecoilValue(store.search);
  /** The same projects ProjectsSection reads, so an empty Chats list can tell "every
   *  chat lives under a project" from "this account has nothing yet". Shared key, so
   *  this costs no second request. */
  const {
    data: projectsData,
    isSuccess: projectsLoaded,
    isError: projectsFailed,
  } = useProjectsInfiniteQuery(
    { sortBy: 'lastConversationAt', sortDirection: 'desc', limit: 25 },
    { enabled: isAuthenticated, staleTime: 30000, cacheTime: 300000 },
  );
  /** Only a loaded, empty project list proves the account has nothing yet. While the
   *  projects are loading or failed to load, an empty Chats list claims no more than
   *  that nothing sits outside a project. */
  const hasProjects = !projectsLoaded || (projectsData?.pages[0]?.projects?.length ?? 0) > 0;
  /** A chat that belongs to a project is shown under that project, not twice. Search and
   *  the archived view stay whole: both are places the user goes to find something, and a
   *  project chat that appears in neither list nor result would have no way back. So does
   *  a list whose projects failed to load, which would otherwise hide every project chat
   *  behind a section that cannot show them. */
  const scopeToUnassigned =
    !isArchivedView && !search.debouncedQuery && !(projectsFailed && projectsData == null);

  const {
    data,
    fetchNextPage,
    isFetchingNextPage,
    isLoading,
    isFetching,
    isPreviousData,
    isError,
    refetch,
  } = useConversationsInfiniteQuery(
    {
      /** Omitted rather than `false`: the parameter's absence is what the server reads
       *  as "not archived", and a stray `isArchived=false` would key a third cache. */
      isArchived: isArchivedView ? true : undefined,
      sortBy: sort.field,
      sortDirection: sort.direction,
      tags: tags.length === 0 ? undefined : tags,
      search: search.debouncedQuery || undefined,
      projectId: scopeToUnassigned ? 'unassigned' : undefined,
      ...facetParams,
    },
    {
      enabled: isAuthenticated,
      staleTime: 30000,
      cacheTime: 300000,
    },
  );

  const computedHasNextPage = useMemo(() => {
    if (data?.pages && data.pages.length > 0) {
      const lastPage: ConversationListResponse = data.pages[data.pages.length - 1];
      return lastPage.nextCursor !== null;
    }
    return false;
  }, [data?.pages]);

  const conversationsRef = useRef<List | null>(null);

  const { moveToTop } = useNavScrolling<ConversationListResponse>({
    fetchNextPage: async (options?) => {
      if (computedHasNextPage) {
        return fetchNextPage(options);
      }
      return Promise.resolve({} as InfiniteQueryObserverResult<ConversationListResponse, unknown>);
    },
    isFetchingNext: isFetchingNextPage,
  });

  const conversations = useMemo(() => {
    return data ? data.pages.flatMap((page) => page.conversations) : [];
  }, [data]);

  /** Pins are fetched on their own so one older than the first page of the chats list
   * still shows on first paint, instead of appearing only once that list scrolls to it.
   * The Chats filters are deliberately not passed: they narrow that list alone. */
  const {
    data: pinnedData,
    isSuccess: isPinnedFetched,
    isFetching: isPinnedFetching,
    dataUpdatedAt: pinnedUpdatedAt,
  } = usePinnedConversationsQuery({ enabled: isAuthenticated });
  const isPinnedComplete = isPinnedFetched && !isPinnedFetching;

  /* `groupConversations` strips pins from the chats groups. A failed
     refetch keeps the previous dedicated result, so merge in pins from the
     live chats cache rather than hiding a newly pinned row — but only while that
     cache holds the same unarchived chats this section shows. */
  const pinnedConversations = useMemo(
    () =>
      collectPinnedConversations(pinnedData?.conversations, isArchivedView ? [] : conversations),
    [pinnedData?.conversations, conversations, isArchivedView],
  );

  /**
   * Selecting a conversation is the most common close path — it must take
   * the animated route or the drawer stalls on the new conversation's
   * commit before it starts sliding. `afterSlide` carries that navigation:
   * run synchronously it would flush the conversation switch in the tap's
   * task and stall the slide anyway; deferred, it lands mid-slide. Desktop
   * runs it immediately (nothing slides).
   */
  const toggleNav = useCallback(
    (afterSlide?: () => void) => {
      if (isSmallScreen) {
        setSidebarOpen(false, afterSlide);
        return;
      }
      afterSlide?.();
    },
    [isSmallScreen, setSidebarOpen],
  );

  const loadMoreConversations = useCallback(() => {
    if (isFetchingNextPage || !computedHasNextPage) {
      return;
    }
    fetchNextPage();
  }, [isFetchingNextPage, computedHasNextPage, fetchNextPage]);

  const retryConversations = useCallback(() => {
    void refetch();
  }, [refetch]);

  const [isSearchLoading, setIsSearchLoading] = useState(
    !!search.query && (search.isTyping || isLoading || isFetching),
  );

  useEffect(() => {
    if (search.isTyping) {
      setIsSearchLoading(true);
    } else if (!isLoading && !isFetching) {
      setIsSearchLoading(false);
    } else if (!!search.query && (isLoading || isFetching)) {
      setIsSearchLoading(true);
    }
  }, [search.query, search.isTyping, isLoading, isFetching]);

  /** Projects, Pinned and Chats share one scroll container so the sidebar scrolls
   *  as a single surface: the chats list is virtualized against this viewport
   *  rather than scrolling inside a pane of its own. */
  const [scrollViewport, setScrollViewport] = useState<HTMLDivElement | null>(null);
  const { attach: attachScrollFade, hasMore: hasMoreBelow } = useScrollFade<HTMLDivElement>();
  /** The viewport is both the element sections measure against and the one that
   *  scrolls, so the fade and the state setter share one callback ref. */
  const setScrollViewportNode = useCallback(
    (node: HTMLDivElement | null) => {
      setScrollViewport(node);
      attachScrollFade(node);
    },
    [attachScrollFade],
  );
  const [scrollContent, setScrollContent] = useState<HTMLDivElement | null>(null);

  /** Searching replaces what the surface holds: Projects and Pinned leave and
   *  the chats become results. A scroll position kept from the previous
   *  contents would open those results partway down whenever they are long
   *  enough for the browser not to clamp it, so the surface returns to the top
   *  whenever it changes what it is showing. */
  const isSearching = Boolean(search.query);
  useEffect(() => {
    if (scrollViewport) {
      scrollViewport.scrollTop = 0;
    }
  }, [isSearching, scrollViewport]);

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden pt-2 pb-3"
      role="region"
      aria-label={localize('com_ui_chat_history')}
    >
      {/* The search field owns this row alone; filtering and ordering moved beside the
          Chats heading, where the list they act on is labelled. On mobile the field
          itself lives in the drawer's bottom bar, within thumb reach. */}
      {!isSmallScreen && search.enabled && (
        <div className="flex items-center px-3">
          <SearchBar isSmallScreen={isSmallScreen} />
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={setScrollViewportNode}
          className="min-h-0 flex-1 scrollbar-gutter-stable overflow-x-hidden overflow-y-auto"
        >
          {/* `min-h-full` keeps the sections filling a tall sidebar, so the chats
            list still claims the space below them when there is little to show. */}
          <div ref={setScrollContent} className="flex min-h-full flex-col">
            {!search.query && (
              <ProjectsSection toggleNav={toggleNav} isAuthenticated={isAuthenticated} />
            )}
            {!search.query && (
              <PinnedSection
                conversations={pinnedConversations}
                toggleNav={toggleNav}
                isSmallScreen={isSmallScreen}
                /* Only a successful drain proves the list is whole: a failed later
                 page still publishes partial data and stops fetching. The Chats filters
                 never reach this query, so nothing else can truncate it. */
                membershipComplete={isPinnedComplete}
                /* When that drain last ran, which decides whether it is current
                 enough to prune the stored order against. */
                membershipUpdatedAt={pinnedUpdatedAt}
              />
            )}
            <Conversations
              conversations={conversations}
              moveToTop={moveToTop}
              toggleNav={toggleNav}
              containerRef={conversationsRef}
              loadMoreConversations={loadMoreConversations}
              isLoading={isFetchingNextPage || isLoading}
              isSearchLoading={isSearchLoading || isPreviousData}
              isChatsExpanded={isChatsExpanded}
              setIsChatsExpanded={setIsChatsExpanded}
              hasNextPage={computedHasNextPage}
              isError={isError}
              onRetry={retryConversations}
              chatsHeaderTrailing={chatsHeaderTrailing}
              accountHasProjects={scopeToUnassigned && hasProjects}
              scrollViewport={scrollViewport}
              scrollContent={scrollContent}
            />
          </div>
        </div>
        {/* The last row fades rather than being cut off, so a list that continues
          below the fold says so without a scrollbar having to appear. */}
        <div
          aria-hidden="true"
          className={cn(
            'from-surface-primary-alt pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t to-transparent transition-opacity duration-200 motion-reduce:transition-none',
            hasMoreBelow ? 'opacity-100' : 'opacity-0',
          )}
        />
      </div>
    </div>
  );
});

ConversationsSection.displayName = 'ConversationsSection';

export default ConversationsSection;
