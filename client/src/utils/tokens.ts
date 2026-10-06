import { Tools, Constants, inputTokensIncludesCache } from 'librechat-data-provider';
import type {
  TMessage,
  TResponseUsage,
  TTokenUsageEvent,
  TContextUsageEvent,
  TTokenBudgetBreakdown,
} from 'librechat-data-provider';

/** Provider-reported usage of one response, in display units (post-normalize). */
export interface BranchUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** Authoritative USD cost; 0 when `interface.contextCost` was off at save */
  cost: number;
  /** Whether cost coverage is COMPLETE — every usage-bearing response summed
   *  here carried a cost. Gates the cost row so a partial sum (some turns saved
   *  before cost display was on) never renders an under-reported total. Starts
   *  true (vacuous) and is ANDed; pair with `hasUsage` to require ≥1 entry. */
  costKnown: boolean;
}

export const EMPTY_USAGE: BranchUsage = {
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
  cost: 0,
  costKnown: true,
};
/** Token counts come from persisted/provider payloads. Keep malformed values
 * out of every aggregate so one bad event cannot turn the meter into NaN. */
export function normalizeTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
    : 0;
}

function hasKnownCost(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export interface TokenEntry {
  tokenCount: number;
  /** Char/4 token estimate used in place of `tokenCount`: count-less (imported /
   *  pre-feature) message bodies, plus quoted user turns (recounted from merged
   *  text+quotes, since the send path ignores their stored count). Includes
   *  tool-call name/args/output. Mutually exclusive with a counted `tokenCount`. */
  estTokens: number;
  /** Char/4 estimate of the tool-call share of the body (tool_call parts'
   *  name/args/output), for the estimate path's "Tool calls" split. Raw — sum
   *  sites clamp it to the entry's actual contribution. */
  estToolTokens: number;
  /** Tool results are outside a counted response’s model-completion total. */
  estToolResultTokens: number;
  isCreatedByUser: boolean;
  parentMessageId: string | null;
  /** Per-response provider usage from `metadata.usage` (response messages only) */
  usage?: BranchUsage;
  /** Pre-invoke compacted context size (`metadata.summaryUsedTokens`) for a
   *  response whose turn summarized. Caps the estimate so it stops re-summing
   *  the now-discarded pre-summary history. */
  summaryUsedTokens?: number;
}

export interface BranchTotals {
  /** Sum of user-message token counts on the active branch */
  input: number;
  /** Sum of assistant-message token counts on the active branch */
  output: number;
  /** Messages on the branch with a known tokenCount */
  counted: number;
  /** Total messages on the branch */
  total: number;
  /** Uncalibrated estimate sum for count-less branch messages (imports /
   *  pre-feature). Kept separate so known counts aren't re-estimated. */
  estTokens: number;
  /** The tail (latest) message's UNCOUNTED estimate — its own `estTokens` when
   *  it has no `tokenCount`, else 0. A live tail rides on `liveTokens`, so the
   *  estimate path drops this; a resumed partial that already carries a count
   *  stays in `output`, so nothing may be dropped for it. */
  tailEstTokens: number;
  /** Tool-call share of the branch estimate (`estToolTokens`, clamped per
   *  message to its contribution) — the estimate path's "Tool calls" split. */
  estToolTokens: number;
  /** The tail's clamped tool share on the same basis as `tailEstTokens`: 0 for a
   *  counted tail, so the split never drops tool traffic whose tokens the
   *  message total keeps. */
  tailEstToolTokens: number;
  tailId: string | null;
  /** Whether the latest run's anchor message is on this branch */
  containsAnchor: boolean;
  /** Provider usage/cost summed along the active branch */
  usage: BranchUsage;
  /** Recorded usage of the selected response, never an earlier ancestor's usage. */
  lastTurnUsage?: BranchUsage;
  /** Compacted-context baseline from the deepest summarized response on the
   *  branch (0 if none). The branch walk stops there, so `input`/`output` cover
   *  only the post-summary messages; the estimate adds this to avoid counting
   *  the discarded pre-summary history. */
  summaryBaseline: number;
}

export const EMPTY_BRANCH: BranchTotals = {
  input: 0,
  output: 0,
  counted: 0,
  total: 0,
  estTokens: 0,
  tailEstTokens: 0,
  estToolTokens: 0,
  tailEstToolTokens: 0,
  tailId: null,
  containsAnchor: false,
  usage: EMPTY_USAGE,
  summaryBaseline: 0,
};

/** Module-level token index: conversationId → messageId → entry. Not render state. */
const registry = new Map<string, Map<string, TokenEntry>>();

/**
 * Sticky per-response usage: conversationId → messageId → usage. Written only by
 * the live finalize/stop flush (`setEntryUsage`) and never rebuilt from the
 * messages cache, so a response's usage survives mid-session index rebuilds even
 * when its cache message lacks `metadata.usage` AND it was transiently dropped
 * from the cache (e.g. a sibling branch during a regenerate). `buildIndex`
 * restores from here so branch cost persists across branch switches — the cost
 * analog of `snapshotsByAnchorFamily` for the breakdown. Cleared on convo switch.
 */
const usageHistory = new Map<string, Map<string, BranchUsage>>();

function stickyUsage(conversationId: string, messageId: string): BranchUsage | undefined {
  return usageHistory.get(conversationId)?.get(messageId);
}

/** Reads the persisted per-response usage rollup off a message's metadata.
 *  The backend already normalized per-event into display units, so this reads
 *  them directly. Absent for user messages and pre-feature responses (they
 *  contribute 0 to branch/total). */
function readPersistedUsage(message: Partial<TMessage>): BranchUsage | undefined {
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
    /** Cost is omitted (or malformed) when saved with `contextCost` off — don't
     * render a misleading $0.00. */
    costKnown: hasKnownCost(persisted.cost),
  };
}

