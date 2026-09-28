import { QueryClient } from '@tanstack/react-query';
import { LocalStorageKeys, QueryKeys } from 'librechat-data-provider';
import {
  format,
  isToday,
  subDays,
  getYear,
  parseISO,
  startOfDay,
  startOfYear,
  isWithinInterval,
} from 'date-fns';
import type { TConversation, GroupedConversations } from 'librechat-data-provider';
import type { InvalidateQueryFilters } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import { isTemporaryConversation } from './conversation';

// Date group helpers
export const dateKeys = {
  today: 'com_ui_date_today',
  yesterday: 'com_ui_date_yesterday',
  previous7Days: 'com_ui_date_previous_7_days',
  previous30Days: 'com_ui_date_previous_30_days',
  january: 'com_ui_date_january',
  february: 'com_ui_date_february',
  march: 'com_ui_date_march',
  april: 'com_ui_date_april',
  may: 'com_ui_date_may',
  june: 'com_ui_date_june',
  july: 'com_ui_date_july',
  august: 'com_ui_date_august',
  september: 'com_ui_date_september',
  october: 'com_ui_date_october',
  november: 'com_ui_date_november',
  december: 'com_ui_date_december',
};

const getGroupName = (date: Date) => {
  const now = new Date(Date.now());
  if (isToday(date)) {
    return dateKeys.today;
  }
  if (isWithinInterval(date, { start: startOfDay(subDays(now, 1)), end: now })) {
    return dateKeys.yesterday;
  }
  if (isWithinInterval(date, { start: subDays(now, 7), end: now })) {
    return dateKeys.previous7Days;
  }
  if (isWithinInterval(date, { start: subDays(now, 30), end: now })) {
    return dateKeys.previous30Days;
  }
  if (isWithinInterval(date, { start: startOfYear(now), end: now })) {
    const month = format(date, 'MMMM').toLowerCase();
    return dateKeys[month];
  }
  return ' ' + getYear(date).toString();
};

const monthOrderMap = new Map([
  ['december', 11],
  ['november', 10],
  ['october', 9],
  ['september', 8],
  ['august', 7],
  ['july', 6],
  ['june', 5],
  ['may', 4],
  ['april', 3],
  ['march', 2],
  ['february', 1],
  ['january', 0],
]);
const dateKeysReverse = Object.fromEntries(Object.entries(dateKeys).map(([k, v]) => [v, k]));
const dateGroupsSet = new Set([
  dateKeys.today,
  dateKeys.yesterday,
  dateKeys.previous7Days,
  dateKeys.previous30Days,
]);

type ConversationDateField = 'updatedAt' | 'createdAt' | 'archivedAt';

export type ConversationGroupOptions = {
  field?: ConversationDateField | 'title';
  direction?: 'asc' | 'desc';
  includePinned?: boolean;
};

const getConversationDate = (
  conversation: TConversation,
  field: ConversationDateField,
  fallbackDate: Date,
) => {
  /* The archive's legacy group — archived before `archivedAt` was recorded — is ordered
     and dated by `createdAt` on the server, so reading `updatedAt` first here would put
     those rows in a bucket the cursor never sorted them into. */
  const fallbackField = field === 'archivedAt' ? conversation.createdAt : conversation.updatedAt;
  const dateValue = conversation[field] ?? fallbackField ?? conversation.createdAt;
  return dateValue ? parseISO(dateValue) : fallbackDate;
};

/** A title's own initial, as a code point: `charAt(0)` on a supplementary-plane letter
 *  returns half a surrogate pair, which renders as a replacement character and collapses
 *  unrelated initials into one heading. Non-letters share a single `#` group. The case is
 *  left as written so each heading matches the order the server paged the titles in. */
const getTitleInitial = (title: string): string => {
  const initial = [...title][0];
  if (initial == null || !/\p{L}/u.test(initial)) {
    return '#';
  }
  return initial;
};

