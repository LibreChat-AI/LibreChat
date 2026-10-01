import { useRef, useEffect } from 'react';
import { QueryKeys, dataService } from 'librechat-data-provider';
import { useQueryClient, replaceEqualDeep } from '@tanstack/react-query';
import type { TConversation, ConversationListParams } from 'librechat-data-provider';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { ConversationCursorData } from '~/utils/convos';
import {
  isNotFoundError,
  findConvoInAllQueries,
  updateConvoInAllQueries,
  isConvoInAggregateCaches,
} from '~/utils';
import { REPLY_NOTIFICATION_DEFAULTS, useReplyAlertPreferences } from './replyNotificationSettings';
import { useActiveJobs } from '~/data-provider';

/**
 * Timestamps are the only thing worth taking from a fresher copy; everything else in the row is
 * either already current or derived per list request.
 *
 * `updatedAt` rides along and the row moves to the top, because a reply now advances `updatedAt`
 * server-side: leaving the cached copy behind would show a conversation that just became active
 * still sitting at its old date and position. The same write also refreshes the list query's
 * `dataUpdatedAt`, so a stale row could otherwise survive the next focus refetch.
 *
 * Writes only when something actually differs: an unchanged `setQueryData` would still bump that
 * `dataUpdatedAt`, keeping the query permanently inside its stale window and silently disabling
 * the sidebar's refetch on window focus.
 */
const didListRefreshFail = (queryClient: QueryClient): boolean =>
  queryClient
    .getQueryCache()
    .findAll([QueryKeys.allConversations], { exact: false })
    .some((query) => query.getObserversCount() > 0 && query.state.status === 'error');

type ConversationPages = InfiniteData<ConversationCursorData>;

/**
 * A first-page refetch can promote a row out of a loaded page. Keep the old first-page rows that
 * were displaced, remove the promoted duplicates from later pages, and move the first page cursor
 * forward. This leaves the already-scrolled rows usable without asking the server for every page.
 */
const reconcileFirstPage = (
  previous: ConversationPages | undefined,
  current: ConversationPages | undefined,
): ConversationPages | undefined => {
  if (!previous || !current || previous.pages.length === 0 || current.pages.length === 0) {
    return current;
  }

  const freshFirst = replaceEqualDeep(previous.pages[0], current.pages[0]);
  if (freshFirst === previous.pages[0]) {
    return previous;
  }
  const freshIds = new Set<string>();
  const uniqueFirst = freshFirst.conversations.filter((convo) => {
    const id = convo.conversationId;
    if (!id) {
      return true;
    }
    if (freshIds.has(id)) {
      return false;
    }
    freshIds.add(id);
    return true;
  });

  if (freshFirst.nextCursor == null) {
    return {
      ...current,
      pages: [{ ...freshFirst, conversations: uniqueFirst }],
      pageParams: current.pageParams.slice(0, 1),
    };
  }

  /* Keep rows displaced into the loaded tail. A normal full revalidation still owns pruning
     historical rows, which is why the partial merge never refreshes the original query's age. */
  const displaced =
    current.pages.length > 1 && freshFirst.nextCursor != null
      ? previous.pages[0].conversations.filter(
          (convo) => convo.conversationId && !freshIds.has(convo.conversationId),
        )
      : [];
  const seen = new Set(freshIds);
  const pages = current.pages.map((page, pageIndex) => {
    if (pageIndex === 0) {
      return uniqueFirst.length === freshFirst.conversations.length
        ? freshFirst
        : { ...freshFirst, conversations: uniqueFirst };
    }

    const conversations = [...(pageIndex === 1 ? displaced : []), ...page.conversations].filter(
      (convo) => {
        const id = convo.conversationId;
        if (!id) {
          return true;
        }
        if (seen.has(id)) {
          return false;
        }
        seen.add(id);
        return true;
      },
    );
    if (
      conversations.length === page.conversations.length &&
      conversations.every((convo, index) => convo === page.conversations[index])
    ) {
      return page;
    }
    return { ...page, conversations };
  });

  const pageParams = [...current.pageParams];
  if (
    pages.length > 1 &&
    freshFirst.nextCursor != null &&
    pageParams[1] !== freshFirst.nextCursor
  ) {
    pageParams[1] = freshFirst.nextCursor;
  }
  const pagesChanged = pages.some((page, index) => page !== current.pages[index]);
  const pageParamsChanged = pageParams.some((param, index) => param !== current.pageParams[index]);
  return pagesChanged || pageParamsChanged ? { ...current, pages, pageParams } : current;
};

