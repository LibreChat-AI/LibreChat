import { createPayload } from 'librechat-data-provider';
import type { TMessage, TSubmission, EventSubmission } from 'librechat-data-provider';
import type { ChatPrepareRequest, ChatPreparedRequest } from '../chat';
import type { TResData } from './types';
import {
  mergeErrorMessages,
  toStartGenerationError,
  getStreamStartFailureText,
  mergeRegenerateFinalMessages,
  getExistingConversationAbortMessages,
} from '../resumable';
import { STREAM_START_FAILED_METADATA_KEY } from '../regenerate';
import { resolveErrorTurn } from './errors';

/**
 * A turn as main chat's `ask` leaves it: the submission the turn builder made, and the rows
 * `ask` shows while the request is in flight (the turn's user message and an empty reply, or
 * the empty reply alone for a turn that reuses a saved user message).
 */
export type SubmittedTurn = {
  submission: TSubmission;
  messages: TMessage[];
};

/** How a `Chat` is asked for a turn: the trigger it runs under, with what that trigger names. */
export type SubmittedTurnRequest = Pick<ChatPrepareRequest, 'trigger' | 'input' | 'messageId'>;

/**
 * Which of a `Chat`'s three requests a built turn is. A continuation and a regeneration name
 * the reply they produce; a submitted message carries its text and the parent it answers.
 */
export function describeSubmittedTurn({ submission }: SubmittedTurn): SubmittedTurnRequest {
  const { userMessage, initialResponse } = submission;
  if (submission.isContinued === true) {
    return { trigger: 'continue-message', messageId: initialResponse?.messageId };
  }
  if (submission.isRegenerate === true) {
    return { trigger: 'regenerate-message', messageId: initialResponse?.messageId };
  }
  return {
    trigger: 'submit-message',
    input: {
      parts: [{ type: 'text', text: userMessage.text ?? '' }],
      metadata: { parentMessageId: userMessage.parentMessageId ?? undefined },
    },
  };
}

/**
 * What a `Chat` posts and shows for a turn `ask` built: the body main chat's own start posts
 * for that submission, so the server reads the same request whichever sent it, and the rows
 * `ask` would have written, which the `Chat` writes itself so it can take them back when the
 * server answers the start with a generation that is not this turn.
 */
export function prepareSubmittedTurn({ submission, messages }: SubmittedTurn): ChatPreparedRequest {
  return {
    payload: createPayload(submission).payload,
    messages,
    responseMessageId: submission.initialResponse?.messageId,
  };
}

/** The turn as the handlers that settle it take it: with the reply `ask` always builds. */
const settling = ({ submission }: SubmittedTurn): EventSubmission | undefined =>
  submission.initialResponse == null
    ? undefined
    : { ...submission, initialResponse: submission.initialResponse };

/**
 * The list a turn leaves when it failed for good: the rows main chat's error handler writes.
 * A start the server refused leaves the turn's message with the refusal as its reply, marked as
 * a start that failed so the next message answers past it; a failure the stream reported keeps
 * what had streamed and takes the failure as its last part. `current` is the list as the
 * failure left it. Nothing when the turn has no reply to carry the failure.
 */
export function failedTurnMessages(
  turn: SubmittedTurn,
  current: TMessage[],
  error: Error | undefined,
): TMessage[] | undefined {
  const submission = settling(turn);
  if (submission == null) {
    return undefined;
  }
  const refused = toStartGenerationError(error)?.response;
  const data =
    refused == null
      ? { text: error?.message ?? '' }
      : {
          text: getStreamStartFailureText(refused.data),
          metadata: { [STREAM_START_FAILED_METADATA_KEY]: true },
        };
  const { errorResponse } = resolveErrorTurn({
    data: data as unknown as TResData,
    submission,
    getMessages: () => current,
    isNewConversationRoute: false,
  });
  return mergeErrorMessages({ ...submission, errorMessage: errorResponse });
}

/**
 * The list a rerun leaves when its own stream ended it. While it ran, the list held only the
 * branch being rerun: the reply it replaces and what followed that reply were set aside, as
 * `ask` shows it. They are other branches of the same conversation, so they come back beside
 * the new reply, as main chat's final handler puts them. Nothing for a turn that set none aside.
 */
export function rerunTurnMessages(
  { submission }: SubmittedTurn,
  response: TMessage | undefined,
): TMessage[] | undefined {
  const { regenerateMessages, initialResponse } = submission;
  if (submission.isRegenerate !== true || regenerateMessages == null) {
    return undefined;
  }
  if (response == null) {
    return regenerateMessages.filter((message) => message.messageId !== initialResponse?.messageId);
  }
  return mergeRegenerateFinalMessages({
    messages: regenerateMessages,
    responseMessage: response,
    initialResponseId: initialResponse?.messageId,
  });
}

/**
 * The list a turn leaves when it was stopped before the server kept anything of it: the rows
 * from before the turn, as main chat's final handler restores them. Its message was never
 * saved, so neither it nor the empty reply stays, and the words are the reader's to send again.
 */
export function withdrawnTurnMessages(
  { submission }: SubmittedTurn,
  current: TMessage[],
): TMessage[] {
  return getExistingConversationAbortMessages({
    messages: submission.messages,
    isRegenerate: submission.isRegenerate,
    regenerateMessages: submission.regenerateMessages,
    currentMessages: current,
  });
}
