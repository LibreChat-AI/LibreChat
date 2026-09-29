import { useCallback } from 'react';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { replaceSpecialVars } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { useChatContext, useChatFormContext, useAddedChatContext } from '~/Providers';
import { useGetLatestMessage } from '~/hooks/Messages/useLatestMessage';
import { useAuthContext } from '~/hooks/AuthContext';
import { mainTextareaId } from '~/common';
import store from '~/store';

export default function useSubmitMessage() {
  const { user } = useAuthContext();
  const methods = useChatFormContext();
  const { conversation: addedConvo } = useAddedChatContext();
  const { ask, index, getMessages, setMessages } = useChatContext();
  const getLatestMessage = useGetLatestMessage(index);

  const autoSendPrompts = useRecoilValue(store.autoSendPrompts);
  const setActivePrompt = useSetRecoilState(store.activePromptByIndex(index));

  const submitMessage = useCallback(
    (data?: {
      text: string;
      overrideFiles?: TMessage['files'];
      overrideQuotes?: string[];
      overrideManualSkills?: string[];
      overrideClientRequestId?: string;
      overrideRecoverySteerId?: string;
      overrideExpectedPredecessorCreatedAt?: number;
      overrideQueuedMessageOrigin?: unknown;
    }) => {
      if (!data) {
        return console.warn('No data provided to submitMessage');
      }
      const latestMessage = getLatestMessage();
      const rootMessages = getMessages();
      const isLatestInRootMessages = rootMessages?.some(
        (message) => message.messageId === latestMessage?.messageId,
      );
      if (!isLatestInRootMessages && latestMessage) {
        setMessages([...(rootMessages || []), latestMessage]);
      }

      const submitted = ask(
        {
          text: data.text,
          ...(data.overrideRecoverySteerId != null && {
            overrideUserMessageId: data.overrideRecoverySteerId,
          }),
        },
        {
          addedConvo: addedConvo ?? undefined,
          // Queued during-run messages carry their own consumed attachments,
          // quote chips, and manual skill picks (undefined = drain composer).
          overrideFiles: data.overrideFiles,
          overrideQuotes: data.overrideQuotes,
          overrideManualSkills: data.overrideManualSkills,
          overrideClientRequestId: data.overrideClientRequestId,
          overrideRecoverySteerId: data.overrideRecoverySteerId,
          overrideExpectedPredecessorCreatedAt: data.overrideExpectedPredecessorCreatedAt,
          overrideQueuedMessageOrigin: data.overrideQueuedMessageOrigin,
        },
      );
      if (submitted === false) {
        return false;
      }
      methods.reset();
    },
    [ask, methods, addedConvo, setMessages, getMessages, getLatestMessage],
  );

  const submitPrompt = useCallback(
    (text: string) => {
      const parsedText = replaceSpecialVars({ text, user });
      if (autoSendPrompts && submitMessage({ text: parsedText }) !== false) {
        return;
      }
      /** A refused auto-send still belongs to the user. Stage it exactly like
       * a non-auto-sent prompt so every picker, including variable dialogs,
       * preserves the text for the composer's guarded submit route. */

      const textarea = document.getElementById(mainTextareaId) as HTMLTextAreaElement | null;
      const currentText = textarea?.value ?? methods.getValues('text');
      const newText = currentText.trim().length > 1 ? `\n${parsedText}` : parsedText;
      setActivePrompt(newText);
    },
    [autoSendPrompts, submitMessage, setActivePrompt, methods, user],
  );

  return { submitMessage, submitPrompt };
}
