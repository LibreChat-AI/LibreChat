import { useCallback } from 'react';
import { useToastContext } from '@librechat/client';
import { setDefaultSteerHost } from '@librechat/chat/react';
import type {
  SteerHost,
  SteerSettings,
  SteerNotification,
  SteerRequestCallbacks,
} from '@librechat/chat/react';
import type { ChatTransportError } from '@librechat/chat';
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
import useCodeApprovalMode from '~/hooks/Agents/useCodeApprovalMode';
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

function useNotify(): (notification: SteerNotification) => void {
  const { showToast } = useToastContext();
  return showToast;
}

function useClearFilesToDelete(): () => void {
  const setFilesToDelete = useSetFilesToDelete();
  return useCallback(() => setFilesToDelete({}), [setFilesToDelete]);
}

function useSettings(): SteerSettings {
  const { config, duringRunDefaultAction, setDuringRunDefaultAction } = useChatSettings();
  return {
    duringRunDefaultAction,
    setDuringRunDefaultAction,
    queuedSendLockTimeoutMs: config.queuedSendLockTimeoutMs,
    queuedTurnReconciliationTimeoutMs: config.queuedTurnReconciliationTimeoutMs,
    steerArmConfirmationTimeoutMs: config.steerArmConfirmationTimeoutMs,
  };
}

/** The app's services behind the steer and queue hooks: its transport-backed mutations and
 *  queries, toasts, translations, file map and chat settings. */
export const appSteerHost: SteerHost = {
  useSteerMessage,
  useCancelSteer: () => useCancelSteerMutation().mutateAsync,
  useArmSteer: () => useArmSteerMutation().mutateAsync,
  useMarkFilesUsage: () => useMarkFilesUsageMutation().mutate,
  useEnqueueQueuedTurn,
  useCancelQueuedTurn: () => useCancelAgentQueuedTurnMutation().mutateAsync,
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

setDefaultSteerHost(appSteerHost);

export { SteerHostProvider, useSteerHost } from '@librechat/chat/react';
