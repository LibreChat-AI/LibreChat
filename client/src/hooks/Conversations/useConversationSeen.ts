import { useRef, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Constants, QueryKeys } from 'librechat-data-provider';
import {
  findConvoInAllQueries,
  hasLocallyCommittedReply,
  hasServerFetchedReply,
  isConversationUnseen,
} from '~/utils';
import { consumeFocusSuppression } from './notificationNavigation';
import { useMarkConversationSeenMutation } from '~/data-provider';

/**
 * Records that the user has caught up with a conversation's newest message.
 *
 * "Seen" deliberately means the newest message reached the viewport while the tab was focused,
 * not merely that the route is open, so a backgrounded tab restoring on reload does not silently
 * clear every indicator.
 *
 * Five events can satisfy those conditions, and all five are already available without polling:
 * the messages-end intersection flipping, a response finishing while the user sits at the bottom,
 * the window regaining focus on a conversation left open, the list cache itself reporting the
 * conversation (a direct-URL open fires the initial intersection before the list query resolves),
 * and the messages query settling a revalidation (a warm-cache open reports the bottom of the
 * old tree before the reply it is acknowledging has rendered). Each one re-checks imperatively
 * against the cached list rather than subscribing to it, which keeps the check off the render
 * path.
 *
 * The unseen check is also the cost guard: re-reading a conversation already caught up sends
 * nothing.
 */
