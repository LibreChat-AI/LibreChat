import { Constants, ContentTypes } from 'librechat-data-provider';
import type { TMessage, TActivityLabelEvent, TMessageContentParts } from 'librechat-data-provider';
import { findResponseMessageIndex } from '~/utils/steer';
import { hasParallelLanes } from '~/utils/lanes';

type ActivityLabelPart = Extract<TMessageContentParts, { type: ContentTypes.ACTIVITY_LABEL }> & {
  activity_label_type?: 'phase';
  activity_start_index?: number;
  activity_end_index?: number;
  activity_count?: number;
  agent_ids?: string[];
};

export type ActivityPhaseSegment =
  | {
      type: 'content';
      content: Array<TMessageContentParts | undefined>;
      contentIndices: number[];
      startIndex: number;
    }
  | {
      type: 'phase';
      content: Array<TMessageContentParts | undefined>;
      contentIndices: number[];
      startIndex: number;
      labelPart: ActivityLabelPart;
      labelIndex: number;
      hasContent: boolean;
      /** Client-built card: no server phase marker covers this span yet, so
       *  the header carries the newest child label as a ticker instead of a
       *  generated summary. Set only by `synthesizeActivityFolds`. */
      synthesized?: boolean;
      /** A synthesized card over the span the run is still writing: it folds
       *  from the first tool call and keeps the in-flight tail inside, and its
       *  header is resolved at render from the newest activity in `content`. */
      live?: boolean;
    };

function isVisibleContentPart(part: TMessageContentParts | undefined): boolean {
  return (
    part != null &&
    !(
      part.type === ContentTypes.ACTIVITY_LABEL &&
      getActivityLabelText(getActivityLabelPart(part)).length === 0
    )
  );
}

function isLogicallyEarlierPhaseMarker(
  parts: ReadonlyArray<TMessageContentParts | undefined>,
  index: number,
): boolean {
  const part = parts[index];
  const label = getActivityLabelPart(part);
  if (!isPhaseActivityLabel(label) || typeof label?.activity_end_index !== 'number') {
    return false;
  }
  const endIndex = Math.max(0, Math.min(index, label.activity_end_index));
  if (endIndex >= index) {
    return false;
  }
  return Object.keys(parts).some((key) => {
    const trailingIndex = Number(key);
    if (trailingIndex < endIndex || trailingIndex >= index) {
      return false;
    }
    const trailingPart = parts[trailingIndex];
    if (!isVisibleContentPart(trailingPart)) {
      return false;
    }
    if (getBatchActivityLabelPart(trailingPart) != null) {
      return false;
    }
    if (trailingPart?.type !== ContentTypes.TEXT) {
      return true;
    }
    return textValue(trailingPart).length > 0;
  });
}

function findLateActivityLabelsConsumedByPhase(
  parts: ReadonlyArray<TMessageContentParts | undefined>,
): Set<number> {
  const consumed = new Set<number>();
  let earliestPhaseEnd: number | undefined;
  const definedIndices = Object.keys(parts);
  for (let position = definedIndices.length - 1; position >= 0; position -= 1) {
    const index = Number(definedIndices[position]);
    const marker = getActivityLabelPart(parts[index]);
    if (
      isPhaseActivityLabel(marker) &&
      marker?.pending !== true &&
      typeof marker?.activity_end_index === 'number'
    ) {
      earliestPhaseEnd = Math.min(earliestPhaseEnd ?? index, marker.activity_end_index);
    } else if (
      earliestPhaseEnd != null &&
      earliestPhaseEnd <= index &&
      getBatchActivityLabelPart(parts[index]) != null
    ) {
      consumed.add(index);
    }
  }
  return consumed;
}

export function isPhaseActivityLabel(part: ActivityLabelPart | undefined): boolean {
  return part?.activity_label_type === 'phase';
}

export function getBatchActivityLabelPart(
  part: TMessageContentParts | undefined,
): ActivityLabelPart | undefined {
  const label = getActivityLabelPart(part);
  return label != null && !isPhaseActivityLabel(label) ? label : undefined;
}

/** Returns the activity-label content part when `part` is one, else undefined. */
export function getActivityLabelPart(
  part: TMessageContentParts | undefined,
): ActivityLabelPart | undefined {
  return part?.type === ContentTypes.ACTIVITY_LABEL ? (part as ActivityLabelPart) : undefined;
}

