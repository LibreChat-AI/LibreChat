import {
  Constants,
  StepTypes,
  StepEvents,
  ContentTypes,
  getToolTimingDurations,
} from 'librechat-data-provider';
import type {
  Agents,
  TMessage,
  EventSubmission,
  PtcToolCallEvent,
  SubagentUpdateEvent,
  SandboxStartingEvent,
  TMessageContentParts,
} from 'librechat-data-provider';
import {
  getEditPrefix,
  applyAgentUpdate,
  applySummaryStep,
  applyMessageDelta,
  finalizeSummaries,
  applyRunStepClosed,
  applyToolCallsStep,
  applyToolCallDelta,
  applyReasoningDelta,
  applySummarizeDelta,
  applyToolCallCompleted,
  isSkillAuthoringToolCall,
} from './steps';

/**
 * The step reducer behind `useStepHandler`: folds one agent step event into the response message
 * it targets and reports every write outside the message list as an effect.
 *
 * Message writes go through `StepContext.setMessages` as they happen, because later writes in the
 * same event read the list back through `getMessages`. Everything else (live-status stores,
 * announcements, cache invalidation, coalesced flushes) is returned in order for the binding.
 *
 * Invariant: a part's position in `message.content` is its step index plus the retained edit
 * prefix. Nothing here splices content mid-stream.
 */

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

const toolTimingKey = (stepId: string, callId: string) => `${stepId}\u0000${callId}`;

const isValidTime = (at: unknown): at is number =>
  typeof at === 'number' && Number.isFinite(at) && at >= 0;

const getCurrentMessages = (ctx: StepContext, messages: TMessage[]): TMessage[] => {
  const freshMessages = ctx.getMessages();
  return freshMessages && freshMessages.length >= messages.length ? freshMessages : messages;
};

const getEventMessages = (ctx: StepContext, messages: TMessage[]): TMessage[] =>
  ctx.submission.isRegenerate ? messages : getCurrentMessages(ctx, messages);

const getRegenerateResponseIds = (submission: EventSubmission, responseMessageId: string) => {
  const ids = new Set<string>();
  const addId = (id?: string | null) => {
    if (!id) {
      return;
    }
    ids.add(id);
    ids.add(id.replace(/_+$/, ''));
  };
  addId(responseMessageId);
  addId(submission.initialResponse?.messageId);
  addId(submission.userMessage?.responseMessageId);
  return ids;
};

const shouldRemoveRegenerateResponse = (
  submission: EventSubmission,
  message: TMessage,
  responseMessageId: string,
) =>
  submission.isRegenerate &&
  !message.isCreatedByUser &&
  /** A compaction's preliminary response is `${anchorId}_`. The ordinary regenerate alias set
   *  strips that suffix, but here the base ID is the assistant ANCHOR, not a response being
   *  replaced. Keep it so the summary remains its child instead of becoming an orphan root. */
  (submission.compact !== true || message.messageId !== submission.userMessage.messageId) &&
  getRegenerateResponseIds(submission, responseMessageId).has(message.messageId);

const shouldRemoveInitialResponse = (
  submission: EventSubmission,
  message: TMessage,
  responseMessageId: string,
) => {
  const initialResponseId = submission.initialResponse?.messageId;
  return (
    !submission.isRegenerate &&
    !message.isCreatedByUser &&
    initialResponseId != null &&
    initialResponseId !== responseMessageId &&
    message.messageId === initialResponseId &&
    message.parentMessageId === submission.userMessage.messageId
  );
};

const ensureUserMessagePresent = (
  submission: EventSubmission,
  candidateMessages: TMessage[],
  responseMessageId: string,
): TMessage[] => {
  const { userMessage } = submission;
  if (
    submission.isRegenerate ||
    !userMessage?.messageId ||
    candidateMessages.some((message) => message.messageId === userMessage.messageId)
  ) {
    return candidateMessages;
  }

  /** Insert before the row's first CHILD as well as before the response row: abandoned responses
   *  from preempted attempts are children of this user message and may already sit in the list.
   *  Landing the parent after them orders children before their parent, which the message tree
   *  renders as phantom root branches (a folded thread). */
  let insertIndex = candidateMessages.length;
  for (let i = 0; i < candidateMessages.length; i++) {
    const message = candidateMessages[i];
    if (
      message.messageId === responseMessageId ||
      message.parentMessageId === userMessage.messageId
    ) {
      insertIndex = i;
      break;
    }
  }
  if (insertIndex >= candidateMessages.length) {
    return [...candidateMessages, userMessage as TMessage];
  }

  const nextMessages = [...candidateMessages];
  nextMessages.splice(insertIndex, 0, userMessage as TMessage);
  return nextMessages;
};

