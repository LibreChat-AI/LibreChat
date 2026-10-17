import { Constants } from 'librechat-data-provider';
import type {
  Agents,
  StepEvents,
  TMessage,
  EventSubmission,
  PtcToolCallEvent,
  SubagentUpdateEvent,
  SandboxStartingEvent,
} from 'librechat-data-provider';

export type StepEvent =
  | { event: StepEvents.ON_RUN_STEP; data: Agents.RunStep }
  | { event: StepEvents.ON_AGENT_UPDATE; data: Agents.AgentUpdate }
  | { event: StepEvents.ON_MESSAGE_DELTA; data: Agents.MessageDeltaEvent }
  | { event: StepEvents.ON_REASONING_DELTA; data: Agents.ReasoningDeltaEvent }
  | { event: StepEvents.ON_RUN_STEP_DELTA; data: Agents.RunStepDeltaEvent }
  | { event: StepEvents.ON_TOOL_CALLS_DISPATCHED; data: Agents.ToolCallsDispatchedEvent }
  | { event: StepEvents.ON_TOOL_PREPARATION; data: Agents.ToolPreparationMarker }
  | { event: StepEvents.ON_RUN_STEP_COMPLETED; data: { result: Agents.ToolEndEvent } }
  | { event: StepEvents.ON_RUN_STEP_CLOSED; data: Agents.RunStepClosedEvent }
  | { event: StepEvents.ON_SUMMARIZE_START; data: Agents.SummarizeStartEvent }
  | { event: StepEvents.ON_SUMMARIZE_DELTA; data: Agents.SummarizeDeltaEvent }
  | { event: StepEvents.ON_SUMMARIZE_COMPLETE; data: Agents.SummarizeCompleteEvent }
  | { event: StepEvents.ON_SUBAGENT_UPDATE; data: SubagentUpdateEvent }
  | { event: StepEvents.ON_SANDBOX_STARTING; data: SandboxStartingEvent }
  | { event: StepEvents.ON_PTC_TOOL_CALL; data: PtcToolCallEvent };

/**
 * Side channels of one step event, in the order the event produced them.
 *
 * `flush` and `summary` ask the binding to merge the response into the list later (deltas are
 * coalesced per frame); `messages` is the list the event read, which the flush merges onto.
 */
export type StepEffect =
  | { type: 'flush'; messageId: string; messages: TMessage[] }
  | { type: 'summary'; messageId: string; messages: TMessage[] }
  | { type: 'announce'; message: 'summarize_started' | 'summarize_completed' | 'summarize_failed' }
  | { type: 'sandbox-starting'; toolCallId: string }
  | { type: 'sandbox-settled'; toolCallId?: string }
  | { type: 'skill-authored' }
  | { type: 'ptc'; event: PtcToolCallEvent; parentMessageId: string }
  | { type: 'subagent'; invocationKey: string; events: SubagentUpdateEvent[] }
  | { type: 'subagent-index'; conversationId: string };

/** The message list the reducer reads and writes; the React Query cache in the app. */
export type StepContext = {
  submission: EventSubmission;
  getMessages: () => TMessage[] | undefined;
  setMessages: (messages: TMessage[]) => void;
};

type PendingSubagent = { parentMessageId: string; events: SubagentUpdateEvent[] };

/** Per-run bookkeeping. Mutable by design: deltas arrive per token. */
export type StreamState = {
  /** Authoritative streaming copy of each response, ahead of the cache while a flush is queued. */
  messages: Map<string, TMessage>;
  steps: Map<string, Agents.RunStep>;
  toolCallIds: Map<string, string | undefined>;
  firstFragmentByCall: Map<string, number>;
  firstFragmentByStep: Map<string, number>;
  dispatchedByCall: Map<string, number>;
  completedByCall: Map<string, number>;
  /** Deltas that arrived before their run step, replayed when it lands. */
  pendingDeltas: Map<string, StepEvent[]>;
  /**
   * `subagentRunId` to one concrete parent content-part occurrence. Provider ids repeat across
   * and within messages, so the claim is by occurrence, oldest first.
   */
  subagentInvocations: Map<string, string>;
  claimedInvocations: Set<string>;
  /** Subagent envelopes that arrived before their parent tool call was in `messages`. */
  pendingSubagents: Map<string, PendingSubagent>;
};

export function createStreamState(): StreamState {
  return {
    messages: new Map(),
    steps: new Map(),
    toolCallIds: new Map(),
    firstFragmentByCall: new Map(),
    firstFragmentByStep: new Map(),
    dispatchedByCall: new Map(),
    completedByCall: new Map(),
    pendingDeltas: new Map(),
    subagentInvocations: new Map(),
    claimedInvocations: new Set(),
    pendingSubagents: new Map(),
  };
}

export function resetStreamState(state: StreamState): void {
  state.messages.clear();
  state.steps.clear();
  state.toolCallIds.clear();
  state.firstFragmentByCall.clear();
  state.firstFragmentByStep.clear();
  state.dispatchedByCall.clear();
  state.completedByCall.clear();
  state.pendingDeltas.clear();
  state.subagentInvocations.clear();
  state.claimedInvocations.clear();
  state.pendingSubagents.clear();
}

/** Atom identity of one subagent tool-call content-part occurrence. */
export const subagentProgressKey = (
  parentMessageId: string,
  toolCallId: string,
  partIndex: number,
): string => `${parentMessageId}\u0000${toolCallId}\u0000${partIndex}`;

export const toolTimingKey = (stepId: string, callId: string) => `${stepId}\u0000${callId}`;

export const isValidTime = (at: unknown): at is number =>
  typeof at === 'number' && Number.isFinite(at) && at >= 0;

/** The response a step writes to; a preliminary id resolves to the submission's response. */
export const resolveResponseId = (
  submission: EventSubmission,
  runId: string | undefined,
): string =>
  runId === Constants.USE_PRELIM_RESPONSE_MESSAGE_ID
    ? (submission.initialResponse?.messageId ?? '')
    : (runId ?? '');

export const bufferDelta = (state: StreamState, stepId: string, event: StepEvent): void => {
  const buffer = state.pendingDeltas.get(stepId) ?? [];
  buffer.push(event);
  state.pendingDeltas.set(stepId, buffer);
};