/**
 * The generated description, or empty when none exists yet.
 *
 * There is deliberately NO fallback string. A templated stand-in
 * ("ran 1 command") only restates the tool card rendered directly beneath
 * it, and showing one changes the UI before anything worth reading exists.
 * Callers render nothing until this returns text.
 */
export function getActivityLabelText(part: ActivityLabelPart | undefined): string {
  if (!part) {
    return '';
  }
  const label = part[ContentTypes.ACTIVITY_LABEL];
  return typeof label === 'string' ? label.trim() : '';
}

/** Maps a completion-local half-open boundary into edited-response coordinates. */
export function offsetActivityPhaseBoundary(
  boundary: number,
  prefixLength: number,
  foldedFirstPart: boolean,
): number {
  return boundary + prefixLength - (foldedFirstPart && boundary <= 1 ? 1 : 0);
}

/**
 * Mirrors `SUBSTANTIAL_TEXT_CHARS` in `activityPhases/runtime.ts`. Short
 * commentary belongs inside a phase; a real block of prose ends one.
 */
const SUBSTANTIAL_TEXT_CHARS = 200;

/**
 * Activities a span needs before it is worth folding, matching the server's
 * `MIN_ACTIVITIES`. Below it the child groups already read as a short list
 * and a card would add a disclosure without hiding anything.
 */
const MIN_FOLD_ACTIVITIES = 2;

function textValue(part: TMessageContentParts | undefined): string {
  if (part?.type !== ContentTypes.TEXT) {
    return '';
  }
  return (typeof part.text === 'string' ? part.text : part.text?.value) ?? '';
}

/**
 * What an activity block may contain — the membership `groupSequentialToolCalls`
 * uses, plus `AGENT_UPDATE`, which the server deliberately keeps inside a phase
 * (a transfer card cannot join a tool group, so the parent card is where it
 * belongs). Everything absent here — an error, an image, a summary — is content
 * in its own right and ends the fold rather than disappearing into it.
 */
const ACTIVITY_BLOCK_TYPES = new Set<string>([
  ContentTypes.TOOL_CALL,
  ContentTypes.THINK,
  ContentTypes.ACTIVITY_LABEL,
  ContentTypes.AGENT_UPDATE,
]);

/**
 * True at a hard UI boundary — where a fold has to stop.
 *
 * Prose is the strictest case. `groupSequentialToolCalls` absorbs only
 * `commentary` text into an activity block, so anything else the model says is
 * an answer the reader came for and must never end up behind a disclosure —
 * including a two-word reply on a provider that never stamps `phase`, which
 * the server's own 200-character rule would let through. Long commentary ends
 * a fold too, matching `SUBSTANTIAL_TEXT_CHARS`, so a card cannot swallow an
 * essay. Steers and existing phase markers end one because the server says so.
 */
function isFoldBoundaryPart(part: TMessageContentParts | undefined): boolean {
  if (part == null) {
    return false;
  }
  if (isPhaseActivityLabel(getActivityLabelPart(part))) {
    return true;
  }
  if (part.type === ContentTypes.TEXT) {
    const text = textValue(part).trim();
    if (text.length === 0) {
      return false;
    }
    return (
      (part as { phase?: string }).phase !== 'commentary' || text.length > SUBSTANTIAL_TEXT_CHARS
    );
  }
  return !ACTIVITY_BLOCK_TYPES.has(part.type);
}

/**
 * True when the part is one an activity label can CLAIM. Mirrors
 * `isGroupableToolCall` plus the block's reasoning and commentary members: a
 * handoff call is never groupable, so a label covering only handoffs claims
 * nothing and renders standalone rather than heading a group.
 */
function claimsActivity(part: TMessageContentParts | undefined): boolean {
  if (part == null) {
    return false;
  }
  if (part.type === ContentTypes.THINK) {
    return true;
  }
  if (part.type === ContentTypes.TEXT) {
    return (part as { phase?: string }).phase === 'commentary';
  }
  if (part.type !== ContentTypes.TOOL_CALL) {
    return false;
  }
  const name = (part[ContentTypes.TOOL_CALL] as { name?: string } | undefined)?.name;
  return typeof name !== 'string' || !name.startsWith(Constants.LC_TRANSFER_TO_);
}

