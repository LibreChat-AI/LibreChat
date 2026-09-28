import { atom } from 'jotai';
import type { ConversationListParams } from 'librechat-data-provider';
import { createStorageAtom } from '~/store/jotai-utils';

/** Which slice of the user's chats the sidebar list is showing. */
export type ChatFilterStatus = 'active' | 'archived';

export type ChatSortField = NonNullable<ConversationListParams['sortBy']>;
export type ChatSortDirection = NonNullable<ConversationListParams['sortDirection']>;

export type ChatSort = {
  field: ChatSortField;
  direction: ChatSortDirection;
};

export const DEFAULT_CHAT_SORT: ChatSort = { field: 'updatedAt', direction: 'desc' };

/** Sort fields the list offers, per view. `archivedAt` only means something once the
 *  archive is what is on screen, and the server rejects any field outside this set. */
export const ACTIVE_SORT_FIELDS: readonly ChatSortField[] = ['updatedAt', 'createdAt', 'title'];
export const ARCHIVED_SORT_FIELDS: readonly ChatSortField[] = [
  'archivedAt',
  'updatedAt',
  'createdAt',
  'title',
];

export const sortFieldsFor = (status: ChatFilterStatus): readonly ChatSortField[] =>
  status === 'archived' ? ARCHIVED_SORT_FIELDS : ACTIVE_SORT_FIELDS;

/** `title` orders strings; every other field orders instants. The direction control
 *  and the list's own grouping both read this. */
export const isAlphabeticalSort = (field: ChatSortField): boolean => field === 'title';

/**
 * A persisted sort survives a rename of these fields, a downgrade, and hand-editing,
 * and an unknown field reaches Mongo as a rejected sort — a failed list, not a
 * fallback. Anything unrecognized, or valid only for the view that is not on screen,
 * reads as the default instead.
 */
const sanitizeSort = (value: unknown, status: ChatFilterStatus): ChatSort => {
  if (value == null || typeof value !== 'object') {
    return DEFAULT_CHAT_SORT;
  }
  const { field, direction } = value as Partial<ChatSort>;
  if (field == null || !sortFieldsFor(status).includes(field)) {
    return DEFAULT_CHAT_SORT;
  }
  return { field, direction: direction === 'asc' ? 'asc' : 'desc' };
};

/** Which chats are listed. Deliberately not persisted: a filter that hides chats
 *  should not greet the user on the next visit. */
export const chatFilterStatusAtom = atom<ChatFilterStatus>('active');

/** Bookmark (tag) filter, OR-matched by the server. Session-scoped, like the status. */
export const chatFilterTagsAtom = atom<string[]>([]);

/** Ordering is a preference rather than a filter, so it is the one part that is kept. */
const storedChatSortAtom = createStorageAtom<ChatSort>('chatListSort', DEFAULT_CHAT_SORT);

export const chatSortAtom = atom(
  (get) => sanitizeSort(get(storedChatSortAtom), get(chatFilterStatusAtom)),
  (get, set, next: ChatSort) => {
    set(storedChatSortAtom, sanitizeSort(next, get(chatFilterStatusAtom)));
  },
);

/** Read by conversation rows to offer restoring instead of archiving. */
export const isArchivedChatViewAtom = atom((get) => get(chatFilterStatusAtom) === 'archived');

/** Drives the trigger's badge: how many choices differ from the default list. */
export const chatFilterCountAtom = atom((get) => {
  const sort = get(chatSortAtom);
  let count = get(chatFilterTagsAtom).length;
  if (get(chatFilterStatusAtom) !== 'active') {
    count += 1;
  }
  if (sort.field !== DEFAULT_CHAT_SORT.field || sort.direction !== DEFAULT_CHAT_SORT.direction) {
    count += 1;
  }
  return count;
});

export const resetChatFiltersAtom = atom(null, (_get, set) => {
  set(chatFilterStatusAtom, 'active');
  set(chatFilterTagsAtom, []);
  set(storedChatSortAtom, DEFAULT_CHAT_SORT);
});

/**
 * Switching views re-scopes the sort: `archivedAt` cannot order the active list, and
 * leaving it set would send the server a field it refuses.
 */
export const setChatFilterStatusAtom = atom(null, (get, set, status: ChatFilterStatus) => {
  set(chatFilterStatusAtom, status);
  const sort = sanitizeSort(get(storedChatSortAtom), status);
  set(storedChatSortAtom, sort);
});

/** Reset account-scoped filters without discarding the per-device sort preference. */
export const resetChatFilterSessionAtom = atom(null, (_get, set) => {
  set(chatFilterStatusAtom, 'active');
  set(chatFilterTagsAtom, []);
});

export const toggleChatFilterTagAtom = atom(null, (get, set, tag: string) => {
  const tags = get(chatFilterTagsAtom);
  set(
    chatFilterTagsAtom,
    tags.includes(tag) ? tags.filter((current) => current !== tag) : [...tags, tag],
  );
});
