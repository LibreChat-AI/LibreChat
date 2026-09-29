import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useDrag, useDragLayer, useDrop } from 'react-dnd';
import { Skeleton, useMediaQuery, useToastContext, buttonVariants } from '@librechat/client';
import type { TConversation, TEndpointsConfig } from 'librechat-data-provider';
import type {
  SelectEndpointHandler,
  SelectSpecHandler,
} from '~/components/Nav/Favorites/useFavoritesData';
import type { ConversationDragItem } from './dnd';
import type { Favorite } from '~/store/favorites';
import {
  CONVERSATION_DRAG_TYPE,
  beginPinnedDrag,
  endedOverExternalTarget,
  markPinnedHover,
  mergeVisibleOrder,
  shouldSwapOnHover,
} from './dnd';
import {
  useActiveJobs,
  useGetPinnedOrderQuery,
  usePinConversationMutation,
  useUpdatePinnedOrderMutation,
} from '~/data-provider';
import useFavoritesData from '~/components/Nav/Favorites/useFavoritesData';
import FavoriteItem from '~/components/Nav/Favorites/FavoriteItem';
import { useLocalize, useLocalStorage } from '~/hooks';
import { getSpecAgentAvatarURL, cn } from '~/utils';
import { NotificationSeverity } from '~/common';
import { Collapse } from '~/components/ui';
import { focusFirstRow } from './focus';
import Convo from './Convo';

const FAVORITE_ROW_DRAG_TYPE = 'favorite-item';

/** Declared on each row's focus target: a screen-reader user tabbing straight
 *  to a row would otherwise never meet the section's written hint, leaving the
 *  only non-pointer way to reorder undiscoverable. */
const REORDER_SHORTCUTS = 'Alt+ArrowUp Alt+ArrowDown';
/** The whole section accepts both kinds: a drop anywhere on it pins a chat that
 *  is not pinned yet, whichever row it happened to land on. */
const PINNED_ROW_ACCEPTS = [CONVERSATION_DRAG_TYPE, FAVORITE_ROW_DRAG_TYPE];
/** What a row answers a release with, so the drag can tell a reorder inside
 *  this list from a drop that filed the chat somewhere else. */
const PINNED_ROW_DROP_RESULT = { pinnedRowReorder: true } as const;

const noop = () => {};

/** A key identifies a row everywhere in this section, so the encoding has to be
 *  injective. The favorites API accepts any string for an endpoint or a model,
 *  so a plain `endpoint::model` join collides: `a::b` + `c` and `a` + `b::c`
 *  both read back as `a::b::c`, and the dedupe below would then hide one of two
 *  distinct favorites. Length-prefixing the endpoint makes the split exact. */
export const favoriteEntryKey = (favorite: Favorite): string => {
  if (favorite.agentId) {
    return `agent:${favorite.agentId}`;
  }
  if (favorite.spec) {
    return `spec:${favorite.spec}`;
  }
  const endpoint = favorite.endpoint ?? '';
  return `model:${endpoint.length}:${endpoint}:${favorite.model ?? ''}`;
};

const convoEntryKey = (conversationId: string): string => `convo:${conversationId}`;

type PinnedEntry =
  | { key: string; kind: 'favorite'; favorite: Favorite }
  | { key: string; kind: 'convo'; conversationId: string };

type PinnedRowDragItem = ConversationDragItem & { key: string };

/** Mirrors a favorite row (h-9, icon, title) so the loading swap keeps height. */
const FavoriteRowSkeleton = () => (
  <div className="flex w-full items-center rounded-lg p-2" aria-hidden="true">
    <Skeleton className="mr-2 h-5 w-5 rounded-full" />
    <Skeleton className="h-4 w-24" />
  </div>
);

interface DraggablePinnedRowProps {
  entry: PinnedEntry;
  conversation?: TConversation;
  indexOfKey: (key: string) => number;
  moveEntry: (dragKey: string, hoverKey: string) => void;
  moveEntryBy: (key: string, delta: number) => void;
  onDrop: (handledElsewhere: boolean) => void;
  /** Released while the row's title is being edited, so a drag-select inside
   *  the rename input is not swallowed by the drag source. */
  canDrag?: boolean;
  children: React.ReactNode;
}