/**
 * A call a live row cannot stand for: a handoff, whose card names the
 * destination agent and can never join a group, or a legacy Assistants variant
 * (no top-level `args`), which the live header has no line for. Questions
 * and subagents also retain their own cards: optimistic answers, child
 * progress and detached-thread navigation are not carried by the outer part.
 */
function endsLiveSpan(part: TMessageContentParts | undefined): boolean {
  if (part?.type !== ContentTypes.TOOL_CALL) {
    return false;
  }
  const toolCall = part[ContentTypes.TOOL_CALL];
  return (
    !claimsActivity(part) ||
    toolCall == null ||
    !('args' in toolCall) ||
    toolCall.name === 'ask_user_question' ||
    toolCall.name === Constants.SUBAGENT
  );
}

type FoldRun = {
  content: Array<TMessageContentParts | undefined>;
  contentIndices: number[];
};

type SynthesizedPhaseHeader = {
  labelPart: ActivityLabelPart;
  labelIndex: number;
  /** Position in the run of the last filled child label — the fold's tail. */
  endPosition: number;
};

/**
 * Builds the header for a synthesized fold, or undefined when the span has not
 * accumulated enough filled child labels to be worth folding.
 *
 * The text is the NEWEST filled child label, which makes the collapsed row a
 * ticker: it reads as the line the reader would have seen at the bottom of the
 * unfolded list, and the generated summary replaces it verbatim once a real
 * phase marker claims the span.
 */
function buildSynthesizedPhaseLabel(run: FoldRun): SynthesizedPhaseHeader | undefined {
  let endPosition = -1;
  let text = '';
  let count = 0;
  let failed = 0;
  let degraded = 0;
  /** Parts available to the next label. Any label — blank reservation included
   *  — closes the claim, exactly as `claimStart` does in
   *  `groupSequentialToolCalls`, so a label can only ever claim its own batch. */
  let claimable = 0;
  for (let position = 0; position < run.content.length; position += 1) {
    const part = run.content[position];
    if (part?.type !== ContentTypes.ACTIVITY_LABEL) {
      /** A part the block cannot hold FLUSHES it in `groupSequentialToolCalls`
       *  — a handoff call, or the agent update beside it — so whatever came
       *  before is no longer claimable. Without the reset, `tool → transfer →
       *  label` reads as a claimed batch here while the grouping drops that
       *  label entirely through `coversTransferCall`. */
      claimable = claimsActivity(part) ? claimable + 1 : 0;
      continue;
    }
    const claimed = claimable;
    claimable = 0;
    const child = getBatchActivityLabelPart(part);
    const childText = getActivityLabelText(child);
    /** An orphan label heads no group — it renders as a standalone line. Two of
     *  them are not two activities, and folding them would hide the first
     *  behind a card whose body is just the pair of lines. */
    if (child == null || childText.length === 0 || claimed === 0) {
      continue;
    }
    count += 1;
    text = childText;
    endPosition = position;
    if (child.status === 'failed') {
      failed += 1;
      degraded += 1;
    } else if (child.status === 'partial') {
      degraded += 1;
    }
  }
  if (count < MIN_FOLD_ACTIVITIES || endPosition < 0) {
    return undefined;
  }
  const labelIndex = run.contentIndices[endPosition];
  let status: 'ok' | 'partial' | 'failed' = 'ok';
  if (failed === count) {
    status = 'failed';
  } else if (degraded > 0) {
    status = 'partial';
  }
  return {
    labelIndex,
    endPosition,
    labelPart: {
      type: ContentTypes.ACTIVITY_LABEL,
      [ContentTypes.ACTIVITY_LABEL]: text,
      activity_label_type: 'phase',
      activity_start_index: run.contentIndices[0],
      activity_end_index: labelIndex + 1,
      activity_count: count,
      status,
      /** Never summarized by a model, so it stays pending forever — which also
       *  keeps it out of `completed` if it is ever read back through here. */
      pending: true,
    } as ActivityLabelPart,
  };
}

/**
 * Builds the header for the span a run is still writing. It needs no filled
 * label — one claimable tool call is enough — because its purpose is to hold
 * the block at the single row it will settle into, rather than letting every
 * call add and remove rows on the way there. The text stays empty: the newest
 * line needs localization, so the renderer resolves it.
 */
