import { ASK_USER_QUESTION } from 'librechat-data-provider';
import type {
  Agents,
  TMessage,
  TMessageContentParts,
  AskUserQuestionContentPart,
} from 'librechat-data-provider';

/**
 * UI-only content-part type used to render an `ask_user_question` pause inline
 * with the assistant's other content parts. It rides on the standard `content`
 * array (which `Agents.MessageContentComplex` allows for arbitrary `type`
 * strings), so it survives SSE, sync, and DB rehydration without a new wire
 * type or an extra field on `TMessage`.
 */
export { ASK_USER_QUESTION };

/** Shape of the synthetic content part carrying an ask-user pending action. */
export type AskUserQuestionPart = AskUserQuestionContentPart;

/**
 * The synthetic type isn't in the `ContentTypes` union, so this reads the
 * `type` field through a cast rather than a type-predicate (which TS rejects
 * because `AskUserQuestionPart` isn't assignable to the strict
 * `TMessageContentParts` union).
 */
export const isAskUserQuestionPart = (part: Partial<TMessageContentParts> | undefined): boolean =>
  (part as { type?: string } | undefined)?.type === ASK_USER_QUESTION &&
  part != null &&
  ASK_USER_QUESTION in part;

/**
 * Ask actions the user has answered this session. The SSE step handler evolves
 * its own cached copy of the streaming message, so the store-level strip of an
 * answered card can't reach it, and writing that copy back would resurrect the
 * card. Keyed by `actionId` and only ever added to by
 * {@link markAskUserQuestionAnswered}, so a step event racing a still-LIVE pause
 * can never mistake its card for an answered one.
 */
const answeredAskActionIds = new Set<string>();

/** Records that the user answered the ask action `actionId` this session. */
export function markAskUserQuestionAnswered(actionId: string): void {
  answeredAskActionIds.add(actionId);
}

/** Whether `part` is an ask card whose question the user already answered. */
export const isAnsweredAskUserQuestionPart = (
  part: Partial<TMessageContentParts> | undefined,
): boolean =>
  isAskUserQuestionPart(part) &&
  answeredAskActionIds.has((part as unknown as AskUserQuestionPart)[ASK_USER_QUESTION].actionId);

/**
 * Finds the live (unanswered) ask-user-question pause across a conversation's
 * messages; the newest synthetic part wins. Drives the composer popover: the
 * part exists exactly while a pause is live (applied on `on_pending_action`,
 * stripped when the answer submits), so its presence IS the popover signal.
 *
 * Answered cards are skipped rather than assumed absent: the strip is a store
 * write, and any holder of an older message copy (the SSE step handler's
 * in-flight cache, a replayed event) can put one back. Honouring it would
 * reopen the popover on a question the user already answered.
 */
export function findLiveAskUserQuestion(messages: TMessage[] | null | undefined): {
  actionId: string;
  question: Agents.AskUserQuestionRequest;
  questions?: Agents.AskUserQuestionBatchItem[];
  messageId: string;
} | null {
  if (!Array.isArray(messages)) {
    return null;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const content = message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j];
      if (isAskUserQuestionPart(part) && !isAnsweredAskUserQuestionPart(part)) {
        const ask = (part as unknown as AskUserQuestionPart)[ASK_USER_QUESTION];
        return {
          actionId: ask.actionId,
          question: ask.question,
          questions: ask.questions,
          messageId: message.messageId,
        };
      }
    }
  }
  return null;
}