export const groupConversations = (
  conversations: Array<TConversation | null>,
  { field = 'updatedAt', direction = 'desc', includePinned = false }: ConversationGroupOptions = {},
): GroupedConversations => {
  if (!Array.isArray(conversations)) {
    return [];
  }

  const seenConversationIds = new Set<string | null>();
  const groups = new Map<string, TConversation[]>();
  /* Title paging is a keyset over the server's own string order, so re-sorting what arrived
     can only disagree with it: a title that belongs before this page sits behind its cursor
     and arrives later. These groups therefore keep the fetched order, which means a heading
     can repeat — `!draft`, `Apple`, `_scratch` puts two non-letter rows either side of `A` —
     and merging those two into one `#` group would move a row across the cursor boundary. */
  const runs: GroupedConversations = [];
  const now = new Date(Date.now());

  conversations.forEach((conversation) => {
    if (!conversation || (!includePinned && conversation.pinned)) {
      return;
    }
    if (seenConversationIds.has(conversation.conversationId)) {
      return;
    }
    seenConversationIds.add(conversation.conversationId);

    if (field === 'title') {
      const title = typeof conversation.title === 'string' ? conversation.title : '';
      const groupName = getTitleInitial(title);
      const currentRun = runs[runs.length - 1];
      if (currentRun && currentRun[0] === groupName) {
        currentRun[1].push(conversation);
      } else {
        runs.push([groupName, [conversation]]);
      }
      return;
    }

    const groupName = getGroupName(getConversationDate(conversation, field, now));
    const group = groups.get(groupName);
    if (group) {
      group.push(conversation);
    } else {
      groups.set(groupName, [conversation]);
    }
  });

  if (field === 'title') {
    return runs;
  }

  const yearMonthGroups = Array.from(groups.keys())
    .filter((group) => !dateGroupsSet.has(group))
    .sort((a, b) => {
      const getOrder = (group: string) => {
        const month = dateKeysReverse[group];
        if (month) {
          return now.getFullYear() * 12 + (monthOrderMap.get(month) ?? 0);
        }
        return parseInt(group.trim(), 10) * 12;
      };
      const orderA = getOrder(a);
      const orderB = getOrder(b);
      return direction === 'asc' ? orderA - orderB : orderB - orderA;
    });
  const recentGroups = Array.from(dateGroupsSet).filter((group) => groups.has(group));
  const orderedGroupNames =
    direction === 'asc'
      ? [...yearMonthGroups, ...recentGroups.reverse()]
      : [...recentGroups, ...yearMonthGroups];

  orderedGroupNames.forEach((groupName) => {
    groups.get(groupName)!.sort((a, b) => {
      const comparison =
        getConversationDate(b, field, now).getTime() - getConversationDate(a, field, now).getTime();
      return direction === 'asc' ? -comparison : comparison;
    });
  });

  return orderedGroupNames.map((groupName) => [groupName, groups.get(groupName)!]);
};

export type ConversationCursorData = {
  conversations: TConversation[];
  nextCursor?: string | null;
};

function getConversationQueryProjectId(queryKey: readonly unknown[]): string | undefined {
  const params = queryKey[1];
  if (!params || typeof params !== 'object') {
    return undefined;
  }
  return (params as { projectId?: string }).projectId;
}

function conversationMatchesProjectQuery(
  queryKey: readonly unknown[],
  conversation: Pick<TConversation, 'chatProjectId'>,
): boolean {
  const projectId = getConversationQueryProjectId(queryKey);
  if (!projectId) {
    return true;
  }
  if (projectId === 'unassigned') {
    return !conversation.chatProjectId;
  }
  return conversation.chatProjectId === projectId;
}

function getConversationListQueryParams(queryKey: readonly unknown[]): {
  tags?: string[];
  search?: string;
  sortBy?: string;
  sortDirection?: string;
  isArchived?: boolean;
} {
  const params = queryKey[1];
  if (!params || typeof params !== 'object') {
    return {};
  }
  return params as {
    tags?: string[];
    search?: string;
    sortBy?: string;
    sortDirection?: string;
    isArchived?: boolean;
  };
}

