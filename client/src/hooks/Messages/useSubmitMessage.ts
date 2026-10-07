import { useCallback } from 'react';
import { useRecoilValue, useRecoilState, useSetRecoilState } from 'recoil';
import { replaceSpecialVars } from 'librechat-data-provider';
import { useChatContext, useChatFormContext, useAddedChatContext } from '~/Providers';
import { useAuthContext } from '~/hooks/AuthContext';
import {
  useUpdateFarmerPlatformMutation,
  useUpdateFarmerLastActiveAt,
  useUserTermsQuery,
} from '~/data-provider';
import { useLocalize } from '~/hooks';
import store from '~/store';

export default function useSubmitMessage() {
  const { user } = useAuthContext();
  const localize = useLocalize();
  const methods = useChatFormContext();
  const updateFarmerPlatform = useUpdateFarmerPlatformMutation();
  const { conversation: addedConvo } = useAddedChatContext();
  const { ask, index, getMessages, setMessages, latestMessage } = useChatContext();
  const updateLastActiveAt = useUpdateFarmerLastActiveAt();
  // Independent of Root's terms-modal-gated call to the same query (same query key, so this
  // dedupes against that cache when it's warm) — kept unconditional here (only gated on being
  // logged in) so an example-question tap can always read the farmer's state regardless of
  // whether the ToS-modal feature flag is on.
  const { data: termsData } = useUserTermsQuery({ enabled: !!user });
  const autoSendPrompts = useRecoilValue(store.autoSendPrompts);
  const [activePrompt, setActivePrompt] = useRecoilState(store.activePromptByIndex(index));
  const [showFeedbackReminder, setShowFeedbackReminder] = useRecoilState(store.showFeedbackReminder);
  const setPendingNewConversation = useRecoilState(store.pendingNewConversation)[1];
  const [isRequiredFeedback] = useRecoilState(store.isRequiredFeedback);
  const setFeedbackSkipCount = useSetRecoilState(store.feedbackSkipCount);

  const submitMessage = useCallback(
    async (
      data?: { text: string; isExampleQuestion?: boolean },
      position?: { latitude: number; longitude: number },
    ) => {
      if (!data) {
        return console.warn('No data provided to submitMessage');
      }

      // Block submission if feedback is required — Recoil state is synced from the API via MessagesViewContext
      if (isRequiredFeedback) {
        setPendingNewConversation(false);
        setShowFeedbackReminder(true);
        setFeedbackSkipCount((n) => n + 1);
        return;
      }

      const rootMessages = getMessages();
      const isLatestInRootMessages = rootMessages?.some(
        (message) => message.messageId === latestMessage?.messageId,
      );
      if (!isLatestInRootMessages && latestMessage) {
        setMessages([...(rootMessages || []), latestMessage]);
      }

      const ua = navigator.userAgent;
      let platform = 'Unknown';
      if (/android/i.test(ua)) platform = 'Android';
      else if (/iphone|ipad|ipod/i.test(ua)) platform = 'iOS';
      else if (/windows/i.test(ua)) platform = 'Windows';
      else if (/macintosh|mac os x/i.test(ua)) platform = 'MacOS';
      else if (/linux/i.test(ua)) platform = 'Linux';
      updateFarmerPlatform.mutate(platform);
      updateLastActiveAt.mutate();

      // Disabled: appending the farmer's saved state to example questions.
      // const farmerState = termsData?.farmerProfile?.state;
      // const shouldAppendState = !!(data.isExampleQuestion && farmerState);
      // const finalText = shouldAppendState
      //   ? `${data.text}\n\n${localize('com_ui_state_prefix')} ${farmerState}`
      //   : data.text;

      ask(
        {
          text: data.text,
          position,
          // isExampleQuestion: shouldAppendState,
        },
        {
          addedConvo: addedConvo ?? undefined,
        },
      );
      methods.reset();
    },
    [
      ask,
      methods,
      addedConvo,
      setMessages,
      getMessages,
      latestMessage,
      updateFarmerPlatform,
      updateLastActiveAt,
      setShowFeedbackReminder,
      setPendingNewConversation,
      isRequiredFeedback,
      termsData,
      localize,
    ],
  );

  const submitPrompt = useCallback(
    (text: string) => {
      const parsedText = replaceSpecialVars({ text, user });
      if (autoSendPrompts) {
        submitMessage({ text: parsedText });
        return;
      }

      const currentText = methods.getValues('text');
      const newText = currentText.trim().length > 1 ? `\n${parsedText}` : parsedText;
      setActivePrompt(newText);
    },
    [autoSendPrompts, submitMessage, setActivePrompt, methods, user],
  );

  return { submitMessage, submitPrompt };
}