const getResponseBaseMessages = (
  ctx: StepContext,
  candidateMessages: TMessage[],
  responseMessageId: string,
  ensureUserMessage = false,
): TMessage[] => {
  const { submission } = ctx;
  const currentMessages = getEventMessages(ctx, candidateMessages);
  if (!submission.isRegenerate) {
    const nextMessages = currentMessages.filter(
      (message) => !shouldRemoveInitialResponse(submission, message, responseMessageId),
    );
    return ensureUserMessage
      ? ensureUserMessagePresent(submission, nextMessages, responseMessageId)
      : nextMessages;
  }
  return currentMessages.filter(
    (message) => !shouldRemoveRegenerateResponse(submission, message, responseMessageId),
  );
};

/** Replaces (or appends) the response in the list, dropping the placeholder it supersedes. */
export function mergeResponseMessage(
  ctx: StepContext,
  candidateMessages: TMessage[],
  updatedResponse: TMessage,
  responseMessageId: string,
  options?: { ensureUserMessage?: boolean },
): TMessage[] {
  const currentMessages = getResponseBaseMessages(
    ctx,
    candidateMessages,
    responseMessageId,
    options?.ensureUserMessage === true,
  );
  const hasResponseMessage = currentMessages.some((msg) => msg.messageId === responseMessageId);
  return hasResponseMessage
    ? currentMessages.map((msg) => (msg.messageId === responseMessageId ? updatedResponse : msg))
    : [...currentMessages, updatedResponse];
}

/** Writes the coalesced delta state of each response, merging onto the list the event read. */
export function flushResponses(
  state: StreamState,
  ctx: StepContext,
  messageIds: Iterable<string>,
  messages: TMessage[],
): void {
  let candidate = messages;
  for (const id of messageIds) {
    const latest = state.messages.get(id);
    if (!latest) {
      continue;
    }
    candidate = mergeResponseMessage(ctx, candidate, latest, id, { ensureUserMessage: true });
    ctx.setMessages(candidate);
  }
}

/** Writes the coalesced summarize-delta state of one response. */
export function flushSummary(
  state: StreamState,
  ctx: StepContext,
  messageId: string,
  messages: TMessage[],
): void {
  const latest = state.messages.get(messageId);
  if (!latest) {
    return;
  }
  const currentMessages = ctx.submission.isRegenerate ? messages : ctx.getMessages() || [];
  ctx.setMessages(mergeResponseMessage(ctx, currentMessages, latest, messageId));
}

const resolveSubagentInvocationKey = (
  state: StreamState,
  payload: SubagentUpdateEvent,
  parentMessageId: string,
): string | undefined => {
  const cached = state.subagentInvocations.get(payload.subagentRunId);
  if (cached != null) return cached;
  if (parentMessageId === '') return undefined;

  /** `runId` names the expected parent message. Until it arrives, buffer instead of claiming a
   *  same-ID call from another parallel response; the claim is permanent once made. */
  const content = state.messages.get(parentMessageId)?.content;
  if (!Array.isArray(content)) return undefined;
  for (let i = 0; i < content.length; i++) {
    const part = content[i];
    if (part?.type !== ContentTypes.TOOL_CALL) continue;
    const tc = (part as { [ContentTypes.TOOL_CALL]?: { id?: string; name?: string } })[
      ContentTypes.TOOL_CALL
    ];
    if (
      tc?.name === Constants.SUBAGENT &&
      tc.id &&
      (payload.parentToolCallId == null || tc.id === payload.parentToolCallId) &&
      !state.claimedInvocations.has(subagentProgressKey(parentMessageId, tc.id, i))
    ) {
      const invocationKey = subagentProgressKey(parentMessageId, tc.id, i);
      state.subagentInvocations.set(payload.subagentRunId, invocationKey);
      state.claimedInvocations.add(invocationKey);
      return invocationKey;
    }
  }
  return undefined;
};

