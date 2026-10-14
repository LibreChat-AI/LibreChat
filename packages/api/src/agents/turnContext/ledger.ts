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
import type { LiveToolGroups, ToolPlan } from './tools';
import { createAnchor, reanchor, readEntries } from './anchor';
import { findSummarySegment, formatContextUpdate } from '../contextUpdates';
import { findToolResets, isToolGroupKey, planTools } from './tools';

export interface TurnPlan {
  /** What the model knows from the system prompt in this segment, in system order. */
  anchor: ContextEntry[];
  /** Set when this turn opened the segment: where to store `anchor` (null: the conversation). */
  anchorTarget?: { messageId: string | null };
  /** Why this turn re-anchored a segment without a compaction (a declared reset). */
  reset?: string[];
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
      source.resets === true ||
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

interface Segment {
  /** The message that stores the segment's anchor; -1 when the conversation does. */
  carrier: number;
  /** The first message whose stored changes the anchor does not include. */
  eventsFrom: number;
  /** The first message the model sees. */
  visibleFrom: number;
}

/**
 * The segment the branch ends in. A compaction opens one after its summary; a
 * declared reset opens one on the user message that stores its anchor.
 */
function findSegment(messages: readonly TurnContextMessage[]): Segment {
  const { carrier, visibleFrom } = findSummarySegment(messages);
  for (let i = messages.length - 1; i > carrier; i--) {
    if (messages[i].isCreatedByUser === true && messages[i].contextAnchor != null) {
      return { carrier: i, eventsFrom: i, visibleFrom };
    }
  }
  return { carrier, eventsFrom: carrier + 1, visibleFrom };
}

/** The anchor the segment before `carrier` started from, which orders a new one. */
function previousAnchor(
  messages: readonly TurnContextMessage[],
  carrier: number,
  conversationAnchor: readonly ContextEntry[] | null | undefined,
): readonly ContextEntry[] | null | undefined {
  const earlier = findSegment(messages.slice(0, carrier)).carrier;
  return earlier >= 0 ? messages[earlier].contextAnchor : conversationAnchor;
}

/**
 * Changes the anchor cannot absorb as updates: a source that resets, compared
 * only when the anchor recorded it, and tool changes the dispatcher cannot reach.
 */
function findResets(
  anchor: readonly ContextEntry[],
  live: ReadonlyMap<string, string>,
  toolGroups: LiveToolGroups | undefined,
): string[] {
  const reasons = anchor
    .filter(
      ({ key, value }) =>
        findContextSource(key)?.resets === true && (live.get(key) ?? null) !== value,
    )
    .map(({ key }) => key.slice(ContextSourceKeys.segmentPrefix.length));
  return [...reasons, ...(toolGroups != null ? findToolResets(anchor, toolGroups) : [])];
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
 * before anchors existed. A sent message whose live state breaks the prefix
 * anyway (another model, agent setup or provider tools, a schema-profile
 * option, a tool group the dispatcher cannot reach) re-anchors the segment on
 * itself the same way, and the plan reports why.
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
  const segment = findSegment(messages);
  const { visibleFrom } = segment;
  let { carrier, eventsFrom } = segment;
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
  let reset: string[] | undefined;
  const resets =
    storedAnchor != null && currentIndex != null
      ? findResets(storedAnchor, live, snapshot.toolGroups)
      : [];
  const currentId = currentIndex != null ? messages[currentIndex]?.messageId : undefined;
  if (resets.length > 0 && typeof currentId === 'string' && currentId !== '') {
    anchor = reanchor(storedAnchor, live);
    anchorTarget = { messageId: currentId };
    reset = resets;
    carrier = currentIndex as number;
    eventsFrom = carrier;
  } else if (storedAnchor != null) {
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
        i >= eventsFrom,
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
    ...(reset != null && { reset }),
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
