import { useRef, useState, useEffect, useCallback } from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import type { Query, QueryClient, InfiniteData } from '@tanstack/react-query';
import type { TConversation } from 'librechat-data-provider';
import type { ConversationCursorData, PinnedConversationsData } from '~/utils/convos';
import type { ConvoCandidate } from '~/utils';
import {
  convoQueryAuthority,
  freshestCandidate,
  isConversationUnseen,
  trackConvoQueryAuthority,
  isAggregateQueryAuthoritative,
} from '~/utils';

export type UnseenConversation = {
  conversationId: string;
  title: string;
  /** The reply that made it unseen; a later one to the same chat is its own arrival. */
  lastResponseAt: string;
  /** The indicator comes from "mark as unread" on a conversation that has never been replied
   * to, so the stamp is the manual flag rather than a reply the alerts should announce. */
  flagged: boolean;
};

export type ReplyReadState = {
  unseen: UnseenConversation[];
  /** The reply stamp of every replied-to conversation in cache, seen rows included. The alerts'
   * baseline on it: a seen conversation marked unread from another device re-enters `unseen`
   * carrying the stamp it always had, which only this record can tell from a new reply. */
  stamps: Array<[conversationId: string, lastResponseAt: string]>;
  /** Reply stamps observed when a known row changed through a local cache merge. */
  arrivalStamps: Array<[conversationId: string, lastResponseAt: string]>;
};

/** How often the aggregate re-checks that deadline on its own; see the effect below. */
const LEFTOVER_SWEEP_MS = 60_000;

/** Null until a conversation list has actually resolved, which is not the same as an empty
 *  one: treating "not loaded yet" as "nothing unseen" makes the backlog look like arrivals. */
const readReplyState = (
  queryClient: QueryClient,
  arrivalStamps: ReplyReadState['arrivalStamps'],
): ReplyReadState | null => {
  /* Keyed rather than first-wins: the same row is cached once per list variant and only the
     mounted ones refetch, so an older copy would otherwise shadow a newer reply and drop it
     from the count. `freshestCandidate` settles which copy is actually current. */
  const byId = new Map<string, ConvoCandidate>();
  let hasList = false;

  const collect = (convo: TConversation, authority: Omit<ConvoCandidate, 'convo'>) => {
    const { conversationId } = convo;
    if (!conversationId) {
      return;
    }
    byId.set(
      conversationId,
      freshestCandidate(byId.get(conversationId), { convo, ...authority }) ?? {
        convo,
        ...authority,
      },
    );
  };

  const listQueries = queryClient
    .getQueryCache()
    .findAll([QueryKeys.allConversations], { exact: false });

  for (const query of listQueries) {
    const data = queryClient.getQueryData<InfiniteData<ConversationCursorData>>(query.queryKey);
    const authority = convoQueryAuthority(queryClient, query);
    if (!data || !isAggregateQueryAuthoritative(queryClient, query)) {
      continue;
    }
    hasList = true;
    for (const page of data.pages) {
      for (const convo of page.conversations) {
        collect(convo, authority);
      }
    }
  }

  /* The pinned section is fed by its own request, so a pin older than the loaded chat pages
     lives only here. Skipping it would show that row's dot while the tab count and the alerts
     never counted it. Readiness still keys on the chats list, which is the one the backlog
     arrives in. */
  const pinnedQueries = queryClient
    .getQueryCache()
    .findAll([QueryKeys.pinnedConversations], { exact: false });

  for (const query of pinnedQueries) {
    const data = queryClient.getQueryData<PinnedConversationsData>(query.queryKey);
    const authority = convoQueryAuthority(queryClient, query);
    if (!data || !isAggregateQueryAuthoritative(queryClient, query)) {
      continue;
    }
    for (const convo of data.conversations) {
      collect(convo, authority);
    }
  }

  if (!hasList) {
    return null;
  }

  const unseen: UnseenConversation[] = [];
  const stamps: ReplyReadState['stamps'] = [];
  for (const [conversationId, candidate] of byId) {
    const { convo } = candidate;
    const { lastResponseAt } = convo;
    if (!lastResponseAt) {
      continue;
    }
    const flagged = convo.lastResponseIsManual === true;
    /* Manual markers are state, not replies. Keep them out of the alert baseline so the first
       real reply after a mark-unread remains an arrival even when it shares a millisecond. */
    if (!flagged) {
      stamps.push([conversationId, lastResponseAt]);
    }
    if (isConversationUnseen(convo)) {
      unseen.push({
        conversationId,
        title: convo.title ?? '',
        lastResponseAt,
        flagged,
      });
    }
  }
  /* Ordered by id so the identity below does not depend on cache scan order. */
  stamps.sort(([a], [b]) => a.localeCompare(b));
  return { unseen, stamps, arrivalStamps };
};

