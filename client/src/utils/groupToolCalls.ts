import { Constants, ContentTypes, ToolCallTypes } from 'librechat-data-provider';
import type { TMessageContentParts, Agents } from 'librechat-data-provider';
import type { PartWithIndex } from '~/components/Chat/Messages/Content/ParallelContent';
import { getBatchActivityLabelPart, getActivityLabelText } from '~/utils/activityLabels';

export type GroupedPart =
  | { type: 'single'; part: PartWithIndex }
  | { type: 'tool-group'; parts: PartWithIndex[]; labelPart?: PartWithIndex };

type ToolCallWithNestedContent = Agents.ToolCall & {
  subagent_content?: TMessageContentParts[];
};

/**
 * True when the part carries an unresolved tool approval — directly or nested
 * in subagent content. Collapsed disclosure bodies retain instead of
 * unmounting while this holds, because `ToolApproval` owns unsent local
 * edit/respond/reason state that an unmount would discard.
 */
export function hasPendingApprovalInPart(part: TMessageContentParts): boolean {
  if (part.type !== ContentTypes.TOOL_CALL) {
    return false;
  }
  const toolCall = part[ContentTypes.TOOL_CALL] as ToolCallWithNestedContent | undefined;
  if (!toolCall) {
    return false;
  }
  if (toolCall.approval != null && (toolCall.output?.length ?? 0) === 0) {
    return true;
  }
  return (
    Array.isArray(toolCall.subagent_content) &&
    toolCall.subagent_content.some(hasPendingApprovalInPart)
  );
}

/**
 * True while a standard tool call waits on a sign-in. A step the run already
 * closed can never be waiting, whatever its progress says: `ToolCall` hides
 * the sign-in button on a terminal status, so counting it as pending would
 * show a trust warning with no authentication action behind it.
 */
export function hasPendingAuthInPart(part: TMessageContentParts): boolean {
  if (part.type !== ContentTypes.TOOL_CALL) {
    return false;
  }
  const toolCall = part[ContentTypes.TOOL_CALL];
  if (!toolCall || !('args' in toolCall) || toolCall.runStepStatus != null) {
    return false;
  }
  const standardToolCall = toolCall as Agents.ToolCall & { progress?: number };
  return (
    typeof standardToolCall.auth === 'string' &&
    standardToolCall.auth.length > 0 &&
    (standardToolCall.progress ?? 0.1) < 1
  );
}