export default function useConversationSeen(
  conversationId: string | undefined,
  isSubmitting: boolean,
  measureNearBottom?: () => boolean | null,
  isResponseRendered?: (messageId: string) => boolean,
) {
  const queryClient = useQueryClient();
  const { mutate: markSeen } = useMarkConversationSeenMutation();
  const isNearBottomRef = useRef(false);
  /** Read from the deferred revalidation check, which outlives the render that created it. */
  const measureRef = useRef(measureNearBottom);
  measureRef.current = measureNearBottom;
  const pendingFrameRef = useRef<number | null>(null);
  /** The list stamp observed when the current messages fetch began. A later stamp must not be
   * credited by that fetch merely because it arrived before the success notification. */
  const fetchStartStampRef = useRef<Map<string, string | undefined>>(new Map());
  /** A list stamp can arrive after a successful, but stale, messages query. Keep one
   * revalidation in flight per stamp rather than starting another request for every cache event. */
  const requestedMessagesRef = useRef<Map<string, string>>(new Map());
  /** Set only after the messages success event has had two frames to commit and paint. */
  const renderedMessagesRef = useRef<Map<string, string>>(new Map());
  /** The last reply each conversation was acknowledged for. A failed write rolls the cache
   * back to unseen, which is itself a cache event this hook listens to, so without this the
   * rejection would immediately re-arm the trigger and spin requests for as long as the
   * network keeps refusing them. Re-armed by a genuinely newer reply, or by refocusing. */
  const attemptedRef = useRef<Map<string, string | undefined>>(new Map());
  const markSeenRef = useRef<() => void>(() => undefined);
  const isResponseRenderedRef = useRef(isResponseRendered);
  isResponseRenderedRef.current = isResponseRendered;
  /** Proof that the stamped reply is the one on screen. The active MessagesView scopes the
   * lookup to its rendered tree; the document fallback keeps the hook usable for callers that
   * own no content ref, while still requiring the row's committed body rather than a
   * progressive placeholder.
   *
   * Manual markers name no message, and a row stamped before reply identity existed cannot be
   * bound to a branch either; both fall back to the history-fetch proof rather than stranding a
   * dot no acknowledgement could ever clear. */
  const replyBranchIsVisible = useCallback(
    (convo: { lastResponseIsManual?: boolean; lastResponseMessageId?: string } | undefined) => {
      const messageId = convo?.lastResponseMessageId;
      if (convo?.lastResponseIsManual === true || !messageId) {
        return true;
      }
      if (isResponseRenderedRef.current) {
        return isResponseRenderedRef.current(messageId);
      }
      const body = document
        .getElementById(messageId)
        ?.querySelector('[data-testid="message-body"]');
      return (
        body != null && (body.childElementCount > 0 || (body.textContent?.trim().length ?? 0) > 0)
      );
    },
    [],
  );

  const scheduleRenderedCheck = useCallback(
    (expectedStamp: string | undefined, proofSource?: 'local' | 'server') => {
      if (!conversationId) {
        return;
      }
      if (pendingFrameRef.current != null) {
        window.cancelAnimationFrame(pendingFrameRef.current);
      }
      pendingFrameRef.current = window.requestAnimationFrame(() => {
        pendingFrameRef.current = window.requestAnimationFrame(() => {
          pendingFrameRef.current = null;
          const cached = findConvoInAllQueries(queryClient, conversationId);
          const messagesState = queryClient.getQueryState([QueryKeys.messages, conversationId]);
          const messagesReady =
            messagesState?.status === 'success' && messagesState.fetchStatus === 'idle';
          const proofStillHolds =
            expectedStamp != null &&
            ((proofSource === 'local' &&
              hasLocallyCommittedReply(queryClient, conversationId, expectedStamp)) ||
              (proofSource === 'server' &&
                hasServerFetchedReply(queryClient, conversationId, expectedStamp)));
          const responseIsRendered = replyBranchIsVisible(cached);
          if (
            expectedStamp != null &&
            messagesReady &&
            cached?.lastResponseAt === expectedStamp &&
            isConversationUnseen(cached) &&
            responseIsRendered &&
            (proofSource == null ? true : cached.lastResponseIsManual !== true && proofStillHolds)
          ) {
            renderedMessagesRef.current.set(conversationId, expectedStamp);
          }
          const measured = measureRef.current?.() ?? null;
          if (measured != null) {
            isNearBottomRef.current = measured;
          }
          markSeenRef.current();
        });
      });
    },
    [conversationId, queryClient, replyBranchIsVisible],
  );

  const markSeenIfCaughtUp = useCallback(
    (retryMessages = false) => {
      if (!conversationId || conversationId === Constants.NEW_CONVO) {
        return;
      }
      if (!isNearBottomRef.current || !document.hasFocus()) {
        return;
      }
      const cached = findConvoInAllQueries(queryClient, conversationId);
      if (!isConversationUnseen(cached)) {
        return;
      }
      const { lastResponseAt } = cached ?? {};
      if (!lastResponseAt) {
        return;
      }

      /* A list/point cache can resolve before the active messages query mounts, or after its
       * cached tree has gone stale. Neither case proves that the reply was rendered. Every real
       * reply therefore waits for a successful messages fetch and its post-render measurement. */
      const messagesKey = [QueryKeys.messages, conversationId];
      const messagesQueryState = queryClient.getQueryState(messagesKey);
      if (messagesQueryState == null) {
        return;
      }
      if (messagesQueryState.status === 'error') {
        if (retryMessages && requestedMessagesRef.current.get(conversationId) !== lastResponseAt) {
          requestedMessagesRef.current.set(conversationId, lastResponseAt);
          void queryClient.invalidateQueries(messagesKey).catch(() => undefined);
        }
        return;
      }
      if (messagesQueryState.fetchStatus !== 'idle') {
        return;
      }

      const renderedStamp = renderedMessagesRef.current.get(conversationId);
      const isManualMarker = cached?.lastResponseIsManual === true;
      const hasLocalProof = hasLocallyCommittedReply(queryClient, conversationId, lastResponseAt);
      const hasServerProof = hasServerFetchedReply(queryClient, conversationId, lastResponseAt);
      if (!isManualMarker && (hasLocalProof || hasServerProof) && !replyBranchIsVisible(cached)) {
        /* A stamped history cache can still describe a hidden sibling branch, or a progressive
         * row whose body has not committed. Neither is safe to acknowledge and neither should
         * trigger a second history request. */
        return;
      }
      if (isManualMarker && renderedStamp !== lastResponseAt) {
        /* Synthetic markers carry no message identity. The successful active history query and
         * the two-frame render gate are the route/scroll proof for these list-only events. */
        scheduleRenderedCheck(lastResponseAt);
        return;
      }
      if (
        renderedStamp !== lastResponseAt &&
        !isManualMarker &&
        (hasLocalProof || hasServerProof)
      ) {
        /* A terminal SSE event or a server fetch paired this exact cache object with the reply.
         * It is proof only after the same two-frame commit/paint delay as a fetch. */
        scheduleRenderedCheck(lastResponseAt, hasLocalProof ? 'local' : 'server');
        return;
      }

      if (renderedStamp !== lastResponseAt) {
        if (isManualMarker) {
          return;
        }
        if (requestedMessagesRef.current.get(conversationId) === lastResponseAt) {
          /* The requested fetch succeeded, but its cache event has not painted yet. */
          return;
        }
        requestedMessagesRef.current.set(conversationId, lastResponseAt);
        void queryClient.invalidateQueries(messagesKey).catch(() => undefined);
        return;
      }

      if (
        attemptedRef.current.has(conversationId) &&
        attemptedRef.current.get(conversationId) === lastResponseAt
      ) {
        return;
      }
      attemptedRef.current.set(conversationId, lastResponseAt);
      /* Names the reply that is actually on screen: the server acknowledges that one and no
       * newer, so a reply persisted from another device mid-request stays unseen. */
      markSeen({ conversationId, lastResponseAt });
    },
    [conversationId, queryClient, markSeen, scheduleRenderedCheck, replyBranchIsVisible],
  );

  markSeenRef.current = markSeenIfCaughtUp;

  /** Refocusing is a deliberate return to the conversation, and a human-paced one, so it is
   *  the right moment to let a write or message refresh that failed while offline try again. */
  const retryOnFocus = useCallback(() => {
    if (consumeFocusSuppression()) {
      return;
    }
    attemptedRef.current.clear();
    if (conversationId) {
      requestedMessagesRef.current.delete(conversationId);
      fetchStartStampRef.current.delete(conversationId);
    }
    markSeenIfCaughtUp(true);
  }, [conversationId, markSeenIfCaughtUp]);

  /** Stable across renders so the memoized scroll observer is not torn down on every check. */
  const reportNearBottom = useCallback(
    (isNearBottom: boolean) => {
      isNearBottomRef.current = isNearBottom;
      markSeenIfCaughtUp();
    },
    [markSeenIfCaughtUp],
  );

  /* A fresh conversation's scroll position is unknown until its observer reports; inheriting
   * "near bottom" from the previous conversation would mark it seen sight unseen.
   * Arriving also re-arms the attempt guard for this conversation: leaving and coming back is
   * a deliberate, human-paced return, the same reason refocusing re-arms it, and the hook
   * outlives the route so a write that failed here would otherwise stay suppressed. */
  useEffect(() => {
    isNearBottomRef.current = false;
    if (conversationId) {
      attemptedRef.current.delete(conversationId);
      requestedMessagesRef.current.delete(conversationId);
      fetchStartStampRef.current.delete(conversationId);
      renderedMessagesRef.current.delete(conversationId);
    }
  }, [conversationId]);

  useEffect(() => {
    if (isSubmitting) {
      return;
    }
    markSeenIfCaughtUp();
  }, [isSubmitting, markSeenIfCaughtUp]);

  useEffect(() => {
    window.addEventListener('focus', retryOnFocus);
    return () => window.removeEventListener('focus', retryOnFocus);
  }, [retryOnFocus]);

  useEffect(() => {
    if (!conversationId || conversationId === Constants.NEW_CONVO) {
      return;
    }
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      /* Every root the lookup reads. An old pin lives only in the pinned cache, and a
       * conversation opened by URL can be in neither list, resolving into its own point query
       * after the messages have already reported the bottom; that arrival is then the last
       * trigger left to notice the conversation at all. */
      const root = event?.query?.queryKey?.[0];
      /* Only a messages fetch belonging to this conversation can establish that its reply
       * rendered. Streamed tokens also land in this cache, but through `setQueryData`, which
       * marks its success action manual; re-checking on each of those would scan the lists once
       * per token. */
      if (root === QueryKeys.messages) {
        const messageConversationId = event?.query?.queryKey?.[1];
        if (messageConversationId !== conversationId || event.type !== 'updated') {
          return;
        }
        if (event.action.type === 'fetch') {
          fetchStartStampRef.current.set(
            conversationId,
            findConvoInAllQueries(queryClient, conversationId)?.lastResponseAt,
          );
          return;
        }
        if (event.action.type !== 'success' || event.action.manual) {
          return;
        }
        const stampAtFetchStart = fetchStartStampRef.current.get(conversationId);
        /* Capture the stamp from fetch start, not success: a newer reply can reach the list while
         * this request is in flight, and that reply was not part of the fetched/rendered tree. */
        scheduleRenderedCheck(stampAtFetchStart);
        return;
      }
      if (
        root !== QueryKeys.allConversations &&
        root !== QueryKeys.pinnedConversations &&
        root !== QueryKeys.conversation
      ) {
        return;
      }
      markSeenIfCaughtUp(true);
    });
    return () => {
      unsubscribe();
      if (pendingFrameRef.current != null) {
        window.cancelAnimationFrame(pendingFrameRef.current);
        pendingFrameRef.current = null;
      }
    };
  }, [conversationId, queryClient, markSeenIfCaughtUp, scheduleRenderedCheck]);

  return reportNearBottom;
}