type ArrivalSnapshot = Map<string, string | null>;
type ArrivalSnapshots = Map<string, ArrivalSnapshot | null>;
type ArrivalEvidence = Map<string, string>;
type ArrivalMode = 'server' | 'local' | 'none';

const snapshotForQuery = (query: Query): ArrivalSnapshot | null => {
  const data = query.state.data as
    | InfiniteData<ConversationCursorData>
    | PinnedConversationsData
    | undefined;
  if (!data) {
    return null;
  }
  const snapshot: ArrivalSnapshot = new Map();
  const pages = 'pages' in data ? data.pages : [data];
  for (const page of pages) {
    for (const convo of page.conversations) {
      if (convo.conversationId) {
        /* Keep user-only rows in the snapshot. A locally merged first reply must be distinguishable
         * from a conversation that was newly discovered by a later page or query variant. */
        snapshot.set(convo.conversationId, convo.lastResponseAt ?? null);
      }
    }
  }
  return snapshot;
};

const observeArrivalQuery = (
  query: Query,
  snapshots: ArrivalSnapshots,
  evidence: ArrivalEvidence,
  mode: ArrivalMode,
): void => {
  const current = snapshotForQuery(query);
  const previous = snapshots.get(query.queryHash);
  /* The watcher names the conversations a discovery refresh was started for. Those are live on
     the query it creates; every other row on that first page is backlog this session has never
     observed, and announcing it would greet the user with their whole unseen history. */
  const discovered = query.meta?.replyDiscovery;
  const discoveredIds = Array.isArray(discovered) ? new Set(discovered as string[]) : null;
  const isLiveDiscovery = mode === 'server' && (discoveredIds?.size ?? 0) > 0;
  if (current === null || (previous == null && !isLiveDiscovery)) {
    snapshots.set(query.queryHash, current);
    return;
  }
  if (mode !== 'none') {
    const data = query.state.data as InfiniteData<ConversationCursorData> | PinnedConversationsData;
    const pages = 'pages' in data ? data.pages : [data];
    /* A server response is read on its first page, where a reply lands and where discovery
       names what it found. A local merge can touch a row wherever the list holds it: a title
       or oldest-first sort leaves a replied row on a later page, and missing it there would add
       its stamp to the baseline with no arrival behind it. Only rows the previous snapshot
       already knew are considered below, so this cannot announce backlog. */
    const candidates =
      mode === 'local'
        ? pages.flatMap((page) => page.conversations)
        : (pages[0]?.conversations ?? []);
    for (const convo of candidates) {
      const { conversationId, lastResponseAt } = convo;
      if (
        !conversationId ||
        !lastResponseAt ||
        convo.lastResponseIsManual === true ||
        (mode === 'local' && !previous?.has(conversationId))
      ) {
        continue;
      }
      if (previous == null && discoveredIds?.has(conversationId) !== true) {
        continue;
      }
      /* An unknown row can enter this page because it was renamed. Real reply writes advance
         both stamps together; a later metadata-only update must not announce old backlog. */
      if (!previous?.has(conversationId) && convo.updatedAt !== lastResponseAt) {
        continue;
      }
      if (previous?.get(conversationId) === lastResponseAt) {
        continue;
      }
      const recorded = evidence.get(conversationId);
      if (recorded === undefined || lastResponseAt > recorded) {
        evidence.set(conversationId, lastResponseAt);
      }
    }
  }
  snapshots.set(query.queryHash, current);
};

/**
 * How many arrivals are remembered before the dead ones are swept.
 *
 * Every refresh copies and sorts this map into the state identity, so in a tab left open across
 * many replies its cost would otherwise grow with the lifetime number of arrivals rather than
 * with the live cache. The bound is generous enough that an ordinary session never sweeps.
 */
const ARRIVAL_EVIDENCE_BOUND = 500;

/**
 * Drops evidence for conversations no observed snapshot still holds.
 *
 * An entry earns its place by baselining a row the alerts may still meet again; once the row
 * has left every list the cache knows, nothing can consult it, and a deleted or evicted
 * conversation would otherwise be remembered for the life of the tab.
 */
const pruneArrivalEvidence = (snapshots: ArrivalSnapshots, evidence: ArrivalEvidence): void => {
  const live = new Set<string>();
  for (const snapshot of snapshots.values()) {
    if (snapshot === null) {
      continue;
    }
    for (const conversationId of snapshot.keys()) {
      live.add(conversationId);
    }
  }
  for (const conversationId of evidence.keys()) {
    if (!live.has(conversationId)) {
      evidence.delete(conversationId);
    }
  }
};