function buildLivePhaseLabel(run: FoldRun): SynthesizedPhaseHeader | undefined {
  let activities = 0;
  let reasons = false;
  for (const part of run.content) {
    /** A thought counts from its first character. Left outside until a tool
     *  call arrived, it rendered as its own row with a multi-line peek that
     *  the first call then snapped shut — a grow-and-shrink on every step of a
     *  reasoning model that talks between calls. */
    if (part?.type === ContentTypes.THINK) {
      const thought = typeof part.think === 'string' ? part.think : (part.think?.value ?? '');
      reasons ||= thought.trim().length > 0;
      continue;
    }
    /** Only an agents-shaped call can be named by the live header; the legacy
     *  Assistants variants carry no top-level `args` and keep their own cards. */
    const toolCall = part?.type === ContentTypes.TOOL_CALL ? part[ContentTypes.TOOL_CALL] : null;
    if (toolCall != null && 'args' in toolCall && claimsActivity(part)) {
      activities += 1;
    }
  }
  if (activities === 0 && !reasons) {
    return undefined;
  }
  const endPosition = run.content.length - 1;
  const labelIndex = run.contentIndices[endPosition];
  return {
    labelIndex,
    endPosition,
    labelPart: {
      type: ContentTypes.ACTIVITY_LABEL,
      [ContentTypes.ACTIVITY_LABEL]: '',
      activity_label_type: 'phase',
      activity_start_index: run.contentIndices[0],
      activity_end_index: labelIndex + 1,
      activity_count: activities,
      status: 'ok',
      pending: true,
    } as ActivityLabelPart,
  };
}

/**
 * Splits one unclaimed content segment at its hard boundaries and folds every
 * run that carries enough labeled activity into a phase segment.
 *
 * This is why the module owns the partition: a run of labeled tool blocks is
 * one card whether the server has summarized it yet or not, so `ContentParts`
 * renders `ActivityPhaseGroup` either way and the card chrome has a single
 * definition. Returns the segment untouched when nothing folds, so a message
 * that never accumulates labeled activity keeps its exact prior shape.
 */
function synthesizeActivityFolds(
  segment: Extract<ActivityPhaseSegment, { type: 'content' }>,
  liveTail = false,
): ActivityPhaseSegment[] {
  const segments: ActivityPhaseSegment[] = [];
  const pending: FoldRun = { content: [], contentIndices: [] };
  const run: FoldRun = { content: [], contentIndices: [] };
  let folded = false;

  const flushPending = () => {
    if (pending.contentIndices.length === 0) {
      return;
    }
    segments.push({
      type: 'content',
      content: pending.content,
      contentIndices: pending.contentIndices,
      /** The leading chunk keeps the original span start; a sparse segment can
       *  begin before its first defined index and the nested renderer offsets
       *  from it. */
      startIndex: segments.length === 0 ? segment.startIndex : pending.contentIndices[0],
    });
    pending.content = [];
    pending.contentIndices = [];
  };
  const carryOver = (from: number) => {
    for (let position = from; position < run.content.length; position += 1) {
      pending.content.push(run.content[position]);
      pending.contentIndices.push(run.contentIndices[position]);
    }
  };
  const flushRun = (live = false) => {
    if (run.contentIndices.length === 0) {
      return;
    }
    const liveHeader = live ? buildLivePhaseLabel(run) : undefined;
    const header = liveHeader ?? buildSynthesizedPhaseLabel(run);
    if (header == null) {
      carryOver(0);
    } else {
      flushPending();
      folded = true;
      const content = run.content.slice(0, header.endPosition + 1);
      segments.push({
        type: 'phase',
        content,
        contentIndices: run.contentIndices.slice(0, header.endPosition + 1),
        startIndex: run.contentIndices[0],
        labelPart: header.labelPart,
        labelIndex: header.labelIndex,
        hasContent: content.some(isVisibleContentPart),
        synthesized: true,
        ...(liveHeader != null && { live: true }),
      });
      /** Everything past the newest label is still in flight — the reasoning
       *  and the tool call the reader is watching right now. It stays outside
       *  the card and joins on the commit where its own label fills. */
      carryOver(header.endPosition + 1);
    }
    run.content = [];
    run.contentIndices = [];
  };

  for (let position = 0; position < segment.content.length; position += 1) {
    const part = segment.content[position];
    const index = segment.contentIndices[position];
    /** Folding a call the header cannot stand for would hide its card for the
     *  rest of the run, so while streaming it ends the span the way prose
     *  does, and the calls after it start a live span of their own. */
    if (isFoldBoundaryPart(part) || (liveTail && endsLiveSpan(part))) {
      flushRun();
      pending.content.push(part);
      pending.contentIndices.push(index);
      continue;
    }
    run.content.push(part);
    run.contentIndices.push(index);
  }
  /** Only a run that reaches the end of the message is still being written; a
   *  boundary after it means the stream has moved on to something else. */
  flushRun(liveTail);
  flushPending();
  return folded ? segments : [segment];
}