/** Hover-reorder wrapper for the unified pinned list, following the favorites
 *  pattern: rows shift as the drag passes them and the order commits on drop.
 *  Touch pointers are excluded, matching every other drag source here, so the
 *  Alt+Arrow shortcut below is the only way to reorder without a mouse. */
const DraggablePinnedRow = ({
  entry,
  conversation,
  indexOfKey,
  moveEntry,
  moveEntryBy,
  onDrop,
  canDrag = true,
  children,
}: DraggablePinnedRowProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const hasHoverPointer = useMediaQuery('(hover: hover)');
  const [{ handlerId }, drop] = useDrop<PinnedRowDragItem, unknown, { handlerId: unknown }>({
    /* A row only takes a drag of its own kind, so a pinned chat never shifts a
     * pinned agent or model out of the way — not even as a preview. The two
     * groups are ordered independently, and the drag layer shows no
     * displacement for a target that cannot receive it. */
    accept: entry.kind === 'convo' ? CONVERSATION_DRAG_TYPE : FAVORITE_ROW_DRAG_TYPE,
    /* A release on a row ends a reorder; it files nothing. The row has to stay
     * droppable to get there — the HTML5 backend reports hover only for targets
     * that could receive the drag, and the hover is what reorders — so it names
     * itself in the drop result instead. Without that name, `end` below saw
     * `monitor.didDrop()` and read the release as a filing action, discarding
     * the arrangement: every pointer reorder snapped back on release. */
    drop: () => PINNED_ROW_DROP_RESULT,
    collect(monitor) {
      return { handlerId: monitor.getHandlerId() };
    },
    hover(item, monitor) {
      /* Recorded before any of the guards below, including the one for hovering
       * the dragged row itself. Returning early there would leave an earlier
       * external hover standing, and a drag that wandered onto a project and
       * came back to its own position would be discarded as a filing action. */
      markPinnedHover();
      if (!item.key || item.key === entry.key || !ref.current) {
        return;
      }
      const clientOffset = monitor.getClientOffset();
      if (!clientOffset) {
        return;
      }
      const rect = ref.current.getBoundingClientRect();
      const swap = shouldSwapOnHover({
        dragIndex: indexOfKey(item.key),
        hoverIndex: indexOfKey(entry.key),
        pointerY: clientOffset.y,
        hoverTop: rect.top,
        hoverBottom: rect.bottom,
      });
      if (!swap) {
        return;
      }
      moveEntry(item.key, entry.key);
    },
  });

  const [{ isDragging }, drag] = useDrag<PinnedRowDragItem, unknown, { isDragging: boolean }>({
    type: entry.kind === 'convo' ? CONVERSATION_DRAG_TYPE : FAVORITE_ROW_DRAG_TYPE,
    item: (): PinnedRowDragItem => {
      beginPinnedDrag();
      return entry.kind === 'convo'
        ? {
            key: entry.key,
            conversationId: entry.conversationId,
            chatProjectId: conversation?.chatProjectId ?? null,
            pinned: conversation?.pinned === true,
          }
        : { key: entry.key, conversationId: '', chatProjectId: null, pinned: false };
    },
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    /* A drop the list itself answered is a reorder and keeps the arrangement.
     * Anything else that handled it filed the chat — into a project, or back
     * into Chats — and a refused external target reports no handler at all, so
     * the last thing under the pointer settles that case. */
    end: (_item, monitor) => {
      const result = monitor.getDropResult() as { pinnedRowReorder?: boolean } | null;
      const filedElsewhere = monitor.didDrop() && result?.pinnedRowReorder !== true;
      onDrop(filedElsewhere || endedOverExternalTarget());
    },
  });

  drop(ref);
  drag(hasHoverPointer && canDrag ? ref : null);

  /* Keyboard equivalent of the drag: the shortcut is caught as it bubbles from
   * whichever element inside the row holds focus, so the row keeps that focus
   * across the move. It obeys the same gate as the pointer drag, which also
   * keeps Alt/Option+Arrow doing its usual word-wise caret movement inside an
   * open rename input rather than moving the row out from under it. */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canDrag) {
      return;
    }
    if (!event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    moveEntryBy(entry.key, event.key === 'ArrowUp' ? -1 : 1);
  };

  return (
    <div
      ref={ref}
      style={{ opacity: isDragging ? 0 : 1 }}
      data-handler-id={handlerId}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  );
};