const readArrivalStamps = (evidence: ArrivalEvidence): ReplyReadState['arrivalStamps'] =>
  [...evidence.entries()].sort(([a], [b]) => a.localeCompare(b));

/* Title and reply stamp are part of the identity, not just the id: a conversation is auto-titled
   moments after the reply that made it unseen, and a second reply to an already-unseen chat has
   to reach the alerts as its own arrival. The seen rows' stamps count too, so the alerts'
   baseline keeps up with replies that were caught up the moment they landed. */
const identityOf = (state: ReplyReadState | null): string =>
  state === null
    ? 'pending'
    : JSON.stringify([
        state.unseen
          .map((c): [string, string, string] => [c.conversationId, c.title, c.lastResponseAt])
          .sort(([a], [b]) => a.localeCompare(b)),
        state.stamps,
        state.arrivalStamps,
      ]);

/**
 * The set of conversations that have replied since the user last caught up with them, alongside
 * the reply stamps of everything the cache knows.
 *
 * Derived from the conversation list already in cache, so it costs no request of its own and
 * needs no count endpoint. A reply lifts its conversation, so an unseen one normally sits on the
 * first page. "Mark as unread" is the exception: it deliberately leaves `updatedAt` alone, and
 * its explicit manual marker is counted only once its page is loaded. Its own row still shows the
 * indicator; only this aggregate waits.
 *
 * Subscribing to the query cache (rather than mounting a second list query) avoids duplicating
 * the sidebar's fetch. Cache events are filtered by key before any recomputation, because they
 * also fire for message updates on every streamed token.
 *
 * Returns null while no list has resolved yet, so callers can tell "nothing is unseen" apart
 * from "nothing is known".
 */
export default function useUnseenConversations(): ReplyReadState | null {
  const queryClient = useQueryClient();
  const arrivalSnapshots = useRef<ArrivalSnapshots>(new Map());
  const arrivalEvidence = useRef<ArrivalEvidence>(new Map());
  const [state, setState] = useState<ReplyReadState | null>(() => readReplyState(queryClient, []));

  const refresh = useCallback(() => {
    const next = readReplyState(queryClient, readArrivalStamps(arrivalEvidence.current));
    setState((current) => (identityOf(current) === identityOf(next) ? current : next));
  }, [queryClient]);

  useEffect(() => {
    const cache = queryClient.getQueryCache();
    trackConvoQueryAuthority(queryClient);

    for (const query of cache.getAll()) {
      const root = query.queryKey?.[0];
      if (
        root === QueryKeys.allConversations ||
        root === QueryKeys.pinnedConversations ||
        root === QueryKeys.conversation
      ) {
        convoQueryAuthority(queryClient, query);
        if (root === QueryKeys.allConversations || root === QueryKeys.pinnedConversations) {
          observeArrivalQuery(query, arrivalSnapshots.current, arrivalEvidence.current, 'none');
        }
      }
    }

    const unsubscribe = cache.subscribe((event) => {
      const { query } = event;
      const root = query.queryKey?.[0];
      if (
        root !== QueryKeys.allConversations &&
        root !== QueryKeys.pinnedConversations &&
        root !== QueryKeys.conversation
      ) {
        return;
      }
      convoQueryAuthority(queryClient, query);
      if (event.type === 'removed') {
        arrivalSnapshots.current.delete(query.queryHash);
        pruneArrivalEvidence(arrivalSnapshots.current, arrivalEvidence.current);
      } else if (root === QueryKeys.allConversations || root === QueryKeys.pinnedConversations) {
        let mode: ArrivalMode = 'none';
        if (event.type === 'updated' && event.action.type === 'success') {
          mode = event.action.manual === true ? 'local' : 'server';
        }
        observeArrivalQuery(query, arrivalSnapshots.current, arrivalEvidence.current, mode);
        if (arrivalEvidence.current.size > ARRIVAL_EVIDENCE_BOUND) {
          pruneArrivalEvidence(arrivalSnapshots.current, arrivalEvidence.current);
        }
      }
      refresh();
    });
    refresh();
    /* Crossing the leftover deadline is not a cache event, so an otherwise idle tab would keep
     * counting a phantom row until something else happened to touch the caches. Recomputing on
     * a slow tick costs a scan of what is already in memory and no request. */
    const tick = window.setInterval(refresh, LEFTOVER_SWEEP_MS);
    return () => {
      window.clearInterval(tick);
      unsubscribe();
    };
  }, [queryClient, refresh]);

  return state;
}
