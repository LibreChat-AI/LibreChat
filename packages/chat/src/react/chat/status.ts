import { ContentTypes } from 'librechat-data-provider';
import type { Agents, TMessage, TMessageContentParts } from 'librechat-data-provider';
import type { ChatStatus } from './types';

const getPartTextValue = (value?: string | { value?: string }): string =>
  (typeof value === 'string' ? value : value?.value) ?? '';

/** Slots the persistence compaction leaves nothing behind for: the
 * dual-message `type: ''` placeholders, text/think parts that never received a
 * delta, and tool calls missing their `tool_call` payload. */
export const isEmptyContentPart = (part: TMessageContentParts): boolean => {
  if (!part.type) {
    return true;
  }
  if (part.type === ContentTypes.TEXT) {
    return getPartTextValue(part.text).length === 0;
  }
  if (part.type === ContentTypes.THINK) {
    return getPartTextValue(part.think).length === 0;
  }
  if (part.type === ContentTypes.TOOL_CALL) {
    return (part[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined) == null;
  }
  return false;
};

/**
 * Placeholder slots (empty text or think, lane placeholders) are not streamed output. A rerun edit
 * seeds its response with the retained prefix, which reads as streamed from the start: the
 * contract carries no first-delta signal a restored or replaced run could keep correct.
 */
const hasStreamed = (message: TMessage) =>
  (message.text?.length ?? 0) > 0 ||
  (message.files?.length ?? 0) > 0 ||
  (message.content?.some((part) => part != null && !isEmptyContentPart(part)) ?? false);

/**
 * The error part names the failure; top-level text is only the fallback for legacy error rows,
 * and never for a failed user message, whose text is what the user sent.
 */
export const getErrorText = (message: TMessage): string => {
  const part = message.content?.find((item) => item?.type === ContentTypes.ERROR);
  if (part?.type !== ContentTypes.ERROR) {
    return message.isCreatedByUser ? '' : (message.text ?? '');
  }
  const text = typeof part.text === 'string' ? part.text : part.text?.value;
  return part.error || text || message.text || '';
};

const isErrorMessage = (message: TMessage) =>
  message.error === true ||
  (message.content?.some((part) => part?.type === ContentTypes.ERROR) ?? false);

/**
 * `submitted` until the response for the in-flight turn has content, then `streaming`; once the
 * turn ends, `error` when the latest message failed (a user message that never got a response
 * included) and `ready` otherwise, a stopped turn included.
 * `abortScroll` is a scroll hold rather than an abort flag, so a stop is read from the settled
 * message, not from it.
 */
export const getChatStatus = (isSubmitting: boolean, latest: TMessage | undefined): ChatStatus => {
  if (isSubmitting) {
    return latest && !latest.isCreatedByUser && hasStreamed(latest) ? 'streaming' : 'submitted';
  }
  return latest && isErrorMessage(latest) ? 'error' : 'ready';
};

/** The latest message, searched from the tail, where it almost always is. */
export const findLatest = (
  stored: TMessage[] | undefined,
  latestMessageId: string | undefined,
): TMessage | undefined => {
  if (!stored || latestMessageId == null) {
    return undefined;
  }
  for (let i = stored.length - 1; i >= 0; i--) {
    if (stored[i].messageId === latestMessageId) {
      return stored[i];
    }
  }
  return undefined;
};
