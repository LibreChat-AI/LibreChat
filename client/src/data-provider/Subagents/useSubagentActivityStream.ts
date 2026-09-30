import { useEffect, useRef } from 'react';
import { SSE } from 'sse.js';
import { useAtomValue, useSetAtom } from 'jotai';
import { useQueryClient } from '@tanstack/react-query';
import { QueryKeys, StepEvents, apiBaseUrl } from 'librechat-data-provider';
import type { SubagentUpdateEvent } from 'librechat-data-provider';
import type { ActiveSubagentPanel } from '~/components/Chat/Subagents/state';
import {
  closeParentSubagentProgress,
  reduceSubagentProgress,
  registerSubagentProgressKey,
  subagentParentStreamOpenByToolCallId,
  subagentProgressByToolCallId,
  subagentProgressKey,
} from '~/components/Chat/Subagents/state';
import { useAuthContext } from '~/hooks/AuthContext';

type ActivityEnvelope = {
  event?: unknown;
  data?: unknown;
  final?: unknown;
  subagentActivity?: unknown;
  droppedCount?: unknown;
};

const INITIAL_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 5_000;

const isSubagentUpdate = (value: unknown): value is SubagentUpdateEvent => {
  if (value == null || typeof value !== 'object') return false;
  const event = value as Partial<SubagentUpdateEvent>;
  return (
    typeof event.subagentRunId === 'string' &&
    typeof event.subagentType === 'string' &&
    (event.activityEventId == null || typeof event.activityEventId === 'string') &&
    (event.activitySequence == null ||
      (Number.isSafeInteger(event.activitySequence) && event.activitySequence >= 0)) &&
    (event.parentToolCallId == null || typeof event.parentToolCallId === 'string') &&
    typeof event.phase === 'string'
  );
};