/**
 * Newest-first is the only order these writers can reproduce. A title or created-at
 * variant, or an ascending one, orders rows by a key the client cannot place a row
 * against without the server's cursor, so moving a row to the front of those pages —
 * or seeding one there — would invent an order the next page contradicts. Those
 * variants take the field update in place and are refetched instead.
 */
function queryListsNewestFirst(queryKey: readonly unknown[]): boolean {
  const { sortBy, sortDirection } = getConversationListQueryParams(queryKey);
  return (
    (sortBy == null || sortBy === 'updatedAt') &&
    (sortDirection == null || sortDirection === 'desc')
  );
}

/**
 * Every cached conversation list, active and archived alike. A write that visits only
 * one prefix leaves the other rendering the row it just changed: the sidebar lists the
 * archive from the same components, so both are live caches now.
 */
export const CONVERSATION_LIST_KEYS = [
  QueryKeys.allConversations,
  QueryKeys.archivedConversations,
] as const;

function findConversationListQueries(queryClient: QueryClient) {
  return CONVERSATION_LIST_KEYS.flatMap((listKey) =>
    queryClient.getQueryCache().findAll([listKey], { exact: false }),
  );
}

/**
 * Reconciles both list prefixes against the server. For callers that cannot say what
 * changed — a recovered stream, a schedule that moved, a project that took its chats'
 * fields with it — and so cannot write the row themselves.
 */
export function invalidateConversationLists(
  queryClient: QueryClient,
  filters?: Omit<InvalidateQueryFilters, 'queryKey'>,
): Promise<void> {
  return Promise.all(
    CONVERSATION_LIST_KEYS.map((listKey) =>
      queryClient.invalidateQueries({ queryKey: [listKey], ...filters }),
    ),
  ).then(() => undefined);
}

/** Whether a list variant shows archived chats, which its key states and its root implies. */
function queryListsArchived(queryKey: readonly unknown[]): boolean {
  if (queryKey[0] === QueryKeys.archivedConversations) {
    return true;
  }
  return getConversationListQueryParams(queryKey).isArchived === true;
}

/**
 * Whether a row still belongs in a variant at all, by the facets the client can decide:
 * its project and whether it is archived. Bookmark and search membership are deliberately
 * excluded — a search cache matches nothing client-side, so judging a row that is already
 * in one by that rule would evict every row it holds.
 */
function conversationBelongsToListQuery(
  queryKey: readonly unknown[],
  conversation: Pick<TConversation, 'chatProjectId' | 'isArchived'>,
): boolean {
  return (
    conversationMatchesProjectQuery(queryKey, conversation) &&
    queryListsArchived(queryKey) === (conversation.isArchived === true)
  );
}

/**
 * Whether only the server can say what a variant holds after a write. Two things put it
 * out of the client's reach: an order keyed on something other than last activity, which
 * these writers cannot place a row against, and a search, which the server evaluates —
 * a title edit or a new message can make a row start or stop matching one.
 */
function queryNeedsServerReconciliation(queryKey: readonly unknown[]): boolean {
  if (!queryListsNewestFirst(queryKey)) {
    return true;
  }
  const { search } = getConversationListQueryParams(queryKey);
  return typeof search === 'string' && search.trim() !== '';
}

/**
 * What a writer may do with a row it wants to add to a variant.
 *
 * `skip` is only for a variant the row provably does not belong to, by the facets the
 * client decides: project, archive state, bookmarks. Anything left to the server is
 * refetched instead — skipping it silently would leave a mounted list missing a row.
 */
type ListInsertVerdict = 'insert' | 'skip' | 'refetch';

function conversationInsertVerdict(
  queryKey: readonly unknown[],
  conversation: Pick<TConversation, 'chatProjectId' | 'tags' | 'isArchived'>,
): ListInsertVerdict {
  if (!conversationBelongsToListQuery(queryKey, conversation)) {
    return 'skip';
  }
  const { tags } = getConversationListQueryParams(queryKey);
  if (Array.isArray(tags) && tags.length > 0) {
    const conversationTags = conversation.tags;
    if (!Array.isArray(conversationTags) || !tags.some((tag) => conversationTags.includes(tag))) {
      return 'skip';
    }
  }
  return queryNeedsServerReconciliation(queryKey) ? 'refetch' : 'insert';
}

