import { useEffect, useMemo, useRef } from 'react';
import { atomFamily, selectAtom } from 'jotai/utils';
import { useQueryClient } from '@tanstack/react-query';
import { atom, useAtom, useAtomValue, useSetAtom } from 'jotai';
import { QueryKeys, StepEvents, apiBaseUrl } from 'librechat-data-provider';
import type {
  ChatEvent,
  SubagentUpdateEvent,
  SubagentTaskContentSnapshot,
} from 'librechat-data-provider';
import type { ActiveSubagentPanel } from './state';
import {
  closeParentSubagentProgress,
  reduceSubagentProgress,
  reduceSubagentReplay,
  registerSubagentProgressKey,
  subagentParentStreamOpenByToolCallId,
  subagentProgressByToolCallId,
  subagentProgressKey,
} from './state';
import { useStreamHost } from '../stream/host';

type ActivityEnvelope = {
  event?: unknown;
  data?: unknown;
  final?: unknown;
  subagentActivity?: unknown;
  droppedCount?: unknown;
};

const contentReady = atomFamily((_key: string) => atom(false));
const readyReaders = new Map<string, number>();

const INITIAL_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 5_000;
/** Reconnects in a row that deliver no live update before the feed gives up; the durable
 *  thread query keeps polling, so the panel still converges on the stored transcript.
 *  Internal retry hygiene with that fallback, not an operator lever, so not in configSchema. */
const MAX_IDLE_RECONNECTS = 8;
/** A child opened before its thread is reserved answers 404 until preparation finishes; the
 *  durable thread query treats that as pending for the same window, so the feed does too. */
const CHILD_READY_WINDOW_MS = 60_000;

/** A refusal no retry can clear: the task is gone or not the viewer's. 401 arrives here only
 *  after the transport's own refresh failed; 408 and 429 are worth retrying. */
const isRefusal = (status?: number): boolean =>
  status != null && status >= 400 && status < 500 && status !== 408 && status !== 429;

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

/**
 * Replay-then-live enhancement for the selected durable child; the durable query remains
 * canonical. The feed attaches through the host's transport, which owns the connection,
 * framing and token refresh.
 */
export function useSubagentActivityStream(
  selection: ActiveSubagentPanel,
  enabled = true,
): { isReady: boolean } {
  const transport = useStreamHost().useTransport();
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
      transport == null
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
    let stream: AbortController | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryAttempt = 0;
    let idleReconnects = 0;
    const readinessDeadline = Date.now() + CHILD_READY_WINDOW_MS;
    let disposed = false;
    let terminal = false;

    const closeCurrent = () => {
      const current = stream;
      stream = undefined;
      current?.abort();
    };
    const connect = () => {
      retryTimer = undefined;
      if (disposed || terminal) return;
      const next = new AbortController();
      stream = next;

      const onEvent = (event: ChatEvent) => {
        if (stream !== next || disposed) return;
        if (event.type === 'error') {
          setReady(true);
          refreshContent();
          if (event.status === 404 && Date.now() < readinessDeadline) {
            reconnect(true);
            return;
          }
          if (isRefusal(event.status)) {
            terminal = true;
            closeCurrent();
            return;
          }
          reconnect();
          return;
        }
        if (event.type === 'ready') {
          setReady(true);
          refreshContent();
          return;
        }
        if (event.type !== 'step' && event.type !== 'final') return;
        const envelope: ActivityEnvelope = event.data;
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
        const update = envelope.data;
        if (envelope.event !== StepEvents.ON_SUBAGENT_UPDATE || !isSubagentUpdate(update)) {
          return;
        }
        if (
          selection.event == null &&
          update.parentToolCallId != null &&
          update.parentToolCallId !== selection.toolCallId
        ) {
          return;
        }
        retryAttempt = 0;
        idleReconnects = 0;
        registerSubagentProgressKey(key);
        setProgress((previous) =>
          reduceSubagentProgress(
            previous,
            [
              {
                ...update,
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
      };
      transport.reconnectToStream({ url: endpoint }, { signal: next.signal, onEvent });
    };

    const reconnect = (pending = false) => {
      if (disposed || terminal || retryTimer != null) return;
      closeCurrent();
      if (!pending && idleReconnects >= MAX_IDLE_RECONNECTS) {
        terminal = true;
        return;
      }
      if (!pending) idleReconnects += 1;
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
    transport,
  ]);
  return { isReady };
}
