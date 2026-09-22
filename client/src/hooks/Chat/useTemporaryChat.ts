import { useCallback } from 'react';
import { useRecoilState, useRecoilValue } from 'recoil';
import { Constants, isForcedTemporaryRetention } from 'librechat-data-provider';
import { useGetStartupConfig } from '~/data-provider';
import store from '~/store';

export type UseTemporaryChatResult = {
  /** Only offered before a conversation has any history, it cannot be toggled mid-thread. */
  show: boolean;
  isTemporary: boolean;
  /** Temporary mode is locked in for the conversation in progress, leaving only a read-only indicator. */
  isActive: boolean;
  /** The administrator forces temporary mode, so the toggle is read-only rather than absent. */
  isEnforced: boolean;
  toggle: () => void;
};

export default function useTemporaryChat(): UseTemporaryChatResult {
  const { data: startupConfig } = useGetStartupConfig();
  const [isTemporary, setIsTemporary] = useRecoilState(store.isTemporary);
  const conversation = useRecoilValue(store.conversationByIndex(0));
  const isSubmitting = useRecoilValue(store.isSubmittingFamily(0));
  const isEnforced = isForcedTemporaryRetention(startupConfig?.interface?.retentionMode);

  const toggle = useCallback(() => {
    if (isEnforced) {
      return;
    }
    setIsTemporary((previous) => !previous);
  }, [isEnforced, setIsTemporary]);

  const conversationId = conversation?.conversationId;
  const hasStarted = conversationId != null && conversationId !== Constants.NEW_CONVO;
  const hasMessages = Array.isArray(conversation?.messages) && conversation.messages.length >= 1;

  const show = !hasStarted && !hasMessages && !isSubmitting;
  const isForced = isEnforced || isTemporary;

  return {
    show,
    isTemporary: isForced,
    isActive: isForced && !show,
    isEnforced,
    toggle,
  };
}
