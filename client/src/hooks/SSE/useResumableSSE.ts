import { useState, useEffect, useCallback } from 'react';
import {
  ResumableRun,
  mountSubmission,
  releaseSubmission,
  documentVisibility,
  attachResumableStream,
} from '@librechat/chat';
import type { ResumableHost, ResumableParts } from '@librechat/chat';
import type { TSubmission } from 'librechat-data-provider';
import type { EventHandlerParams } from './useEventHandlers';
import {
  logger,
  applySteerPart,
  applyReasoningLabel,
  findSteerMessageIndex,
  applyActivityLabelPart,
  offsetActivityPhaseBoundary,
  findActivityLabelMessageIndex,
  findReasoningLabelMessageIndex,
} from '~/utils';
import { useGetUserBalance, fetchStreamStatus, useGetStartupConfig } from '~/data-provider';
import { useChatTransport } from '~/Providers/ChatTransportContext';
import useResumableEvents from './useResumableEvents';
import useResumableSteers from './useResumableSteers';
import { useAuthContext } from '~/hooks/AuthContext';
import useResumableCache from './useResumableCache';
import useResumablePane from './useResumablePane';
import useSteerState from './steer';

type ChatHelpers = Pick<
  EventHandlerParams,
  'setMessages' | 'getMessages' | 'setConversation' | 'setIsSubmitting' | 'newConversation'
>;

/** How the app's message parts place steers and labels onto a response. */
const resumableParts: ResumableParts = {
  applySteer: applySteerPart,
  findSteerTarget: findSteerMessageIndex,
  applyActivityLabel: applyActivityLabelPart,
  findActivityLabelTarget: findActivityLabelMessageIndex,
  offsetActivityPhaseBoundary,
  applyReasoningLabel,
  findReasoningLabelTarget: findReasoningLabelMessageIndex,
};

export { ABORT_SWEEP_STATUSES, selectLocalSteersForQueue } from '@librechat/chat';

/**
 * Hook for resumable SSE streams.
 * Separates generation start (POST) from stream subscription (GET EventSource).
 * Supports auto-reconnection with exponential backoff.
 *
 * Key behavior:
 * - Navigation away does NOT abort the generation (just closes SSE)
 * - Only explicit abort (via stop button → backend abort endpoint) stops generation
 * - Backend emits `done` event with `aborted: true` on abort, handled via finalHandler
 *
 * The run itself lives in `@librechat/chat` (`mountSubmission`, `attachResumableStream`);
 * this hook supplies it the app it runs in.
 */
export default function useResumableSSE(
  submission: TSubmission | null,
  chatHelpers: ChatHelpers,
  isAddedRequest = false,
  runIndex = 0,
) {
  const [run] = useState(() => new ResumableRun());
  const [streamId, setStreamId] = useState<string | null>(null);
  const { token, isAuthenticated } = useAuthContext();
  const transport = useChatTransport();
  const { setMessages, getMessages, setConversation, setIsSubmitting, newConversation } =
    chatHelpers;

  const { data: startupConfig } = useGetStartupConfig();
  const balanceQuery = useGetUserBalance({
    enabled: !!isAuthenticated && startupConfig?.balance?.enabled,
  });
  const balanceEnabled = startupConfig?.balance?.enabled ?? false;
  const refreshBalance = useCallback(() => {
    balanceEnabled && balanceQuery.refetch();
  }, [balanceEnabled, balanceQuery]);

  const cache = useResumableCache(getMessages);
  const steerState = useSteerState();
  const steers = useResumableSteers(steerState);
  const { events, usage } = useResumableEvents({ run, runIndex, isAddedRequest, chatHelpers });
  const { pane, queue } = useResumablePane({
    run,
    runIndex,
    isAddedRequest,
    setStreamId,
    refreshBalance,
    setIsSubmitting,
    setConversation,
    newConversation,
    setGenerationEpoch: steerState.updateActiveGenerationCreatedAt,
  });

  const buildHost = useCallback(
    (): ResumableHost => ({
      logger,
      visibility: documentVisibility,
      fetchStatus: fetchStreamStatus,
      subscribe: (next) => attachResumableStream(run, buildHost(), next),
      cache,
      queue,
      pane,
      steers,
      events,
      usage,
      messages: { get: getMessages, set: setMessages },
      stream: transport.stream({ token }),
      start: transport.start,
      exposeDebugControls: import.meta.env.DEV
        ? ({ killNetwork, closeClean }) => {
            // Debug hooks for testing reconnection vs clean close behavior (dev only)
            const debugWindow = window as Window & {
              __killNetwork?: () => void;
              __closeClean?: () => void;
            };
            debugWindow.__killNetwork = killNetwork;
            debugWindow.__closeClean = closeClean;
          }
        : undefined,
      parts: resumableParts,
    }),
    [run, cache, queue, pane, steers, events, usage, getMessages, setMessages, transport, token],
  );

  useEffect(() => {
    const host = buildHost();
    if (!submission || Object.keys(submission).length === 0) {
      releaseSubmission(run, host);
      return;
    }
    return mountSubmission(run, host, submission);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submission]);

  return { streamId };
}
