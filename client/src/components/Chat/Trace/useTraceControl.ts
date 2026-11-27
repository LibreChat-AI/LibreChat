import { useRef, useEffect, useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { useQueryClient } from '@tanstack/react-query';
import { QueryKeys, Constants, resolveTraceViewerConfig } from 'librechat-data-provider';
import type { TTraceViewerConfig } from 'librechat-data-provider';
import { keepNewestTracePage, useConversationTraceAvailabilityQuery } from '~/data-provider';
import { traceViewerConversationAtom } from './store';

export type TraceControl = {
  /** A persisted conversation of the user's with at least one readable trace. */
  show: boolean;
  open: () => void;
};

const UNPERSISTED_IDS = new Set(
  [Constants.NEW_CONVO, Constants.PENDING_CONVO, Constants.SEARCH].map(String),
);

/**
 * The trace entry point for the desktop button and the mobile overflow item, so
 * both surfaces share one visibility rule. Availability is re-read after each
 * run settles, which is when a newly sampled response can make it appear.
 */
export default function useTraceControl({
  conversationId,
  traceViewer,
  isSubmitting,
  enabled = true,
}: {
  conversationId?: string | null;
  traceViewer?: TTraceViewerConfig;
  isSubmitting: boolean;
  enabled?: boolean;
}): TraceControl {
  const setTraceConversation = useSetAtom(traceViewerConversationAtom);
  const persisted = conversationId != null && !UNPERSISTED_IDS.has(conversationId);
  const eligible = enabled && persisted && resolveTraceViewerConfig(traceViewer).enabled;

  const { data } = useConversationTraceAvailabilityQuery(conversationId ?? '', {
    enabled: eligible && !isSubmitting,
  });

  /** A settled run adds a turn to the trace, so pages cached by an earlier open go stale now
   *  rather than when their stale time lapses. */
  const queryClient = useQueryClient();
  const wasSubmitting = useRef(isSubmitting);
  useEffect(() => {
    const settled = wasSubmitting.current && !isSubmitting;
    wasSubmitting.current = isSubmitting;
    if (settled && eligible && conversationId != null) {
      keepNewestTracePage(queryClient, conversationId);
      queryClient.invalidateQueries([QueryKeys.conversationTraceRecords, conversationId]);
      queryClient.invalidateQueries([QueryKeys.conversationTraceRecord, conversationId]);
    }
  }, [isSubmitting, eligible, conversationId, queryClient]);

  const open = useCallback(() => {
    if (conversationId != null) {
      setTraceConversation(conversationId);
    }
  }, [conversationId, setTraceConversation]);

  return { show: eligible && data?.available === true, open };
}
