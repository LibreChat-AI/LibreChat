import { ContentTypes } from 'librechat-data-provider';
import {
  ASK_USER_QUESTION,
  isAskUserQuestionPart,
  findLiveAskUserQuestion,
  markAskUserQuestionAnswered,
  isAnsweredAskUserQuestionPart,
} from '@librechat/chat';
import type { Agents, TMessage, TMessageContentParts } from 'librechat-data-provider';
import type { AskUserQuestionPart } from '@librechat/chat';

export {
  ASK_USER_QUESTION,
  isAskUserQuestionPart,
  findLiveAskUserQuestion,
  isAnsweredAskUserQuestionPart,
};
export {
  applyPendingAction,
  countTaggedApprovalParts,
  findPendingActionMessageIndex,
} from '@librechat/chat';
export type { AskUserQuestionPart } from '@librechat/chat';

/**
 * Answer sent when the user explicitly skips a question: the run must resume
 * (a client-side dismiss would leave it paused until expiry — a hung turn),
 * and the model needs to know the user declined rather than answered.
 */
export const ASK_USER_DECLINED_ANSWER = 'The user chose not to answer this question.';
const ASK_USER_QUESTION_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_ASK_USER_QUESTIONS = 4;
const MAX_ASK_USER_QUESTION_HEADER_LENGTH = 80;

/**
 * Parse an `ask_user_question` tool call's args into the question request shape.
 * Args arrive as a JSON string on persisted messages (or an object mid-stream);
 * malformed/empty args degrade to `null` so the caller can render a fallback
 * label instead of crashing on model output.
 */