/** Pure sum of two usage records — for combining branch/total with pending. */
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
function addUsage(target: BranchUsage, usage?: BranchUsage): void {
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
function toolCallLengths(call: ToolCallLengthFields): { args: number; output: number } {
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
 * Reasoning (`think`) and error parts are excluded — the send path strips them
 * before counting, so they aren't part of the next call's context. */
function partTextChars(part: unknown): number {
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

/** Char length of a message's tool-call payload — tool_call parts' name, args
 *  and output — the estimate path's split of message body into conversation vs
 *  tool-call usage. Zero for plain-text bodies. */
function messageToolChars(message: Partial<TMessage>): { chars: number; resultChars: number } {
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
 *  Prefer structured `content` when present — the send path formats from it (incl.
 *  tool calls), so a message carrying both `text` and `content` (e.g. a stopped
 *  agent response) would otherwise drop its content/tool-call tokens. */
function messageChars(message: Partial<TMessage>): number {
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
function quoteChars(message: Partial<TMessage>): number {
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

function toEntry(message: Partial<TMessage>): TokenEntry {
  const summaryUsedTokens = normalizeTokenCount(message.metadata?.summaryUsedTokens);
  const tokenCount = normalizeTokenCount(message.tokenCount);
  const isCreatedByUser = message.isCreatedByUser === true;
  const quoted = isCreatedByUser && Array.isArray(message.quotes) && message.quotes.length > 0;
  /** A quoted user turn's stored `tokenCount` is unreliable: a text-only Save edit
   *  recomputes it from `text` alone, and the send path recounts the quote-merged
   *  prompt every turn regardless (`needsCanonicalTokenCount` in agents/client.js).
   *  So mirror the server — estimate quoted turns from the merged text+quotes and
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

/** Full O(n) rebuild — only on discrete cache replacements (load, refetch, edits).
 *  Restores a response's `usage` from the sticky history when the rebuilt message
 *  carries none: per-message usage is immutable and the live finalize flushes it
 *  into the index (`setEntryUsage`) before the persisted `metadata.usage` reaches
 *  the cache, so a mid-session rebuild (e.g. during regenerate) must not wipe an
 *  earlier branch's flushed usage — which would drop its branch cost on switch. */
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

/** Incremental upsert — final SSE events touch at most two entries */
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

export function hasIndex(conversationId: string): boolean {
  return registry.has(conversationId);
}

/** O(depth) walk from the branch tail up the parent chain */
export function sumBranch(
  conversationId: string,
  tailId: string | null | undefined,
  anchorId?: string | null,
): BranchTotals {
  const index = registry.get(conversationId);
  if (!index || !tailId) {
    return EMPTY_BRANCH;
  }

  const totals = {
    input: 0,
    output: 0,
    counted: 0,
    total: 0,
    estTokens: 0,
    estToolTokens: 0,
    containsAnchor: false,
  };
  /** The in-flight response, when streaming, is the branch tail and is covered
   *  by `liveTokens`; expose its estimate so the estimate path can drop it. A
   *  tail that already carries a `tokenCount` (a resumed partial response) is
   *  counted in `input`/`output` instead, and its tool share is inside
   *  `estToolTokens` clamped to that count — dropping either would leave the
   *  message total holding tokens whose tool share had been removed, so both
   *  tail figures are zero for a counted tail. */
  const tailEntry = index.get(tailId);
  const lastTurnUsage = tailEntry?.isCreatedByUser === false ? tailEntry.usage : undefined;
  const tailCounted = tailEntry != null && tailEntry.tokenCount > 0;
  const tailEstTokens = tailCounted ? 0 : (tailEntry?.estTokens ?? 0);
  const tailEstToolTokens = tailCounted
    ? 0
    : Math.min(tailEntry?.estToolTokens ?? 0, tailEntry?.estTokens ?? 0);
  let summaryBaseline = 0;
  const usage: BranchUsage = { ...EMPTY_USAGE };
  /** Once a summary marker is crossed, older turns are out of the CONTEXT WINDOW
   *  (subsumed by the baseline) — but their provider spend still happened, so the
   *  usage/cost walk continues to the root while context counting stops. */
  let contextCapped = false;
  let currentId: string | null = tailId;
  let guard = index.size;

  while (currentId && currentId !== Constants.NO_PARENT && guard-- > 0) {
    const entry: TokenEntry | undefined = index.get(currentId);
    if (!entry) {
      break;
    }
    totals.total += 1;
    /** Only match the anchor while still inside the active context window. An
     *  anchor OLDER than the deepest summary marker belongs to a pre-summary
     *  snapshot; treating it as on-branch would let `useTokenUsage` revive that
     *  stale breakdown (discarded history) over the summary-baseline estimate
     *  that `findBranchSnapshotAnchor` correctly refuses to recover. */
    if (!contextCapped && anchorId != null && currentId === anchorId) {
      totals.containsAnchor = true;
    }
    if (!contextCapped && entry.tokenCount > 0) {
      totals.counted += 1;
      if (entry.isCreatedByUser) {
        totals.input += entry.tokenCount;
      } else {
        totals.output += entry.tokenCount;
      }
    } else if (!contextCapped && entry.estTokens > 0) {
      totals.estTokens += entry.estTokens;
    }
    /** Tool-call share of this entry's contribution — a subset of the
     *  input/output/estimated rows, so it never adds to the gauge. */
    if (!contextCapped) {
      const contribution = entry.tokenCount > 0 ? entry.tokenCount : entry.estTokens;
      totals.estToolTokens += Math.min(entry.estToolTokens, contribution);
    }
    /** Cost/usage is cumulative spend — never truncated at the summary boundary. */
    addUsage(usage, entry.usage);
    /** This response's turn compacted the history: its own output is counted
     *  above; record the pre-invoke compacted baseline and stop counting context
     *  tokens for older (summarized-away) turns, but keep walking for cost. */
    if (!contextCapped && entry.summaryUsedTokens != null) {
      summaryBaseline = entry.summaryUsedTokens;
      contextCapped = true;
    }
    currentId = entry.parentMessageId;
  }

  return {
    ...totals,
    tailEstTokens,
    tailEstToolTokens,
    tailId,
    usage,
    lastTurnUsage,
    summaryBaseline,
  };
}

/**
 * Message tokens that would actually be sent for an over-window branch. The send
 * path prunes oldest-first to fit (`getMessagesWithinTokenLimit`), so walk the
 * branch newest→oldest and stop once the next message would exceed `budget`,
 * mirroring its "newest-that-fits" behavior for the gauge. Approximation: it omits
 * the instruction/tool-schema overhead and tool-call pairing the real pruner also
 * accounts for, which the client can't know for a snapshot-less branch — close
 * enough for an estimate, and superseded by an exact snapshot once generated.
 * `budget` is the message window (max minus the always-sent summary baseline);
 * when `excludeTail`, the in-flight tail response is skipped (it rides on
 * `liveTokens`). Per-message contribution matches `sumBranch`: stored `tokenCount`
 * when counted, else the char-based `estTokens`. Returns the kept total plus the
 * tool-call share of what was kept, so the estimate can split the Messages row.
 */
export function prunedBranchTokens(
  conversationId: string,
  tailId: string | null | undefined,
  budget: number,
  excludeTail: boolean,
): { tokens: number; toolTokens: number } {
  const index = registry.get(conversationId);
  if (!index || !tailId || budget <= 0) {
    return { tokens: 0, toolTokens: 0 };
  }

  let total = 0;
  let toolTotal = 0;
  let currentId: string | null = tailId;
  let guard = index.size;
  let isTail = true;

  while (currentId && currentId !== Constants.NO_PARENT && guard-- > 0) {
    const entry: TokenEntry | undefined = index.get(currentId);
    if (!entry) {
      break;
    }
    const skip = isTail && excludeTail;
    isTail = false;
    if (!skip) {
      const contribution = entry.tokenCount > 0 ? entry.tokenCount : entry.estTokens;
      if (total + contribution > budget) {
        break;
      }
      total += contribution;
      toolTotal += Math.min(entry.estToolTokens, contribution);
    }
    /** Pre-summary turns are subsumed by the baseline the caller already reserved,
     *  so stop after counting the summarizing turn — mirrors `sumBranch`. */
    if (entry.summaryUsedTokens != null && entry.summaryUsedTokens > 0) {
      break;
    }
    currentId = entry.parentMessageId;
  }
  return { tokens: total, toolTokens: toolTotal };
}

/**
 * One persisted snapshot's used-context reading, with the basis it was measured
 * on. `remaining` is the authoritative pre-invoke figure (`budget − remaining`);
 * `breakdown` is the instructions+summary+messages sum a snapshot saved before
 * `remainingContextTokens` existed still supports. The two measure different
 * quantities (the backend's remaining covers content the breakdown does not),
 * so a growth delta may only compare readings of the same basis.
 */
export interface AnchorReading {
  used: number;
  basis: 'remaining' | 'breakdown';
  configuration?: string;
}

/** Compare the measured call configuration, including fixed prompt overhead.
 * Older snapshots without call identity cannot establish comparability. */
export function snapshotConfiguration(
  snapshot: Pick<TContextUsageEvent, 'model' | 'provider' | 'agentId' | 'contextBudget'> & {
    breakdown?: Partial<TTokenBudgetBreakdown>;
  },
): string | undefined {
  if (!snapshot.model || !snapshot.provider) {
    return undefined;
  }
  return JSON.stringify([
    snapshot.model,
    snapshot.provider,
    snapshot.agentId,
    snapshot.contextBudget ?? snapshot.breakdown?.maxContextTokens,
    snapshot.breakdown?.instructionTokens,
    snapshot.breakdown?.toolSchemaTokens,
  ]);
}

/**
 * Used-token readings for every persisted snapshot on the viewed branch, oldest
 * → newest (the walk is tail→root, so results are reversed). Drives the growth
 * sparkline and the runway projection in the breakdown. Stops after a summarized
 * response — older snapshots describe discarded history, mirroring `sumBranch`.
 * A snapshot that carries neither basis is skipped rather than reported as
 * having consumed its entire budget.
 */
export function collectAnchorSeries(
  conversationId: string,
  tailId: string | null | undefined,
  anchors: ReadonlyMap<string, unknown>,
): AnchorReading[] {
  const index = registry.get(conversationId);
  if (!index || !tailId || anchors.size === 0) {
    return [];
  }

  const series: AnchorReading[] = [];
  let currentId: string | null = tailId;
  let guard = index.size;

  while (currentId && currentId !== Constants.NO_PARENT && guard-- > 0) {
    const entry: TokenEntry | undefined = index.get(currentId);
    if (!entry) {
      break;
    }
    const snapshot = anchors.get(currentId) as
      | (Partial<Omit<TContextUsageEvent, 'breakdown'>> & {
          breakdown?: Partial<TTokenBudgetBreakdown>;
        })
      | undefined;
    if (snapshot != null) {
      const budget = normalizeTokenCount(
        snapshot.contextBudget ?? snapshot.breakdown?.maxContextTokens,
      );
      const configuration = snapshotConfiguration(snapshot);
      /** Runway growth keeps the raw remaining basis, even if the gauge floors
       *  that reading to the breakdown; older snapshots use all breakdown parts. */
      if (snapshot.remainingContextTokens != null && budget > 0) {
        const remaining = normalizeTokenCount(snapshot.remainingContextTokens);
        series.push({ used: Math.max(0, budget - remaining), basis: 'remaining', configuration });
      } else {
        const used =
          normalizeTokenCount(
            snapshot.effectiveInstructionTokens ?? snapshot.breakdown?.instructionTokens,
          ) +
          normalizeTokenCount(snapshot.breakdown?.summaryTokens) +
          normalizeTokenCount(snapshot.breakdown?.messageTokens);
        if (used > 0) {
          series.push({ used, basis: 'breakdown', configuration });
        }
      }
    }
    if (entry.summaryUsedTokens != null && entry.summaryUsedTokens > 0) {
      break;
    }
    currentId = entry.parentMessageId;
  }
  return series.reverse();
}

/**
 * The branch's largest messages (context contributions), largest first — the
 * "what is eating my window" list. Same contribution rule as `sumBranch`:
 * stored `tokenCount` when counted, else the char-based `estTokens`.
 */
export function topBranchMessages(
  conversationId: string,
  tailId: string | null | undefined,
  limit = 3,
): Array<{ role: 'user' | 'assistant'; tokens: number }> {
  const index = registry.get(conversationId);
  if (!index || !tailId) {
    return [];
  }

  const items: Array<{ role: 'user' | 'assistant'; tokens: number }> = [];
  let currentId: string | null = tailId;
  let guard = index.size;
  let contextCapped = false;

  while (currentId && currentId !== Constants.NO_PARENT && guard-- > 0) {
    const entry: TokenEntry | undefined = index.get(currentId);
    if (!entry) {
      break;
    }
    if (!contextCapped) {
      const contribution = entry.tokenCount > 0 ? entry.tokenCount : entry.estTokens;
      if (contribution > 0) {
        items.push({ role: entry.isCreatedByUser ? 'user' : 'assistant', tokens: contribution });
      }
    }
    if (!contextCapped && entry.summaryUsedTokens != null && entry.summaryUsedTokens > 0) {
      contextCapped = true;
    }
    currentId = entry.parentMessageId;
  }
  return items.sort((a, b) => b.tokens - a.tokens).slice(0, limit);
}

/**
 * Tokens of the most recent exchange (the tail response plus the user turn it
 * answers) — what a summarization would KEEP. `excludeTail` skips an in-flight
 * tail (it rides on `liveTokens`), leaving the previous complete exchange.
 * The compaction preview is context tokens minus this.
 *
 * `summaryOutputTokens` removes an internal summarization's completion from a
 * tail whose turn compacted: the backend folds that pass into the response's
 * `tokenCount`, while the snapshot keeps it in `breakdown.summaryTokens` rather
 * than `messageTokens`. Leaving it in would subtract a summary the message
 * total never carried, understating the reclaim by the size of the summary.
 */
export function latestExchangeTokens(
  conversationId: string,
  tailId: string | null | undefined,
  excludeTail: boolean,
  summaryOutputTokens = 0,
): number {
  const index = registry.get(conversationId);
  if (!index || !tailId) {
    return 0;
  }
  const contribution = (entry: TokenEntry | undefined): number => {
    if (entry == null) {
      return 0;
    }
    /** Completion counts include call arguments, but tool results are separate.
     * Count-less content already estimates both. */
    return entry.tokenCount > 0 ? entry.tokenCount + entry.estToolResultTokens : entry.estTokens;
  };

  const tailEntry = index.get(tailId);
  const parentEntry = index.get(tailEntry?.parentMessageId ?? '');
  let tail = excludeTail ? 0 : contribution(tailEntry);
  /** Only a turn that actually summarized carries that completion; the marker
   *  persists on the response whose turn compacted. */
  if (tail > 0 && tailEntry?.summaryUsedTokens != null && tailEntry.summaryUsedTokens > 0) {
    tail = Math.max(0, tail - normalizeTokenCount(summaryOutputTokens));
  }
  return tail + contribution(parentEntry);
}

/**
 * Sums provider usage/cost across EVERY message in the conversation (all
 * branches, including regenerated/abandoned responses) — the conversation
 * total, shown alongside the branch figure when they differ.
 */
export function sumTotalUsage(conversationId: string): BranchUsage {
  const usage: BranchUsage = { ...EMPTY_USAGE };
  const index = registry.get(conversationId);
  if (!index) {
    return usage;
  }
  for (const entry of index.values()) {
    addUsage(usage, entry.usage);
  }
  return usage;
}

/**
 * Attaches a response's usage to its index entry AND the sticky usage history.
 * Used by the live finalize/stop flush. The history copy lets `buildIndex`
 * restore the usage after a rebuild (the persisted `metadata.usage` reaches
 * `buildIndex` on reload; the sticky copy covers the in-session window before
 * that, including a sibling transiently dropped from the cache on regenerate).
 */
export function setEntryUsage(conversationId: string, messageId: string, usage: BranchUsage): void {
  const costKnown =
    usage.costKnown === true &&
    typeof usage.cost === 'number' &&
    Number.isFinite(usage.cost) &&
    usage.cost >= 0;
  const safeUsage: BranchUsage = {
    input: normalizeTokenCount(usage.input),
    output: normalizeTokenCount(usage.output),
    cacheWrite: normalizeTokenCount(usage.cacheWrite),
    cacheRead: normalizeTokenCount(usage.cacheRead),
    cost: costKnown ? usage.cost : 0,
    costKnown,
  };
  /** Remember it durably first so a later rebuild — or a transient cache drop
   *  during regenerate — can restore it even when the entry isn't present yet. */
  let history = usageHistory.get(conversationId);
  if (!history) {
    history = new Map<string, BranchUsage>();
    usageHistory.set(conversationId, history);
  }
  history.set(messageId, safeUsage);
  const entry = registry.get(conversationId)?.get(messageId);
  if (entry) {
    entry.usage = safeUsage;
  }
}

/**
 * Walks the branch tail up the parent chain and returns the first message id
 * present in `anchors` — i.e. the deepest (most recent) stored snapshot anchor
 * on the viewed branch. Used to recover a branch's granular breakdown after a
 * later generation on a sibling branch overwrote the live snapshot.
 */
export function findBranchSnapshotAnchor(
  conversationId: string,
  tailId: string | null | undefined,
  anchors: ReadonlyMap<string, unknown>,
): string | null {
  const index = registry.get(conversationId);
  if (!index || !tailId || anchors.size === 0) {
    return null;
  }

  let currentId: string | null = tailId;
  let guard = index.size;

  while (currentId && currentId !== Constants.NO_PARENT && guard-- > 0) {
    if (anchors.has(currentId)) {
      return currentId;
    }
    const entry: TokenEntry | undefined = index.get(currentId);
    if (!entry) {
      break;
    }
    /** Stop at a summarized response that has no snapshot of its own: crossing it
     *  would recover an older PRE-summary snapshot (discarded history), which the
     *  summary-baseline estimate is meant to replace. */
    if (entry.summaryUsedTokens != null) {
      return null;
    }
    currentId = entry.parentMessageId;
  }

  return null;
}

export interface ToolTokenGroups {
  system: number;
  mcp: number;
  skills: number;
  subagents: number;
  systemDeferred: number;
  mcpDeferred: number;
}

export const EMPTY_TOOL_GROUPS: ToolTokenGroups = {
  system: 0,
  mcp: 0,
  skills: 0,
  subagents: 0,
  systemDeferred: 0,
  mcpDeferred: 0,
};

/**
 * Classifies per-tool schema tokens into display groups: built-in system
 * tools, MCP tools, skills, and subagents — with deferred (on-demand) tools
 * split out for the system/MCP groups.
 */
export function groupToolTokens(
  toolTokenCounts?: Record<string, number>,
  deferredToolNames?: string[],
): ToolTokenGroups {
  if (toolTokenCounts == null) {
    return EMPTY_TOOL_GROUPS;
  }
  const deferred = new Set(deferredToolNames ?? []);
  const groups = { ...EMPTY_TOOL_GROUPS };
  for (const [name, rawTokens] of Object.entries(toolTokenCounts)) {
    const tokens = normalizeTokenCount(rawTokens);
    if (tokens === 0) {
      continue;
    }
    if (name === Tools.skill) {
      groups.skills += tokens;
    } else if (name === Constants.SUBAGENT) {
      groups.subagents += tokens;
    } else if (name.includes(Constants.mcp_delimiter)) {
      if (deferred.has(name)) {
        groups.mcpDeferred += tokens;
      } else {
        groups.mcp += tokens;
      }
    } else if (deferred.has(name)) {
      groups.systemDeferred += tokens;
    } else {
      groups.system += tokens;
    }
  }
  return groups;
}

function getOutputChars(part: unknown): number | null {
  if (part == null || typeof part !== 'object') {
    return null;
  }
  const { text, think } = part as { text?: unknown; think?: unknown };
  if (typeof text === 'string') {
    return text.length;
  }
  if (typeof think === 'string') {
    return think.length;
  }
  return null;
}

/**
 * Chars of the contiguous text/think parts at the very END of aggregated
 * content — the output the model is actively producing on the current call,
 * which the latest pre-invoke context snapshot does not yet account for.
 *
 * Crucially this does NOT skip a trailing tool-call part: once the model has
 * emitted a tool call, that call's text is already folded into the next
 * snapshot's `messageTokens`, so counting it would double-count against the
 * snapshot. A tool call at the end therefore yields 0 (nothing new in flight).
 */
export function countTrailingOutputChars(content?: unknown[] | null): number {
  if (!Array.isArray(content) || content.length === 0) {
    return 0;
  }
  let chars = 0;
  for (let i = content.length - 1; i >= 0; i--) {
    const partChars = getOutputChars(content[i]);
    if (partChars == null) {
      break;
    }
    chars += partChars;
  }
  return chars;
}

/** Rough live estimate for streaming text, calibrated by the last known provider ratio */
export function estimateTokens(charCount: number, calibrationRatio = 1): number {
  const chars = normalizeTokenCount(charCount);
  const ratio =
    typeof calibrationRatio === 'number' &&
    Number.isFinite(calibrationRatio) &&
    calibrationRatio > 0
      ? calibrationRatio
      : 1;
  return normalizeTokenCount(Math.round((chars / 4) * ratio));
}

/** Billable token quantities of one or more model calls, normalized for pricing */
export interface CostUnits {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * Normalizes one call's usage into billable units, mirroring the backend's
 * authoritative `splitUsage`/`resolveCompletionTokens`
 * (packages/api/src/agents/usage.ts):
 *   - cache classification is by provider, not magnitude — Bedrock keeps cache
 *     additive (input is uncached-only); Anthropic and OpenAI fold cache into
 *     `input_tokens`. Falls back to a magnitude heuristic only when
 *     the provider is unknown.
 *   - completion is repaired for providers (e.g. Vertex) that under-report
 *     `output_tokens` but carry the gap in `total_tokens`.
 * Applied per event so units stay correct when summed across calls.
 */
export function normalizeUsageUnits(usage: TTokenUsageEvent): CostUnits {
  const rawInput = normalizeTokenCount(usage.input_tokens);
  const rawOutput = normalizeTokenCount(usage.output_tokens);
  const total = normalizeTokenCount(usage.total_tokens);
  const cacheWrite = normalizeTokenCount(usage.input_token_details?.cache_creation);
  const cacheRead = normalizeTokenCount(usage.input_token_details?.cache_read);

  const includesCache =
    usage.provider != null
      ? inputTokensIncludesCache(usage.provider)
      : cacheWrite + cacheRead <= rawInput;

  const cacheAdjustment = includesCache ? 0 : cacheRead + cacheWrite;
  const output =
    total > rawInput + rawOutput + cacheAdjustment ? total - rawInput - cacheAdjustment : rawOutput;

  return {
    input: includesCache ? Math.max(0, rawInput - cacheRead - cacheWrite) : rawInput,
    output,
    cacheWrite,
    cacheRead,
  };
}

const tokenFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function formatTokens(count: number): string {
  const formatted = tokenFormatter.format(normalizeTokenCount(count));
  return formatted.replace(/\.0(?=[A-Za-z]|$)/, '');
}

/** Display currency for the context cost. `rate` is a static USD→local
 *  multiplier (no live FX); `code` is an ISO-4217 currency for Intl formatting. */
export interface CurrencyConfig {
  code: string;
  rate: number;
}

const DEFAULT_CURRENCY: CurrencyConfig = { code: 'USD', rate: 1 };
const currencyFormatters = new Map<string, Intl.NumberFormat>();
const currencyDigits = new Map<string, number>();
let supportedCurrencies: Set<string> | null | undefined;

/** True only for codes recognized as ISO-4217. `Intl.NumberFormat` accepts any
 *  well-formed three-letter code (e.g. `EUU`, `RMB`) without throwing, so the
 *  ISO-4217 set is the real guard against typo'd / non-ISO codes. */
function isSupportedCurrency(code: unknown): code is string {
  if (typeof code !== 'string' || code.length === 0) {
    return false;
  }
  const upper = code.toUpperCase();
  if (supportedCurrencies === undefined) {
    const supportedValuesOf = (
      Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf;
    supportedCurrencies =
      typeof supportedValuesOf === 'function' ? new Set(supportedValuesOf('currency')) : null;
  }
  if (supportedCurrencies != null) {
    return supportedCurrencies.has(upper);
  }
  /** Older runtime without `supportedValuesOf`: accept any code Intl can build. */
  try {
    new Intl.NumberFormat(undefined, { style: 'currency', currency: upper });
    return true;
  } catch {
    return false;
  }
}

/** Default fraction digits for a validated currency: USD→2, JPY→0, KWD→3. */
function maxFractionDigits(code: string): number {
  const cached = currencyDigits.get(code);
  if (cached !== undefined) {
    return cached;
  }
  const digits =
    new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  currencyDigits.set(code, digits);
  return digits;
}

function currencyFormatter(code: string, minDigits: number, maxDigits: number): Intl.NumberFormat {
  const key = `${code}:${minDigits}:${maxDigits}`;
  let formatter = currencyFormatters.get(key);
  if (formatter == null) {
    formatter = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: minDigits,
      maximumFractionDigits: maxDigits,
    });
    currencyFormatters.set(key, formatter);
  }
  return formatter;
}

export function formatCost(usd: number, currency: CurrencyConfig = DEFAULT_CURRENCY): string {
  /** Resolve to a safe (code, rate): an unsupported code falls back to USD AND
   *  rate 1 — never present a converted amount under the wrong symbol. A
   *  non-finite/negative rate (e.g. a partial admin override that set `code`
   *  before `rate`) falls back to 1 so a cost never renders as `NaN`. */
  let code = DEFAULT_CURRENCY.code;
  let rate = 1;
  if (isSupportedCurrency(currency?.code)) {
    code = currency.code.toUpperCase();
    rate = Number.isFinite(currency?.rate) && (currency.rate as number) > 0 ? currency.rate : 1;
  }
  const base = maxFractionDigits(code);

  const amount = (Number.isFinite(usd) && usd > 0 ? usd : 0) * rate;
  /** The currency's own minor unit — USD/EUR→0.01, JPY→1, KWD→0.001. */
  const smallest = Math.pow(10, -base);

  if (amount <= 0) {
    return currencyFormatter(code, base, base).format(0);
  }
  if (amount < smallest) {
    return `<${currencyFormatter(code, base, base).format(smallest)}`;
  }
  if (amount < 1 && base > 0) {
    /** Extra precision for sub-unit costs; trailing zeros trim to the currency's
     *  own scale (min = base). */
    return currencyFormatter(code, base, base + 2).format(amount);
  }
  return currencyFormatter(code, base, base).format(amount);
}
