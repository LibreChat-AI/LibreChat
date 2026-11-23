import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useStore, useAtomValue, useSetAtom } from 'jotai';
import { Constants, QueryKeys } from 'librechat-data-provider';
import { deriveTokenUsageView, pendingToBranchUsage } from '@librechat/chat';
import type { TMessage, TConversation } from 'librechat-data-provider';
import type { TokenUsageView } from '@librechat/chat';
import {
  liveTokensFamily,
  totalUsageFamily,
  removeUsageAtoms,
  hydrateSnapshots,
  pendingUsageFamily,
  activeUsageResponseIdFamily,
  subagentUsageFamily,
  pendingSubagentUsageFamily,
  branchTotalsFamily,
  overheadKey,
  getModelOverhead,
  contextSnapshotFamily,
  snapshotsByAnchorFamily,
} from '~/components/Chat/Input/TokenUsage/store';
import {
  buildIndex,
  upsertEntries,
  sumBranch,
  clearIndex,
  mergeUsage,
  sumTotalUsage,
  findBranchSnapshotAnchor,
} from '~/utils';
import { useLatestMessageId } from '~/hooks/Messages/useLatestMessage';
import useTokenLimits from './useTokenLimits';

export type { TokenUsageView };

export interface TokenUsageParams {
  index: number;
  conversation: TConversation | null;
  isSubmitting: boolean;
}

/**
 * View-model for the context usage indicator. Mount only inside the
 * indicator so its subscriptions never re-render the chat tree.
 */
