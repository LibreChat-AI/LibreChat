import { useCallback, useMemo } from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { useToastContext } from '@librechat/client';
import { useQueryClient } from '@tanstack/react-query';
import type {
  SteerHost,
  SteerSettings,
  SteerNotification,
  SteerRequestCallbacks,
} from '@librechat/chat/react';
import type { ChatTransportError, StreamStatusResponse } from '@librechat/chat';
import type { TAgentQueuedTurnReceipt } from 'librechat-data-provider';
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
import { agentQueuedTurnsQueryKey } from '~/data-provider/SSE/queuedTurns';
import useCodeApprovalMode from '~/hooks/Agents/useCodeApprovalMode';
import { streamStatusQueryKey } from '~/data-provider/SSE/queries';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import { useLatestMessage } from '~/hooks/Messages';
import { useSetFilesToDelete } from '~/hooks/Files';
import { useFileMapContext } from '~/Providers';
import useLocalize from '~/hooks/useLocalize';

/** Settles a fire-and-forget request through the caller's callbacks. The transport rejects with
 *  a `ChatTransportError`; the mutation layer only types its error as unknown. */
const settleWith = <Result,>(callbacks?: SteerRequestCallbacks<Result>) => ({
  onSuccess: (result: Result) => callbacks?.onSuccess?.(result),
  onError: (error: unknown) => callbacks?.onError?.(error as ChatTransportError),
});

function useSteerMessage(): ReturnType<SteerHost['useSteerMessage']> {
  const { mutate } = useSteerMessageMutation();
  return useCallback((request, callbacks) => mutate(request, settleWith(callbacks)), [mutate]);
}

function useEnqueueQueuedTurn(): ReturnType<SteerHost['useEnqueueQueuedTurn']> {
  const { mutate } = useEnqueueAgentQueuedTurnMutation();
  return useCallback((input, callbacks) => mutate(input, settleWith(callbacks)), [mutate]);
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
  useSteerMessage,
  useSteerMessageAsync: () => useSteerMessageMutation().mutateAsync,
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
  useLatestMessage: (index, conversationId) => useLatestMessage(index, conversationId),
  useCodeApprovalMode: (conversation, addedConversation, codeEnvironmentMode) =>
    useCodeApprovalMode(conversation, addedConversation, codeEnvironmentMode).selected,
  useLocalize,
  useNotify,
  useFileMap: useFileMapContext,
  useClearFilesToDelete,
  useSettings,
};

export { SteerHostProvider, useSteerHost } from '@librechat/chat/react';
