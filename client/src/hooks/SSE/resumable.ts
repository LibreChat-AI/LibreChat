import { useCallback } from 'react';
import { documentVisibility } from '@librechat/chat';
import type { ResumableServices, ResumableStreamParams } from '@librechat/chat/react';
import type { ResumableParts } from '@librechat/chat';
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
import { useGetUserBalance, fetchStreamStatus } from '~/data-provider';
import { useChatTransport } from '~/Providers/ChatTransportContext';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import useResumableEvents from './events';
import useResumableSteers from './steers';
import useResumableCache from './cache';
import useResumablePane from './pane';
import useSteerState from './steer';

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
 * The services a pane's resumable stream runs on in this app: its query cache, steer chips,
 * stream handlers, pane controls, balance refresh and transport. The binding in
 * `@librechat/chat/react` owns the run, the stream id and how a stream re-attaches.
 */
export function useResumableServices({
  run,
  chat,
  runIndex,
  isAddedRequest,
  setStreamId,
}: ResumableStreamParams): () => ResumableServices {
  const { auth, config } = useChatSettings();
  const { token, isAuthenticated = false } = auth;
  const transport = useChatTransport();
  const { setMessages, getMessages, setConversation, setIsSubmitting, newConversation } = chat;

  const { balanceEnabled = false } = config;
  const balanceQuery = useGetUserBalance({ enabled: isAuthenticated && balanceEnabled });
  const refreshBalance = useCallback(() => {
    balanceEnabled && balanceQuery.refetch();
  }, [balanceEnabled, balanceQuery]);

  const cache = useResumableCache(getMessages, runIndex);
  const steerState = useSteerState();
  const steers = useResumableSteers(steerState);
  const { events, usage } = useResumableEvents({
    run,
    runIndex,
    isAddedRequest,
    chatHelpers: chat,
  });
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

  return useCallback(
    (): ResumableServices => ({
      logger,
      visibility: documentVisibility,
      fetchStatus: fetchStreamStatus,
      cache,
      queue,
      pane,
      steers,
      events,
      usage,
      messages: { get: getMessages, set: setMessages },
      stream: transport.stream({ token }),
      start: (request, options) => transport.start(request, options),
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
    [cache, queue, pane, steers, events, usage, getMessages, setMessages, transport, token],
  );
}