/** Dedicated pinned data wins for ids it already has. Pins that only live on
 * the loaded chats pages are appended so a failed refetch of the dedicated
 * query cannot hide a newly pinned row. */
export function collectPinnedConversations(
  dedicated: Array<TConversation | null | undefined> | undefined,
  fromChats: Array<TConversation | null | undefined>,
): TConversation[] {
  const byId = new Map<string, TConversation>();
  for (const conversation of dedicated ?? []) {
    if (conversation?.conversationId && conversation.pinned === true) {
      byId.set(conversation.conversationId, conversation);
    }
  }
  for (const conversation of fromChats) {
    if (
      conversation?.conversationId &&
      conversation.pinned === true &&
      !byId.has(conversation.conversationId)
    ) {
      byId.set(conversation.conversationId, conversation);
    }
  }
  /** The server returns pins newest-first, so a row merged in from the chats cache
   * has to take its place in that order: a chat pinned while the dedicated refetch
   * is failing is the newest pin, and appending it would bury it below the fold. */
  return [...byId.values()].sort((a, b) => pinnedSortTime(b) - pinnedSortTime(a));
}

function pinnedSortTime(conversation: TConversation): number {
  const timestamp = Date.parse(conversation.updatedAt ?? conversation.createdAt ?? '');
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

/**
 * Reads the project id from the current URL's `?projectId` param — the source of
 * truth for a new chat's project scope (the conversation atom can lag behind it).
 */
export function getRouteChatProjectId(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const projectId = new URLSearchParams(window.location.search).get('projectId');
  return projectId != null && /^[a-f\d]{24}$/i.test(projectId) ? projectId : null;
}

// === InfiniteData helpers for cursor-based convo queries ===

export function findConversationInInfinite(
  data: InfiniteData<ConversationCursorData> | undefined,
  conversationId: string,
): TConversation | undefined {
  if (!data) {
    return undefined;
  }
  for (const page of data.pages) {
    const found = page.conversations.find((c) => c.conversationId === conversationId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

export function updateInfiniteConvoPage(
  data: InfiniteData<ConversationCursorData> | undefined,
  conversationId: string,
  updater: (c: TConversation) => TConversation,
): InfiniteData<ConversationCursorData> | undefined {
  if (!data) {
    return data;
  }
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      conversations: page.conversations.map((c) =>
        c.conversationId === conversationId ? updater(c) : c,
      ),
    })),
  };
}

export function addConversationToInfinitePages(
  data: InfiniteData<ConversationCursorData> | undefined,
  newConversation: TConversation,
): InfiniteData<ConversationCursorData> {
  if (!data) {
    return {
      pageParams: [undefined],
      pages: [{ conversations: [newConversation], nextCursor: null }],
    };
  }
  return {
    ...data,
    pages: [
      { ...data.pages[0], conversations: [newConversation, ...data.pages[0].conversations] },
      ...data.pages.slice(1),
    ],
  };
}

export function addConversationToAllConversationsQueries(
  queryClient: QueryClient,
  newConversation: TConversation,
) {
  for (const query of findConversationListQueries(queryClient)) {
    const verdict = conversationInsertVerdict(query.queryKey, newConversation);
    if (verdict === 'skip') {
      continue;
    }
    if (verdict === 'refetch') {
      queryClient.invalidateQueries({ queryKey: query.queryKey, refetchType: 'active' });
      continue;
    }
    queryClient.setQueryData<InfiniteData<ConversationCursorData>>(query.queryKey, (old) => {
      if (
        !old ||
        old.pages[0].conversations.some((c) => c.conversationId === newConversation.conversationId)
      ) {
        return old;
      }
      return {
        ...old,
        pages: [
          {
            ...old.pages[0],
            conversations: [newConversation, ...old.pages[0].conversations],
          },
          ...old.pages.slice(1),
        ],
      };
    });
  }
}