/** Replay-then-live enhancement for the selected durable child; the durable query remains canonical. */
export default function useSubagentActivityStream(
  selection: ActiveSubagentPanel,
  enabled = true,
): void {
  const { token, isAuthenticated } = useAuthContext();
  const queryClient = useQueryClient();
  const key = subagentProgressKey(
    selection.parentMessageId,
    selection.event?.progressKey ?? selection.toolCallId,
    selection.partIndex,
  );
  const setProgress = useSetAtom(subagentProgressByToolCallId(key));
  const parentStreamOpen = useAtomValue(subagentParentStreamOpenByToolCallId(key));
  const setParentStreamOpen = useSetAtom(subagentParentStreamOpenByToolCallId(key));
  const parentStreamOpenRef = useRef(parentStreamOpen);
  const durable = selection.durable;
  const threadId = durable?.threadId;
  const taskId = durable?.taskId;

  useEffect(() => {
    parentStreamOpenRef.current = parentStreamOpen;
    if (!parentStreamOpen) {
      setProgress(closeParentSubagentProgress);
    }
  }, [parentStreamOpen, setProgress]);

  useEffect(() => {
    if (!selection.isSubmitting) return;
    registerSubagentProgressKey(key);
    parentStreamOpenRef.current = true;
    setParentStreamOpen(true);
  }, [key, selection.isSubmitting, setParentStreamOpen]);

  useEffect(() => {
    if (
      selection.host !== 'conversation' ||
      threadId == null ||
      taskId == null ||
      !enabled ||
      !isAuthenticated ||
      token == null
    ) {
      return;
    }

    const queryKey = [QueryKeys.subagentThread, selection.parentConversationId, threadId, taskId];
    const endpoint = `${apiBaseUrl()}/api/convos/${encodeURIComponent(selection.parentConversationId)}/subagents/${encodeURIComponent(threadId)}/tasks/${encodeURIComponent(taskId)}/activity`;
    let stream: SSE | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryAttempt = 0;
    let disposed = false;
    let terminal = false;
    let replayReceived = false;

    const closeCurrent = () => {
      const current = stream;
      stream = undefined;
      current?.close();
    };
    const connect = () => {
      retryTimer = undefined;
      if (disposed || terminal) return;
      const next = new SSE(endpoint, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      stream = next;

      next.addEventListener('message', (message: MessageEvent) => {
        if (stream !== next || disposed) return;
        let envelope: ActivityEnvelope;
        try {
          envelope = JSON.parse(message.data) as ActivityEnvelope;
        } catch {
          return;
        }
        if (envelope.final === true && envelope.subagentActivity === true) {
          terminal = true;
          closeCurrent();
          void queryClient.invalidateQueries(queryKey);
          return;
        }
        if (envelope.event === 'subagent_activity_replay' && Array.isArray(envelope.data)) {
          replayReceived = true;
          const replay = envelope.data as ActivityEnvelope[];
          const events = replay.flatMap((entry) =>
            entry.event === StepEvents.ON_SUBAGENT_UPDATE && isSubagentUpdate(entry.data)
              ? [entry.data]
              : [],
          );
          if (events.length === 0) return;
          registerSubagentProgressKey(key);
          setProgress((previous) => {
            /** Replace a suffix only when replay actually backfills earlier activity.
             * A later capped snapshot must not erase parts already held by the client. */
            const firstSequence = events[0].activitySequence;
            const sameRun = previous?.subagentRunId === events[0].subagentRunId;
            const addsEarlierActivity =
              previous?.firstActivitySequence != null &&
              firstSequence != null &&
              firstSequence < previous.firstActivitySequence;
            const base =
              sameRun && (previous?.coverage === 'complete' || !addsEarlierActivity)
                ? previous
                : null;
            const progress = reduceSubagentProgress(base, events, 'detached', false);
            if (progress == null) return previous;
            const droppedCount = replay.reduce((count, entry) => {
              if (
                !isSubagentUpdate(entry.data) ||
                (base?.lastActivitySequence != null &&
                  (entry.data.activitySequence ?? -1) <= base.lastActivitySequence)
              )
                return count;
              return count + (typeof entry.droppedCount === 'number' ? entry.droppedCount : 0);
            }, base?.droppedCount ?? 0);
            return { ...progress, droppedCount };
          });
          retryAttempt = 0;
          return;
        }
        const event = envelope.data;
        if (envelope.event !== StepEvents.ON_SUBAGENT_UPDATE || !isSubagentUpdate(event)) {
          return;
        }
        if (
          selection.event == null &&
          event.parentToolCallId != null &&
          event.parentToolCallId !== selection.toolCallId
        ) {
          return;
        }
        retryAttempt = 0;
        registerSubagentProgressKey(key);
        setProgress((previous) => {
          const progress = reduceSubagentProgress(
            previous,
            [event],
            'detached',
            !replayReceived && parentStreamOpenRef.current,
          );
          if (progress == null || progress === previous) return progress;
          const droppedCount =
            typeof envelope.droppedCount === 'number' &&
            (previous?.lastActivitySequence ?? -1) < (event.activitySequence ?? Infinity)
              ? envelope.droppedCount
              : 0;
          return { ...progress, droppedCount: (previous?.droppedCount ?? 0) + droppedCount };
        });
      });
      next.addEventListener('error', () => {
        if (stream !== next || disposed || terminal || retryTimer != null) return;
        closeCurrent();
        const delay = Math.min(INITIAL_RECONNECT_MS * 2 ** retryAttempt, MAX_RECONNECT_MS);
        retryAttempt += 1;
        retryTimer = setTimeout(connect, delay);
      });
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer != null) clearTimeout(retryTimer);
      closeCurrent();
    };
  }, [
    enabled,
    isAuthenticated,
    key,
    queryClient,
    selection.host,
    selection.event,
    selection.parentConversationId,
    selection.parentMessageId,
    selection.partIndex,
    selection.toolCallId,
    setProgress,
    taskId,
    threadId,
    token,
  ]);
}
