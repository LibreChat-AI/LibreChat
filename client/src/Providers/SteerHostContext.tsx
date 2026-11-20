import { useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useToastContext } from '@librechat/client';
import { useQueryClient } from '@tanstack/react-query';
import { QueryKeys, safelyTrack, productTrackingContextSchema } from 'librechat-data-provider';
import type {
  SteerHost,
  SteerSettings,
  SteerNotification,
  SteerRequestCallbacks,
} from '@librechat/chat/react';
import type { ChatBrowserFact, TAgentQueuedTurnReceipt } from 'librechat-data-provider';
import type { ChatTransportError, StreamStatusResponse } from '@librechat/chat';
import {
  fetchStreamStatus,
  useAgentQueuedTurns,
  useArmSteerMutation,
  useCancelSteerMutation,
  useSteerMessageMutation,
  useMarkFilesUsageMutation,
  useCancelAgentQueuedTurnMutation,
  useEnqueueAgentQueuedTurnMutation,
} from '~/data-provider';
import { useProductTracking, useProductTrackingContext } from './TrackingContext';
import { agentQueuedTurnsQueryKey } from '~/data-provider/SSE/queuedTurns';
import useCodeApprovalMode from '~/hooks/Agents/useCodeApprovalMode';
import { streamStatusQueryKey } from '~/data-provider/SSE/queries';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import { cancelUploads } from '~/hooks/Files/useFileHandling';
import { useSetFilesToDelete } from '~/hooks/Files';
import { useFileMapContext } from '~/Providers';
import useLocalize from '~/hooks/useLocalize';

/** Settles a fire-and-forget request through the caller's callbacks. The transport rejects with
 *  a `ChatTransportError`; the mutation layer only types its error as unknown. */
const settleWith = <Result,>(callbacks?: SteerRequestCallbacks<Result>) => ({
  onSuccess: (result: Result) => callbacks?.onSuccess?.(result),
  onError: (error: unknown) => callbacks?.onError?.(error as ChatTransportError),
});

function useSteerProductTracking() {
  const track = useProductTracking();
  const getContext = useProductTrackingContext();
  return useCallback(
    (fact: ChatBrowserFact) => {
      const context = fact.name === 'librechat.chat.submission.failed' ? undefined : getContext();
      track(
        fact,
        'submissionId' in fact ? { ...context, submissionId: fact.submissionId } : context,
      );
    },
    [track, getContext],
  );
}

function useSteerMessage(): ReturnType<SteerHost['useSteerMessage']> {
  const { mutate } = useSteerMessageMutation();
  const track = useSteerProductTracking();
  return useCallback(
    (request, callbacks) => {
      if (request.clientSteerId)
        safelyTrack(track, {
          name: 'librechat.chat.message.steered',
          feature: 'chat',
          conversationId: request.conversationId,
          clientSteerId: request.clientSteerId,
          generationCreatedAt: request.generationCreatedAt,
        });
      mutate(request, settleWith(callbacks));
    },
    [mutate, track],
  );
}

function useSteerMessageAsync(): ReturnType<SteerHost['useSteerMessageAsync']> {
  const { mutateAsync } = useSteerMessageMutation();
  const track = useSteerProductTracking();
  return useCallback(
    (request) => {
      if (request.clientSteerId)
        safelyTrack(track, {
          name: 'librechat.chat.message.steered',
          feature: 'chat',
          conversationId: request.conversationId,
          clientSteerId: request.clientSteerId,
          generationCreatedAt: request.generationCreatedAt,
        });
      return mutateAsync(request);
    },
    [mutateAsync, track],
  );
}