/**
 * Refresh the visible sidebar and the unfiltered cache read by global reply indicators.
 *
 * `discovered` names the conversations this refresh was started for. The queries it creates
 * have never been observed before, so the alert layer would otherwise have to choose between
 * treating their whole first page as new arrivals — announcing the user's entire unseen
 * backlog — and treating it as a quiet baseline, which would swallow the very reply that
 * triggered the refresh. Naming the ids keeps both from happening.
 */
const refreshConversationLists = async (
  queryClient: QueryClient,
  discovered: readonly string[] = [],
  /* How many rows the canonical discovery fetch reads. It is a ceiling rather than a
     guarantee: draining the cursor on a poll that repeats every thirty seconds is the wrong
     trade, and covering a deployment whose replies outpace it properly wants an unseen query
     on the server rather than a wider page here, which is why operators can raise it. */
  limit: number = REPLY_NOTIFICATION_DEFAULTS.pollLimit,
): Promise<void> => {
  const cache = queryClient.getQueryCache();
  const active = cache
    .findAll([QueryKeys.allConversations], { exact: false })
    .filter((query) => query.isActive());
  const invalidation = queryClient.invalidateQueries([QueryKeys.allConversations], {
    refetchType: 'none',
  });
  const refreshes = active.map(async (query) => {
    const queryFn = query.options.queryFn;
    const snapshot = await queryClient.fetchInfiniteQuery<ConversationCursorData>({
      queryKey: [...query.queryKey, 'reply-discovery'],
      meta: { replyDiscovery: discovered },
      queryFn: async ({ signal }) => {
        if (typeof queryFn !== 'function') {
          return dataService.listConversations({
            ...(query.queryKey[1] as ConversationListParams | undefined),
            cursor: undefined,
          });
        }
        return (await queryFn({
          queryKey: query.queryKey,
          pageParam: undefined,
          signal,
          meta: query.meta,
        })) as ConversationCursorData;
      },
      getNextPageParam: () => undefined,
    });
    if (cache.find(query.queryKey) !== query) {
      return;
    }
    const current = queryClient.getQueryData<ConversationPages>(query.queryKey);
    if (!current || !snapshot.pages[0]) {
      return;
    }
    const reconciled = reconcileFirstPage(current, {
      ...current,
      pages: [snapshot.pages[0], ...current.pages.slice(1)],
    });
    if (reconciled && reconciled !== current) {
      /* The snapshot owns the new first page, not the old loaded tail. Keep the original
         query's age so normal focus/mount revalidation can still refresh those older pages. */
      queryClient.setQueryData(query.queryKey, reconciled, {
        updatedAt: query.state.dataUpdatedAt,
      });
    }
  });

  await Promise.all([
    invalidation,
    ...refreshes,
    queryClient.invalidateQueries([QueryKeys.pinnedConversations]),
    queryClient.fetchInfiniteQuery({
      queryKey: [QueryKeys.allConversations, { isArchived: false, replyDiscovery: true }],
      meta: { replyDiscovery: discovered },
      queryFn: () => dataService.listConversations({ isArchived: false, limit }),
      getNextPageParam: () => undefined,
    }),
  ]);
};

