import { StepTypes, ContentTypes } from 'librechat-data-provider';
import type {
  Agents,
  TMessage,
  ContentMetadata,
  SummaryContentPart,
} from 'librechat-data-provider';
import type { TextPhase } from './content';
import {
  prepareReasoningPartForStep,
  calculateContentIndex,
  getStepMetadata,
  foldsEditPrefix,
  updateContent,
} from './content';

/** Result of folding one message or reasoning delta into a response. */
export type DeltaResult = {
  message: TMessage;
  /** False when the delta carried no parts, so nothing should be written. */
  updated: boolean;
  /** True when a part folded into the last part of the retained edit prefix. */
  foldedEditPrefix: boolean;
};

const toParts = (
  content: Agents.MessageContentComplex | Agents.MessageContentComplex[],
): Agents.MessageContentComplex[] => (Array.isArray(content) ? content : [content]);

/**
 * Folds a message delta (text, or think parts on providers that stream reasoning through the
 * message channel) into the response. A delta may carry several parts, such as Google server-side
 * tool chunks, and every entry is applied in order or streamed text is silently dropped.
 * AI SDK: `text-delta`.
 */
export function applyMessageDelta(
  message: TMessage,
  runStep: Agents.RunStep,
  delta: Agents.MessageDeltaEvent,
  editPrefixOffset: number,
): DeltaResult {
  const result: DeltaResult = { message, updated: false, foldedEditPrefix: false };
  if (!delta.delta.content) {
    return result;
  }
  const phase =
    runStep.stepDetails.type === StepTypes.MESSAGE_CREATION
      ? (runStep.stepDetails.message_creation as { phase?: TextPhase } | undefined)?.phase
      : undefined;
  const metadata = getStepMetadata(runStep);
  for (const contentPart of toParts(delta.delta.content)) {
    if (contentPart == null) {
      continue;
    }
    const phasedContentPart =
      contentPart.type === ContentTypes.TEXT && (phase === 'commentary' || phase === 'final_answer')
        ? { ...contentPart, phase }
        : contentPart;
    const index = calculateContentIndex(
      runStep.index,
      editPrefixOffset,
      phasedContentPart.type || '',
      result.message.content,
      phase,
    );
    if (foldsEditPrefix(runStep.index, editPrefixOffset, index)) {
      result.foldedEditPrefix = true;
    }
    if (phasedContentPart.type === ContentTypes.THINK) {
      result.message = prepareReasoningPartForStep(result.message, index, delta.id);
    }
    result.message = updateContent(result.message, index, phasedContentPart, false, metadata);
    result.updated = true;
  }
  return result;
}

/**
 * Folds a reasoning delta into the response. Same multi-part contract as
 * {@link applyMessageDelta}. AI SDK: `reasoning-delta`.
 */
export function applyReasoningDelta(
  message: TMessage,
  runStep: Agents.RunStep,
  delta: Agents.ReasoningDeltaEvent,
  editPrefixOffset: number,
): DeltaResult {
  const result: DeltaResult = { message, updated: false, foldedEditPrefix: false };
  if (delta.delta.content == null) {
    return result;
  }
  const metadata = getStepMetadata(runStep);
  for (const contentPart of toParts(delta.delta.content)) {
    if (contentPart == null) {
      continue;
    }
    const index = calculateContentIndex(
      runStep.index,
      editPrefixOffset,
      contentPart.type || '',
      result.message.content,
    );
    if (foldsEditPrefix(runStep.index, editPrefixOffset, index)) {
      result.foldedEditPrefix = true;
    }
    result.message = prepareReasoningPartForStep(result.message, index, delta.id);
    result.message = updateContent(result.message, index, contentPart, false, metadata);
    result.updated = true;
  }
  return result;
}

/**
 * Writes an agent handoff marker at its own index. Agent updates carry their own agent id and
 * default to group 1 when they have one.
 */
export function applyAgentUpdate(
  message: TMessage,
  event: Agents.AgentUpdate,
  editPrefixOffset: number,
): TMessage {
  const { agent_update } = event;
  const metadata: ContentMetadata | undefined = agent_update.agentId
    ? { agentId: agent_update.agentId, groupId: 1 }
    : undefined;
  return updateContent(message, agent_update.index + editPrefixOffset, event, false, metadata);
}

/** Opens an in-flight summary part at a summarize step's slot. */
export function applySummaryStep(
  message: TMessage,
  runStep: Agents.RunStep,
  editPrefixOffset: number,
): TMessage {
  if (runStep.summary == null) {
    return message;
  }
  const summaryPart: SummaryContentPart = {
    type: ContentTypes.SUMMARY,
    content: [],
    summarizing: true,
    model: runStep.summary.model,
    provider: runStep.summary.provider,
  };
  return updateContent(
    { ...message },
    runStep.index + editPrefixOffset,
    summaryPart,
    false,
    getStepMetadata(runStep),
  );
}

/** Appends a summary delta to its step's in-flight summary part. */
export function applySummarizeDelta(
  message: TMessage,
  runStep: Agents.RunStep,
  delta: Agents.SummarizeDeltaEvent,
  editPrefixOffset: number,
): TMessage {
  const contentPart: SummaryContentPart = { ...delta.delta.summary, summarizing: true };
  return updateContent(
    message,
    runStep.index + editPrefixOffset,
    contentPart,
    false,
    getStepMetadata(runStep),
  );
}

/**
 * Settles in-flight summary parts. Scoped to `completeIndex` when the owning step is known: a
 * global scan would finalize a NEWER round's in-flight part when summarize cycles run
 * back-to-back. A negative index finalizes every in-flight part.
 *
 * Failed rounds keep their slot, flagged `failed`, rather than being spliced out: removing a part
 * shifts every later part under the index-keyed renderer and breaks the position invariant.
 *
 * Returns `undefined` when no part was in flight.
 */
export function finalizeSummaries(
  message: TMessage,
  event: Agents.SummarizeCompleteEvent,
  completeIndex: number,
): TMessage | undefined {
  if (!Array.isArray(message.content)) {
    return undefined;
  }
  let didFinalize = false;
  const content = message.content.map((part, index) => {
    if (part?.type !== ContentTypes.SUMMARY || !(part as SummaryContentPart).summarizing) {
      return part;
    }
    if (completeIndex >= 0 && index !== completeIndex) {
      return part;
    }
    didFinalize = true;
    if (!event.error && event.summary) {
      /** The completed summary may omit the step metadata the in-flight part was opened with. */
      const { agentId, groupId } = part as ContentMetadata;
      return {
        ...(agentId != null && { agentId }),
        ...(groupId != null && { groupId }),
        ...event.summary,
        summarizing: false,
      } as SummaryContentPart;
    }
    if (event.error) {
      return { ...part, summarizing: false, failed: true } as SummaryContentPart;
    }
    return { ...part, summarizing: false } as SummaryContentPart;
  });
  return didFinalize ? { ...message, content } : undefined;
}
