import { useRef, useMemo, useCallback, useSyncExternalStore } from 'react';
import type { TMessage, UIMessage } from 'librechat-data-provider';
import type { UseChatHelpers } from './types';
import { useRegenerate, useTurnActions } from './actions';
import { getChatStatus, getErrorText } from './status';
import { toStoredMessages } from './messages';
import { useChatContext } from './context';
import { toView } from './views';

/**
 * AI SDK `useChat`, read and called through `ChatContext`. It holds no state of its own:
 * `messages` is `getMessages()` mapped per message, re-read when the message cache is
 * written, and every action forwards to the contract.
 */
export function useChat(): UseChatHelpers {
  const {
    conversation,
    getMessages,
    messagesKey,
    subscribeMessages,
    getMessagesRevision,
    setMessages: setStoredMessages,
    latestMessageId,
    useLiveAttachments,
    getMappingOptions,
    isSubmitting,
    ask,
    regenerate: regenerateTarget,
    stopGenerating,
  } = useChatContext();
  const liveAttachments = useLiveAttachments();

  const snapshot = useRef<{ writes: number; stored?: TMessage[] }>();
  /**
   * A stream frame replaces a response's content on the same object, so structural sharing can
   * keep the cached array. Every write still counts on the cache, so the snapshot is keyed by that
   * count and by the array; a write that lands before the listener subscribes is still seen.
   */
  const readSnapshot = useCallback(() => {
    const stored = getMessages();
    const writes = getMessagesRevision();
    const current = snapshot.current;
    if (current?.writes === writes && current.stored === stored) {
      return current;
    }
    snapshot.current = { writes, stored };
    return snapshot.current;
  }, [getMessages, getMessagesRevision]);
  const cache = useSyncExternalStore(subscribeMessages, readSnapshot, readSnapshot);

  const { messages, latest } = useMemo(() => {
    const list: UIMessage[] = [];
    let latestMessage: TMessage | undefined;
    for (const message of cache.stored ?? []) {
      list.push(toView(message, liveAttachments[message.messageId], getMappingOptions));
      if (message.messageId === latestMessageId) {
        latestMessage = message;
      }
    }
    return { messages: list, latest: latestMessage };
  }, [cache, latestMessageId, liveAttachments, getMappingOptions]);

  const chatId = messagesKey || conversation?.conversationId || undefined;
  const status = getChatStatus(isSubmitting, latest);
  const errorText = status === 'error' && latest ? getErrorText(latest) : undefined;
  const error = useMemo(
    () => (errorText === undefined ? undefined : new Error(errorText)),
    [errorText],
  );

  const regenerate = useRegenerate(getMessages, latestMessageId, regenerateTarget);
  const { sendMessage, resumeStream } = useTurnActions(ask, chatId);

  const setMessages = useCallback(
    (update: UIMessage[] | ((messages: UIMessage[]) => UIMessage[])) => {
      const current = getMessages() ?? [];
      const next =
        typeof update === 'function'
          ? update(
              current.map((message) =>
                toView(message, liveAttachments[message.messageId], getMappingOptions),
              ),
            )
          : update;
      setStoredMessages(toStoredMessages(next, current, latestMessageId, chatId));
    },
    [chatId, getMessages, latestMessageId, liveAttachments, getMappingOptions, setStoredMessages],
  );

  return {
    id: chatId,
    messages,
    status,
    error,
    sendMessage,
    regenerate,
    stop: stopGenerating,
    resumeStream,
    setMessages,
  };
}
