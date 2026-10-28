import type { TMessage, TResponseUsage } from 'librechat-data-provider';
import { BranchUsage, TokenEntry, hasKnownCost, normalizeTokenCount } from './types';

/** Module-level token index: conversationId → messageId → entry. Not render state. */
export const registry: Map<string, Map<string, TokenEntry>> = new Map();

/**
 * Sticky per-response usage: conversationId → messageId → usage. Written only by
 * the live finalize/stop flush (`setEntryUsage`) and never rebuilt from the
 * messages cache, so a response's usage survives mid-session index rebuilds even
 * when its cache message lacks `metadata.usage` AND it was transiently dropped
 * from the cache (e.g. a sibling branch during a regenerate). `buildIndex`
 * restores from here so branch cost persists across branch switches, the cost
 * analog of `snapshotsByAnchorFamily` for the breakdown. Cleared on convo switch.
 */
export const usageHistory: Map<string, Map<string, BranchUsage>> = new Map();

export function stickyUsage(conversationId: string, messageId: string): BranchUsage | undefined {
  return usageHistory.get(conversationId)?.get(messageId);
}

/** Reads the persisted per-response usage rollup off a message's metadata.
 *  The backend already normalized per-event into display units, so this reads
 *  them directly. Absent for user messages and pre-feature responses (they
 *  contribute 0 to branch/total). */
export function readPersistedUsage(message: Partial<TMessage>): BranchUsage | undefined {
  const usage = message.metadata?.usage;
  if (usage == null || typeof usage !== 'object') {
    return undefined;
  }
  const persisted = usage as TResponseUsage;
  return {
    input: normalizeTokenCount(persisted.input),
    output: normalizeTokenCount(persisted.output),
    cacheWrite: normalizeTokenCount(persisted.cacheWrite),
    cacheRead: normalizeTokenCount(persisted.cacheRead),
    cost: hasKnownCost(persisted.cost) ? persisted.cost : 0,
    /** Cost is omitted (or malformed) when saved with `contextCost` off, don't
     * render a misleading $0.00. */
    costKnown: hasKnownCost(persisted.cost),
  };
}

/** Pure sum of two usage records, for combining branch/total with pending. */
export function mergeUsage(a: BranchUsage, b: BranchUsage): BranchUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    cost: a.cost + b.cost,
    /** Coverage stays complete only if BOTH sides are complete */
    costKnown: a.costKnown && b.costKnown,
  };
}

/** Accumulates one entry's usage into a running total (in place). */
export function addUsage(target: BranchUsage, usage?: BranchUsage): void {
  if (usage == null) {
    return;
  }
  target.input += usage.input;
  target.output += usage.output;
  target.cacheWrite += usage.cacheWrite;
  target.cacheRead += usage.cacheRead;
  target.cost += usage.cost;
  /** A usage-bearing entry without a cost breaks complete coverage */
  if (!usage.costKnown) {
    target.costKnown = false;
  }
}

type ToolCallLengthFields = {
  args?: unknown;
  output?: unknown;
  argsLength?: unknown;
  outputLength?: unknown;
};

/** Stored lengths of a tool call's arguments and output. A preview carries the full lengths in
 *  `argsLength`/`outputLength`, so estimates match the conversation the model actually sees. */
export function toolCallLengths(call: ToolCallLengthFields): { args: number; output: number } {
  let args = 0;
  if (typeof call.argsLength === 'number') {
    args = call.argsLength;
  } else if (typeof call.args === 'string') {
    args = call.args.length;
  } else if (call.args != null) {
    args = JSON.stringify(call.args)?.length ?? 0;
  }
  let output = 0;
  if (typeof call.outputLength === 'number') {
    output = call.outputLength;
  } else if (typeof call.output === 'string') {
    output = call.output.length;
  }
  return { args, output };
}

/** Chars of a content part's text, handling both the string and `{ value }` forms.
 * Reasoning (`think`) and error parts are excluded, the send path strips them
 * before counting, so they aren't part of the next call's context. */
export function partTextChars(part: unknown): number {
  if (part == null || typeof part !== 'object') {
    return 0;
  }
  const type = (part as { type?: unknown }).type;
  if (type === 'think' || type === 'error') {
    return 0;
  }
  if (type === 'tool_call') {
    const call = (part as { tool_call?: ToolCallLengthFields & { name?: unknown } }).tool_call;
    if (call == null) {
      return 0;
    }
    const lengths = toolCallLengths(call);
    return (typeof call.name === 'string' ? call.name.length : 0) + lengths.args + lengths.output;
  }
  const text = (part as { text?: unknown }).text;
  if (typeof text === 'string') {
    return text.length;
  }
  if (
    text != null &&
    typeof text === 'object' &&
    typeof (text as { value?: unknown }).value === 'string'
  ) {
    return (text as { value: string }).value.length;
  }
  return 0;
}

/** Char length of a message's tool-call payload, tool_call parts' name, args
 *  and output, the estimate path's split of message body into conversation vs
 *  tool-call usage. Zero for plain-text bodies. */