/**
 * Partitions completed phase markers into collapsed parent groups while
 * carrying absolute indexes alongside compact content slices. Pending markers
 * preserve feature-off UI; finalized empty markers only restore child order.
 */
export function groupActivityPhases(
  content: Array<TMessageContentParts | undefined> | undefined,
  laneGroups?: ReadonlySet<number>,
  /** True while this message is the one the run is streaming into. */
  live = false,
): ActivityPhaseSegment[] | undefined {
  if (!content) {
    return undefined;
  }
  const definedIndices = Object.keys(content).map(Number);
  /** Parallel columns lay their own activity out and are rendered by
   *  `ParallelContentRenderer`, which a synthesized card would pull onto the
   *  phase path. Server markers may still claim parallel spans; only the
   *  client-built folds stand down. A group id alone is not enough: one that
   *  resolves to a single agent renders sequentially, so it folds like any
   *  other run.
   *
   *  `laneGroups` is the caller's own lane scan over this same content, and
   *  content is rewritten on every streamed delta — taking the answer rather
   *  than repeating the scan keeps a render to one pass. */
  const foldable = laneGroups != null ? laneGroups.size === 0 : !hasParallelLanes(content);
  const completed = definedIndices
    .map((index) => ({ part: getActivityLabelPart(content[index]), index }))
    .filter(
      ({ part }) =>
        isPhaseActivityLabel(part) &&
        part?.pending !== true &&
        typeof part?.activity_start_index === 'number',
    );
  if (completed.length === 0) {
    if (!foldable) {
      return undefined;
    }
    /** No marker has landed yet — the whole message is one unclaimed span.
     *  Returning `undefined` when nothing folds keeps the untouched
     *  fast path for messages that never accumulate labeled activity. */
    const folded = synthesizeActivityFolds(
      {
        type: 'content',
        content: definedIndices.map((index) => content[index]),
        contentIndices: definedIndices,
        startIndex: definedIndices[0] ?? 0,
      },
      live,
    );
    return folded.some((segment) => segment.type === 'phase') ? folded : undefined;
  }

  const segments: ActivityPhaseSegment[] = [];
  let cursor = 0;
  let definedPosition = 0;
  const collect = () => ({
    content: [] as Array<TMessageContentParts | undefined>,
    contentIndices: [] as number[],
    hasContent: false,
  });
  const append = (segment: ReturnType<typeof collect>, partIndex: number) => {
    const child = content[partIndex];
    segment.content.push(child);
    segment.contentIndices.push(partIndex);
    segment.hasContent ||= isVisibleContentPart(child);
  };
  /** Recovery can empty a span it already claimed. An index-less segment
   *  renders nothing but still mounts a nested `ContentParts`, so drop it the
   *  same way a fully recovered segment is spliced out below. */
  const pushContent = (segment: ReturnType<typeof collect>, startIndex: number) => {
    if (segment.contentIndices.length === 0) {
      return;
    }
    segments.push({
      type: 'content',
      content: segment.content,
      contentIndices: segment.contentIndices,
      startIndex,
    });
  };
  /** Phase markers and defined content indexes are both sorted. Walk them in
   *  lockstep so every ordinary part is classified once, even when a custom
   *  max permits many parent phases in one long response. */
  for (const { part, index } of completed) {
    if (!part) continue;
    const start = Math.min(index, Math.max(0, part.activity_start_index ?? index));
    const end = Math.max(start, Math.min(index, Math.max(0, part.activity_end_index ?? index)));
    const adjacent = collect();
    const phase = collect();
    const trailing = collect();
    /** A boundary may resolve after a higher-index parallel activity has
     *  already rendered. Recover that activity from an earlier adjacent
     *  segment so a later phase marker can still claim its declared span. */
    if (start < cursor) {
      const recoveredIndices: number[] = [];
      const deferredTrailingIndices: number[] = [];
      for (let segmentIndex = segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
        const segment = segments[segmentIndex];
        if (segment.type !== 'content' && segment.type !== 'phase') {
          continue;
        }
        const retainedContent: Array<TMessageContentParts | undefined> = [];
        const retainedIndices: number[] = [];
        for (
          let childPosition = 0;
          childPosition < segment.contentIndices.length;
          childPosition += 1
        ) {
          const childIndex = segment.contentIndices[childPosition];
          const child = segment.content[childPosition];
          const canRecover = segment.type === 'content' || getBatchActivityLabelPart(child) != null;
          if (canRecover && childIndex >= start && childIndex < end) {
            recoveredIndices.push(childIndex);
          } else if (canRecover && childIndex >= end) {
            deferredTrailingIndices.push(childIndex);
          } else {
            retainedContent.push(child);
            retainedIndices.push(childIndex);
          }
        }
        if (retainedIndices.length === 0) {
          /** A completed phase can legitimately carry no children after
           *  compaction — its summary header is the whole segment. Only drop
           *  what recovery actually emptied, not what arrived empty. */
          if (segment.contentIndices.length > 0) {
            segments.splice(segmentIndex, 1);
          }
        } else {
          segment.content = retainedContent;
          segment.contentIndices = retainedIndices;
          segment.startIndex = retainedIndices[0];
          if (segment.type === 'phase') {
            /** Recovery can take the only filled label and leave blank
             *  reservations behind. A stale flag renders an expandable card
             *  with nothing in it instead of the compact header. */
            segment.hasContent = retainedContent.some(isVisibleContentPart);
          }
        }
      }
      recoveredIndices.sort((a, b) => a - b);
      for (const recoveredIndex of recoveredIndices) {
        append(phase, recoveredIndex);
      }
      deferredTrailingIndices.sort((a, b) => a - b);
      for (const trailingIndex of deferredTrailingIndices) {
        append(trailing, trailingIndex);
      }
    }
    while (definedPosition < definedIndices.length && definedIndices[definedPosition] < index) {
      const childIndex = definedIndices[definedPosition];
      definedPosition += 1;
      if (childIndex < cursor) {
        continue;
      }
      if (childIndex < start) {
        append(adjacent, childIndex);
      } else if (childIndex < end || getBatchActivityLabelPart(content[childIndex]) != null) {
        append(phase, childIndex);
      } else {
        append(trailing, childIndex);
      }
    }
    if (definedIndices[definedPosition] === index) {
      definedPosition += 1;
    }
    if (start > cursor) {
      pushContent(adjacent, cursor);
    }
    const labelText = getActivityLabelText(part);
    if (labelText) {
      segments.push({
        type: 'phase',
        content: phase.content,
        contentIndices: phase.contentIndices,
        startIndex: start,
        labelPart: part,
        labelIndex: index,
        hasContent: phase.hasContent,
      });
    } else {
      /** A failed/empty parent stays visually feature-off, but its bounds are
       *  still authoritative: delayed child labels must move back beside the
       *  tools they describe instead of rendering after the final answer. */
      pushContent(phase, start);
    }
    if (end < index) {
      pushContent(trailing, end);
    }
    cursor = index + 1;
  }
  if (cursor < content.length) {
    const adjacent = collect();
    while (definedPosition < definedIndices.length) {
      const childIndex = definedIndices[definedPosition];
      definedPosition += 1;
      if (childIndex >= cursor) {
        append(adjacent, childIndex);
      }
    }
    pushContent(adjacent, cursor);
  }
  if (!foldable) {
    return segments;
  }
  const tail = segments.length - 1;
  return segments.flatMap((segment, position) =>
    segment.type === 'content'
      ? synthesizeActivityFolds(segment, live && position === tail)
      : segment,
  );
}

