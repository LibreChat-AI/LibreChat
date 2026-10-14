import type { ContextEntry, ContextSource, SendSnapshot } from './registry';
import type { TurnContextMessage } from './anchor';
import {
  ContextSourceKeys,
  getWithheldKeys,
  renderAnchorText,
  findContextSource,
  compareContextKeys,
  collectLiveContext,
} from './registry';
import type { ToolPlan } from './tools';
import { createAnchor, reanchor, readEntries } from './anchor';
import { findSummarySegment, formatContextUpdate } from '../contextUpdates';
import { isToolGroupKey, planTools } from './tools';

export interface TurnPlan {
  /** What the model knows from the system prompt in this segment, in system order. */
  anchor: ContextEntry[];
  /** Set when this turn opened the segment: where to store `anchor` (null: the conversation). */
  anchorTarget?: { messageId: string | null };
  /** The `<context_update>` block of each user message that has one, by message index. */
  updates: Map<number, string>;
  /** Entries to store on the user message sent this turn; undefined when none is sent. */
  currentEntries?: ContextEntry[];
  /** Keys whose text reaches the model nowhere this turn. */
  withheld: Set<string>;
  /** System prompt text of the anchor. */
  block: string;
  /** System prompt text of the anchored memory; empty when the segment has none or it is withheld. */
  memoryBlock: string;
  /** Memory texts the request carries, for content inspection. */
  memoryTexts: string[];
  /** Retrieved file context the request carries, for content inspection. */
  ragTexts: string[];
  /** The tools this turn binds; undefined when the snapshot sampled no tool groups. */
  tools?: ToolPlan;
}

function diffLive(
  known: ReadonlyMap<string, string>,
  live: ReadonlyMap<string, string>,
  withheld: ReadonlySet<string>,
  unavailable: ReadonlySet<string>,
): ContextEntry[] {
  const entries: ContextEntry[] = [];
  for (const key of [...new Set([...known.keys(), ...live.keys()])].sort(compareContextKeys)) {
    const source = findContextSource(key);
    const value = live.get(key) ?? null;
    if (source == null) {
      continue;
    }
    if (source.kind === 'message') {
      if (value != null) {
        entries.push({ key, value });
      }
      continue;
    }
    if (
      withheld.has(key) ||
      /** Unreachable for now, not switched off: the model keeps knowing it. */
      (value == null && unavailable.has(key)) ||
      (value == null && source.whenOff === 'silent')
    ) {
      continue;
    }
    const previous = known.get(key) ?? null;
    const stored = source.diff != null ? source.diff(previous, value) : value;
    if (stored === undefined || (source.diff == null && value === previous)) {
      continue;
    }
    entries.push({ key, value: stored });
  }
  return entries;
}

/** The anchor the segment before `carrier` started from, which orders a new one. */
function previousAnchor(
  messages: readonly TurnContextMessage[],
  carrier: number,
  conversationAnchor: readonly ContextEntry[] | null | undefined,
): readonly ContextEntry[] | null | undefined {
  const earlier = findSummarySegment(messages.slice(0, carrier)).carrier;
  return earlier >= 0 ? messages[earlier].contextAnchor : conversationAnchor;
}

interface Fold {
  known: Map<string, string>;
  /** The last value each key had at some point of the segment, kept after it is switched off. */
  lastSeen: Map<string, string>;
  withheld: ReadonlySet<string>;
  snapshot: SendSnapshot;
  memoryTexts: string[];
  ragTexts: string[];
}

function renderEntry(
  fold: Fold,
  source: ContextSource,
  { key, value }: ContextEntry,
  inSegment: boolean,
): string | undefined {
  if (source.kind === 'message') {
    if (value == null) {
      return undefined;
    }
    if (key === ContextSourceKeys.rag) {
      fold.ragTexts.push(value);
    }
    return source.renderUpdate(key, value, null, fold.snapshot.agent);
  }
  /** Changes stored before the segment's anchor are part of it already. */
  if (!inSegment) {
    return undefined;
  }
  const previous = fold.known.get(key) ?? null;
  const state = value != null && source.apply != null ? source.apply(previous, value) : value;
  if (state === previous) {
    return undefined;
  }
  const wasKnown = fold.lastSeen.has(key);
  const lastSeen = fold.lastSeen.get(key) ?? null;
  if (state == null) {
    fold.known.delete(key);
  } else {
    fold.known.set(key, state);
    fold.lastSeen.set(key, state);
  }
  if (fold.withheld.has(key) || (value == null && source.whenOff === 'silent')) {
    return undefined;
  }
  const line = source.renderUpdate(key, value, previous, fold.snapshot.agent, wasKnown, lastSeen);
  if (key === ContextSourceKeys.memory && value != null) {
    fold.memoryTexts.push(line);
  }
  return line;
}