export function removeConvoFromInfinitePages(
  data: InfiniteData<ConversationCursorData> | undefined,
  conversationId: string,
): InfiniteData<ConversationCursorData> | undefined {
  if (!data) {
    return data;
  }
  return {
    ...data,
    pages: data.pages
      .map((page) => ({
        ...page,
        conversations: page.conversations.filter((c) => c.conversationId !== conversationId),
      }))
      .filter((page) => page.conversations.length > 0),
  };
}

// Used for partial update (e.g., title, etc.), updating AND possibly bumping to front of visible convos
export function updateConvoFieldsInfinite(
  data: InfiniteData<ConversationCursorData> | undefined,
  updatedConversation: Partial<TConversation> & { conversationId: string },
  keepPosition = false,
): InfiniteData<ConversationCursorData> | undefined {
  if (!data) {
    return data;
  }
  let found: TConversation | undefined;
  let pageIdx = -1,
    convoIdx = -1;
  for (let i = 0; i < data.pages.length; ++i) {
    const idx = data.pages[i].conversations.findIndex(
      (c) => c.conversationId === updatedConversation.conversationId,
    );
    if (idx !== -1) {
      pageIdx = i;
      convoIdx = idx;
      found = data.pages[i].conversations[idx];
      break;
    }
  }
  if (!found) {
    return data;
  }

  if (keepPosition) {
    return {
      ...data,
      pages: data.pages.map((page, pi) =>
        pi === pageIdx
          ? {
              ...page,
              conversations: page.conversations.map((c, ci) =>
                ci === convoIdx ? { ...c, ...updatedConversation } : c,
              ),
            }
          : page,
      ),
    };
  } else {
    const patched = { ...found, ...updatedConversation, updatedAt: new Date().toISOString() };
    const pages = data.pages.map((page) => ({
      ...page,
      conversations: page.conversations.filter((c) => c.conversationId !== patched.conversationId),
    }));

    pages[0].conversations = [patched, ...pages[0].conversations];

    const finalPages = pages.filter((page) => page.conversations.length > 0);
    return { ...data, pages: finalPages };
  }
}

export function storeEndpointSettings(conversation: TConversation | null) {
  if (!conversation) {
    return;
  }
  const { endpoint, model } = conversation;
  if (!endpoint) {
    return;
  }
  const lastModel = JSON.parse(localStorage.getItem(LocalStorageKeys.LAST_MODEL) ?? '{}');
  lastModel[endpoint] = model;
  localStorage.setItem(LocalStorageKeys.LAST_MODEL, JSON.stringify(lastModel));
}

// Add
export function addConvoToAllQueries(queryClient: QueryClient, newConvo: TConversation) {
  for (const query of findConversationListQueries(queryClient)) {
    /* The unpin path reinserts a row that the update helper may have just marked stale;
       seeding it at page one would clear that invalidation and fabricate a position. */
    const verdict = conversationInsertVerdict(query.queryKey, newConvo);
    if (verdict === 'skip') {
      continue;
    }
    if (verdict === 'refetch') {
      queryClient.invalidateQueries({ queryKey: query.queryKey, refetchType: 'active' });
      continue;
    }
    queryClient.setQueryData<InfiniteData<ConversationCursorData>>(query.queryKey, (oldData) => {
      if (!oldData) {
        return oldData;
      }
      if (
        oldData.pages.some((p) =>
          p.conversations.some((c) => c.conversationId === newConvo.conversationId),
        )
      ) {
        return oldData;
      }
      /** Removing the last loaded row leaves a cache with no pages at all, so the
       * first page has to be recreated rather than spread from `undefined`. */
      const firstPage = oldData.pages[0] ?? { conversations: [], nextCursor: null };
      return {
        ...oldData,
        pages: [
          {
            ...firstPage,
            conversations: [newConvo, ...firstPage.conversations],
          },
          ...oldData.pages.slice(1),
        ],
      };
    });
  }
}