/**
 * Last content index that actually renders something. Trailing BLANK label
 * reservations are invisible (every batch publishes one at batch end), so
 * counting one as the last part would suppress the streaming cursor and
 * other last-item affordances on the last VISIBLE part for the whole
 * interval until the label fills or the next delta arrives. Used by both
 * the sequential and parallel content renderers so they stay in lockstep.
 */
export function lastVisibleContentIdx(
  content: ReadonlyArray<TMessageContentParts | undefined> | undefined,
): number {
  const parts = content ?? [];
  const consumedLateActivityLabels = findLateActivityLabelsConsumedByPhase(parts);
  let last = parts.length - 1;
  while (last >= 0 && last in parts) {
    if (
      isVisibleContentPart(parts[last]) &&
      !isLogicallyEarlierPhaseMarker(parts, last) &&
      !consumedLateActivityLabels.has(last)
    ) {
      return last;
    }
    last -= 1;
  }
  if (last < 0) {
    return -1;
  }
  /** Streaming/resume arrays can retain absolute indices as true holes. Jump
   *  between defined slots instead of walking the whole index space. */
  const definedIndices = Object.keys(parts);
  for (let i = definedIndices.length - 1; i >= 0; i -= 1) {
    const index = Number(definedIndices[i]);
    if (
      index <= last &&
      isVisibleContentPart(parts[index]) &&
      !isLogicallyEarlierPhaseMarker(parts, index) &&
      !consumedLateActivityLabels.has(index)
    ) {
      return index;
    }
  }
  return -1;
}

