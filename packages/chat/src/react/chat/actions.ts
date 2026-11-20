import { useMemo, useCallback, useSyncExternalStore } from 'react';
import { useStore } from 'jotai';
import { Constants } from 'librechat-data-provider';
import type { ChatActions, SendMessage, UseChatHelpers, SendMessageInput } from './types';
import type { ChatContract, TAskProps } from './contract';
import { getChatStatus, findLatest } from './status';
import { resumeRequestsAtom } from './resume';
import { useChatContext } from './context';

/** Regenerates the response to `messageId`, or the latest message of the branch. */
export const useRegenerate = (
  getMessages: ChatContract['getMessages'],
  latestMessageId: string | undefined,
  regenerateTarget: ChatContract['regenerate'],
): UseChatHelpers['regenerate'] =>
  useCallback(
    (options?: { messageId?: string }) => {
      const messageId = options?.messageId ?? latestMessageId;
      const target = getMessages()?.find((message) => message.messageId === messageId);
      regenerateTarget(
        target
          ? {
              messageId: target.messageId,
              parentMessageId: target.parentMessageId,
              isCreatedByUser: target.isCreatedByUser,
            }
          : { messageId },
      );
    },
    [getMessages, latestMessageId, regenerateTarget],
  );

/** `ask` arguments for a `sendMessage` call, which may carry an AI SDK user message. */
const toAskProps = (message: TAskProps | SendMessageInput): TAskProps => {
  if (!('parts' in message)) {
    return message;
  }
  const { parentMessageId } = message.metadata ?? {};
  return {
    text: message.parts.map((part) => part.text).join(''),
    /** A root message's view carries a `null` parent, which `ask` would read as "append to the
     *  branch tail"; the turn asked to attach at the root. */
    ...(parentMessageId !== undefined && {
      parentMessageId: parentMessageId ?? Constants.NO_PARENT,
    }),
  };
};

/** `sendMessage` and `resumeStream` for the chat `id`, shared by `useChat` and `useChatActions`. */
export function useTurnActions(
  ask: ChatContract['ask'],
  id?: string,
): Pick<ChatActions, 'sendMessage' | 'resumeStream'> {
  const jotaiStore = useStore();
  const sendMessage = useCallback<SendMessage>(
    (message, options) => ask(toAskProps(message), options),
    [ask],
  );
  const resumeStream = useCallback(async () => {
    if (!id || id === Constants.NEW_CONVO) {
      return;
    }
    jotaiStore.set(resumeRequestsAtom, (pending) =>
      pending.has(id) ? pending : new Set(pending).add(id),
    );
  }, [id, jotaiStore]);
  return { sendMessage, resumeStream };
}

/**
 * `useChat` without `messages`, for controls that submit or read status: it re-renders when the
 * status changes, not on every stream frame, and never maps the conversation.
 */
export function useChatActions(): ChatActions {
  const {
    conversation,
    getMessages,
    messagesKey,
    subscribeMessages,
    latestMessageId,
    isSubmitting,
    ask,
    regenerate: regenerateTarget,
    stopGenerating,
  } = useChatContext();
  const readStatus = useCallback(
    () => getChatStatus(isSubmitting, findLatest(getMessages(), latestMessageId)),
    [getMessages, isSubmitting, latestMessageId],
  );
  const status = useSyncExternalStore(subscribeMessages, readStatus, readStatus);
  const regenerate = useRegenerate(getMessages, latestMessageId, regenerateTarget);
  const id = messagesKey || conversation?.conversationId || undefined;
  const { sendMessage, resumeStream } = useTurnActions(ask, id);

  return useMemo(
    () => ({ id, status, sendMessage, regenerate, stop: stopGenerating, resumeStream }),
    [id, status, sendMessage, regenerate, stopGenerating, resumeStream],
  );
}