export function upsertConvoInAllQueries(
  queryClient: QueryClient,
  nextConvo: TConversation,
  moveToTop = true,
) {
  if (!nextConvo.conversationId) {
    return;
  }
  const conversationId = nextConvo.conversationId;

  /* The history query excludes temporary conversations server-side, so seeding
     one into the list caches would surface it in the sidebar until the next
     refetch, contradicting what temporary mode promises. Enforced here rather
     than at each caller so a future insert path cannot reintroduce the leak. */
  if (isTemporaryConversation(nextConvo)) {
    return;
  }

  const cachedPin = findPinnedConversation(queryClient, conversationId);
  const listConvo = cachedPin ? preserveListFlags(nextConvo, cachedPin) : nextConvo;

  /* Root-level SSE updates and resumable settlement go through upsert, not
     update. Merge into any already-cached pin so that path cannot leave the
     section at the old title or position. Carry its list flags into history
     too when the conversation is older than the loaded pages. Do not insert
     into the pinned cache: a new chat is not pinned until the pin mutation
     refetches. */
  updatePinnedConvosQuery(
    queryClient,
    conversationId,
    (found) => ({
      ...found,
      ...listConvo,
      updatedAt: listConvo.updatedAt ?? (moveToTop ? new Date().toISOString() : found.updatedAt),
    }),
    moveToTop,
  );

  const queries = findConversationListQueries(queryClient);

  for (const query of queries) {
    /* A variant the writers cannot order takes the merge in place and is refetched, so the
       row's new text shows at once while the server decides where it belongs. */
    const newestFirst = queryListsNewestFirst(query.queryKey);
    const verdict = conversationInsertVerdict(query.queryKey, listConvo);
    queryClient.setQueryData<InfiniteData<ConversationCursorData>>(query.queryKey, (oldData) => {
      if (!oldData) {
        return oldData;
      }

      let pageIdx = -1;
      let convoIdx = -1;
      for (let pi = 0; pi < oldData.pages.length; pi++) {
        const ci = oldData.pages[pi].conversations.findIndex(
          (c) => c.conversationId === conversationId,
        );
        if (ci !== -1) {
          pageIdx = pi;
          convoIdx = ci;
          break;
        }
      }

      const now = new Date().toISOString();
      if (pageIdx === -1) {
        if (verdict !== 'insert') {
          return oldData;
        }
        const firstPage = oldData.pages[0] ?? { conversations: [], nextCursor: null };
        return {
          ...oldData,
          pages: [
            {
              ...firstPage,
              conversations: [
                { ...listConvo, updatedAt: listConvo.updatedAt ?? now },
                ...firstPage.conversations,
              ],
            },
            ...oldData.pages.slice(1),
          ],
        };
      }

      const found = oldData.pages[pageIdx].conversations[convoIdx];
      const updated = {
        ...found,
        ...listConvo,
        updatedAt: listConvo.updatedAt ?? (moveToTop ? now : found.updatedAt),
      };

      if (!conversationBelongsToListQuery(query.queryKey, updated)) {
        return removeConvoFromInfinitePages(oldData, updated.conversationId ?? '');
      }

      if (!moveToTop || !newestFirst || (pageIdx === 0 && convoIdx === 0)) {
        return {
          ...oldData,
          pages: oldData.pages.map((page, pi) =>
            pi === pageIdx
              ? {
                  ...page,
                  conversations: page.conversations.map((c, ci) => (ci === convoIdx ? updated : c)),
                }
              : page,
          ),
        };
      }

      const pages = oldData.pages.map((page, pi) => {
        if (pi === 0 && pageIdx === 0) {
          const conversations = page.conversations.filter((_, ci) => ci !== convoIdx);
          return { ...page, conversations: [updated, ...conversations] };
        }
        if (pi === 0) {
          return { ...page, conversations: [updated, ...page.conversations] };
        }
        if (pi === pageIdx) {
          return {
            ...page,
            conversations: page.conversations.filter((_, ci) => ci !== convoIdx),
          };
        }
        return page;
      });

      return { ...oldData, pages };
    });
    if (queryNeedsServerReconciliation(query.queryKey)) {
      /* Inactive variants are only marked stale: they refresh when something mounts them. */
      queryClient.invalidateQueries({ queryKey: query.queryKey, refetchType: 'active' });
    }
  }
}