const mergeTimestamps = async (
  queryClient: QueryClient,
  convo: Partial<TConversation>,
  aggregateRevealed: Map<string, string>,
  /** The completion fetch exists only to deliver a stamp the cache lacks. Once the cache
   *  carries that stamp, the rest of its snapshot is a read from before the open conversation
   *  acknowledged here, and merging it would clear the newer catch-up with the attempt guard
   *  suppressing the re-send. The away poll keeps full-snapshot semantics: an equal-stamp row
   *  with a cleared catch-up is how a remote mark-as-unread reaches this tab, and that path's
   *  own stale reads are fenced by its arrival focus check. */
  stampDelivery = false,
  isCurrent: () => boolean = () => true,
): Promise<void> => {
  const {
    conversationId,
    lastResponseAt,
    lastResponseMessageId,
    lastResponseIsManual,
    lastSeenAt,
    updatedAt,
  } = convo;
  if (!conversationId || !lastResponseAt) {
    return;
  }
  let cached = findConvoInAllQueries(queryClient, conversationId);

  /* A job completing on another device can belong to a conversation the chats list has never
     loaded, and the writes below only reach rows that already exist. Hand-inserting one would
     fight the list's own ordering and pagination, so the list is refetched instead, exactly as
     the away poll does when it meets an id it does not know.
     Keyed on the caches the unseen aggregate actually reads: a conversation opened by URL sits
     in its own point query, which is enough for the lookup above but invisible to the badge and
     the alerts, so it still needs the list. Checked before the unchanged-row return, because a
     transiently failed refetch leaves the next snapshot looking identical: absence from the
     aggregate caches re-arms the attempt, and marking a stamp done only on a refetch that
     succeeded keeps a row that moved beyond the refreshed pages from causing a refetch loop. */
  if (!isConvoInAggregateCaches(queryClient, conversationId)) {
    if (aggregateRevealed.get(conversationId) !== lastResponseAt) {
      await refreshConversationLists(queryClient, [conversationId]);
      if (!isCurrent()) {
        return;
      }
      if (!didListRefreshFail(queryClient)) {
        aggregateRevealed.set(conversationId, lastResponseAt);
      }
      cached = findConvoInAllQueries(queryClient, conversationId);
    }
    if (!cached) {
      return;
    }
  }

  const incomingResponseMessageId =
    lastResponseIsManual === true ? undefined : lastResponseMessageId;
  if (
    cached &&
    cached.lastResponseAt === lastResponseAt &&
    cached.lastResponseIsManual === lastResponseIsManual &&
    cached.lastSeenAt === (lastSeenAt ?? undefined) &&
    (updatedAt === undefined || cached.updatedAt === updatedAt) &&
    (incomingResponseMessageId === undefined ||
      cached.lastResponseMessageId === incomingResponseMessageId)
  ) {
    return;
  }

  /* Two fetches for the same conversation can resolve out of order: overlapping away polls, or
   * completion fetches for concurrent jobs. Taking the older one would walk the read state
   * backwards and either drop a dot or bring one back. A snapshot is accepted whole or not at
   * all, since its two stamps come from one server read and `lastSeenAt` legitimately clears
   * when another device marks the conversation unread. */
  if (cached?.lastResponseAt != null && lastResponseAt < cached.lastResponseAt) {
    return;
  }

  /* An equal timestamp already names the same server reply. Identity can arrive after the
   * timestamp (especially from a completion point read), so merge it without refetching history.
   * Completion snapshots are intentionally read-state neutral: they must not clear a newer
   * catch-up that arrived while the point request was in flight. */
  if (cached?.lastResponseAt === lastResponseAt) {
    const nextLastResponseMessageId =
      lastResponseIsManual === true
        ? undefined
        : (incomingResponseMessageId ?? cached.lastResponseMessageId);
    const nextLastSeenAt = stampDelivery ? cached.lastSeenAt : lastSeenAt;
    const nextUpdatedAt = stampDelivery ? cached.updatedAt : (updatedAt ?? cached.updatedAt);
    if (
      cached.lastResponseMessageId !== nextLastResponseMessageId ||
      cached.lastResponseIsManual !== lastResponseIsManual ||
      cached.lastSeenAt !== nextLastSeenAt ||
      cached.updatedAt !== nextUpdatedAt
    ) {
      updateConvoInAllQueries(queryClient, conversationId, (current) => ({
        ...current,
        lastResponseMessageId: nextLastResponseMessageId,
        lastResponseIsManual,
        lastSeenAt: nextLastSeenAt,
        updatedAt: nextUpdatedAt,
      }));
    }
    return;
  }

  /* Awaited, and before the stamp. A reply this tab never streamed is not in the rendered
   * tree, and exposing the stamp first would let the seen trigger acknowledge it from a scroll
   * position that belongs to the previous message. Invalidation resolves once the active
   * refetch has landed, so the conversation the user is looking at is showing the reply by the
   * time it can be credited; anywhere else the query is unmounted, nothing is fetched and this
   * resolves immediately. */
  const messagesKey = [QueryKeys.messages, conversationId];
  await queryClient.invalidateQueries(messagesKey);
  if (!isCurrent()) {
    return;
  }
  /* Invalidation settles rather than throwing when the refetch fails, so the failure has to be
   * read off the query itself. Exposing the stamp anyway would let the seen trigger credit a
   * reply the tab never managed to load; the next poll retries.
   * Only an observed query counts: invalidation refetches those, so its error is this attempt's.
   * A cached error left behind by a conversation the user has since closed never clears, and
   * reading it would withhold that conversation's stamp for the rest of the session. */
  const messagesQuery = queryClient.getQueryCache().find(messagesKey);
  const isObserved = (messagesQuery?.getObserversCount() ?? 0) > 0;
  if (isObserved && messagesQuery?.state.status === 'error') {
    return;
  }

  /* The await above is a real network wait while the conversation is open, and a newer stamp
   * can land during it: the SSE final handler, or a fresher overlapping fetch. Writing this
   * snapshot over that would walk the read state backwards after the newer reply's signal was
   * already consumed, so the ordering guard runs again against what the cache holds now, and
   * an unchanged row is left alone for the same `dataUpdatedAt` reason as above. */
  const fresh = findConvoInAllQueries(queryClient, conversationId);
  if (fresh?.lastResponseAt != null && lastResponseAt < fresh.lastResponseAt) {
    return;
  }
  if (stampDelivery && fresh?.lastResponseAt === lastResponseAt) {
    if (
      fresh.lastResponseMessageId !== incomingResponseMessageId ||
      fresh.lastResponseIsManual !== lastResponseIsManual
    ) {
      updateConvoInAllQueries(queryClient, conversationId, (current) => ({
        ...current,
        lastResponseMessageId: incomingResponseMessageId,
        lastResponseIsManual,
      }));
    }
    return;
  }
  if (
    fresh &&
    fresh.lastResponseAt === lastResponseAt &&
    fresh.lastResponseMessageId === (incomingResponseMessageId ?? fresh.lastResponseMessageId) &&
    fresh.lastResponseIsManual === lastResponseIsManual &&
    fresh.lastSeenAt === (lastSeenAt ?? undefined) &&
    (updatedAt === undefined || fresh.updatedAt === updatedAt)
  ) {
    return;
  }

  updateConvoInAllQueries(
    queryClient,
    conversationId,
    (current) => ({
      ...current,
      lastResponseAt,
      lastResponseMessageId: incomingResponseMessageId ?? current.lastResponseMessageId,
      lastResponseIsManual,
      lastSeenAt,
      updatedAt: updatedAt ?? current.updatedAt,
    }),
    /* Reordering only when the server says the conversation moved; a bare read-state merge
     * must not jump the row. */
    updatedAt !== undefined && fresh?.updatedAt !== updatedAt,
  );
};