interface FavoriteRowProps {
  favorite: Favorite;
  agentsMap: ReturnType<typeof useFavoritesData>['agentsMap'];
  specsMap: ReturnType<typeof useFavoritesData>['specsMap'];
  endpointsConfig: TEndpointsConfig;
  isAgentsLoading: boolean;
  onSelectEndpoint: SelectEndpointHandler;
  onSelectSpec: SelectSpecHandler;
  onRemoveFocus: () => void;
  keyShortcuts?: string;
}

/** One favorite rendered for the unified list; skeleton while its agent is
 *  still resolving, nothing if the agent or spec is gone (cleanup handles the
 *  latter asynchronously). */
const FavoriteRow = ({
  favorite,
  agentsMap,
  specsMap,
  endpointsConfig,
  isAgentsLoading,
  onSelectEndpoint,
  onSelectSpec,
  onRemoveFocus,
  keyShortcuts,
}: FavoriteRowProps) => {
  if (favorite.agentId) {
    const agent = agentsMap[favorite.agentId];
    if (!agent) {
      if (isAgentsLoading) {
        return <FavoriteRowSkeleton />;
      }
      return null;
    }
    return (
      <FavoriteItem
        item={agent}
        type="agent"
        onSelectEndpoint={onSelectEndpoint}
        onRemoveFocus={onRemoveFocus}
        keyShortcuts={keyShortcuts}
      />
    );
  }
  if (favorite.spec) {
    const spec = specsMap[favorite.spec];
    if (!spec) {
      return null;
    }
    return (
      <FavoriteItem
        item={spec}
        type="spec"
        onSelectSpec={onSelectSpec}
        endpointsConfig={endpointsConfig}
        agentAvatarURL={getSpecAgentAvatarURL(spec, agentsMap)}
        onRemoveFocus={onRemoveFocus}
        keyShortcuts={keyShortcuts}
      />
    );
  }
  if (favorite.model && favorite.endpoint) {
    return (
      <FavoriteItem
        item={{ model: favorite.model, endpoint: favorite.endpoint }}
        type="model"
        onSelectEndpoint={onSelectEndpoint}
        endpointsConfig={endpointsConfig}
        onRemoveFocus={onRemoveFocus}
        keyShortcuts={keyShortcuts}
      />
    );
  }
  return null;
};

interface PinnedSectionProps {
  conversations: TConversation[];
  toggleNav: () => void;
  isSmallScreen?: boolean;
  /** True when this list is the whole pinned list: no bookmark filter, and the
   *  pinned query has finished draining. Only then can keys the section cannot
   *  resolve be treated as gone rather than merely unseen. */
  membershipComplete?: boolean;
  /** When the pinned query last delivered, compared against the stored order's
   *  own fetch time to tell membership that reconciled with it from membership
   *  that is merely still inside its own freshness window. */
  membershipUpdatedAt?: number;
}

/** Pinned chats and pinned agents/models/specs (favorites) render as ONE
 *  reorderable list, kept in two groups — favorites first, then chats — because
 *  a row only reorders against its own kind. The order persists per user, and
 *  the section opens with the same collapse motion as the Projects section
 *  above it. */
