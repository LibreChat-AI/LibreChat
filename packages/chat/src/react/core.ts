import { useRef, useMemo, useCallback } from 'react';
import type { TMessage, UIMessage, TAttachment } from 'librechat-data-provider';
import type {
  Chat,
  ChatStatus,
  ChatConnection,
  SendMessageInput,
  ChatRequestOptions,
} from '../core';
import type { ChatViewContract } from './chat/contract';
import { toStoredMessages } from './chat/messages';
import { useSnapshot } from './snapshot';
import { toView } from './chat/views';

export type UseCoreChatOptions = {
  chat: Chat;
  /** The app's tool outcome rules for viewing a message; see `ChatViewContract`. */
  getMappingOptions: ChatViewContract['getMappingOptions'];
  /** Renders message updates at most once per interval, in ms. Status and error render at once. */
  throttle?: number;
  /** Attachments delivered per message id that the message list does not hold yet. */
  liveAttachments?: Record<string, TAttachment[] | undefined>;
  /** The active branch's tail, under which `setMessages` joins new messages. Defaults to the list's tail. */
  latestMessageId?: string;
};

/** AI SDK `UseChatHelpers`, over a core {@link Chat}. */
export type CoreChatHelpers = {
  id: string;
  messages: UIMessage[];
  status: ChatStatus;
  error: Error | undefined;
  connection: ChatConnection;
  sendMessage: (input: SendMessageInput, options?: ChatRequestOptions) => Promise<void>;
  regenerate: (options?: { messageId?: string } & ChatRequestOptions) => Promise<void>;
  continue: (options: { messageId: string } & ChatRequestOptions) => Promise<void>;
  clearError: () => void;
  /** Writes views back onto the stored messages; see `toStoredMessages`. */
  setMessages: (messages: UIMessage[] | ((messages: UIMessage[]) => UIMessage[])) => Promise<void>;
};

type MessagesSnapshot = { version: number; stored: TMessage[] };

const noLiveAttachments: Record<string, TAttachment[] | undefined> = {};

/**
 * AI SDK `useChat` for a core {@link Chat}, which a host constructs and may share between
 * components (AI SDK: the `chat` option). Messages are viewed through the same per-message cache
 * as `useChat`, and only message updates are throttled, so `ready` never renders beside stale
 * messages.
 */
export function useCoreChat({
  chat,
  getMappingOptions,
  throttle,
  liveAttachments = noLiveAttachments,
  latestMessageId,
}: UseCoreChatOptions): CoreChatHelpers {
  const subscribe = useCallback((listener: () => void) => chat.subscribe(listener), [chat]);
  const snapshot = useRef<MessagesSnapshot>();
  /** Keyed by the chat's change count as well as the list: a write can keep the same array. */
  const readMessages = useCallback(() => {
    const version = chat.version;
    const stored = chat.messages;
    const current = snapshot.current;
    if (current?.version === version && current.stored === stored) {
      return current;
    }
    snapshot.current = { version, stored };
    return snapshot.current;
  }, [chat]);
  const cache = useSnapshot(subscribe, readMessages, { throttle });
  const status = useSnapshot(subscribe, () => chat.status);
  const error = useSnapshot(subscribe, () => chat.error);
  const connection = useSnapshot(subscribe, () => chat.connection);

  const messages = useMemo(
    () =>
      cache.stored.map((message) =>
        toView(message, liveAttachments[message.messageId], getMappingOptions),
      ),
    [cache, liveAttachments, getMappingOptions],
  );

  const setMessages = useCallback<CoreChatHelpers['setMessages']>(
    (update) =>
      chat.setMessages((current) => {
        const viewOf = (message: TMessage) =>
          toView(message, liveAttachments[message.messageId], getMappingOptions);
        const next = typeof update === 'function' ? update(current.map(viewOf)) : update;
        const tail = latestMessageId ?? current[current.length - 1]?.messageId;
        return toStoredMessages(next, current, tail, chat.conversationId, viewOf);
      }),
    [chat, liveAttachments, getMappingOptions, latestMessageId],
  );

  return useMemo(
    () => ({
      id: chat.id,
      messages,
      status,
      error,
      connection,
      sendMessage: (input, options) => chat.sendMessage(input, options),
      regenerate: (options) => chat.regenerate(options),
      continue: (options) => chat.continue(options),
      clearError: () => chat.clearError(),
      setMessages,
    }),
    [chat, messages, status, error, connection, setMessages],
  );
}
