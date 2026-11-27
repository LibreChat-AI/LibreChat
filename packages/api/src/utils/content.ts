import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';

type ActivityLabelPart = Extract<TMessageContentParts, { type: ContentTypes.ACTIVITY_LABEL }>;
type SummaryPart = Extract<TMessageContentParts, { type: ContentTypes.SUMMARY }>;
type RuntimeSummaryPart = Omit<SummaryPart, 'content'> & {
  content?: SummaryPart['content'] | string;
  text?: string;
};

function hasSummaryText(part: RuntimeSummaryPart): boolean {
  if (typeof part.content === 'string') {
    return part.content.trim().length > 0;
  }

  if (Array.isArray(part.content)) {
    for (const block of part.content) {
      if (typeof block?.text === 'string' && block.text.trim().length > 0) {
        return true;
      }
    }
  }

  return typeof part.text === 'string' && part.text.trim().length > 0;
}

function isRetainablePart(
  part: TMessageContentParts | null | undefined,
): part is TMessageContentParts {
  if (!part || typeof part !== 'object') {
    return false;
  }

  if (part.type === ContentTypes.TOOL_CALL) {
    return 'tool_call' in part && part.tool_call != null && typeof part.tool_call === 'object';
  }

  if (part.type === ContentTypes.SUMMARY) {
    return hasSummaryText(part);
  }

  return true;
}

function isPhaseMarker(part: TMessageContentParts): part is ActivityLabelPart {
  return (
    part.type === ContentTypes.ACTIVITY_LABEL &&
    (part as ActivityLabelPart).activity_label_type === 'phase'
  );
}

/**
 * Rebase a parent-phase bound from source coordinates onto compacted ones.
 * `retainedBefore[i]` counts the parts kept ahead of source index `i`, which is
 * the compacted position of source `i` for an inclusive start and the exclusive
 * end for a bound that lands on a dropped slot.
 */
function rebaseBound(bound: number, retainedBefore: number[], sourceLength: number): number {
  return retainedBefore[Math.max(0, Math.min(sourceLength, bound))];
}

/**
 * Removes malformed tool calls, empty summaries, and empty slots, then rebases
 * parent activity-phase bounds onto the compacted coordinates.
 *
 * The source array is frequently sparse: the aggregator writes parts at
 * provider-source indexes, so a model turn that emits no text before its tool
 * calls leaves holes. Compacting shifts every part after a hole, while a phase
 * marker's `activity_start_index`/`activity_end_index` still address the source
 * positions — leaving the persisted bounds pointing at the wrong parts (the
 * final answer gets swallowed into the parent card, or the marker's own slot is
 * claimed as a child).
 *
 * Markers are copied rather than mutated: the caller's array stays in its own
 * coordinate space, which the live stream and the resume snapshot still use.
 */
function compactContentParts(contentParts: TMessageContentParts[]): TMessageContentParts[] {
  const retained: TMessageContentParts[] = [];
  const retainedBefore: number[] = new Array<number>(contentParts.length + 1);
  let phaseMarkerCount = 0;

  for (let index = 0; index < contentParts.length; index += 1) {
    retainedBefore[index] = retained.length;
    const part = contentParts[index];
    if (!isRetainablePart(part)) {
      continue;
    }
    if (isPhaseMarker(part)) {
      phaseMarkerCount += 1;
    }
    retained.push(part);
  }
  retainedBefore[contentParts.length] = retained.length;

  if (phaseMarkerCount === 0 || retained.length === contentParts.length) {
    return retained;
  }

  for (let index = 0; index < retained.length; index += 1) {
    const part = retained[index];
    if (!isPhaseMarker(part)) {
      continue;
    }
    const { activity_start_index: start, activity_end_index: end } = part;
    const nextStart =
      typeof start === 'number' ? rebaseBound(start, retainedBefore, contentParts.length) : start;
    const nextEnd =
      typeof end === 'number' ? rebaseBound(end, retainedBefore, contentParts.length) : end;
    if (nextStart === start && nextEnd === end) {
      continue;
    }
    retained[index] = {
      ...part,
      ...(typeof nextStart === 'number' && { activity_start_index: nextStart }),
      ...(typeof nextEnd === 'number' && { activity_end_index: nextEnd }),
    };
  }

  return retained;
}

/**
 * Produces the durable content array: drops malformed tool calls and empty summaries,
 * compacts away empty slots, and rebases parent activity-phase bounds onto the
 * resulting coordinates.
 *
 * Compaction is not incidental — the source array is frequently sparse, because the
 * aggregator writes parts at provider-source indexes. Since that shifts positions, any
 * index-referencing metadata is rebased to match; see {@link compactContentParts}.
 *
 * Non-array input is returned unchanged.
 *
 * @param contentParts - Array of content parts to compact
 * @returns Compacted array with malformed tool calls removed and phase bounds rebased
 *
 * @example
 * // Removes malformed tool_call without the tool_call property
 * const parts = [
 *   { type: 'tool_call', tool_call: { id: '123', name: 'test' } }, // valid - kept
 *   { type: 'tool_call' }, // invalid - filtered out
 *   { type: 'text', text: 'Hello' }, // valid - kept (other types pass through)
 * ];
 * const filtered = filterMalformedContentParts(parts);
 * // Returns all parts except the malformed tool_call
 *
 * @example
 * // A hole shifts later parts, so a phase marker's bounds move with them
 * const parts = []; // parts[0] never materialized
 * parts[1] = { type: 'tool_call', tool_call: { id: 'a' } };
 * parts[2] = { type: 'text', text: 'Final answer' };
 * parts[3] = { type: 'activity_label', activity_label_type: 'phase',
 *              activity_start_index: 0, activity_end_index: 2 };
 * const filtered = filterMalformedContentParts(parts);
 * // Final answer is now at index 1, and activity_end_index is rebased to 1
 */
export function filterMalformedContentParts(
  contentParts: TMessageContentParts[],
): TMessageContentParts[];
export function filterMalformedContentParts<T>(contentParts: T): T;
export function filterMalformedContentParts<T>(
  contentParts: T | TMessageContentParts[],
): T | TMessageContentParts[] {
  if (!Array.isArray(contentParts)) {
    return contentParts;
  }

  return compactContentParts(contentParts);
}
