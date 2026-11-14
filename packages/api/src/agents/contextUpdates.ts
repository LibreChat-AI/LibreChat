import { Tools, replaceSpecialVars } from 'librechat-data-provider';
import type { ContextEntry } from './turnContext/registry';
import type { PromptCacheConfig } from './promptCache';
import { getPromptTime, isStableContextEnabled } from './promptCache';
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

/** `dynamicToolContextMap` key of agent instructions resolved from temporal special variables. */
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

/**
 * Insert-time `createdAt` for this turn's user message: the turn start that
 * dated it in the prompt, so later turns render the same note. Only with
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

function isValidInstant(value: Instant | null | undefined): value is Instant {
  return value != null && !Number.isNaN(new Date(value).getTime());
}

/**
 * Notes to prepend to the prompt copies of a request's history, by message index.
 * Every note derives from stored message times and the conversation start, so a
 * message renders the same on every later turn; the current message is not
 * stored yet and is dated by the turn start.
 *
 * - With `promptCache.stableContext`, when an agent's prompt states the
 *   conversation date: a user message sent on a later local date announces it,
 *   and later messages compare against that date. After a summary the
 *   comparison restarts from the conversation start.
 * - With `promptMessageTimestamps`: every visible user message states when it was sent.
 *
 * Notes are rendered in the request's timezone, so a user who switches timezones
 * mid-conversation re-renders earlier notes once (one prefix-cache miss).
 */
export function buildHistoryContextUpdates({
  req,
  messages,
  agents,
}: {
  req: {
    config?: PromptCacheConfig & PromptTimestampConfig;
    turnStartedAt?: number;
    conversationCreatedAt?: string;
    body?: { timezone?: string } | null;
  };
  messages: readonly ContextUpdateMessage[];
  agents: Iterable<{ dynamicToolContextMap?: Record<string, unknown> } | null | undefined>;
}): Map<number, string> {
  const updates = new Map<number, string>();
  const trackDateChanges = isStableContextEnabled(req.config) && hasConversationDateContext(agents);
  const includeTimestamps = isPromptMessageTimestampsEnabled(req.config);
  if (!trackDateChanges && !includeTimestamps) {
    return updates;
  }

  const format = (text: string, now: Instant) =>
    replaceSpecialVars({ text, now, timezone: req.body?.timezone });
  const anchor = getPromptTime(req.config, req);
  let lastSeenDate = isValidInstant(anchor) ? format('{{current_date}}', anchor) : undefined;
  const lastIndex = messages.length - 1;
  for (let i = findSummarySegment(messages).visibleFrom; i < messages.length; i++) {
    const message = messages[i];
    const sentAt = message.createdAt ?? (i === lastIndex ? req.turnStartedAt : undefined);
    if (message.isCreatedByUser !== true || !isValidInstant(sentAt)) {
      continue;
    }

    const lines: string[] = [];
    if (trackDateChanges) {
      const date = format('{{current_date}}', sentAt);
      if (lastSeenDate != null && date !== lastSeenDate) {
        lines.push(`Current date changed to: ${date}`);
      }
      lastSeenDate = date;
    }
    if (includeTimestamps) {
      lines.push(`Message sent: ${format('{{current_datetime}}', sentAt)}`);
    }
    if (lines.length > 0) {
      updates.set(i, formatContextUpdate(lines));
    }
  }
  return updates;
}
