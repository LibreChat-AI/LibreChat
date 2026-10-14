import { Tools, formatPromptTimestamp } from 'librechat-data-provider';
import { isUsableSummaryPart } from './compaction';

type Instant = string | number | Date;

/** The fields of a history row that decide its prompt-time context update. */
export interface ContextUpdateMessage {
  messageId?: string | null;
  isCreatedByUser?: boolean;
  createdAt?: Instant | null;
  content?: unknown;
}

/**
 * Wraps mid-conversation context in the block prepended to a user message.
 * Changes reach the model as events in the history instead of edits to the
 * system prompt, which keeps the cached prompt prefix intact.
 */
export function formatContextUpdate(lines: string[]): string {
  return `<context_update>\n${lines.join('\n')}\n</context_update>`;
}

function getRetainedFromMessageId(part: unknown): string | undefined {
  const coverage = (part as { coverage?: { retainedFromMessageId?: unknown } }).coverage;
  const id = coverage?.retainedFromMessageId;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
}

/**
 * Index of the first message the model still sees once the latest usable
 * summary replaces the history it covers; 0 when there is no summary. Mirrors
 * the agents SDK formatter: a summary that names `coverage.retainedFromMessageId`
 * (an earlier or the same message) keeps history from that message, any other
 * summary keeps history from the message that carries it.
 */
export function findSummaryBoundaryIndex(messages: readonly ContextUpdateMessage[]): number {
  let boundary = 0;
  const indexByMessageId = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const { messageId, content } = messages[i];
    if (typeof messageId === 'string' && messageId !== '') {
      indexByMessageId.set(messageId, i);
    }
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!isUsableSummaryPart(part)) {
        continue;
      }
      const retainedFromMessageId = getRetainedFromMessageId(part);
      const retainedIndex =
        retainedFromMessageId != null ? indexByMessageId.get(retainedFromMessageId) : undefined;
      boundary = retainedIndex ?? i;
    }
  }
  return boundary;
}

function isValidInstant(value: Instant | null | undefined): value is Instant {
  return value != null && !Number.isNaN(new Date(value).getTime());
}

/**
 * Computes the context update block for each visible user message, keyed by
 * its index in `messages`. Every block derives from stored message times and
 * the conversation start, so a message renders identically on every later turn.
 *
 * - `trackDateChanges`: the model last saw the conversation start date (the
 *   runtime context); a user message sent on another local date announces it,
 *   and later messages compare against that new date. Messages a summary
 *   replaced are not visible, so they announce nothing.
 * - `includeTimestamps`: every visible user message states when it was sent.
 *
 * The newest message is not stored yet and has no `createdAt`; it is dated by
 * `currentTurnStartedAt`.
 *
 * Blocks are rendered in the request's timezone, so a user who switches
 * timezones mid-conversation re-renders earlier blocks once (one prefix-cache
 * miss); persisting the rendered block per message would avoid that.
 */
export function buildUserMessageContextUpdates({
  messages,
  conversationStartedAt,
  currentTurnStartedAt,
  timezone,
  trackDateChanges,
  includeTimestamps,
}: {
  messages: readonly ContextUpdateMessage[];
  conversationStartedAt?: Instant | null;
  currentTurnStartedAt?: Instant | null;
  timezone?: string;
  trackDateChanges: boolean;
  includeTimestamps: boolean;
}): Map<number, string> {
  const updates = new Map<number, string>();
  if (!trackDateChanges && !includeTimestamps) {
    return updates;
  }

  const anchor = isValidInstant(conversationStartedAt)
    ? conversationStartedAt
    : currentTurnStartedAt;
  let lastSeenDate = isValidInstant(anchor)
    ? formatPromptTimestamp({ now: anchor, timezone, precision: 'date' })
    : undefined;
  const lastIndex = messages.length - 1;
  for (let i = findSummaryBoundaryIndex(messages); i < messages.length; i++) {
    const message = messages[i];
    if (message.isCreatedByUser !== true) {
      continue;
    }
    const sentAt = message.createdAt ?? (i === lastIndex ? currentTurnStartedAt : undefined);
    if (!isValidInstant(sentAt)) {
      continue;
    }

    const lines: string[] = [];
    if (trackDateChanges) {
      const date = formatPromptTimestamp({ now: sentAt, timezone, precision: 'date' });
      if (lastSeenDate != null && date !== lastSeenDate) {
        lines.push(`Current date changed to: ${date}`);
      }
      lastSeenDate = date;
    }
    if (includeTimestamps) {
      lines.push(
        `Message sent: ${formatPromptTimestamp({ now: sentAt, timezone, precision: 'second' })}`,
      );
    }
    if (lines.length > 0) {
      updates.set(i, formatContextUpdate(lines));
    }
  }
  return updates;
}

/**
 * Insert-time `createdAt` for this turn's user message: the turn start that
 * dated it in the prompt, so later turns render the same timestamp.
 */
export function getTurnUserMessageCreatedAt(
  req: { turnStartedAt?: number } | null | undefined,
): Date | undefined {
  const turnStartedAt = req?.turnStartedAt;
  return turnStartedAt != null && Number.isFinite(turnStartedAt)
    ? new Date(turnStartedAt)
    : undefined;
}

/** `dynamicToolContextMap` key for instructions resolved from temporal special variables. */
export const AGENT_TEMPORAL_INSTRUCTIONS_KEY = 'agent_temporal_instructions';

/**
 * Whether any agent's system prompt states the conversation date (the web
 * search runtime context or resolved temporal instructions). Only then is
 * there a date for a later message to announce a change from.
 */
export function hasConversationDateContext(
  agents: Iterable<{ dynamicToolContextMap?: Record<string, unknown> } | null | undefined>,
): boolean {
  for (const agent of agents) {
    const map = agent?.dynamicToolContextMap;
    if (map?.[Tools.web_search] || map?.[AGENT_TEMPORAL_INSTRUCTIONS_KEY]) {
      return true;
    }
  }
  return false;
}
