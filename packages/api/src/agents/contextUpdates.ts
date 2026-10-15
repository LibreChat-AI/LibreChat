import { Tools, formatPromptTimestamp } from 'librechat-data-provider';
import type { PromptCacheConfig } from './promptCache';
import type { FormattedMessageWithContent } from './client';
import { prependContextText } from './client';
import { isStableContextEnabled } from './promptCache';
import type { ContextEntry } from './turnContext/registry';
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

/** Where the latest usable summary splits a branch. */
export interface SummarySegment {
  /** Index of the message carrying the summary; -1 when there is none. */
  carrier: number;
  /** First message the model still sees. */
  visibleFrom: number;
}

/**
 * Locates the latest usable summary of a branch. Mirrors the agents SDK
 * formatter: a summary that names `coverage.retainedFromMessageId` (an earlier
 * or the same message) keeps history from that message, any other summary
 * keeps history from the message that carries it.
 */
export function findSummarySegment(messages: readonly ContextUpdateMessage[]): SummarySegment {
  const segment: SummarySegment = { carrier: -1, visibleFrom: 0 };
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
      segment.carrier = i;
      segment.visibleFrom = retainedIndex ?? i;
    }
  }
  return segment;
}

/** Index of the first message the model still sees once the latest usable summary applies. */
export function findSummaryBoundaryIndex(messages: readonly ContextUpdateMessage[]): number {
  return findSummarySegment(messages).visibleFrom;
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
 * dated it in the prompt, so later turns render the same timestamp. Only with
 * `promptCache.stableContext` or `promptMessageTimestamps`, the two features
 * that read it back.
 */
export function getTurnUserMessageCreatedAt(
  req:
    | { turnStartedAt?: number; config?: PromptCacheConfig & PromptTimestampConfig }
    | null
    | undefined,
): Date | undefined {
  const turnStartedAt = req?.turnStartedAt;
  if (
    turnStartedAt == null ||
    !Number.isFinite(turnStartedAt) ||
    !(isStableContextEnabled(req?.config) || isPromptMessageTimestampsEnabled(req?.config))
  ) {
    return undefined;
  }
  return new Date(turnStartedAt);
}

/** The context changes a turn's user message announced, set on the request by `buildMessages`. */
export interface TurnContextUpdates {
  messageId: string;
  entries: ContextEntry[];
}

/** Entries to store with `messageId` when it is the user message this turn announced them on. */
export function getTurnContextUpdates(
  req: { turnContextUpdates?: TurnContextUpdates } | null | undefined,
  messageId: string | null | undefined,
): ContextEntry[] | undefined {
  const updates = req?.turnContextUpdates;
  return updates != null && messageId != null && updates.messageId === messageId
    ? updates.entries
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

interface PromptTimestampConfig {
  endpoints?: { agents?: { promptMessageTimestamps?: boolean } };
}

function isPromptMessageTimestampsEnabled(config?: PromptTimestampConfig | null): boolean {
  return config?.endpoints?.agents?.promptMessageTimestamps === true;
}

/** The request fields that date a conversation's messages in the prompt. */
export interface HistoryContextRequest {
  conversationCreatedAt?: Instant | null;
  turnStartedAt?: Instant | null;
  body?: { timezone?: string } | null;
  config?: PromptCacheConfig & PromptTimestampConfig;
}

/** Context notes for the history of one request, applied message by message. */
export interface HistoryContextUpdates {
  /**
   * Prepends the note for the history message at `index` to its prompt copy.
   * Returns the note, or `undefined` when that message has none.
   */
  apply(formattedMessage: FormattedMessageWithContent, index: number): string | undefined;
  /** The note of each message that has one, by message index. */
  readonly updates: ReadonlyMap<number, string>;
  /** Whether any message has a note, so the prompt differs from what is stored. */
  readonly hasUpdates: boolean;
}

/**
 * Computes the date-change and send-time notes of a request's history. Date
 * changes are announced only with `promptCache.stableContext` and when an
 * agent states the conversation date; send times only with
 * `promptMessageTimestamps`.
 */
export function createHistoryContextUpdates({
  req,
  messages,
  agents,
}: {
  req: HistoryContextRequest;
  messages: readonly ContextUpdateMessage[];
  agents: Iterable<{ dynamicToolContextMap?: Record<string, unknown> } | null | undefined>;
}): HistoryContextUpdates {
  const updates = buildUserMessageContextUpdates({
    messages,
    conversationStartedAt: req.conversationCreatedAt,
    currentTurnStartedAt: req.turnStartedAt,
    timezone: req.body?.timezone,
    trackDateChanges: isStableContextEnabled(req.config) && hasConversationDateContext(agents),
    includeTimestamps: isPromptMessageTimestampsEnabled(req.config),
  });
  return {
    updates,
    hasUpdates: updates.size > 0,
    apply(formattedMessage, index) {
      const update = updates.get(index);
      if (update != null) {
        prependContextText(formattedMessage, update, '\n\n');
      }
      return update;
    },
  };
}