/**
 * Routes a subagent envelope to its parent invocation, buffering it until the parent tool call
 * is known and releasing the buffer, in arrival order, once it is.
 */
function claimSubagentUpdate(
  state: StreamState,
  payload: SubagentUpdateEvent,
  parentMessageId: string,
): StepEffect[] {
  const invocationKey = resolveSubagentInvocationKey(state, payload, parentMessageId);
  const pending = state.pendingSubagents.get(payload.subagentRunId);

  if (!invocationKey) {
    const buffer = pending ?? { parentMessageId, events: [] };
    buffer.events.push(payload);
    state.pendingSubagents.set(payload.subagentRunId, buffer);
    return [];
  }

  if (pending && pending.events.length > 0) {
    state.pendingSubagents.delete(payload.subagentRunId);
  }
  const events = pending ? [...pending.events, payload] : [payload];
  return [{ type: 'subagent', invocationKey, events }];
}

/**
 * Seeds the streaming copy of a message from a sync snapshot, so later deltas build on it, and
 * releases subagent envelopes that were waiting for it.
 */
export function syncStreamMessage(state: StreamState, message: TMessage): StepEffect[] {
  if (!message?.messageId) return [];
  state.messages.set(message.messageId, { ...message });
  const effects: StepEffect[] = [];
  const ready = [...state.pendingSubagents.entries()].filter(
    ([, pending]) => pending.parentMessageId === message.messageId,
  );
  for (const [subagentRunId, pending] of ready) {
    state.pendingSubagents.delete(subagentRunId);
    for (const event of pending.events) {
      effects.push(...claimSubagentUpdate(state, event, message.messageId));
    }
  }
  return effects;
}

/** The response a step writes to; a preliminary id resolves to the submission's response. */
const resolveResponseId = (submission: EventSubmission, runId: string | undefined): string =>
  runId === Constants.USE_PRELIM_RESPONSE_MESSAGE_ID
    ? (submission.initialResponse?.messageId ?? '')
    : (runId ?? '');

const bufferDelta = (state: StreamState, stepId: string, event: StepEvent) => {
  const buffer = state.pendingDeltas.get(stepId) ?? [];
  buffer.push(event);
  state.pendingDeltas.set(stepId, buffer);
};