export function messageToolChars(message: Partial<TMessage>): {
  chars: number;
  resultChars: number;
} {
  if (!Array.isArray(message.content)) {
    return { chars: 0, resultChars: 0 };
  }
  let chars = 0;
  let resultChars = 0;
  for (const part of message.content) {
    if (part == null || typeof part !== 'object') {
      continue;
    }
    if ('type' in part && part.type === 'tool_call' && 'tool_call' in part) {
      const call = part.tool_call;
      if (call == null || typeof call !== 'object') {
        continue;
      }
      if ('name' in call && typeof call.name === 'string') {
        chars += call.name.length;
      }
      const lengths = toolCallLengths(call as ToolCallLengthFields);
      chars += 'args' in call && call.args == null ? 4 : lengths.args;
      chars += lengths.output;
      resultChars += lengths.output;
    }
  }
  return { chars, resultChars };
}

/** Char length of a message's rendered text, for estimating count-less messages.
 *  Prefer structured `content` when present, the send path formats from it (incl.
 *  tool calls), so a message carrying both `text` and `content` (e.g. a stopped
 *  agent response) would otherwise drop its content/tool-call tokens. */
export function messageChars(message: Partial<TMessage>): number {
  if (Array.isArray(message.content) && message.content.length > 0) {
    let chars = 0;
    for (const part of message.content) {
      chars += partTextChars(part);
    }
    return chars;
  }
  if (typeof message.text === 'string') {
    return message.text.length;
  }
  return 0;
}

/** Quoted excerpts the send path merges into a user message's prompt. */
export function quoteChars(message: Partial<TMessage>): number {
  if (!Array.isArray(message.quotes)) {
    return 0;
  }
  let chars = 0;
  for (const quote of message.quotes) {
    if (typeof quote === 'string') {
      chars += quote.length;
    }
  }
  return chars;
}

export function toEntry(message: Partial<TMessage>): TokenEntry {
  const summaryUsedTokens = normalizeTokenCount(message.metadata?.summaryUsedTokens);
  const tokenCount = normalizeTokenCount(message.tokenCount);
  const isCreatedByUser = message.isCreatedByUser === true;
  const quoted = isCreatedByUser && Array.isArray(message.quotes) && message.quotes.length > 0;
  /** A quoted user turn's stored `tokenCount` is unreliable: a text-only Save edit
   *  recomputes it from `text` alone, and the send path recounts the quote-merged
   *  prompt every turn regardless (`needsCanonicalTokenCount` in agents/client.js).
   *  So mirror the server, estimate quoted turns from the merged text+quotes and
   *  ignore the stored count. Other count-less imports / pre-feature messages
   *  estimate from text. */
  let estTokens = 0;
  if (quoted) {
    estTokens = Math.round((messageChars(message) + quoteChars(message)) / 4);
  } else if (tokenCount === 0) {
    estTokens = Math.round(messageChars(message) / 4);
  }
  const toolChars = messageToolChars(message);
  return {
    tokenCount: quoted ? 0 : tokenCount,
    estTokens,
    estToolTokens: Math.round(toolChars.chars / 4),
    estToolResultTokens: Math.round(toolChars.resultChars / 4),
    isCreatedByUser,
    parentMessageId: message.parentMessageId ?? null,
    usage: readPersistedUsage(message),
    summaryUsedTokens: summaryUsedTokens > 0 ? summaryUsedTokens : undefined,
  };
}

/** Full O(n) rebuild, only on discrete cache replacements (load, refetch, edits).
 *  Restores a response's `usage` from the sticky history when the rebuilt message
 *  carries none: per-message usage is immutable and the live finalize flushes it
 *  into the index (`setEntryUsage`) before the persisted `metadata.usage` reaches
 *  the cache, so a mid-session rebuild (e.g. during regenerate) must not wipe an
 *  earlier branch's flushed usage, which would drop its branch cost on switch. */
export function buildIndex(conversationId: string, messages?: TMessage[] | null): void {
  const index = new Map<string, TokenEntry>();
  if (messages != null) {
    for (const message of messages) {
      if (message?.messageId) {
        const entry = toEntry(message);
        if (entry.usage == null) {
          entry.usage = stickyUsage(conversationId, message.messageId);
        }
        index.set(message.messageId, entry);
      }
    }
  }
  registry.set(conversationId, index);
}

/** Incremental upsert, final SSE events touch at most two entries */
export function upsertEntries(
  conversationId: string,
  messages: (Partial<TMessage> | null | undefined)[],
): void {
  let index = registry.get(conversationId);
  if (!index) {
    index = new Map<string, TokenEntry>();
    registry.set(conversationId, index);
  }
  for (const message of messages) {
    if (message?.messageId) {
      const entry = toEntry(message);
      if (entry.usage == null) {
        entry.usage = stickyUsage(conversationId, message.messageId);
      }
      index.set(message.messageId, entry);
    }
  }
}

/** Re-keys the index when `new` resolves to a real conversation id */
export function migrateIndex(fromId: string, toId: string): void {
  if (fromId === toId) {
    return;
  }
  const index = registry.get(fromId);
  if (index) {
    registry.delete(fromId);
    registry.set(toId, index);
  }
  const usage = usageHistory.get(fromId);
  if (usage) {
    usageHistory.delete(fromId);
    usageHistory.set(toId, usage);
  }
}

export function clearIndex(conversationId: string): void {
  registry.delete(conversationId);
  usageHistory.delete(conversationId);
}