function isGroupableToolCall(part: TMessageContentParts): boolean {
  if (part.type !== ContentTypes.TOOL_CALL) {
    return false;
  }
  const toolCall = part[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined;
  if (!toolCall) {
    return false;
  }
  const isStandardToolCall =
    'args' in toolCall && (!toolCall.type || toolCall.type === ToolCallTypes.TOOL_CALL);
  if (isStandardToolCall && toolCall.name?.startsWith(Constants.LC_TRANSFER_TO_)) {
    return false;
  }
  return true;
}

/** Reasoning ("Thoughts") parts are transparent to grouping: a thought
 *  interleaved between tool calls joins the run instead of splitting it, so
 *  reasoning models that think between every call still collapse into a single
 *  tool group. A run becomes a group once it holds >= 2 tool calls, OR a single
 *  tool call accompanied by reasoning, so a lone tool wrapped in thinking
 *  (a skill invocation, say) still gets the grouped chrome with its thoughts
 *  folded in. A run of pure reasoning (no tool call) keeps rendering as its own
 *  standalone card. */
function isReasoningPart(part: TMessageContentParts): boolean {
  return part.type === ContentTypes.THINK;
}

/** Assistant prose emitted mid-run. Grouping treats it as block-joining so a
 *  labeled batch can still claim the tools around it, but an UNLABELED group
 *  must never swallow it: that group auto-collapses once complete, which would
 *  hide the prose behind a generic action header. */
function isCommentaryPart(part: TMessageContentParts): boolean {
  return part.type === ContentTypes.TEXT && (part as { phase?: string }).phase === 'commentary';
}

function countToolCalls(parts: PartWithIndex[]): number {
  let count = 0;
  for (const { part } of parts) {
    if (isGroupableToolCall(part)) {
      count += 1;
    }
  }
  return count;
}

/**
 * True when the label covers ANY `transfer_to_*` handoff call. Transfer
 * parts are never groupable, so the flush at the handoff card leaves such a
 * label with nothing to head — it can only orphan into a stray line after
 * cards that already show everything (the handoff card names the
 * destination; mixed batches keep their tool cards). Content persisted
 * before the server stopped claiming labels for handoff batches still
 * carries these; they are dropped at render.
 */
function coversTransferCall(labelPart: TMessageContentParts, allParts: PartWithIndex[]): boolean {
  const ids = (labelPart as { tool_call_ids?: unknown }).tool_call_ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return false;
  }
  return ids.some((id) =>
    allParts.some(({ part }) => {
      if (part?.type !== ContentTypes.TOOL_CALL) {
        return false;
      }
      const toolCall = part[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined;
      return toolCall?.id === id && toolCall?.name?.startsWith(Constants.LC_TRANSFER_TO_) === true;
    }),
  );
}

/**
 * Groups message content for rendering.
 *
 * Activity blocks: reasoning (THINK) parts are absorbed tentatively; when an
 * ACTIVITY_LABEL part terminates the run, the whole block (thinking + tool
 * calls) becomes one labeled group — the claude.ai-style hierarchy. Any
 * other part type breaks the block.
 *
 * Without an ACTIVITY_LABEL part (feature off, older conversations), the
 * block still groups: reasoning stays folded in with its tool calls, and a
 * run groups at >= 2 tool calls or a single call accompanied by reasoning.
 */
export function groupSequentialToolCalls(parts: PartWithIndex[]): GroupedPart[] {
  const result: GroupedPart[] = [];
  let currentBlock: PartWithIndex[] = [];
  /** Position in `currentBlock` just past the most recent BLANK label. A
   *  filled label may only claim parts after it (its own batch); everything
   *  before it belongs to earlier batches whose labels stayed empty. */
  let claimStart = 0;

  /** Splits the block at commentary so an unlabeled group only ever holds
   *  reasoning and tool calls; each surrounding run still has to earn the
   *  grouped chrome on its own. */
  const flushWithoutLabel = () => {
    let run: PartWithIndex[] = [];
    const emitRun = () => {
      const toolCallCount = countToolCalls(run);
      const hasReasoning = run.some((p) => isReasoningPart(p.part));
      if (toolCallCount >= 2 || (toolCallCount >= 1 && hasReasoning)) {
        result.push({ type: 'tool-group', parts: run });
      } else {
        for (const p of run) {
          result.push({ type: 'single', part: p });
        }
      }
      run = [];
    };
    for (const p of currentBlock) {
      if (isCommentaryPart(p.part)) {
        emitRun();
        result.push({ type: 'single', part: p });
        continue;
      }
      run.push(p);
    }
    emitRun();
    currentBlock = [];
    claimStart = 0;
  };

  for (const item of parts) {
    if (
      isGroupableToolCall(item.part) ||
      item.part.type === ContentTypes.THINK ||
      isCommentaryPart(item.part)
    ) {
      currentBlock.push(item);
      continue;
    }
    if (item.part.type === ContentTypes.ACTIVITY_LABEL) {
      const batchLabel = getBatchActivityLabelPart(item.part);
      if (batchLabel == null) {
        flushWithoutLabel();
        result.push({ type: 'single', part: item });
        continue;
      }
      const hasText = getActivityLabelText(batchLabel).length > 0;
      if (!hasText) {
        /** A reserved-but-unfilled slot (and a failed/blank fill) must be
         *  INVISIBLE. Every batch now publishes its reservation immediately,
         *  so forming a group here would wrap even a single tool call and pull
         *  THINK parts inside it while generation is still pending. It cannot
         *  flush either: two consecutive single-call batches would then render
         *  as two standalone cards where the feature-off path merges them into
         *  one legacy group. It only marks the claim boundary, so the block
         *  keeps accumulating for legacy merging while a later filled label
         *  still cannot reach back into this batch. */
        claimStart = currentBlock.length;
        continue;
      }
      const claimed = currentBlock.slice(claimStart);
      /** Earlier blank-labeled batches render legacy-style, in order, before
       *  this label's group. */
      currentBlock = currentBlock.slice(0, claimStart);
      flushWithoutLabel();
      if (claimed.length > 0) {
        result.push({ type: 'tool-group', parts: claimed, labelPart: item });
      } else if (!coversTransferCall(item.part, parts)) {
        /** Orphan label (block parts hidden/filtered): renders standalone —
         *  UNLESS its batch contained a handoff call, where the cards
         *  already say everything and the label would be a stray line. */
        result.push({ type: 'single', part: item });
      }
      continue;
    }
    flushWithoutLabel();
    result.push({ type: 'single', part: item });
  }
  flushWithoutLabel();

  return result;
}