function isEmptyTextContentPart(part: TMessageContentParts | undefined): boolean {
  return part?.type === ContentTypes.TEXT && textValue(part).length === 0;
}

/**
 * Last content index that should own the streaming cursor. A provider may
 * append an empty TEXT placeholder after already-visible output; that
 * placeholder must remain available for the initial waiting state without
 * moving the cursor away from the visible part in either renderer.
 */
export function lastCursorContentIdx(
  content: ReadonlyArray<TMessageContentParts | undefined> | undefined,
): number {
  const parts = content ?? [];
  const lastIdx = lastVisibleContentIdx(parts);
  if (lastIdx > 0 && isEmptyTextContentPart(parts[lastIdx])) {
    const precedingIdx = lastVisibleContentIdx(parts.slice(0, lastIdx));
    return precedingIdx >= 0 ? precedingIdx : lastIdx;
  }
  return lastIdx;
}

/** Resolves the assistant row an activity label targets; see `findResponseMessageIndex`. */
export function findActivityLabelMessageIndex(
  messages: TMessage[],
  event: TActivityLabelEvent,
  fallbackMessageIds: readonly (string | null | undefined)[] = [],
): number {
  return findResponseMessageIndex(messages, event.responseMessageId, fallbackMessageIds);
}

/**
 * Places an activity-label part at its absolute content index on the target
 * response message. The server claimed that slot (subsequent SDK events were
 * emitted with already-shifted indices), so the write never collides with
 * streamed parts. Pure with a referential-stability contract: returns the
 * SAME message reference when the write would be a no-op — including when a
 * stale pending placeholder arrives AFTER the resolved label (out-of-order
 * publish), which must never overwrite the filled text.
 */
export function applyActivityLabelPart(message: TMessage, event: TActivityLabelEvent): TMessage {
  const { index, part } = event;
  if (typeof index !== 'number' || index < 0 || part == null) {
    return message;
  }
  const content = Array.isArray(message.content) ? message.content : [];
  const existing = getActivityLabelPart(content[index] as TMessageContentParts | undefined);
  const incoming = part as ActivityLabelPart;
  if (
    existing != null &&
    existing[ContentTypes.ACTIVITY_LABEL] === part[ContentTypes.ACTIVITY_LABEL] &&
    existing.pending === part.pending &&
    existing.activity_label_type === incoming.activity_label_type &&
    existing.activity_start_index === incoming.activity_start_index &&
    existing.activity_end_index === incoming.activity_end_index &&
    existing.activity_count === incoming.activity_count
  ) {
    return message;
  }
  if (existing != null && existing.pending !== true && part.pending === true) {
    return message;
  }
  const nextContent = [...content] as TMessageContentParts[];
  nextContent[index] = part as TMessageContentParts;
  return { ...message, content: nextContent };
}
