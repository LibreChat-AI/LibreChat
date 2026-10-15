import { useRef, useEffect } from 'react';
import { useAtom } from 'jotai';
import { useQueryClient } from '@tanstack/react-query';
import { Constants, QueryKeys } from 'librechat-data-provider';
import type { TSubmission } from 'librechat-data-provider';
import type { MutableRefObject } from 'react';
import type { OwedSuccessorState } from './useOwedSuccessor';
import { resumeRequestsAtom } from '~/hooks/Chat/resume';
import { streamStatusQueryKey } from '~/data-provider';

/**
 * Matches the active-job list's own poll interval: answering an announcement
 * faster than the list can change it would only re-read the same snapshot.
 */
const ACTIVE_JOB_REARM_INTERVAL_MS = 5_000;

/**
 * Re-arms the resume check when a run this pane did not start is announced (the active-job
 * list, an owed queued turn) or when `resumeStream` asks for it, forcing the status and
 * history reads it is about to make fresh first.
 */
export default function useResumeAnnouncements({
  conversationId,
  resumableEnabled,
  owed,
  processedConvoRef,
  answeredActiveJobRef,
  setExternalRunArm,
  setSubmission,
  routeConversationLoaded,
  hasActiveSubmissionForThisConvo,
  hasLiveSubmissionForThisConvo,
  attachedGenerationCreatedAt,
}: {
  conversationId: string | undefined;
  resumableEnabled: boolean;
  owed: OwedSuccessorState;
  processedConvoRef: MutableRefObject<string | null>;
  answeredActiveJobRef: MutableRefObject<{ conversationId: string; at: number } | null>;
  setExternalRunArm: (update: (arm: number) => number) => void;
  setSubmission: (submission: TSubmission | null) => void;
  routeConversationLoaded: boolean;
  hasActiveSubmissionForThisConvo: boolean;
  hasLiveSubmissionForThisConvo: boolean;
  attachedGenerationCreatedAt: number | null;
}): void {
  const queryClient = useQueryClient();
  const { successorOwed, hasActiveJobForThisConvo, activeJobsUpdatedAt, receiptSignature } = owed;
  /** Receipt state at the last arm, so history is refetched on a transition
   *  rather than on every heartbeat of an unchanged queued turn. */
  const lastArmedReceiptSignatureRef = useRef<string | null>(null);

  /**
   * Answer an active-job announcement for the conversation on screen.
   *
   * The announcement means "your history may have moved", not merely "re-open
   * the status query", so both reads this pane is about to make are forced
   * fresh first. Toggling `enabled` alone would not do it: an inactive status
   * answered less than `staleTime` ago is still fresh, and React Query would
   * hand back that cached "nothing running" and let the effect above record the
   * announcement as handled without ever attaching.
   *
   * History is invalidated for the same reason, and it matters whichever way
   * the status read lands. An external client may have completed whole turns
   * this pane never saw before starting the one now running: the resume
   * submission and `finalHandler` both build on this snapshot, so attaching
   * without it grafts the live turn onto a hole. And when the run turns out to
   * have already finished, the refetch is the entire repair: the messages
   * query disables refetch on focus, mount and reconnect, so nothing else would
   * ever collect those turns. The refetch also re-gates `messagesLoaded`, which
   * defers the effect above until the authoritative history has landed.
   */
  /**
   * Two announcement sources, one arm. The active-job list is the general one.
   * An owed queued turn is the specific one, and it must be able to arm on its
   * own: the run it announces can start and finish between two list polls, and
   * the status read this arm enables is the authoritative answer either way:
   * active attaches, inactive means the history refetch below is the repair.
   */
  const successorAnnounced = hasActiveJobForThisConvo || successorOwed;
  useEffect(() => {
    if (!successorAnnounced) {
      answeredActiveJobRef.current = null;
      return;
    }
    if (!resumableEnabled || !conversationId || hasLiveSubmissionForThisConvo) {
      return;
    }

    const answered = answeredActiveJobRef.current;
    const now = Date.now();
    if (
      answered != null &&
      answered.conversationId === conversationId &&
      now - answered.at < ACTIVE_JOB_REARM_INTERVAL_MS
    ) {
      return;
    }
    answeredActiveJobRef.current = { conversationId, at: now };

    console.log('[ResumeOnLoad] Active job announced without an attachment', { conversationId });
    /**
     * A finished submission still installed here is the one thing standing
     * between this announcement and the attachment: it is what the check below
     * reads as "already attached", and what disables the status query. The run
     * it describes is over, so release it; a server-side continuation such as
     * a background tool dispatch finishing is a different generation, and the
     * resume path is what owns building the submission for it.
     */
    if (hasActiveSubmissionForThisConvo) {
      setSubmission(null);
    }
    queryClient.invalidateQueries({ queryKey: streamStatusQueryKey(conversationId) });
    /**
     * History is refetched only when this arm can actually change what the
     * pane shows: a run is listed (attachment is imminent and must not be
     * grafted onto a stale snapshot), or the receipts just transitioned (the
     * turn was admitted, or dropped after finishing inside a poll gap). A
     * long wait behind an unadmitted turn re-arms status on the heartbeat but
     * must not download the conversation again each time.
     */
    const receiptsTransitioned = lastArmedReceiptSignatureRef.current !== receiptSignature;
    lastArmedReceiptSignatureRef.current = receiptSignature;
    if (hasActiveJobForThisConvo || receiptsTransitioned) {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.messages, conversationId] });
    }
    processedConvoRef.current = null;
    setExternalRunArm((arm) => arm + 1);
  }, [
    conversationId,
    resumableEnabled,
    successorAnnounced,
    hasActiveJobForThisConvo,
    hasActiveSubmissionForThisConvo,
    hasLiveSubmissionForThisConvo,
    attachedGenerationCreatedAt,
    activeJobsUpdatedAt,
    receiptSignature,
    setSubmission,
    queryClient,
    processedConvoRef,
    answeredActiveJobRef,
    setExternalRunArm,
  ]);

  /**
   * An explicit `resumeStream` request takes the announcement's path: the
   * status read decides whether anything is running, and the effect above
   * builds the resume submission that `useResumableSSE` attaches through the
   * host transport. The request is consumed either way: one made while this
   * pane is already attached is answered by that attachment.
   */
  const [resumeRequests, setResumeRequests] = useAtom(resumeRequestsAtom);
  const resumeRequested = !!conversationId && resumeRequests.has(conversationId);
  useEffect(() => {
    if (!resumeRequested || !conversationId || !routeConversationLoaded) {
      return;
    }
    setResumeRequests((pending) => {
      const next = new Set(pending);
      next.delete(conversationId);
      return next;
    });
    if (!resumableEnabled || conversationId === Constants.NEW_CONVO) {
      return;
    }
    if (hasLiveSubmissionForThisConvo) {
      return;
    }
    /** A finished submission still installed reads as attached to the check above. */
    if (hasActiveSubmissionForThisConvo) {
      setSubmission(null);
    }
    queryClient.invalidateQueries({ queryKey: streamStatusQueryKey(conversationId) });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.messages, conversationId] });
    processedConvoRef.current = null;
    setExternalRunArm((arm) => arm + 1);
  }, [
    conversationId,
    resumeRequested,
    routeConversationLoaded,
    setResumeRequests,
    resumableEnabled,
    hasActiveSubmissionForThisConvo,
    hasLiveSubmissionForThisConvo,
    setSubmission,
    queryClient,
    processedConvoRef,
    setExternalRunArm,
  ]);
}