function useEnqueueQueuedTurn(): ReturnType<SteerHost['useEnqueueQueuedTurn']> {
  const { mutate } = useEnqueueAgentQueuedTurnMutation();
  const track = useSteerProductTracking();
  return useCallback(
    (input, callbacks) =>
      mutate(input, {
        ...settleWith(callbacks),
        onError: (error) => {
          const transportError = error as ChatTransportError;
          const status = transportError.response?.status;
          const context = productTrackingContextSchema.safeParse({
            submissionId: input.clientRequestId,
          });
          if (context.success && context.data.submissionId) {
            safelyTrack(track, {
              name: 'librechat.chat.submission.failed',
              feature: 'chat',
              submissionId: input.clientRequestId,
              conversationId: input.conversationId,
              /** A 5xx can follow an accepted turn, as in the other start paths. */
              reason: status != null && status >= 400 && status < 500 ? 'rejected' : 'unconfirmed',
            });
          }
          callbacks?.onError?.(transportError);
        },
      }),
    [mutate, track],
  );
}

/** Observes the receipts and stream status the app's queries cache for a conversation, without
 *  registering a competing query function. */
function useQueuedTurnCache(conversationId: string): ReturnType<SteerHost['useQueuedTurnCache']> {
  const queryClient = useQueryClient();
  return useMemo(
    () => ({
      read: () => ({
        receipts: queryClient.getQueryData<TAgentQueuedTurnReceipt[]>(
          agentQueuedTurnsQueryKey(conversationId),
        ),
        status: queryClient.getQueryData<StreamStatusResponse>(
          streamStatusQueryKey(conversationId),
        ),
      }),
      subscribe: (notify: () => void) =>
        queryClient.getQueryCache().subscribe((event) => {
          const key = event?.query.queryKey;
          if (
            key?.[1] === conversationId &&
            (key[0] === QueryKeys.agentQueuedTurns || key[0] === 'streamStatus')
          ) {
            notify();
          }
        }),
    }),
    [queryClient, conversationId],
  );
}

function useNotify(): (notification: SteerNotification) => void {
  const { showToast } = useToastContext();
  return showToast;
}

function useClearFilesToDelete(): () => void {
  const setFilesToDelete = useSetFilesToDelete();
  return useCallback(() => setFilesToDelete({}), [setFilesToDelete]);
}

function useSettings(): SteerSettings {
  const { config, duringRunDefaultAction, setDuringRunDefaultAction, getPaneConversations } =
    useChatSettings();
  return {
    duringRunDefaultAction,
    setDuringRunDefaultAction,
    queuedSendLockTimeoutMs: config.queuedSendLockTimeoutMs,
    queuedTurnReconciliationTimeoutMs: config.queuedTurnReconciliationTimeoutMs,
    steerArmConfirmationTimeoutMs: config.steerArmConfirmationTimeoutMs,
    getPaneConversations,
  };
}

/** The app's services behind the steer and queue hooks: its transport-backed mutations and
 *  queries, toasts, translations, file map and chat settings. */
export const appSteerHost: SteerHost = {
  cancelUploads,
  useSteerMessage,
  useSteerMessageAsync,
  useProductTracking: useSteerProductTracking,
  useCancelSteer: () => useCancelSteerMutation().mutateAsync,
  useArmSteer: () => useArmSteerMutation().mutateAsync,
  useMarkFilesUsage: () => useMarkFilesUsageMutation().mutate,
  useEnqueueQueuedTurn,
  useCancelQueuedTurn: () => useCancelAgentQueuedTurnMutation().mutateAsync,
  useQueuedTurnCache,
  useQueuedTurns: (conversationId, enabled, clientRequestIds, reconcileUntil, expectsReceipts) =>
    useAgentQueuedTurns(conversationId, enabled, clientRequestIds, reconcileUntil, expectsReceipts)
      .data,
  useFetchStreamStatus: () => fetchStreamStatus,
  useRouteConversationId: () => useParams().conversationId,
  useCodeApprovalInputs: (conversation, addedConversation) =>
    useCodeApprovalMode(conversation, addedConversation).readInputs(),
  useLocalize,
  useNotify,
  useFileMap: useFileMapContext,
  useClearFilesToDelete,
  useSettings,
};

export { SteerHostProvider, useSteerHost } from '@librechat/chat/react';