/** Folds one step event into `state` and the message list; returns its side channels in order. */
export function reduceStep(state: StreamState, event: StepEvent, ctx: StepContext): StepEffect[] {
  const { submission } = ctx;
  const messages = getEventMessages(ctx, submission.messages ?? []);
  const { userMessage } = submission;
  const effects: StepEffect[] = [];
  const merge = (updated: TMessage, responseMessageId: string) =>
    ctx.setMessages(
      mergeResponseMessage(ctx, messages, updated, responseMessageId, { ensureUserMessage: true }),
    );

  /** Activity labels honor the same `editPrefixCleared` flag `getEditPrefix` reads, so a batch's
   *  tool cards and its header land in one index space. */
  const { initialContent, editPrefixOffset } = getEditPrefix(submission);

  if (event.event === StepEvents.ON_RUN_STEP) {
    const runStep = event.data;
    let parentMessageId =
      submission.isRegenerate && submission.initialResponse?.parentMessageId
        ? submission.initialResponse.parentMessageId
        : userMessage.messageId;
    let responseMessageId = runStep.runId ?? '';
    if (responseMessageId === Constants.USE_PRELIM_RESPONSE_MESSAGE_ID) {
      responseMessageId = submission?.initialResponse?.messageId ?? '';
      parentMessageId = submission?.initialResponse?.parentMessageId ?? '';
    }
    if (!responseMessageId) {
      console.warn('No message id found in run step event');
      return effects;
    }

    state.steps.set(runStep.id, runStep);

    let response = state.messages.get(responseMessageId);

    if (!response) {
      /** Regenerate can target an earlier branch while the visible history still ends at a later
       *  assistant message, so a regenerated response is never seeded from the tail. */
      const lastMessage = messages[messages.length - 1] as TMessage;
      const responseMessage =
        !submission.isRegenerate && lastMessage && !lastMessage.isCreatedByUser
          ? lastMessage
          : (submission?.initialResponse as TMessage);

      /** An edit's `initialContent` IS the starting content; a resume starts from what exists. */
      const existingContent = responseMessage?.content ?? [];
      const mergedContent: TMessageContentParts[] =
        initialContent.length > 0 ? initialContent : existingContent;

      response = {
        ...responseMessage,
        parentMessageId,
        conversationId: userMessage.conversationId,
        messageId: responseMessageId,
        content: mergedContent,
      };

      state.messages.set(responseMessageId, response);

      /** Fresh read: another tab may have loaded more history since the handler started. */
      const currentMessages = getResponseBaseMessages(ctx, messages, responseMessageId, true);

      let updatedMessages = currentMessages.filter(
        (message) =>
          message.messageId !== responseMessageId &&
          !shouldRemoveRegenerateResponse(submission, message, responseMessageId) &&
          !shouldRemoveInitialResponse(submission, message, responseMessageId),
      );

      /** Regenerate reuses an existing user turn; its submission userMessage is only a transport
       *  placeholder and must not become a new visible branch. */
      updatedMessages = ensureUserMessagePresent(submission, updatedMessages, responseMessageId);

      ctx.setMessages([...updatedMessages, response]);
    }

    if (runStep.stepDetails.type === StepTypes.TOOL_CALLS) {
      const { message: updatedResponse, toolCallId } = applyToolCallsStep(
        response,
        runStep,
        editPrefixOffset,
        (callId) => ({
          toolPreparationStartedAt:
            state.firstFragmentByCall.get(toolTimingKey(runStep.id, callId)) ??
            (runStep.stepDetails.type === StepTypes.TOOL_CALLS &&
            (runStep.stepDetails.tool_calls?.length ?? 0) <= 1
              ? state.firstFragmentByStep.get(runStep.id)
              : undefined),
          toolDispatchedAt: state.dispatchedByCall.get(toolTimingKey(runStep.id, callId)),
        }),
      );
      if (toolCallId) {
        state.toolCallIds.set(runStep.id, toolCallId);
      }
      state.messages.set(responseMessageId, updatedResponse);
      merge(updatedResponse, responseMessageId);
    }

    if (runStep.summary != null) {
      const updatedResponse = applySummaryStep(
        state.messages.get(responseMessageId) ?? response,
        runStep,
        editPrefixOffset,
      );
      state.messages.set(responseMessageId, updatedResponse);
      merge(updatedResponse, responseMessageId);
    }

    const bufferedDeltas = state.pendingDeltas.get(runStep.id);
    if (bufferedDeltas && bufferedDeltas.length > 0) {
      state.pendingDeltas.delete(runStep.id);
      for (const bufferedDelta of bufferedDeltas) {
        effects.push(...reduceStep(state, bufferedDelta, ctx));
      }
    }
    return effects;
  }

  if (event.event === StepEvents.ON_AGENT_UPDATE) {
    const responseMessageId = resolveResponseId(submission, event.data.agent_update.runId || '');
    if (!responseMessageId) {
      console.warn('No message id found in agent update event');
      return effects;
    }
    const response = state.messages.get(responseMessageId);
    if (response) {
      const updatedResponse = applyAgentUpdate(response, event.data, editPrefixOffset);
      state.messages.set(responseMessageId, updatedResponse);
      merge(updatedResponse, responseMessageId);
    }
    return effects;
  }

  if (
    event.event === StepEvents.ON_MESSAGE_DELTA ||
    event.event === StepEvents.ON_REASONING_DELTA
  ) {
    const delta = event.data;
    const runStep = state.steps.get(delta.id);
    const responseMessageId = resolveResponseId(submission, runStep?.runId);
    if (!runStep || !responseMessageId) {
      bufferDelta(state, delta.id, event);
      return effects;
    }
    const response = state.messages.get(responseMessageId);
    if (!response) {
      return effects;
    }
    const result =
      event.event === StepEvents.ON_MESSAGE_DELTA
        ? applyMessageDelta(response, runStep, event.data, editPrefixOffset)
        : applyReasoningDelta(response, runStep, event.data, editPrefixOffset);
    if (result.foldedEditPrefix && submission != null) {
      submission.editPrefixFirstPartFolded = true;
    }
    if (result.updated) {
      state.messages.set(responseMessageId, result.message);
      effects.push({ type: 'flush', messageId: responseMessageId, messages });
    }
    return effects;
  }

  if (event.event === StepEvents.ON_TOOL_PREPARATION) {
    const { id, index, toolCallId, observed_at: at } = event.data;
    if (!id || !isValidTime(at)) return effects;
    const runStep = state.steps.get(id);
    const declaredCalls =
      runStep?.stepDetails.type === StepTypes.TOOL_CALLS
        ? runStep.stepDetails.tool_calls
        : undefined;
    const resolvedId =
      toolCallId ?? (index === 0 && declaredCalls?.length === 1 ? declaredCalls[0]?.id : undefined);
    if (resolvedId) {
      const key = toolTimingKey(id, resolvedId);
      state.firstFragmentByCall.set(key, Math.min(state.firstFragmentByCall.get(key) ?? at, at));
    } else if (index === 0) {
      state.firstFragmentByStep.set(id, Math.min(state.firstFragmentByStep.get(id) ?? at, at));
    }
    if (!runStep?.runId || (runStep.status && runStep.status !== 'in_progress')) return effects;
    const responseId = resolveResponseId(submission, runStep.runId);
    const response = state.messages.get(responseId);
    const contentIndex = runStep.index + editPrefixOffset;
    const part = response?.content?.[contentIndex];
    if (
      !response ||
      part?.type !== ContentTypes.TOOL_CALL ||
      part.tool_call.runStepStatus != null ||
      (resolvedId && part.tool_call.id !== resolvedId)
    ) {
      return effects;
    }
    const content = [...(response.content ?? [])];
    content[contentIndex] = {
      ...part,
      tool_call: {
        ...part.tool_call,
        toolPreparationStartedAt: Math.min(part.tool_call.toolPreparationStartedAt ?? at, at),
      },
    };
    const updated = { ...response, content };
    state.messages.set(responseId, updated);
    merge(updated, responseId);
    return effects;
  }

  if (event.event === StepEvents.ON_RUN_STEP_DELTA) {
    const runStepDelta = event.data;
    const at = runStepDelta.observed_at;
    if (typeof at === 'number' && Number.isFinite(at) && at >= 0) {
      for (const chunk of runStepDelta.delta.tool_calls ?? []) {
        if (chunk.id) {
          const first =
            chunk.index === 0 ? state.firstFragmentByStep.get(runStepDelta.id) : undefined;
          const key = toolTimingKey(runStepDelta.id, chunk.id);
          state.firstFragmentByCall.set(
            key,
            Math.min(state.firstFragmentByCall.get(key) ?? at, first ?? at, at),
          );
          if (first != null) state.firstFragmentByStep.delete(runStepDelta.id);
        } else if (chunk.index === 0 && runStepDelta.delta.tool_calls?.length === 1) {
          const declared = state.steps.get(runStepDelta.id)?.stepDetails;
          const firstCallId =
            declared?.type === StepTypes.TOOL_CALLS && declared.tool_calls?.length === 1
              ? declared.tool_calls[0]?.id
              : undefined;
          if (firstCallId) {
            const key = toolTimingKey(runStepDelta.id, firstCallId);
            state.firstFragmentByCall.set(
              key,
              Math.min(state.firstFragmentByCall.get(key) ?? at, at),
            );
          } else {
            state.firstFragmentByStep.set(
              runStepDelta.id,
              Math.min(state.firstFragmentByStep.get(runStepDelta.id) ?? at, at),
            );
          }
        }
      }
    }
    const runStep = state.steps.get(runStepDelta.id);
    const responseMessageId = resolveResponseId(submission, runStep?.runId);
    if (!runStep || !responseMessageId) {
      bufferDelta(state, runStepDelta.id, event);
      return effects;
    }

    const response = state.messages.get(responseMessageId);
    const updatedResponse =
      response &&
      applyToolCallDelta(
        response,
        runStep,
        runStepDelta,
        state.toolCallIds.get(runStepDelta.id) ?? '',
        editPrefixOffset,
        (callId, index) => ({
          toolPreparationStartedAt:
            state.firstFragmentByCall.get(toolTimingKey(runStepDelta.id, callId)) ??
            (index === 0 ? state.firstFragmentByStep.get(runStepDelta.id) : undefined),
          toolDispatchedAt: state.dispatchedByCall.get(toolTimingKey(runStepDelta.id, callId)),
        }),
      );
    if (updatedResponse) {
      state.messages.set(responseMessageId, updatedResponse);
      merge(updatedResponse, responseMessageId);
    }
    return effects;
  }

  if (event.event === StepEvents.ON_TOOL_CALLS_DISPATCHED) {
    const { dispatched_at: at, toolCalls } = event.data;
    if (!isValidTime(at)) return effects;
    for (const call of toolCalls ?? []) {
      if (!call.id || !call.stepId) continue;
      const key = toolTimingKey(call.stepId, call.id);
      const dispatchedAt = Math.min(state.dispatchedByCall.get(key) ?? at, at);
      state.dispatchedByCall.set(key, dispatchedAt);
      const runStep = state.steps.get(call.stepId);
      if (!runStep?.runId) continue;
      const responseId = resolveResponseId(submission, runStep.runId);
      const response = state.messages.get(responseId);
      const index = runStep.index + editPrefixOffset;
      const part = response?.content?.[index];
      if (
        !response ||
        part?.type !== ContentTypes.TOOL_CALL ||
        part.tool_call.id !== call.id ||
        part.tool_call.runStepStatus != null
      ) {
        continue;
      }
      const content = [...(response.content ?? [])];
      content[index] = {
        ...part,
        tool_call: { ...part.tool_call, toolDispatchedAt: dispatchedAt },
      };
      const updated = { ...response, content };
      state.messages.set(responseId, updated);
      merge(updated, responseId);
    }
    return effects;
  }

  if (event.event === StepEvents.ON_RUN_STEP_COMPLETED) {
    const { result } = event.data;
    const { id: stepId } = result;
    const completedCallId = result.tool_call?.id;
    if (
      completedCallId &&
      typeof result.completed_at === 'number' &&
      Number.isFinite(result.completed_at)
    ) {
      state.completedByCall.set(toolTimingKey(stepId, completedCallId), result.completed_at);
    }
    effects.push({ type: 'sandbox-settled', toolCallId: completedCallId });

    const runStep = state.steps.get(stepId);
    const responseMessageId = resolveResponseId(submission, runStep?.runId);
    if (!runStep || !responseMessageId) {
      bufferDelta(state, stepId, event);
      return effects;
    }

    if (isSkillAuthoringToolCall(result.tool_call)) {
      effects.push({ type: 'skill-authored' });
    }

    const response = state.messages.get(responseMessageId);
    if (response) {
      const updatedResponse = applyToolCallCompleted(response, runStep, result, editPrefixOffset);
      state.messages.set(responseMessageId, updatedResponse);
      merge(updatedResponse, responseMessageId);
    }
    return effects;
  }

  if (event.event === StepEvents.ON_RUN_STEP_CLOSED) {
    const closed = event.data;
    const runStep = state.steps.get(closed.id);
    const responseMessageId = resolveResponseId(submission, runStep?.runId);
    /** A closure for a step this client never saw opened happens on reconnect, where the replay
     *  may start after the step was created; it is not an error worth surfacing. */
    if (!runStep || !responseMessageId) {
      return effects;
    }
    const response = state.messages.get(responseMessageId);
    const existing = response?.content?.[runStep.index + editPrefixOffset];
    if (!response || existing?.type !== ContentTypes.TOOL_CALL || !existing.tool_call) {
      return effects;
    }
    const existingToolCall = existing.tool_call;
    const key = toolTimingKey(closed.id, existingToolCall.id ?? '');
    const singleCallStep =
      runStep.stepDetails.type === StepTypes.TOOL_CALLS &&
      (runStep.stepDetails.tool_calls?.length ?? 0) <= 1;
    const observedAt = Math.min(
      state.firstFragmentByCall.get(key) ?? Infinity,
      existingToolCall.toolPreparationStartedAt ?? Infinity,
      singleCallStep ? (state.firstFragmentByStep.get(closed.id) ?? Infinity) : Infinity,
    );
    const timing = getToolTimingDurations({
      observedAt: Number.isFinite(observedAt) ? observedAt : undefined,
      dispatchedAt: existingToolCall.toolDispatchedAt ?? state.dispatchedByCall.get(key),
      completedAt: state.completedByCall.get(key),
    });
    state.firstFragmentByCall.delete(key);
    state.firstFragmentByStep.delete(closed.id);
    state.dispatchedByCall.delete(key);
    state.completedByCall.delete(key);
    const updatedResponse = applyRunStepClosed(response, runStep, closed, editPrefixOffset, timing);
    if (updatedResponse) {
      state.messages.set(responseMessageId, updatedResponse);
      merge(updatedResponse, responseMessageId);
    }
    return effects;
  }

  if (event.event === StepEvents.ON_SANDBOX_STARTING) {
    effects.push({ type: 'sandbox-starting', toolCallId: event.data.tool_call_id });
    return effects;
  }

  if (event.event === StepEvents.ON_PTC_TOOL_CALL) {
    /** `runId` is the response message id (the run configurable's `run_id`), the same
     *  correlation the subagent path uses. */
    effects.push({
      type: 'ptc',
      event: event.data,
      parentMessageId: resolveResponseId(submission, event.data.runId),
    });
    return effects;
  }

  if (event.event === StepEvents.ON_SUBAGENT_UPDATE) {
    const { phase } = event.data;
    effects.push(
      ...claimSubagentUpdate(state, event.data, resolveResponseId(submission, event.data.runId)),
    );
    if (phase === 'start' || phase === 'stop' || phase === 'error') {
      const conversationId = [
        submission?.userMessage?.conversationId,
        submission?.initialResponse?.conversationId,
        submission?.conversation?.conversationId,
      ].find((id) => id && id !== Constants.NEW_CONVO && id !== Constants.PENDING_CONVO);
      if (conversationId) effects.push({ type: 'subagent-index', conversationId });
    }
    return effects;
  }

  if (event.event === StepEvents.ON_SUMMARIZE_START) {
    effects.push({ type: 'announce', message: 'summarize_started' });
    return effects;
  }

  if (event.event === StepEvents.ON_SUMMARIZE_DELTA) {
    const deltaData = event.data;
    const runStep = state.steps.get(deltaData.id);
    const responseMessageId = resolveResponseId(submission, runStep?.runId);
    if (!runStep || !responseMessageId) {
      bufferDelta(state, deltaData.id, event);
      return effects;
    }
    const response = state.messages.get(responseMessageId);
    if (response) {
      state.messages.set(
        responseMessageId,
        applySummarizeDelta(response, runStep, deltaData, editPrefixOffset),
      );
      effects.push({ type: 'summary', messageId: responseMessageId, messages });
    }
    return effects;
  }

  if (event.event === StepEvents.ON_SUMMARIZE_COMPLETE) {
    const completeData = event.data;
    const completeRunStep = state.steps.get(completeData.id);
    const completeMessageId = resolveResponseId(submission, completeRunStep?.runId);
    const targetMessage = state.messages.get(completeMessageId);
    if (!targetMessage) {
      return effects;
    }
    /** Scoped to the owning step's slot when the step is known; see `finalizeSummaries`. */
    const completeIndex = completeRunStep != null ? completeRunStep.index + editPrefixOffset : -1;
    const finalized = finalizeSummaries(targetMessage, completeData, completeIndex);
    if (finalized) {
      effects.push({
        type: 'announce',
        message: completeData.error ? 'summarize_failed' : 'summarize_completed',
      });
      const currentMessages = submission.isRegenerate ? messages : ctx.getMessages() || [];
      state.messages.set(completeMessageId, finalized);
      ctx.setMessages(mergeResponseMessage(ctx, currentMessages, finalized, completeMessageId));
    }
    return effects;
  }

  const _exhaustive: never = event;
  console.warn('Unhandled step event', (_exhaustive as StepEvent).event);
  return effects;
}