export type PinnedConversationsData = {
  conversations: TConversation[];
  nextCursor?: string | null;
};

/** Reads a pin out of whichever cached bookmark variant holds it. Single-conversation
 * responses omit server-derived fields like `isShared`, so callers that insert one
 * elsewhere need the cached row to carry them over. */
export function findPinnedConversation(
  queryClient: QueryClient,
  conversationId: string,
): TConversation | undefined {
  const queries = queryClient
    .getQueryCache()
    .findAll([QueryKeys.pinnedConversations], { exact: false });

  for (const query of queries) {
    const data = queryClient.getQueryData<PinnedConversationsData>(query.queryKey);
    const found = data?.conversations.find((c) => c.conversationId === conversationId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/**
 * Flags the sidebar owns rather than the chat: `isShared` is derived per list request from
 * the shared-links collection, and `pinned` is set by the pin mutation alone. Neither is
 * carried by the single-conversation payloads callers swap in wholesale, so an omitted flag
 * means "unchanged" rather than "cleared".
 */
const listFlags = ['isShared', 'pinned'] as const;

function preserveListFlags(next: TConversation, found: TConversation): TConversation {
  const carried = listFlags.filter((flag) => next[flag] === undefined && found[flag] !== undefined);
  if (carried.length === 0) {
    return next;
  }
  const merged = { ...next };
  for (const flag of carried) {
    merged[flag] = found[flag];
  }
  return merged;
}

/**
 * A chat's conversation state snapshots the sidebar flags when the chat is opened and never
 * hears about a later change, so pinning an open chat leaves a stale `pinned: false` on it.
 * Strip them before that state reaches the list caches, or the next message would write the
 * stale value back over the sidebar and drop the chat out of Pinned.
 */
export function withoutListFlags(conversation: TConversation): TConversation {
  if (listFlags.every((flag) => conversation[flag] === undefined)) {
    return conversation;
  }
  const stripped = { ...conversation };
  for (const flag of listFlags) {
    delete stripped[flag];
  }
  return stripped;
}

/**
 * The pinned sidebar section is fed by its own request rather than by the paginated
 * chats list, so every edit that reaches the chats cache has to reach this one too or
 * the section keeps showing a stale title, or a chat that is no longer pinned.
 */
function updatePinnedConvosQuery(
  queryClient: QueryClient,
  conversationId: string,
  updater: (c: TConversation) => TConversation | null,
  moveToTop = false,
) {
  /* Keyed by the active bookmark filter, so every cached variant has to be touched
     rather than only the unfiltered one. */
  const queries = queryClient
    .getQueryCache()
    .findAll([QueryKeys.pinnedConversations], { exact: false });

  for (const query of queries) {
    queryClient.setQueryData<PinnedConversationsData>(query.queryKey, (oldData) => {
      if (!oldData) {
        return oldData;
      }
      const index = oldData.conversations.findIndex((c) => c.conversationId === conversationId);
      if (index === -1) {
        return oldData;
      }
      const found = oldData.conversations[index];
      const updated = updater(found);
      const merged = updated && preserveListFlags(updated, found);
      if (!merged || merged.pinned !== true) {
        return {
          ...oldData,
          conversations: oldData.conversations.filter((_, i) => i !== index),
        };
      }

      /* The server returns pins newest-first, so a pin that just received a message has
         to lead the section the same way it leads the chats list. The SSE payload can
         still carry the previous turn's `updatedAt`, so refresh it exactly as the chats
         cache does: anything that sorts this list afterwards would otherwise read the
         stale value and undo the move. */
      if (moveToTop) {
        const rest = oldData.conversations.filter((_, i) => i !== index);
        return {
          ...oldData,
          conversations: [{ ...merged, updatedAt: new Date().toISOString() }, ...rest],
        };
      }

      return {
        ...oldData,
        conversations: oldData.conversations.map((c, i) => (i === index ? merged : c)),
      };
    });
  }
}

// Update
export function updateConvoInAllQueries(
  queryClient: QueryClient,
  conversationId: string,
  updater: (c: TConversation) => TConversation,
  moveToTop = false,
) {
  updatePinnedConvosQuery(queryClient, conversationId, updater, moveToTop);

  const queries = findConversationListQueries(queryClient);

  for (const query of queries) {
    /* A variant ordered by a key the client cannot place a row against keeps its positions
       and is refetched instead: a rename also moves a row under a title sort. */
    const newestFirst = queryListsNewestFirst(query.queryKey);
    queryClient.setQueryData<InfiniteData<ConversationCursorData>>(query.queryKey, (oldData) => {
      if (!oldData) {
        return oldData;
      }

      // Find conversation location (single pass with early exit)
      let pageIdx = -1;
      let convoIdx = -1;
      for (let pi = 0; pi < oldData.pages.length; pi++) {
        const ci = oldData.pages[pi].conversations.findIndex(
          (c) => c.conversationId === conversationId,
        );
        if (ci !== -1) {
          pageIdx = pi;
          convoIdx = ci;
          break;
        }
      }

      if (pageIdx === -1) {
        return oldData;
      }

      const found = oldData.pages[pageIdx].conversations[convoIdx];
      /** Callers that swap in a server response or the chat's own state wholesale (rename,
       * pin, SSE updates) omit the sidebar-only flags, which would otherwise drop the
       * shared badge and push a pinned chat back into the date groups. */
      const merged = preserveListFlags(updater(found), found);
      const updated = moveToTop ? { ...merged, updatedAt: new Date().toISOString() } : merged;

      if (!conversationBelongsToListQuery(query.queryKey, updated)) {
        return removeConvoFromInfinitePages(oldData, conversationId);
      }

      // If not moving to top, or already at top of page 0, update in place
      if (!moveToTop || !newestFirst || (pageIdx === 0 && convoIdx === 0)) {
        return {
          ...oldData,
          pages: oldData.pages.map((page, pi) =>
            pi === pageIdx
              ? {
                  ...page,
                  conversations: page.conversations.map((c, ci) => (ci === convoIdx ? updated : c)),
                }
              : page,
          ),
        };
      }

      // Move to top: only modify affected pages
      const newPages = oldData.pages.map((page, pi) => {
        if (pi === 0 && pageIdx === 0) {
          // Source is page 0: remove from current position, add to front
          const convos = page.conversations.filter((_, ci) => ci !== convoIdx);
          return { ...page, conversations: [updated, ...convos] };
        }
        if (pi === 0) {
          // Add to front of page 0
          return { ...page, conversations: [updated, ...page.conversations] };
        }
        if (pi === pageIdx) {
          // Remove from source page
          return {
            ...page,
            conversations: page.conversations.filter((_, ci) => ci !== convoIdx),
          };
        }
        return page;
      });

      return { ...oldData, pages: newPages };
    });
    if (queryNeedsServerReconciliation(query.queryKey)) {
      /* Inactive variants are only marked stale: they refresh when something mounts them. */
      queryClient.invalidateQueries({ queryKey: query.queryKey, refetchType: 'active' });
    }
  }
}

// Remove
export function removeConvoFromAllQueries(queryClient: QueryClient, conversationId: string) {
  updatePinnedConvosQuery(queryClient, conversationId, () => null);

  const queries = findConversationListQueries(queryClient);

  for (const query of queries) {
    queryClient.setQueryData<InfiniteData<ConversationCursorData>>(query.queryKey, (oldData) => {
      if (!oldData) {
        return oldData;
      }
      return {
        ...oldData,
        pages: oldData.pages
          .map((page) => ({
            ...page,
            conversations: page.conversations.filter((c) => c.conversationId !== conversationId),
          }))
          .filter((page) => page.conversations.length > 0),
      };
    });
  }
}
