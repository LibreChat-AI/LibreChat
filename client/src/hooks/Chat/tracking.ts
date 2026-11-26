import { useCallback } from 'react';
import { v4 as uuid } from 'uuid';
import { productTrackingContextSchema } from 'librechat-data-provider';
import type { ChatSubmissionKind, TSubmission } from 'librechat-data-provider';
import { useProductTracking, useProductTrackingContext } from '~/Providers/TrackingContext';

/** Records the explicit submission once; reconnects and HTTP retries retain its context. */
export default function useChatProductTracking() {
  const track = useProductTracking();
  const getContext = useProductTrackingContext();
  return useCallback(
    (submission: TSubmission, kind: ChatSubmissionKind) => {
      const context = getContext();
      if (!context) return undefined;
      const supplied = productTrackingContextSchema.safeParse({
        submissionId: submission.clientRequestId,
      });
      const submissionId = (supplied.success && supplied.data.submissionId) || uuid();
      const trackingContext = { ...context, submissionId };
      track(
        {
          name: 'librechat.chat.message.submitted',
          feature: 'chat',
          submissionId,
          kind,
          conversationId: submission.userMessage.conversationId ?? undefined,
          agentId: submission.conversation.agent_id ?? undefined,
          model: submission.conversation.model ?? undefined,
        },
        trackingContext,
      );
      return trackingContext;
    },
    [track, getContext],
  );
}

/** A failed start says nothing about whether an unconfirmed request ran on the server. */
export function useProductSubmissionFailure() {
  const track = useProductTracking();
  return useCallback(
    (submission: TSubmission, reason: 'rejected' | 'unconfirmed') => {
      const context = submission.productTrackingContext;
      if (!context?.submissionId) return;
      track(
        {
          name: 'librechat.chat.submission.failed',
          feature: 'chat',
          submissionId: context.submissionId,
          reason,
          conversationId: submission.userMessage.conversationId ?? undefined,
          agentId: submission.conversation.agent_id ?? undefined,
          model: submission.conversation.model ?? undefined,
        },
        context,
      );
    },
    [track],
  );
}