const PinnedSection = ({
  conversations,
  toggleNav,
  isSmallScreen,
  membershipComplete = false,
  membershipUpdatedAt = 0,
}: PinnedSectionProps) => {
  const localize = useLocalize();
  const [isExpanded, setIsExpanded] = useLocalStorage('pinnedSectionExpanded', true);
  const { data: activeJobsData } = useActiveJobs();
  const favoritesData = useFavoritesData();
  /* Gated on success, not on the fetch having been attempted: a failed GET
   * still reports as fetched while leaving the order undefined, and merging
   * against that `?? []` then cancelling the retry would post only the visible
   * keys and discard saved positions for good. A reconciling refetch counts as
   * not ready either: returning to this tab after another changed the order
   * would otherwise let a reorder cancel that refetch and post the stale
   * arrangement straight back over it. */
  const {
    data: storedOrder,
    isSuccess: orderFetched,
    isFetching: orderFetching,
    dataUpdatedAt: orderUpdatedAt,
  } = useGetPinnedOrderQuery();
  const orderLoaded = orderFetched && !orderFetching;
  const updatePinnedOrder = useUpdatePinnedOrderMutation();
  const pinMutation = usePinConversationMutation();
  const { showToast } = useToastContext();
  const sectionRef = useRef<HTMLDivElement | null>(null);
  const activeJobIds = useMemo(
    () => new Set(activeJobsData?.activeJobIds ?? []),
    [activeJobsData?.activeJobIds],
  );

  /* Dropping an unpinned conversation anywhere on the section pins it. Row
   * drops reorder instead (their targets carry no drop handler, so a drop that
   * misses them bubbles here), and already-pinned rows are refused so an
   * aborted reorder never re-pins anything. */
  const [{ isPinOver, canPin }, pinDropRef] = useDrop<
    ConversationDragItem,
    unknown,
    { isPinOver: boolean; canPin: boolean }
  >({
    accept: PINNED_ROW_ACCEPTS,
    canDrop: (item, monitor) =>
      monitor.getItemType() === CONVERSATION_DRAG_TYPE && item.pinned !== true,
    /* The header and the padding around the rows are part of this list too, so
     * a drag that wandered onto a project and came back to rest on one of them
     * is still a reorder even though no row hover ran. */
    hover: () => markPinnedHover(),
    drop: (item, monitor) => {
      if (monitor.getItemType() !== CONVERSATION_DRAG_TYPE) {
        return;
      }
      if (!item.conversationId) {
        return;
      }
      pinMutation.mutate(
        { conversationId: item.conversationId, pinned: true },
        {
          onError: () => {
            showToast({
              message: localize('com_ui_pin_error'),
              severity: NotificationSeverity.ERROR,
              showIcon: true,
            });
          },
        },
      );
    },
    collect: (monitor) => ({ isPinOver: monitor.isOver(), canPin: monitor.canDrop() }),
  });

  /* An empty section still needs to receive the drop, so it materializes as a
   * drop zone while a conversation is being dragged. */
  const draggingConversation = useDragLayer(
    (monitor) => monitor.isDragging() && monitor.getItemType() === CONVERSATION_DRAG_TYPE,
  );

  /** Natural order: favorites in their stored order, then pinned chats. Keys
   *  identify a row everywhere here, so a repeat has to be dropped rather than
   *  rendered: the `/favorites` payload validator accepts a duplicate entry,
   *  and one would give two rows the same React key, point every drag at the
   *  first copy, and make the order endpoint reject the write outright. */
  const naturalEntries = useMemo<PinnedEntry[]>(() => {
    const entries: PinnedEntry[] = [];
    const seen = new Set<string>();
    for (const favorite of favoritesData.favorites) {
      const key = favoriteEntryKey(favorite);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      entries.push({ key, kind: 'favorite', favorite });
    }
    for (const convo of conversations) {
      const conversationId = convo.conversationId;
      if (!conversationId) {
        continue;
      }
      const key = convoEntryKey(conversationId);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      entries.push({ key, kind: 'convo', conversationId });
    }
    return entries;
  }, [favoritesData.favorites, conversations]);

  /** Stored keys order the entries they still resolve to; the rest append in
   *  natural order, so a stale order never hides an item. Kinds stay grouped —
   *  pinned agents and models first, then pinned chats — because neither kind
   *  can be dragged through the other: an order saved before that rule, with
   *  the two interleaved, would otherwise leave a row walled in by neighbours
   *  it is not allowed to swap with. */
  const orderedEntries = useMemo<PinnedEntry[]>(() => {
    if (!storedOrder || storedOrder.length === 0) {
      return naturalEntries;
    }
    const byKey = new Map(naturalEntries.map((entry) => [entry.key, entry]));
    const ordered: PinnedEntry[] = [];
    const placed = new Set<string>();
    for (const key of storedOrder) {
      const entry = byKey.get(key);
      if (entry) {
        ordered.push(entry);
        placed.add(key);
      }
    }
    for (const entry of naturalEntries) {
      if (!placed.has(entry.key)) {
        ordered.push(entry);
      }
    }
    return [
      ...ordered.filter((entry) => entry.kind === 'favorite'),
      ...ordered.filter((entry) => entry.kind === 'convo'),
    ];
  }, [storedOrder, naturalEntries]);

  /* The live list the drag mutates; keyed ordering only, so a refetch under a
   * drag cannot clobber the in-flight arrangement. */
  const dragEntriesRef = useRef<PinnedEntry[]>(orderedEntries);
  const dragMembershipRef = useRef(naturalEntries);
  const [liveEntries, setLiveEntries] = useState<PinnedEntry[] | null>(null);
  const [announcement, setAnnouncement] = useState('');
  /** `RenameForm` has no blur cancellation, so a second row's form can open
   *  while the first is still mounted. Every renaming row has to keep its drag
   *  source released, not just the most recent one. */
  const [renamingKeys, setRenamingKeys] = useState<ReadonlySet<string>>(() => new Set());

  const setRowRenaming = useCallback((key: string, renaming: boolean) => {
    setRenamingKeys((previous) => {
      if (previous.has(key) === renaming) {
        return previous;
      }
      const next = new Set(previous);
      if (renaming) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  }, []);

  if (orderedEntries !== dragEntriesRef.current && liveEntries === null) {
    dragEntriesRef.current = orderedEntries;
    dragMembershipRef.current = naturalEntries;
  }

  const displayEntries = liveEntries ?? orderedEntries;

  /** Live index of a key in the list the drag is mutating, so a hover can tell
   *  which side of the hovered row the drag is coming from. */
  /* Read inside callbacks that outlive the render they were created in. */
  const orderLoadedRef = useRef(orderLoaded);
  orderLoadedRef.current = orderLoaded;

  const indexOfKey = useCallback(
    (key: string) => dragEntriesRef.current.findIndex((entry) => entry.key === key),
    [],
  );

  /* Every drag end runs the commit, including drags that only filed a chat
   * into a project and drags that were abandoned without passing a row. Only a
   * drag that actually reordered something is worth a write. */
  const hasReorderedRef = useRef(false);
  /* Bumped by every move. A write that settles after the user has already
   * arranged the list again must not clear the snapshot showing that newer
   * arrangement, or the rows would snap back to the older order while the drag
   * still holds, and releasing would save something no longer on screen. */
  const arrangementRef = useRef(0);

  /** A move only ever swaps two rows of the same kind. Chats and favorites are
   *  two independently ordered groups, so the position announced for the
   *  keyboard path counts within the moved row's own group. */
  const moveEntry = useCallback((dragKey: string, hoverKey: string) => {
    const list = [...dragEntriesRef.current];
    const from = list.findIndex((entry) => entry.key === dragKey);
    const to = list.findIndex((entry) => entry.key === hoverKey);
    if (from < 0 || to < 0 || from === to || list[from].kind !== list[to].kind) {
      return;
    }
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    dragEntriesRef.current = list;
    hasReorderedRef.current = true;
    arrangementRef.current += 1;
    setLiveEntries(list);
  }, []);

  /** Keyboard reorder: one step per keypress, persisted immediately, with the
   *  new position announced because nothing visual conveys it to a screen
   *  reader. A step that would leave the row's own group does nothing, matching
   *  what the pointer can do. */
  const moveEntryBy = useCallback(
    (key: string, delta: number) => {
      if (!orderLoadedRef.current) {
        return;
      }
      const list = [...dragEntriesRef.current];
      const from = list.findIndex((entry) => entry.key === key);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= list.length || list[from].kind !== list[to].kind) {
        return;
      }
      const kind = list[from].kind;
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
      dragEntriesRef.current = list;
      hasReorderedRef.current = true;
      arrangementRef.current += 1;
      setLiveEntries(list);
      const group = list.filter((entry) => entry.kind === kind);
      const position = group.findIndex((entry) => entry.key === key) + 1;
      setAnnouncement(
        localize('com_ui_moved_to_position', { 0: `${position}`, 1: `${group.length}` }),
      );
      commitOrderRef.current();
    },
    [localize],
  );

  const commitOrder = useCallback(
    (handledElsewhere = false) => {
      if (!hasReorderedRef.current) {
        return;
      }
      /* A reconciling refetch is in flight. `canDrag` only disconnects the
       * source for drags that have not started, so one already under the
       * pointer still lands here, and the array built now would be merged onto
       * the order that refetch is about to replace. The arrangement is kept
       * and written once the fresh order arrives, below. */
      if (!handledElsewhere && !orderLoadedRef.current) {
        return;
      }
      hasReorderedRef.current = false;
      const arrangement = arrangementRef.current;
      if (handledElsewhere) {
        /* The drop filed the chat into a project or back into Chats. The rows
         * the pointer crossed on the way shifted only incidentally, so that
         * movement is discarded rather than saved as a deliberate reorder. */
        setLiveEntries(null);
        return;
      }
      const entries = dragEntriesRef.current;
      const visibleKeys = entries.map((entry) => entry.key);
      /* Merging keeps keys the section cannot currently see, which is right
       * while a bookmark filter hides rows or the pinned query is still
       * draining. Once the visible list is known to be the whole list, those
       * keys really are gone and replacing prunes them: merging forever would
       * grow the array until the endpoint's size guard rejected every write. */
      /* Every membership source has to have actually delivered, not merely
       * stopped loading: a favorites fetch that exhausted its retries leaves
       * the list empty, and pruning against that would drop every favorite key
       * from the stored order. */
      /* Current enough, too, and not merely settled: the pinned query holds its
       * data for five minutes while the order has no such window, so focusing a
       * tab reconciles the order on its own. Pruning that newer order against
       * the older membership beside it would drop the position of a favorite
       * or conversation another tab pinned in between. Until both membership
       * sources catch up, merging keeps those keys. */
      const membershipCurrent = membershipComplete && membershipUpdatedAt >= orderUpdatedAt;
      /* Reconciled membership can arrive while the live arrangement is frozen.
       * Its keys are not necessarily represented by that older snapshot. */
      const canPrune =
        membershipCurrent &&
        favoritesData.isLoaded &&
        favoritesData.dataUpdatedAt >= orderUpdatedAt &&
        dragMembershipRef.current === naturalEntries;
      const nextOrder = canPrune ? visibleKeys : mergeVisibleOrder(storedOrder ?? [], visibleKeys);

      updatePinnedOrder.mutate(nextOrder, {
        /* `pinnedOrder` is the only ordering the section reads: no consumer of
         * the favorites array depends on its order, so writing the arrangement
         * back there a second time bought nothing and raced the membership
         * mutations that share that array. */
        onError: () => {
          showToast({
            message: localize('com_ui_reorder_error'),
            severity: NotificationSeverity.ERROR,
            showIcon: true,
          });
        },
        /* Release the local arrangement once the write resolves either way: by
         * then the optimistic cache carries it, or the rollback has replaced it
         * with what the server actually holds. */
        onSettled: () => {
          if (arrangementRef.current !== arrangement) {
            return;
          }
          setLiveEntries(null);
        },
      });
    },
    [
      updatePinnedOrder,
      storedOrder,
      membershipComplete,
      membershipUpdatedAt,
      orderUpdatedAt,
      naturalEntries,
      favoritesData.isLoaded,
      favoritesData.dataUpdatedAt,
      showToast,
      localize,
    ],
  );

  /* `moveEntryBy` is declared above `commitOrder` and both are stable across a
   * drag, so the commit is reached through a ref rather than reordering them
   * into a dependency cycle. */
  const commitOrderRef = useRef(commitOrder);
  commitOrderRef.current = commitOrder;

  /* Flushes an arrangement that arrived while the order was reconciling. The
   * query settling is the external event being waited on, and `commitOrder`
   * returns immediately unless one is actually held. */
  useEffect(() => {
    if (orderLoaded) {
      commitOrderRef.current();
    }
  }, [orderLoaded]);

  /* `FavoriteItem` reports the removal only once its row is already gone, so
   * there is no position left to search around: focus goes to the first
   * surviving row, matching what the favorites list did before this merge. */
  const handleRemoveFocus = useCallback(() => {
    focusFirstRow(sectionRef.current);
  }, []);

  const handleSelectEndpoint = useCallback<SelectEndpointHandler>(
    (...args) => {
      favoritesData.onSelectEndpoint?.(...args);
      if (isSmallScreen) {
        toggleNav();
      }
    },
    [favoritesData, isSmallScreen, toggleNav],
  );

  const handleSelectSpec = useCallback<SelectSpecHandler>(
    (...args) => {
      favoritesData.onSelectSpec?.(...args);
      if (isSmallScreen) {
        toggleNav();
      }
    },
    [favoritesData, isSmallScreen, toggleNav],
  );

  const conversationByKey = useMemo(
    () => new Map(conversations.map((convo) => [convo.conversationId ?? '', convo])),
    [conversations],
  );

  /** The section root is both the pin drop target and the scope focus falls
   *  back into when a row is removed. */
  const setSectionRef = useCallback(
    (node: HTMLDivElement | null) => {
      sectionRef.current = node;
      pinDropRef(node);
    },
    [pinDropRef],
  );

  /* The section renders while either half is present or still resolving, and
   * drops out only once both are definitively empty. A live conversation drag
   * keeps it mounted as a drop target even when empty. */
  if (naturalEntries.length === 0 && !favoritesData.isLoading && !draggingConversation) {
    return null;
  }

  return (
    <div
      ref={setSectionRef}
      className="flex flex-col px-3 text-sm"
      role="region"
      /** The focus handoff after an unpin must act only on rows in this list:
       *  `ConversationsSection` is also a labelled region and an ancestor of
       *  the project rows, which render the same `Convo` and survive unpinning. */
      data-pinned-section=""
      aria-label={localize('com_ui_pinned')}
    >
      <div
        className={cn(
          'flex h-8 w-full items-center pr-2',
          isPinOver && canPin && 'rounded-lg bg-surface-active-alt',
        )}
      >
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className={cn(buttonVariants({ variant: 'section-header' }), 'group min-w-0 flex-1')}
          type="button"
          aria-expanded={isExpanded}
        >
          <span className="select-none truncate">{localize('com_ui_pinned')}</span>
          <ChevronDown
            className={cn(
              'h-3 w-3 shrink-0 transition-transform duration-200',
              isExpanded ? '' : '-rotate-90',
            )}
            aria-hidden="true"
          />
        </button>
      </div>

      <Collapse open={isExpanded}>
        {/* No scroll pane of its own: the sidebar scrolls as one surface. */}
        <div className="pt-0.5">
          {displayEntries.length === 0 && draggingConversation && (
            <div
              className={cn(
                'flex h-9 items-center justify-center rounded-lg border border-dashed text-xs text-text-secondary',
                isPinOver && canPin
                  ? 'border-border-medium bg-surface-active-alt text-text-primary'
                  : 'border-border-light',
              )}
              aria-hidden="true"
            >
              {localize('com_ui_drop_to_pin')}
            </div>
          )}
          <p className="sr-only">{localize('com_ui_pinned_reorder_hint')}</p>
          <p className="sr-only" role="status" aria-live="polite">
            {announcement}
          </p>
          <ul className="m-0 list-none p-0">
            {favoritesData.isLoading && favoritesData.favorites.length === 0 && (
              <li className="list-none">
                <FavoriteRowSkeleton />
              </li>
            )}
            {displayEntries.map((entry) => {
              if (entry.kind === 'convo') {
                const convo = conversationByKey.get(entry.conversationId);
                if (!convo) {
                  return null;
                }
                return (
                  <li key={entry.key} className="list-none">
                    <DraggablePinnedRow
                      entry={entry}
                      conversation={convo}
                      indexOfKey={indexOfKey}
                      moveEntry={moveEntry}
                      moveEntryBy={moveEntryBy}
                      onDrop={commitOrder}
                      canDrag={orderLoaded && !renamingKeys.has(entry.key)}
                    >
                      <Convo
                        conversation={convo}
                        retainView={noop}
                        toggleNav={toggleNav}
                        isGenerating={activeJobIds.has(convo.conversationId ?? '')}
                        keyShortcuts={orderLoaded ? REORDER_SHORTCUTS : undefined}
                        onRenamingChange={(renaming) => setRowRenaming(entry.key, renaming)}
                      />
                    </DraggablePinnedRow>
                  </li>
                );
              }
              return (
                <li key={entry.key} className="list-none">
                  <DraggablePinnedRow
                    entry={entry}
                    indexOfKey={indexOfKey}
                    moveEntry={moveEntry}
                    moveEntryBy={moveEntryBy}
                    onDrop={commitOrder}
                    canDrag={orderLoaded}
                  >
                    <FavoriteRow
                      favorite={entry.favorite}
                      agentsMap={favoritesData.agentsMap}
                      specsMap={favoritesData.specsMap}
                      endpointsConfig={favoritesData.endpointsConfig}
                      isAgentsLoading={favoritesData.isAgentsLoading}
                      onSelectEndpoint={handleSelectEndpoint}
                      onSelectSpec={handleSelectSpec}
                      onRemoveFocus={handleRemoveFocus}
                      keyShortcuts={orderLoaded ? REORDER_SHORTCUTS : undefined}
                    />
                  </DraggablePinnedRow>
                </li>
              );
            })}
          </ul>
        </div>
      </Collapse>
    </div>
  );
};

PinnedSection.displayName = 'PinnedSection';

export default memo(PinnedSection);
