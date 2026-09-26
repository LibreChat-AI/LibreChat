import { useRef, useMemo, useCallback, useSyncExternalStore } from 'react';
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

type ToolContext = {
  content: TMessage['content'];
  attachments: TMessage['attachments'];
  byToolCall: Record<string, TAttachment[] | undefined>;
  /** Step ids each provider tool-call id already owns, for calls that have no step yet. */
  stepIdsById: Map<string, Set<string>>;
};

const toolContexts = new WeakMap<TMessage, ToolContext>();

/**
 * Built once per message snapshot. The stream reuses a response object across frames and
 * replaces its `content` and `attachments` arrays, so both are checked, not only the object.
 */
const getToolContext = (message: TMessage): ToolContext => {
  const cached = toolContexts.get(message);
  if (cached && cached.content === message.content && cached.attachments === message.attachments) {
    return cached;
  }
  const stepIdsById = new Map<string, Set<string>>();
  for (const part of message.content ?? []) {
    if (part?.type !== ContentTypes.TOOL_CALL) {
      continue;
    }
    const { id, stepId } = (part.tool_call ?? {}) as { id?: string; stepId?: string };
    if (!id || !stepId) {
      continue;
    }
    const owned = stepIdsById.get(id) ?? new Set<string>();
    owned.add(stepId);
    stepIdsById.set(id, owned);
  }
  const context: ToolContext = {
    content: message.content,
    attachments: message.attachments,
    byToolCall: mapAttachments(message.attachments ?? []),
    stepIdsById,
  };
  toolContexts.set(message, context);
  return context;
};

/**
 * The client's own tool outcome rules (`getToolMeta`: memory failure prose, background task
 * status attachments), handed to the parts mapping, which reads only markers stored on the call.
 * A call with no step yet is scoped away from attachments its repeated provider id's other
 * steps own, as `summarizeSpan` does.
 */
const resolveToolFailure: NonNullable<UIMappingOptions['resolveToolFailure']> = (
  toolCall,
  message,
) => {
  const context = message ? getToolContext(message) : undefined;
  const { id, stepId } = toolCall as { id?: string; stepId?: string };
  const siblingStepIds = stepId == null && id ? context?.stepIdsById.get(id) : undefined;
  const meta = getToolMeta(
    { type: ContentTypes.TOOL_CALL, tool_call: toolCall },
    context?.byToolCall,
    siblingStepIds,
  );
  if (meta?.cancelled) {
    return 'cancelled';
  }
  return meta?.failed ? 'failed' : undefined;
};

const mappingOptions: UIMappingOptions = { resolveToolFailure };

/** The message fields a view is built from; a stream frame replaces these, not the object. */
const viewSourceKeys = ['content', 'text', 'files', 'attachments', 'error', 'unfinished'] as const;

type CachedView = { view: UIMessage; source: Pick<TMessage, (typeof viewSourceKeys)[number]> };

const views = new WeakMap<TMessage, CachedView>();

const isSameSource = (cached: CachedView, message: TMessage) =>
  viewSourceKeys.every((key) => cached.source[key] === message[key]);

/**
 * Cached per message and per snapshot of the fields a view reads: a stream frame that replaces a
 * response's content remaps that response, while untouched messages keep their views.
 */
const toView = (message: TMessage) => {
  const cached = views.get(message);
  if (cached && isSameSource(cached, message)) {
    return cached.view;
  }
  const view = toUIMessage(message, mappingOptions);
  const source = {} as CachedView['source'];
  for (const key of viewSourceKeys) {
    Object.assign(source, { [key]: message[key] });
  }
  views.set(message, { view, source });
  return view;
};

/** Placeholder slots (empty text or think, lane placeholders) are not streamed output. */
const hasStreamed = (message: TMessage) =>
  (message.text?.length ?? 0) > 0 ||
  (message.content?.some((part) => part != null && !isEmptyContentPart(part)) ?? false);

/** The error part names the failure; top-level text is only the fallback for legacy error rows. */
const getErrorText = (message: TMessage) => {
  const part = message.content?.find((item) => item?.type === ContentTypes.ERROR);
  if (part?.type !== ContentTypes.ERROR) {
    return message.text ?? '';
  }
  const text = typeof part.text === 'string' ? part.text : part.text?.value;
  return part.error || text || message.text || '';
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
  const writes = useRef(0);
  const subscribe = useCallback(
    (onChange: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.query.queryKey[0] !== QueryKeys.messages) {
          return;
        }
        if (
          event.type === 'removed' ||
          (event.type === 'updated' && event.action.type === 'success')
        ) {
          writes.current += 1;
          onChange();
        }
      }),
    [queryClient],
  );
  const snapshot = useRef<{ writes: number; stored?: TMessage[] }>();
  /**
   * A stream frame replaces a response's content on the same object, so structural sharing can
   * keep the cached array: the write count catches those frames, and the array itself catches a
   * write that lands before the listener is subscribed.
   */
  const readSnapshot = useCallback(() => {
    const stored = getMessages();
    const current = snapshot.current;
    if (current?.writes === writes.current && current.stored === stored) {
      return current;
    }
    snapshot.current = { writes: writes.current, stored };
    return snapshot.current;
  }, [getMessages]);
  const cache = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);

  const { messages, latest } = useMemo(() => {
    const list: UIMessage[] = [];
    let latestMessage: TMessage | undefined;
    for (const message of cache.stored ?? []) {
      list.push(toView(message));
      if (message.messageId === latestMessageId) {
        latestMessage = message;
      }
    }
    return { messages: list, latest: latestMessage };
  }, [cache, latestMessageId]);

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
          message.conversationId = conversationId ?? message.conversationId;
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
