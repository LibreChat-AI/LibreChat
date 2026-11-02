import { Constants } from 'librechat-data-provider';
import type {
  TMessage,
  TConversation,
  TTokenUsageEvent,
  TContextUsageEvent,
} from 'librechat-data-provider';

export const FLUSH_INTERVAL_MS = 250;

export interface UsageSubmissionLike {
  userMessage?: Pick<TMessage, 'messageId' | 'conversationId'> | null;
  initialResponse?: Pick<TMessage, 'messageId' | 'parentMessageId'> | null;
  conversation?: Partial<Pick<TConversation, 'conversationId' | 'endpoint' | 'model'>> | null;
}

export interface FinalDataLike {
  requestMessage?: Partial<TMessage> | null;
  responseMessage?: Partial<TMessage> | null;
  conversation?: Partial<TConversation> | null;
}

export interface UsageHandlers {
  /** Bind an optimistic, created, or resumed response without inventing usage. */
  bindResponse: (submission: UsageSubmissionLike) => string | null;
  contextHandler: (data: TContextUsageEvent, submission: UsageSubmissionLike) => void;
  usageHandler: (data: TTokenUsageEvent, submission: UsageSubmissionLike) => void;
  tapStream: (data: { delta?: { content?: unknown } }, submission: UsageSubmissionLike) => void;
  /** Live estimate for the legacy content path, which streams cumulative
   *  (not incremental) text per part, sets rather than accumulates */
  tapContent: (text: unknown, submission: UsageSubmissionLike) => void;
  finalizeUsage: (data: FinalDataLike, submission: UsageSubmissionLike) => void;
  resetLive: (submission: UsageSubmissionLike) => void;
  /** Terminal stop: attribute the in-flight pending usage to the stopped partial
   *  response (so its billed tokens aren't dropped), then reset pending so it
   *  can't leak into the next response. Discards when no response id is known. */
  attributePending: (responseId: string | null, submission: UsageSubmissionLike) => void;
  /** Idempotently folds the resumed run's collected usage into the totals */
  backfillUsage: (entries: TTokenUsageEvent[], submission: UsageSubmissionLike) => void;
  /** Seeds the live estimate from already-streamed output chars on resume */
  seedLive: (chars: number, submission: UsageSubmissionLike) => void;
}

export function getConvoKey(submission: UsageSubmissionLike): string {
  /** On a new chat's first turn the `created` event stamps the real id onto
   *  the user message while the submission's conversation is still `new`;
   *  prefer the real id so live writes land where TokenUsage is subscribed */
  const fromUserMessage = submission.userMessage?.conversationId;
  if (fromUserMessage != null && fromUserMessage !== Constants.NEW_CONVO) {
    return fromUserMessage;
  }
  return submission.conversation?.conversationId ?? Constants.NEW_CONVO;
}

/** Cumulative text of a content-path part: a raw string or a `{ value }` part */
export function extractContentText(text: unknown): string {
  if (typeof text === 'string') {
    return text;
  }
  const value = (text as { value?: unknown })?.value;
  return typeof value === 'string' ? value : '';
}

export function countDeltaChars(content: unknown): number {
  const parts = Array.isArray(content) ? content : [content];
  let chars = 0;
  for (const part of parts) {
    if (part == null || typeof part !== 'object') {
      continue;
    }
    const { text, think } = part as { text?: unknown; think?: unknown };
    if (typeof text === 'string') {
      chars += text.length;
    } else if (typeof think === 'string') {
      chars += think.length;
    }
  }
  return chars;
}