export function parseAskUserQuestionArgs(
  args: string | Record<string, unknown> | undefined,
): Agents.AskUserQuestionRequest | null {
  let parsed: unknown = args;
  if (typeof args === 'string') {
    if (args.trim().length === 0) {
      return null;
    }
    try {
      parsed = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (
    parsed == null ||
    typeof parsed !== 'object' ||
    typeof (parsed as { question?: unknown }).question !== 'string'
  ) {
    return null;
  }
  const request = parsed as {
    question: string;
    description?: unknown;
    options?: unknown;
    multiSelect?: unknown;
  };
  /** Model/persisted args are untrusted — normalize instead of crashing the
   *  message render on shapes like `options: {}` or non-string entries. */
  const options = Array.isArray(request.options)
    ? request.options.filter(
        (option): option is Agents.AskUserQuestionOption =>
          option != null &&
          typeof (option as { label?: unknown }).label === 'string' &&
          typeof (option as { value?: unknown }).value === 'string',
      )
    : undefined;
  return {
    question: request.question,
    description: typeof request.description === 'string' ? request.description : undefined,
    options: options && options.length > 0 ? options : undefined,
    multiSelect: request.multiSelect === true ? true : undefined,
  };
}

/** Parse and validate the batched form of an ask-user tool call. */
export function parseAskUserQuestionsArgs(
  args: string | Record<string, unknown> | undefined,
): Agents.AskUserQuestionsRequest | null {
  let parsed: unknown = args;
  if (typeof args === 'string') {
    if (args.trim().length === 0) {
      return null;
    }
    try {
      parsed = JSON.parse(args);
    } catch {
      return null;
    }
  }
  const rawQuestions =
    parsed != null && typeof parsed === 'object'
      ? (parsed as { questions?: unknown }).questions
      : undefined;
  if (
    !Array.isArray(rawQuestions) ||
    rawQuestions.length === 0 ||
    rawQuestions.length > MAX_ASK_USER_QUESTIONS
  ) {
    return null;
  }
  const questions: Agents.AskUserQuestionBatchItem[] = [];
  const ids = new Set<string>();
  for (const item of rawQuestions) {
    if (item == null || typeof item !== 'object') {
      return null;
    }
    const id = (item as { id?: unknown }).id;
    const request = parseAskUserQuestionArgs(item as Record<string, unknown>);
    if (
      typeof id !== 'string' ||
      !ASK_USER_QUESTION_ID_PATTERN.test(id) ||
      ids.has(id) ||
      request == null
    ) {
      return null;
    }
    ids.add(id);
    const rawHeader = (item as { header?: unknown }).header;
    const header = typeof rawHeader === 'string' ? rawHeader.trim() : '';
    questions.push({
      id,
      ...(header.length > 0 && header.length <= MAX_ASK_USER_QUESTION_HEADER_LENGTH && { header }),
      ...request,
    });
  }
  return { questions };
}

/**
 * Removes the synthetic ask-user-question part for `actionId` from a message.
 * Pure — returns the same message reference when nothing matched.
 *
 * Called when the answer submits successfully: the card is pause-scoped UI, and
 * once the run resumes the server streams new content parts at ABSOLUTE indices
 * continuing after the pre-pause parts — exactly the slot the appended synthetic
 * part occupies. Left in place, it blocks the incoming part at that index and
 * the resumed segment doesn't render until finalize replaces the message.
 */
export function removeAskUserQuestionPart(message: TMessage, actionId: string): TMessage {
  const content = message.content;
  if (!Array.isArray(content)) {
    return message;
  }
  const nextContent = content.filter(
    (part) =>
      !(
        isAskUserQuestionPart(part) &&
        (part as unknown as AskUserQuestionPart)[ASK_USER_QUESTION].actionId === actionId
      ),
  );
  if (nextContent.length === content.length) {
    return message;
  }
  return { ...message, content: nextContent };
}

/**
 * Session-scoped record of answers the user has submitted, keyed by the ask
 * tool_call id. Render-layer fallback for `AskUserQuestionCall`: the SSE
 * step handler evolves its own cached copy of the streaming message, so a
 * store-level `output` stamp can be overwritten by the next streamed event —
 * this survives any message-copy churn until finalize delivers the
 * server-stamped part. Written by {@link resolveAskUserQuestionPart}.
 */
const submittedAskAnswers = new Map<string, string>();

/** The locally-submitted answer for an ask tool_call, if any. */
export function getSubmittedAskAnswer(toolCallId: string | undefined): string | undefined {
  return toolCallId ? submittedAskAnswers.get(toolCallId) : undefined;
}

/**
 * Resolve an answered ask-user-question pause on the client, mirroring the
 * server's resume-time stamp so the durable Q&A card shows the answer the
 * moment the user submits (the server-patched part otherwise only arrives at
 * finalize): removes the synthetic card part for `actionId` AND patches the
 * newest unanswered `ask_user_question` tool_call with `output = answer`
 * (seeding `args` from the synthetic part's question when the streamed args
 * were lost). Pure — returns the input message when nothing matched.
 */
export function resolveAskUserQuestionPart(
  message: TMessage,
  actionId: string,
  resolution: string | Record<string, string>,
): TMessage {
  const content = message.content;
  if (!Array.isArray(content)) {
    return message;
  }
  const syntheticPart = content.find(
    (part) =>
      isAskUserQuestionPart(part) &&
      (part as unknown as AskUserQuestionPart)[ASK_USER_QUESTION].actionId === actionId,
  ) as unknown as AskUserQuestionPart | undefined;
  if (!syntheticPart) {
    return message;
  }
  markAskUserQuestionAnswered(actionId);
  /** Exact-attribution target when the payload carried the interrupting call's
   *  id — several ask cards in one turn each resolve their own part. Absent
   *  (older server/SDK), the newest-unanswered fallback below applies. */
  const targetToolCallId = syntheticPart[ASK_USER_QUESTION].tool_call_id;
  const questions = syntheticPart[ASK_USER_QUESTION].questions;
  const args =
    questions != null
      ? JSON.stringify({ questions })
      : JSON.stringify(syntheticPart[ASK_USER_QUESTION].question);
  const output =
    typeof resolution === 'string' ? resolution : JSON.stringify({ answers: resolution });

  let patched = false;
  const nextContent: TMessageContentParts[] = [];
  for (const part of content) {
    if (
      isAskUserQuestionPart(part) &&
      (part as unknown as AskUserQuestionPart)[ASK_USER_QUESTION].actionId === actionId
    ) {
      continue; // strip the pause-scoped card
    }
    nextContent.push(part);
  }
  for (let i = nextContent.length - 1; i >= 0; i--) {
    const part = nextContent[i] as { type?: string; tool_call?: Agents.ToolCall } | undefined;
    const toolCall = part?.tool_call;
    if (part?.type !== ContentTypes.TOOL_CALL || toolCall?.name !== ASK_USER_QUESTION) {
      continue;
    }
    if (
      targetToolCallId != null
        ? toolCall.id !== targetToolCallId
        : typeof toolCall.output === 'string' && toolCall.output.length > 0
    ) {
      continue;
    }
    const hasArgs =
      (typeof toolCall.args === 'string' && toolCall.args.trim().length > 0) ||
      (toolCall.args != null && typeof toolCall.args === 'object');
    nextContent[i] = {
      ...(part as object),
      tool_call: {
        ...toolCall,
        ...(hasArgs ? {} : { args }),
        output,
        progress: 1,
      },
    } as TMessageContentParts;
    if (typeof toolCall.id === 'string' && toolCall.id.length > 0) {
      submittedAskAnswers.set(toolCall.id, output);
    }
    patched = true;
    break;
  }

  if (!patched && nextContent.length === content.length) {
    return message;
  }
  return { ...message, content: nextContent };
}

/**
 * Splits a model-supplied catch-all "Other"-style option away from the real
 * choices. The answer UI always renders its own inline free-form row, so a
 * model option like "Other (type your own)" would duplicate it — instead its
 * label becomes the inline input's placeholder. Conservative match: value
 * `other` (the shape the tool description used to suggest) or a label that
 * reads as a free-form invitation.
 */
export function splitOtherOption(options: Agents.AskUserQuestionOption[] | undefined): {
  choices: Agents.AskUserQuestionOption[];
  otherLabel?: string;
} {
  const list = options ?? [];
  const isOther = (option: Agents.AskUserQuestionOption): boolean =>
    option.value.trim().toLowerCase() === 'other' ||
    /^other\b|something else|type (my|your) own|free[- ]?form/i.test(option.label);
  const otherOption = [...list].reverse().find(isOther);
  if (!otherOption) {
    return { choices: list };
  }
  return {
    choices: list.filter((option) => option !== otherOption),
    otherLabel: otherOption.label,
  };
}

/**
 * EVERY live (unanswered) ask pause across the conversation, as the set of
 * tool_call_ids their synthetic parts attribute, plus whether any live part
 * lacks attribution (older payloads). Unlike {@link findLiveAskUserQuestion}
 * (newest-only, the popover's signal), this lets a per-call surface — the
 * streaming progress card — test whether ITS OWN pause is live even when a
 * newer sibling pause exists.
 */
export function collectLiveAskToolCallIds(messages: TMessage[] | null | undefined): {
  ids: string[];
  hasUnattributed: boolean;
} {
  const ids: string[] = [];
  let hasUnattributed = false;
  if (!Array.isArray(messages)) {
    return { ids, hasUnattributed };
  }
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!isAskUserQuestionPart(part) || isAnsweredAskUserQuestionPart(part)) {
        continue;
      }
      const toolCallId = (part as unknown as AskUserQuestionPart)[ASK_USER_QUESTION].tool_call_id;
      if (toolCallId == null) {
        hasUnattributed = true;
      } else {
        ids.push(toolCallId);
      }
    }
  }
  return { ids, hasUnattributed };
}

/** Returns the ask-user-question synthetic part when `part` is one, else undefined. */
export function getAskUserQuestionPart(
  part: TMessageContentParts | undefined,
): AskUserQuestionPart | undefined {
  return isAskUserQuestionPart(part) ? (part as unknown as AskUserQuestionPart) : undefined;
}
