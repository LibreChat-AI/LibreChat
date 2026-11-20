import type { TMessage, EventSubmission } from 'librechat-data-provider';
import type { StepContext, StreamState } from './state';

const getCurrentMessages = (ctx: StepContext, messages: TMessage[]): TMessage[] => {
  const freshMessages = ctx.getMessages();
  return freshMessages && freshMessages.length >= messages.length ? freshMessages : messages;
};

export const getEventMessages = (ctx: StepContext, messages: TMessage[]): TMessage[] =>
  ctx.submission.isRegenerate ? messages : getCurrentMessages(ctx, messages);

const getRegenerateResponseIds = (submission: EventSubmission, responseMessageId: string) => {
  const ids = new Set<string>();
  const addId = (id?: string | null) => {
    if (!id) {
      return;
    }
    ids.add(id);
    ids.add(id.replace(/_+$/, ''));
  };
  addId(responseMessageId);
  addId(submission.initialResponse?.messageId);
  addId(submission.userMessage?.responseMessageId);
  return ids;
};

export const shouldRemoveRegenerateResponse = (
  submission: EventSubmission,
  message: TMessage,
  responseMessageId: string,
): boolean =>
  submission.isRegenerate === true &&
  !message.isCreatedByUser &&
  /** A compaction's preliminary response is `${anchorId}_`. The ordinary regenerate alias set
   *  strips that suffix, but here the base ID is the assistant ANCHOR, not a response being
   *  replaced. Keep it so the summary remains its child instead of becoming an orphan root. */
  (submission.compact !== true || message.messageId !== submission.userMessage.messageId) &&
  getRegenerateResponseIds(submission, responseMessageId).has(message.messageId);

export const shouldRemoveInitialResponse = (
  submission: EventSubmission,
  message: TMessage,
  responseMessageId: string,
): boolean => {
  const initialResponseId = submission.initialResponse?.messageId;
  return (
    !submission.isRegenerate &&
    !message.isCreatedByUser &&
    initialResponseId != null &&
    initialResponseId !== responseMessageId &&
    message.messageId === initialResponseId &&
    message.parentMessageId === submission.userMessage.messageId
  );
};

export const ensureUserMessagePresent = (
  submission: EventSubmission,
  candidateMessages: TMessage[],
  responseMessageId: string,
): TMessage[] => {
  const { userMessage } = submission;
  if (
    submission.isRegenerate ||
    !userMessage?.messageId ||
    candidateMessages.some((message) => message.messageId === userMessage.messageId)
  ) {
    return candidateMessages;
  }

  /** Insert before the row's first CHILD as well as before the response row: abandoned responses
   *  from preempted attempts are children of this user message and may already sit in the list.
   *  Landing the parent after them orders children before their parent, which the message tree
   *  renders as phantom root branches (a folded thread). */
  let insertIndex = candidateMessages.length;
  for (let i = 0; i < candidateMessages.length; i++) {
    const message = candidateMessages[i];
    if (
      message.messageId === responseMessageId ||
      message.parentMessageId === userMessage.messageId
    ) {
      insertIndex = i;
      break;
    }
  }
  if (insertIndex >= candidateMessages.length) {
    return [...candidateMessages, userMessage as TMessage];
  }

  const nextMessages = [...candidateMessages];
  nextMessages.splice(insertIndex, 0, userMessage as TMessage);
  return nextMessages;
};

export const getResponseBaseMessages = (
  ctx: StepContext,
  candidateMessages: TMessage[],
  responseMessageId: string,
  ensureUserMessage = false,
): TMessage[] => {
  const { submission } = ctx;
  const currentMessages = getEventMessages(ctx, candidateMessages);
  if (!submission.isRegenerate) {
    const nextMessages = currentMessages.filter(
      (message) => !shouldRemoveInitialResponse(submission, message, responseMessageId),
    );
    return ensureUserMessage
      ? ensureUserMessagePresent(submission, nextMessages, responseMessageId)
      : nextMessages;
  }
  return currentMessages.filter(
    (message) => !shouldRemoveRegenerateResponse(submission, message, responseMessageId),
  );
};

/** Replaces (or appends) the response in the list, dropping the placeholder it supersedes. */
export function mergeResponseMessage(
  ctx: StepContext,
  candidateMessages: TMessage[],
  updatedResponse: TMessage,
  responseMessageId: string,
  options?: { ensureUserMessage?: boolean },
): TMessage[] {
  const currentMessages = getResponseBaseMessages(
    ctx,
    candidateMessages,
    responseMessageId,
    options?.ensureUserMessage === true,
  );
  const hasResponseMessage = currentMessages.some((msg) => msg.messageId === responseMessageId);
  return hasResponseMessage
    ? currentMessages.map((msg) => (msg.messageId === responseMessageId ? updatedResponse : msg))
    : [...currentMessages, updatedResponse];
}

/** Writes the coalesced delta state of each response, merging onto the list the event read. */
export function flushResponses(
  state: StreamState,
  ctx: StepContext,
  messageIds: Iterable<string>,
  messages: TMessage[],
): void {
  let candidate = messages;
  for (const id of messageIds) {
    const latest = state.messages.get(id);
    if (!latest) {
      continue;
    }
    candidate = mergeResponseMessage(ctx, candidate, latest, id, { ensureUserMessage: true });
    ctx.setMessages(candidate);
  }
}

/** Writes the coalesced summarize-delta state of one response. */
export function flushSummary(
  state: StreamState,
  ctx: StepContext,
  messageId: string,
  messages: TMessage[],
): void {
  const latest = state.messages.get(messageId);
  if (!latest) {
    return;
  }
  const currentMessages = ctx.submission.isRegenerate ? messages : ctx.getMessages() || [];
  ctx.setMessages(mergeResponseMessage(ctx, currentMessages, latest, messageId));
}
