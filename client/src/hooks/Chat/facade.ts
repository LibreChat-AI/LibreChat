import { useCallback, useMemo } from 'react';
import { ContentTypes, fromUIMessage, toUIMessage } from 'librechat-data-provider';
import type { TAttachment, TMessage, UIMessage, UIMappingOptions } from 'librechat-data-provider';
import type { TAskFunction } from '~/common';
import { getToolMeta } from '~/components/Chat/Messages/Content/outcome';
import { useChatContext } from '~/Providers/ChatContext';
import { mapAttachments } from '~/utils/map';

/** AI SDK `ChatStatus`. */
export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error';

/**
 * The `useChat` surface of `@ai-sdk/react@4.0.117` (`UseChatHelpers`), over LibreChat's chat
 * contract. Members the contract cannot back (`resumeStream`, `addToolOutput`, `clearError`)
 * are left out rather than stubbed.
 */
export type UseChatHelpers = {
  /** The conversation id; AI SDK's chat id. */
  id: string | undefined;
  /** The cached messages as `UIMessage`s, read when the host re-renders. */
  messages: UIMessage[];
  status: ChatStatus;
  /** Set when the latest message is an error; LibreChat reports errors as messages. */
  error: Error | undefined;
  /** Submits a turn: the contract's `ask`, called with the same arguments. */
  sendMessage: TAskFunction;
  /** Regenerates the response to `messageId`, or the latest message of the branch. */
  regenerate: (options?: { messageId?: string }) => void;
  stop: () => Promise<void>;
  /** Writes messages back to the cache, keeping the stored fields the UI view omits. */
  setMessages: (messages: UIMessage[] | ((messages: UIMessage[]) => UIMessage[])) => void;
};

const attachmentsByMessage = new WeakMap<TMessage, Record<string, TAttachment[] | undefined>>();

/**
 * The client's own tool outcome rules (`getToolMeta`: memory failure prose, background task
 * status attachments), handed to the parts mapping, which reads only markers stored on the call.
 */
const resolveToolFailure: NonNullable<UIMappingOptions['resolveToolFailure']> = (
  toolCall,
  message,
) => {
  let byToolCall = message ? attachmentsByMessage.get(message) : undefined;
  if (message && !byToolCall) {
    byToolCall = mapAttachments(message.attachments ?? []);
    attachmentsByMessage.set(message, byToolCall);
  }
  const meta = getToolMeta({ type: ContentTypes.TOOL_CALL, tool_call: toolCall }, byToolCall);
  if (meta?.cancelled) {
    return 'cancelled';
  }
  return meta?.failed ? 'failed' : undefined;
};

const mappingOptions: UIMappingOptions = { resolveToolFailure };

const toView = (message: TMessage) => toUIMessage(message, mappingOptions);

const hasStreamed = (message: TMessage) =>
  (message.content?.length ?? 0) > 0 || (message.text?.length ?? 0) > 0;

const getErrorText = (message: TMessage) => {
  if (message.text) {
    return message.text;
  }
  const part = message.content?.find((item) => item?.type === ContentTypes.ERROR);
  return part?.type === ContentTypes.ERROR ? (part.error ?? '') : '';
};

const isErrorMessage = (message: TMessage) =>
  message.error === true ||
  (message.content?.some((part) => part?.type === ContentTypes.ERROR) ?? false);

/**
 * `submitted` until the response for the in-flight turn has content, then `streaming`; once the
 * turn ends, `error` when its message failed and `ready` otherwise, a stopped turn included.
 * `abortScroll` is a scroll hold rather than an abort flag, so a stop is read from the settled
 * message, not from it.
 */
export const getChatStatus = (isSubmitting: boolean, latest: TMessage | undefined): ChatStatus => {
  if (isSubmitting) {
    return latest && !latest.isCreatedByUser && hasStreamed(latest) ? 'streaming' : 'submitted';
  }
  return latest && !latest.isCreatedByUser && isErrorMessage(latest) ? 'error' : 'ready';
};

/**
 * AI SDK `useChat`, read and called through `ChatContext`. It holds no state of its own:
 * `messages` is `getMessages()` mapped at render, and every action forwards to the contract.
 */
export function useChat(): UseChatHelpers {
  const {
    conversation,
    getMessages,
    setMessages: setStoredMessages,
    latestMessageId,
    isSubmitting,
    ask,
    regenerate: regenerateTarget,
    stopGenerating,
  } = useChatContext();

  const stored = getMessages();

  const { messages, latest } = useMemo(() => {
    const views: UIMessage[] = [];
    let latestMessage: TMessage | undefined;
    for (const message of stored ?? []) {
      views.push(toView(message));
      if (message.messageId === latestMessageId) {
        latestMessage = message;
      }
    }
    return { messages: views, latest: latestMessage };
  }, [stored, latestMessageId]);

  const status = getChatStatus(isSubmitting, latest);
  const errorText = status === 'error' && latest ? getErrorText(latest) : undefined;
  const error = useMemo(
    () => (errorText === undefined ? undefined : new Error(errorText)),
    [errorText],
  );

  const regenerate = useCallback(
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

  const setMessages = useCallback(
    (update: UIMessage[] | ((messages: UIMessage[]) => UIMessage[])) => {
      const current = getMessages() ?? [];
      const next = typeof update === 'function' ? update(current.map(toView)) : update;
      const byId = new Map(current.map((message) => [message.messageId, message]));
      setStoredMessages(next.map((message) => fromUIMessage(message, byId.get(message.id))));
    },
    [getMessages, setStoredMessages],
  );

  return {
    id: conversation?.conversationId ?? undefined,
    messages,
    status,
    error,
    sendMessage: ask,
    regenerate,
    stop: stopGenerating,
    setMessages,
  };
}
