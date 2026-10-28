import { useEffect, useMemo, useRef } from 'react';
import { SSE } from 'sse.js';
import { atomFamily, selectAtom } from 'jotai/utils';
import { useQueryClient } from '@tanstack/react-query';
import { atom, useAtom, useAtomValue, useSetAtom } from 'jotai';
import { QueryKeys, StepEvents, apiBaseUrl } from 'librechat-data-provider';
import type { SubagentTaskContentSnapshot, SubagentUpdateEvent } from 'librechat-data-provider';
import type { ActiveSubagentPanel } from '~/components/Chat/Subagents/state';
import {
  closeParentSubagentProgress,
  reduceSubagentProgress,
  reduceSubagentReplay,
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
  ready?: unknown;
};

const contentReady = atomFamily((_key: string) => atom(false));
const readyReaders = new Map<string, number>();

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
): { isReady: boolean } {
  const { token, isAuthenticated } = useAuthContext();
  const queryClient = useQueryClient();
  const key = subagentProgressKey(
    selection.parentMessageId,
    selection.event?.progressKey ?? selection.toolCallId,
    selection.partIndex,
  );
  const readyKey = JSON.stringify([
    selection.parentConversationId,
    selection.durable?.threadId,
    selection.durable?.taskId,
  ]);
  const [isReady, setReady] = useAtom(contentReady(readyKey));
  useEffect(() => {
    readyReaders.set(readyKey, (readyReaders.get(readyKey) ?? 0) + 1);
    return () => {
      const remaining = (readyReaders.get(readyKey) ?? 1) - 1;
      if (remaining > 0) {
        readyReaders.set(readyKey, remaining);
        return;
      }
      readyReaders.delete(readyKey);
      queueMicrotask(() => {
        if (readyReaders.has(readyKey)) return;
        setReady(false);
        contentReady.remove(readyKey);
      });
    };
  }, [readyKey, setReady]);
  const replayFrom = useAtomValue(
    useMemo(
      () =>
        selectAtom(subagentProgressByToolCallId(key), (progress) => progress?.activityReplayFrom),
      [key],
    ),
  );
  const reconnectRef = useRef<(() => void) | undefined>();
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
    if (replayFrom != null && !parentStreamOpen) reconnectRef.current?.();
  }, [replayFrom, parentStreamOpen]);

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
    const contentKey = [
      QueryKeys.subagentTaskContent,
      selection.parentConversationId,
      threadId,
      taskId,
    ];
    const refreshContent = () => {
      void queryClient.invalidateQueries(contentKey, { exact: true }, { cancelRefetch: false });
    };
    if ((readyReaders.get(readyKey) ?? 0) <= 1) setReady(false);
    const endpoint = `${apiBaseUrl()}/api/convos/${encodeURIComponent(selection.parentConversationId)}/subagents/${encodeURIComponent(threadId)}/tasks/${encodeURIComponent(taskId)}/activity`;
    let stream: SSE | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryAttempt = 0;
    let disposed = false;
    let terminal = false;

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
        if (envelope.ready === true) {
          setReady(true);
          refreshContent();
          return;
        }
        if (envelope.event === 'subagent_content_available') {
          const watermark = envelope.data as
            | {
                taskId?: string;
                revision?: number;
                throughSequence?: number;
              }
            | undefined;
          if (
            watermark?.taskId === taskId &&
            Number.isSafeInteger(watermark.revision) &&
            Number.isSafeInteger(watermark.throughSequence)
          ) {
            const cached = queryClient.getQueryData<SubagentTaskContentSnapshot>(contentKey);
            if (
              cached == null ||
              cached.revision < watermark.revision! ||
              cached.throughSequence < watermark.throughSequence!
            )
              refreshContent();
          }
          return;
        }
        if (envelope.final === true && envelope.subagentActivity === true) {
          setReady(true);
          refreshContent();
          terminal = true;
          closeCurrent();
          void queryClient.invalidateQueries(queryKey);
          return;
        }
        if (envelope.event === 'subagent_activity_replay' && Array.isArray(envelope.data)) {
          const replay = envelope.data as ActivityEnvelope[];
          const events = replay.flatMap((entry) =>
            entry.event === StepEvents.ON_SUBAGENT_UPDATE && isSubagentUpdate(entry.data)
              ? [
                  {
                    ...entry.data,
                    activityDroppedCount:
                      Number.isSafeInteger(entry.droppedCount) && (entry.droppedCount as number) > 0
                        ? (entry.droppedCount as number)
                        : undefined,
                  },
                ]
              : [],
          );
          registerSubagentProgressKey(key);
          setProgress((previous) =>
            reduceSubagentReplay(previous, events, parentStreamOpenRef.current),
          );
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
        setProgress((previous) =>
          reduceSubagentProgress(
            previous,
            [
              {
                ...event,
                activityDroppedCount:
                  Number.isSafeInteger(envelope.droppedCount) &&
                  (envelope.droppedCount as number) > 0
                    ? (envelope.droppedCount as number)
                    : undefined,
              },
            ],
            'detached',
            parentStreamOpenRef.current || previous?.activityReplayFrom != null,
          ),
        );
      });
      next.addEventListener('error', () => {
        if (stream !== next) return;
        setReady(true);
        refreshContent();
        reconnect();
      });
    };

    const reconnect = () => {
      if (disposed || terminal || retryTimer != null) return;
      closeCurrent();
      const delay = Math.min(INITIAL_RECONNECT_MS * 2 ** retryAttempt, MAX_RECONNECT_MS);
      retryAttempt += 1;
      retryTimer = setTimeout(connect, delay);
    };
    reconnectRef.current = reconnect;
    connect();
    return () => {
      if (reconnectRef.current === reconnect) reconnectRef.current = undefined;
      disposed = true;
      if (retryTimer != null) clearTimeout(retryTimer);
      closeCurrent();
    };
  }, [
    enabled,
    isAuthenticated,
    key,
    queryClient,
    readyKey,
    selection.host,
    selection.event,
    selection.parentConversationId,
    selection.parentMessageId,
    selection.partIndex,
    selection.toolCallId,
    setProgress,
    setReady,
    taskId,
    threadId,
    token,
  ]);
  return { isReady };
}
