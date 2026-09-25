import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QueryKeys, ContentTypes, fromUIMessage, toUIMessage } from 'librechat-data-provider';
import type { TAttachment, TMessage, UIMessage, UIMappingOptions } from 'librechat-data-provider';
import type { TAskFunction } from '~/common';
import { getToolMeta } from '~/components/Chat/Messages/Content/outcome';
import { useChatContext } from '~/Providers/ChatContext';
import { isEmptyContentPart } from '~/utils/messages';
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
  /** The cached messages as `UIMessage`s, re-read whenever the message cache is written. */
  messages: UIMessage[];
  status: ChatStatus;
  /** Set when the latest message is an error; LibreChat reports errors as messages. */
  error: Error | undefined;
  /** Submits a turn: the contract's `ask`, called with the same arguments. */
  sendMessage: TAskFunction;
  /** Regenerates the response to `messageId`, or the latest message of the branch. */
  regenerate: (options?: { messageId?: string }) => void;
  stop: () => Promise<void>;
  /**
   * Writes messages back to the cache, keeping the stored fields the UI view omits. A message
   * with no stored counterpart joins the active conversation under the message before it,
   * unless its metadata names a parent.
   */
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

const views = new WeakMap<TMessage, UIMessage>();

/**
 * Cached by message reference: a stream write replaces only the messages it changed, so the
 * rest of the transcript is not remapped on every chunk.
 */
const toView = (message: TMessage) => {
  let view = views.get(message);
  if (!view) {
    view = toUIMessage(message, mappingOptions);
    views.set(message, view);
  }
  return view;
};

/** Placeholder slots (empty text or think, lane placeholders) are not streamed output. */
const hasStreamed = (message: TMessage) =>
  (message.text?.length ?? 0) > 0 ||
  (message.content?.some((part) => part != null && !isEmptyContentPart(part)) ?? false);

const getErrorText = (message: TMessage) => {
  if (message.text) {
    return message.text;
  }
  const part = message.content?.find((item) => item?.type === ContentTypes.ERROR);
  if (part?.type !== ContentTypes.ERROR) {
    return '';
  }
  const text = typeof part.text === 'string' ? part.text : part.text?.value;
  return part.error || text || '';
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
 * `messages` is `getMessages()` mapped per message, re-read when the message query cache is
 * written, and every action forwards to the contract.
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

  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.query.queryKey[0] === QueryKeys.messages) {
          onChange();
        }
      }),
    [queryClient],
  );
  const readMessages = useCallback(() => getMessages(), [getMessages]);
  const stored = useSyncExternalStore(subscribe, readMessages, readMessages);

  const { messages, latest } = useMemo(() => {
    const list: UIMessage[] = [];
    let latestMessage: TMessage | undefined;
    for (const message of stored ?? []) {
      list.push(toView(message));
      if (message.messageId === latestMessageId) {
        latestMessage = message;
      }
    }
    return { messages: list, latest: latestMessage };
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
      const conversationId = conversation?.conversationId ?? null;
      let previousId: string | null = null;
      const stored = next.map((view) => {
        const base = byId.get(view.id);
        const message = fromUIMessage(view, base);
        if (!base) {
          message.conversationId ??= conversationId;
          if (view.metadata?.parentMessageId === undefined) {
            message.parentMessageId = previousId;
          }
        }
        previousId = message.messageId;
        return message;
      });
      setStoredMessages(stored);
    },
    [conversation?.conversationId, getMessages, setStoredMessages],
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