export default function useTokenUsage({
  index,
  conversation,
  isSubmitting,
}: TokenUsageParams): TokenUsageView {
  const queryClient = useQueryClient();
  const usageStore = useStore();
  const conversationKey = conversation?.conversationId ?? Constants.NEW_CONVO;

  const tailId = useLatestMessageId(index);
  const snapshot = useAtomValue(contextSnapshotFamily(conversationKey));
  const snapshotsByAnchor = useAtomValue(snapshotsByAnchorFamily(conversationKey));
  const pendingUsage = useAtomValue(pendingUsageFamily(conversationKey));
  const activeResponseId = useAtomValue(activeUsageResponseIdFamily(conversationKey));
  const turnInProgress = isSubmitting && activeResponseId != null && activeResponseId === tailId;
  const totalUsageBase = useAtomValue(totalUsageFamily(conversationKey));
  const storedBranchTotals = useAtomValue(branchTotalsFamily(conversationKey));
  /** A terminal stream writer updates the shared rollup for its own response.
   * Project a different viewed tail locally, without writing it back and making
   * two views of the same conversation compete over the shared atom. */
  const branchTotals = useMemo(
    () =>
      storedBranchTotals.tailId === tailId
        ? storedBranchTotals
        : sumBranch(conversationKey, tailId, snapshot?.anchorMessageId),
    [storedBranchTotals, conversationKey, tailId, snapshot?.anchorMessageId],
  );
  const liveTokens = useAtomValue(liveTokensFamily(conversationKey));
  const committedSubagentUsage = useAtomValue(subagentUsageFamily(conversationKey));
  const pendingSubagentUsage = useAtomValue(pendingSubagentUsageFamily(conversationKey));
  const setBranchTotals = useSetAtom(branchTotalsFamily(conversationKey));
  const setTotalUsage = useSetAtom(totalUsageFamily(conversationKey));
  const limits = useTokenLimits(conversation);

  /** Deepest persisted/live snapshot on the viewed branch (present only for
   *  turns generated with the feature on). Gates the projection fetch and is a
   *  render source. */
  const branchSnapshot = useMemo(() => {
    if (snapshotsByAnchor.size === 0) {
      return null;
    }
    const anchor = findBranchSnapshotAnchor(
      conversationKey,
      branchTotals.tailId,
      snapshotsByAnchor,
    );
    return anchor != null ? (snapshotsByAnchor.get(anchor) ?? null) : null;
  }, [conversationKey, branchTotals.tailId, snapshotsByAnchor]);

  /** Branch/total provider usage is index-derived; the in-flight response is
   *  the only live add (the pending holder), counted into both, it sits on the
   *  active branch tail and inside the conversation. The backend prices each
   *  call (premium tiers, cache rates), so cost sums authoritatively. */
  const pendingAsUsage = useMemo(() => pendingToBranchUsage(pendingUsage), [pendingUsage]);
  const branchUsage = useMemo(
    () => (turnInProgress ? mergeUsage(branchTotals.usage, pendingAsUsage) : branchTotals.usage),
    [branchTotals.usage, pendingAsUsage, turnInProgress],
  );
  const totalUsage = useMemo(
    () => mergeUsage(totalUsageBase, pendingAsUsage),
    [totalUsageBase, pendingAsUsage],
  );
  /** The subagent figure mirrors that split: what earlier runs committed plus
   *  the in-flight run's share, which settles or is discarded with the pending
   *  usage it sits inside. */
  const subagentUsage = useMemo(
    () => mergeUsage(committedSubagentUsage, pendingSubagentUsage),
    [committedSubagentUsage, pendingSubagentUsage],
  );
  /** Do not show the previous response as the current turn during a submission.
   * Pending contains only provider-confirmed completed calls, not text estimates. */
  let lastTurnUsage = branchTotals.lastTurnUsage;
  if (turnInProgress) {
    lastTurnUsage = pendingUsage.eventCount > 0 ? pendingAsUsage : undefined;
  }
  const hasUsage =
    branchUsage.input + branchUsage.output + branchUsage.cacheRead + branchUsage.cacheWrite > 0;

  const indexedCache = useRef<{ conversationKey: string; messages: TMessage[] | undefined }>();

  /** The messages cache is authoritative once a run settles. Stream deltas do
   * not rebuild the index, but idle transitions MUST catch up even when the
   * recovered message has the same id (404/retry-ceiling recovery has no FINAL).
   * All refresh triggers use this one projection, not separate writer paths. */
  useEffect(() => {
    const queryKey = [QueryKeys.messages, conversationKey];
    const reconcile = () => {
      const messages = queryClient.getQueryData<TMessage[]>(queryKey);
      if (
        indexedCache.current?.conversationKey !== conversationKey ||
        messages !== indexedCache.current.messages
      ) {
        /** Regeneration temporarily removes the old response and descendants
         * from the cache. A streaming projection is not a history deletion. */
        if (isSubmitting || usageStore.get(activeUsageResponseIdFamily(conversationKey)) != null) {
          upsertEntries(conversationKey, messages ?? []);
        } else {
          buildIndex(conversationKey, messages);
        }
        hydrateSnapshots(conversationKey, messages);
        indexedCache.current = { conversationKey, messages };
      }
      setBranchTotals(sumBranch(conversationKey, tailId, snapshot?.anchorMessageId));
      setTotalUsage(sumTotalUsage(conversationKey));
    };
    reconcile();
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      /** ask() binds before changing the cache. Read that atom synchronously:
       * this callback can run before React renders isSubmitting=true. */
      if (
        isSubmitting ||
        usageStore.get(activeUsageResponseIdFamily(conversationKey)) != null ||
        event.type !== 'updated'
      ) {
        return;
      }
      const key = event.query.queryKey;
      if (key[0] !== QueryKeys.messages || key[1] !== conversationKey) {
        return;
      }
      const messages = event.query.state.data as TMessage[] | undefined;
      if (messages !== indexedCache.current?.messages) {
        reconcile();
      }
    });
    return unsubscribe;
  }, [
    conversationKey,
    tailId,
    snapshot?.anchorMessageId,
    isSubmitting,
    queryClient,
    usageStore,
    setBranchTotals,
    setTotalUsage,
  ]);

  /** Lifetime cleanup is independent of projection refreshes. A branch change
   * or stream completion must not discard sticky usage or replay dedup keys. */
  useEffect(
    () => () => {
      if (indexedCache.current?.conversationKey === conversationKey) {
        indexedCache.current = undefined;
      }
      /** The unsaved conversation is migrated by finalizeUsage. Route changes
       * can unmount this view before that handoff, so leave its state intact. */
      if (conversationKey !== Constants.NEW_CONVO) {
        clearIndex(conversationKey);
        removeUsageAtoms(conversationKey);
      }
    },
    [conversationKey],
  );

  return useMemo(
    () =>
      deriveTokenUsageView({
        snapshot,
        isSubmitting,
        turnInProgress,
        activeResponseId,
        branchTotals,
        branchUsage,
        totalUsage,
        lastTurnUsage,
        hasUsage,
        liveTokens,
        limits,
        branchSnapshot,
        snapshotsByAnchor,
        subagentUsage,
        conversationKey,
        modelOverhead: getModelOverhead(
          overheadKey(
            limits.endpoint ?? conversation?.endpoint,
            limits.model ?? conversation?.model,
            conversation?.agent_id,
          ),
        ),
      }),
    [
      snapshot,
      isSubmitting,
      turnInProgress,
      activeResponseId,
      branchTotals,
      branchUsage,
      totalUsage,
      lastTurnUsage,
      hasUsage,
      liveTokens,
      limits,
      branchSnapshot,
      snapshotsByAnchor,
      subagentUsage,
      conversationKey,
      conversation,
    ],
  );
}