/**
 * Notices replies that finish without this tab holding the stream.
 *
 * `finalHandler` covers the tab that is sitting on the conversation, but navigating elsewhere
 * closes the SSE connection by design, and a run started on another device was never attached
 * here at all. Both cases feed the same unseen pipeline once the timestamps reach the cache, so
 * this hook only has to get them there.
 *
 * Two paths, because one signal cannot cover both cheaply:
 *
 * - **Foreground.** `useActiveJobs` is already mounted by the sidebar and already polls while any
 *   job runs, so watching an id leave that set costs no extra request. Completion then fetches
 *   just that conversation rather than refetching the whole list.
 * - **Away.** Job-set watching is unreliable here: a short run can start and finish between two
 *   polls, leaving no transition to observe. Polling the first page of the list instead reports
 *   the reply whether or not the job was ever seen running. Gated on any of the three away
 *   features (notifications, sound, tab badge), so the request only exists for someone who
 *   asked to be told or shown something while away.
 */
export default function useReplyWatcher() {
  const queryClient = useQueryClient();
  /* Both cadences come from `interface.replyNotifications`. The focused refresh is deliberately
     far slower than the away poll: the user is looking at the sidebar, alerts are suppressed
     there anyway, and it exists only so a reply produced elsewhere eventually shows its dot. */
  const {
    notificationsEnabled,
    soundEnabled,
    badgeEnabled,
    pollLimit,
    pollIntervalMs,
    focusedRefreshMs,
  } = useReplyAlertPreferences();
  const { data: activeJobsData } = useActiveJobs();
  const activeJobIds = activeJobsData?.activeJobIds;
  /** A completion fetch can outlive the watcher. Signing out or switching accounts unmounts
   *  it, and a response for the previous session must not write into the caches the next
   *  one reads. Tracked on unmount rather than in the jobs effect's cleanup: that effect
   *  re-runs on every change to the running set, and the completions it started are still
   *  wanted. */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const runningRef = useRef<Set<string> | null>(null);
  /** Reply stamps whose list refetch has already been attempted for a conversation no cache
   *  knows, keyed by id. Keyed on the stamp rather than the id alone so a later reply to the
   *  same conversation earns a fresh attempt, while repeated polls carrying the same reply do
   *  not refetch the list on every tick. */
  const unknownIdsRef = useRef<Map<string, string>>(new Map());
  /** Reply stamps whose aggregate-cache reveal has already succeeded; see `mergeTimestamps`. */
  const aggregateRevealedRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    /* `useActiveJobs` does not retry: a failed poll reads as no information, not as
       every running job having finished. */
    if (activeJobIds === undefined) {
      return;
    }
    const running = new Set(activeJobIds);
    const previous = runningRef.current;
    runningRef.current = running;

    if (previous === null) {
      return;
    }

    for (const conversationId of previous) {
      if (running.has(conversationId)) {
        continue;
      }
      /* Successive jobs can keep the same conversation continuously active. A stamp delivered
         during that interval may belong to an earlier run, so only a completion fetch can
         establish the final reply. The merge leaves already-delivered stamps alone. */
      dataService
        .getConversationById(conversationId)
        .then((convo) => {
          if (!mountedRef.current) {
            return;
          }
          return mergeTimestamps(
            queryClient,
            convo,
            aggregateRevealedRef.current,
            true,
            () => mountedRef.current,
          );
        })
        .catch((error: unknown) => {
          /* Deleted while it generated is the only terminal answer. Anything else has
             consumed the one completion transition this tab will see, and with the away poll
             gated on the document being unfocused, nothing would deliver the reply's stamp
             while the user stays here; the list refetch is the same recovery the poll uses
             for an unknown id. The messages go stale first so an open conversation refetches
             the reply and the seen trigger holds until it has rendered. */
          if (!mountedRef.current || isNotFoundError(error)) {
            return;
          }
          queryClient.invalidateQueries([QueryKeys.messages, conversationId]);
          queryClient.invalidateQueries([QueryKeys.allConversations]);
        });
    }
  }, [activeJobIds, queryClient]);

  useEffect(() => {
    /* Sidebar dots are unconditional, even when every optional away alert is disabled. The
       operator's poll limit bounds the away poll only; the focused refresh reads a full server
       page, so a lowered limit cannot starve the unseen count behind a filtered list. */
    const timer = window.setInterval(() => {
      if (document.hasFocus()) {
        void refreshConversationLists(queryClient, []).catch(() => {});
      }
    }, focusedRefreshMs);
    return () => window.clearInterval(timer);
  }, [queryClient, focusedRefreshMs]);

  useEffect(() => {
    if (!notificationsEnabled && !soundEnabled && !badgeEnabled) {
      return;
    }

    let active = true;
    let generation = 0;

    const poll = async () => {
      if (document.hasFocus()) {
        return;
      }
      const requestGeneration = ++generation;
      const isCurrent = () => active && generation === requestGeneration && !document.hasFocus();
      try {
        /* The default page is the newest conversations, which is where an unseen reply always
           lands: the list sorts by `updatedAt` descending. */
        const { conversations } = await dataService.listConversations({
          limit: pollLimit,
        });
        /* Re-checked at arrival, not only at issue: the user can return while the request is
           in flight, and this fetch bypasses React Query, so the seen mutation's cancellation
           cannot reach it. A snapshot read before their focus-triggered acknowledgement
           settled carries the same reply stamp with the older catch-up, which the merge
           cannot tell from a remote mark-as-unread and would write back with the attempt
           guard suppressing the re-send. The poll serves the away features only; once the
           tab is focused the ordinary focus refetches own the cache, and the next unfocused
           tick re-reads anything a discarded snapshot carried. */
        if (!isCurrent()) {
          return;
        }
        const unknownStamps = new Map<string, string>();
        const unknownConvos: Array<Partial<TConversation>> = [];
        let hasNewlyUnknownConversation = false;

        for (const convo of conversations) {
          if (!isCurrent()) {
            return;
          }
          const { conversationId, lastResponseAt } = convo;
          if (!conversationId) {
            continue;
          }
          if (findConvoInAllQueries(queryClient, conversationId)) {
            await mergeTimestamps(
              queryClient,
              convo,
              aggregateRevealedRef.current,
              false,
              isCurrent,
            );
            continue;
          }
          /* A conversation started on another device has no row here to merge into, and hand-
             inserting one would fight the list's own ordering and pagination state, so the
             list is refetched instead. Nothing to reveal without a reply stamp. */
          if (!lastResponseAt) {
            continue;
          }
          unknownStamps.set(conversationId, lastResponseAt);
          unknownConvos.push(convo);
          if (unknownIdsRef.current.get(conversationId) !== lastResponseAt) {
            hasNewlyUnknownConversation = true;
          }
        }

        /* A conversation that dropped off the page, or that some other path has since cached,
           starts over: its next appearance here is worth an attempt again. */
        for (const conversationId of [...unknownIdsRef.current.keys()]) {
          if (!unknownStamps.has(conversationId)) {
            unknownIdsRef.current.delete(conversationId);
          }
        }

        if (!isCurrent() || !hasNewlyUnknownConversation) {
          return;
        }
        /* Attempts are recorded only once the refetch meant to reveal them has succeeded.
           Recording them first would let a transient list failure mute those conversations for
           good: every later poll would read them as already attempted and never invalidate
           again, even after the network recovered. */
        await refreshConversationLists(queryClient, [...unknownStamps.keys()], pollLimit);
        if (!isCurrent() || didListRefreshFail(queryClient)) {
          return;
        }

        for (const convo of unknownConvos) {
          if (!isCurrent()) {
            return;
          }
          const conversationId = convo.conversationId as string;
          if (findConvoInAllQueries(queryClient, conversationId)) {
            /* Revealed: merge it now rather than waiting a tick, and forget the attempt. */
            unknownIdsRef.current.delete(conversationId);
            await mergeTimestamps(
              queryClient,
              convo,
              aggregateRevealedRef.current,
              false,
              isCurrent,
            );
            continue;
          }
          /* The row moved beyond the refreshed pages. Retry a new reply stamp without
             refetching on every tick for this one; covering larger batches needs an unseen
             query rather than repeatedly widening the list. */
          unknownIdsRef.current.set(conversationId, unknownStamps.get(conversationId) as string);
        }
      } catch {
        /* Offline or a dropped connection; the next tick retries. */
      }
    };

    const timer = window.setInterval(poll, pollIntervalMs);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [notificationsEnabled, soundEnabled, badgeEnabled, pollLimit, pollIntervalMs, queryClient]);
}