/**
 * Plans the context of one turn on a conversation branch.
 *
 * The model knows the segment's anchor from the system prompt plus the changes
 * announced on the user messages it still sees after the anchor. The user
 * message sent this turn (`currentIndex`) gets the net difference between the
 * live sources and that knowledge, which the caller stores with it; every other
 * message renders its stored entries. Only stored data decides a message's
 * block, so it renders the same bytes on every later turn of the segment.
 *
 * A segment without a stored anchor is anchored to the live state this turn:
 * the conversation's first turn, the first turn after a compaction (keeping
 * the previous anchor's order), or the first turn of a conversation started
 * before anchors existed.
 */
export function planTurnContext({
  messages,
  conversationAnchor,
  snapshot,
  currentIndex,
}: {
  messages: readonly TurnContextMessage[];
  conversationAnchor?: readonly ContextEntry[] | null;
  snapshot: SendSnapshot;
  currentIndex?: number;
}): TurnPlan {
  const { carrier, visibleFrom } = findSummarySegment(messages);
  const stored = carrier >= 0 ? messages[carrier].contextAnchor : conversationAnchor;
  const storedAnchor = stored != null ? readEntries(stored) : undefined;
  const sendSnapshot: SendSnapshot = {
    ...snapshot,
    dateContext:
      snapshot.dateContext ||
      (storedAnchor?.some(({ key }) => key === ContextSourceKeys.date) ?? false),
  };
  const live = collectLiveContext(sendSnapshot);

  let anchor: ContextEntry[];
  let anchorTarget: TurnPlan['anchorTarget'];
  if (storedAnchor != null) {
    anchor = storedAnchor;
  } else if (carrier < 0) {
    anchor = createAnchor(live);
    anchorTarget = { messageId: null };
  } else {
    const previous = readEntries(previousAnchor(messages, carrier, conversationAnchor));
    anchor = reanchor(previous, live);
    const messageId = messages[carrier].messageId;
    anchorTarget = typeof messageId === 'string' && messageId !== '' ? { messageId } : undefined;
  }

  const known = new Map<string, string>();
  for (const { key, value } of anchor) {
    if (value != null) {
      known.set(key, value);
    }
  }
  const withheld = getWithheldKeys(live, known.keys());
  const fold: Fold = {
    known,
    lastSeen: new Map(known),
    withheld,
    snapshot: sendSnapshot,
    memoryTexts: [],
    ragTexts: [],
  };
  const anchorMemory = known.get(ContextSourceKeys.memory);
  if (anchorMemory != null && !withheld.has(ContextSourceKeys.memory)) {
    fold.memoryTexts.push(anchorMemory);
  }
  const memoryBlock =
    anchorMemory != null && !withheld.has(ContextSourceKeys.memory)
      ? renderAnchorText(ContextSourceKeys.memory, anchorMemory, sendSnapshot.agent)
      : '';
  const block = anchor
    .filter(({ key, value }) => value != null && !withheld.has(key))
    .map(({ key, value }) => renderAnchorText(key, value as string, sendSnapshot.agent))
    .filter((text) => text !== '')
    .join('\n\n');

  const updates = new Map<number, string>();
  let currentEntries: ContextEntry[] | undefined;
  for (let i = visibleFrom; i < messages.length; i++) {
    const message = messages[i];
    if (message.isCreatedByUser !== true) {
      continue;
    }
    let entries: ContextEntry[];
    if (i === currentIndex) {
      currentEntries = diffLive(
        known,
        live,
        withheld,
        snapshot.toolGroups?.unavailable ?? new Set(),
      );
      entries = currentEntries;
    } else {
      entries = readEntries(message.contextUpdates);
    }
    const lines: string[] = [];
    for (const entry of [...entries].sort((a, b) => compareContextKeys(a.key, b.key))) {
      const line = renderEntry(
        fold,
        findContextSource(entry.key) as ContextSource,
        entry,
        i > carrier,
      );
      if (line) {
        lines.push(line);
      }
    }
    if (lines.length > 0) {
      updates.set(i, formatContextUpdate(lines));
    }
  }

  /** Bound once the branch has used tool groups, so `tools` stays fixed from then on. */
  const hasToolGroups = (entries: readonly ContextEntry[] | null | undefined) =>
    entries?.some(({ key }) => isToolGroupKey(key)) === true;
  const dispatch =
    hasToolGroups(anchor) ||
    hasToolGroups(currentEntries) ||
    messages.some(({ contextUpdates }, i) => i !== currentIndex && hasToolGroups(contextUpdates));

  return {
    anchor,
    anchorTarget,
    updates,
    currentEntries,
    withheld,
    block,
    memoryBlock,
    memoryTexts: fold.memoryTexts,
    ragTexts: fold.ragTexts,
    /** Without any group, now or earlier in the branch, the tools stay as loaded. */
    tools:
      snapshot.toolGroups != null && (dispatch || snapshot.toolGroups.groups.size > 0)
        ? planTools({ agent: snapshot.agent, anchor, toolGroups: snapshot.toolGroups, dispatch })
        : undefined,
  };
}
