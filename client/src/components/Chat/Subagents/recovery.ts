import { createStreamState, reduceStep, applySteerPart } from '@librechat/chat';
import {
  ContentTypes,
  EModelEndpoint,
  StepEvents,
  StepTypes,
  SteerEvents,
} from 'librechat-data-provider';
import type {
  EventSubmission,
  SubagentTaskContentResponse,
  SubagentTaskContentSnapshot,
  TMessage,
  FullToolCall,
  PartMetadata,
} from 'librechat-data-provider';
import type { StreamState, StepContext } from '@librechat/chat';
import { isLiveSubagentStatus } from './status';

export type RecoveredContent = {
  snapshot: SubagentTaskContentSnapshot;
  stream: StreamState;
};

export const recoveredMessage = (snapshot: SubagentTaskContentSnapshot): TMessage => ({
  messageId: snapshot.messageId,
  parentMessageId: snapshot.parentMessageId,
  conversationId: snapshot.threadId,
  sender: snapshot.sender,
  isCreatedByUser: false,
  text: '',
  content: snapshot.content,
});

/** Null requests a fresh snapshot. Only committed task frames enter the normal pure reducer. */
export function reduceRecoveredContent(
  previous: RecoveredContent | null,
  response: SubagentTaskContentResponse,
): RecoveredContent | null {
  return applyRecoveredContent(previous, response);
}

function applyRecoveredContent(
  previous: RecoveredContent | null,
  response: SubagentTaskContentResponse,
  owned = false,
  materializeSteps = true,
): RecoveredContent | null {
  if (
    previous != null &&
    (previous.snapshot.parentConversationId !== response.parentConversationId ||
      previous.snapshot.parentMessageId !== response.parentMessageId ||
      previous.snapshot.taskId !== response.taskId ||
      previous.snapshot.threadId !== response.threadId ||
      previous.snapshot.messageId !== response.messageId)
  ) {
    return null;
  }
  if (
    previous != null &&
    (response.revision < previous.snapshot.revision ||
      response.throughSequence < previous.snapshot.throughSequence)
  ) {
    return previous;
  }
  if (response.mode === 'snapshot') {
    const stream = createStreamState();
    stream.messages.set(response.messageId, recoveredMessage(response));
    for (const step of response.runSteps) {
      const part = response.content[step.index];
      stream.steps.set(step.id, {
        ...step,
        runId: response.messageId,
        agentId: step.agentId ?? part?.agentId,
        groupId: step.groupId ?? part?.groupId,
      });
      if (step.stepDetails.type === StepTypes.TOOL_CALLS) {
        const tool =
          part?.type === ContentTypes.TOOL_CALL
            ? (part.tool_call as FullToolCall & PartMetadata)
            : undefined;
        const preparedAt = tool?.toolPreparationStartedAt;
        if (
          !tool?.id &&
          (step.stepDetails.tool_calls?.length ?? 0) <= 1 &&
          typeof preparedAt === 'number' &&
          Number.isFinite(preparedAt) &&
          preparedAt >= 0
        ) {
          stream.firstFragmentByStep.set(step.id, preparedAt);
        }
        for (const call of step.stepDetails.tool_calls ?? []) {
          if (!call.id) continue;
          stream.toolCallIds.set(step.id, call.id);
          if (part?.type !== ContentTypes.TOOL_CALL || part.tool_call?.id !== call.id) continue;
          const tool = part.tool_call as FullToolCall & PartMetadata;
          const timingKey = `${step.id}\u0000${call.id}`;
          const preparedAt = tool.toolPreparationStartedAt;
          const dispatchedAt = tool.toolDispatchedAt;
          if (typeof preparedAt === 'number' && Number.isFinite(preparedAt) && preparedAt >= 0) {
            stream.firstFragmentByCall.set(timingKey, preparedAt);
          }
          if (
            typeof dispatchedAt === 'number' &&
            Number.isFinite(dispatchedAt) &&
            dispatchedAt >= 0
          ) {
            stream.dispatchedByCall.set(timingKey, dispatchedAt);
          }
        }
      }
    }
    return { snapshot: response, stream };
  }
  if (
    previous != null &&
    response.throughSequence <= previous.snapshot.throughSequence &&
    response.revision <= previous.snapshot.revision &&
    response.status === previous.snapshot.status &&
    response.recovery === previous.snapshot.recovery &&
    response.retryUntil === previous.snapshot.retryUntil &&
    response.targetThroughSequence === previous.snapshot.targetThroughSequence
  )
    return previous;
  if (previous == null || response.afterSequence !== previous.snapshot.throughSequence) return null;
  if (
    response.revision === previous.snapshot.revision &&
    response.throughSequence === previous.snapshot.throughSequence &&
    response.status === previous.snapshot.status &&
    response.recovery === previous.snapshot.recovery &&
    response.retryUntil === previous.snapshot.retryUntil &&
    response.targetThroughSequence === previous.snapshot.targetThroughSequence
  ) {
    return previous;
  }
  const source = previous.stream;
  const stream: StreamState = owned
    ? source
    : {
        ...source,
        messages: new Map(source.messages),
        steps: new Map(source.steps),
        toolCallIds: new Map(source.toolCallIds),
        firstFragmentByCall: new Map(source.firstFragmentByCall),
        firstFragmentByStep: new Map(source.firstFragmentByStep),
        dispatchedByCall: new Map(source.dispatchedByCall),
        completedByCall: new Map(source.completedByCall),
        pendingDeltas: new Map(
          [...source.pendingDeltas].map(([key, events]) => [key, events.slice()]),
        ),
      };
  const initialResponse = recoveredMessage(previous.snapshot);
  const userMessage: TMessage = {
    messageId: response.parentMessageId,
    parentMessageId: null,
    conversationId: response.threadId,
    isCreatedByUser: true,
    text: '',
  };
  let messages = [userMessage, initialResponse];
  const submission: EventSubmission = {
    userMessage,
    initialResponse,
    messages,
    conversation: { conversationId: response.threadId },
    endpointOption: { endpoint: EModelEndpoint.agents },
    isTemporary: false,
  };
  const context: StepContext = {
    submission,
    getMessages: () => messages,
    setMessages: (next) => {
      messages = next;
    },
  };
  let through = response.afterSequence;
  for (const { sequence, frame } of response.events) {
    if (sequence <= response.afterSequence) continue;
    if (sequence <= through || sequence > response.throughSequence) return null;
    through = sequence;
    if (frame.event === SteerEvents.ON_STEER_APPLIED) {
      const message = stream.messages.get(response.messageId);
      if (message == null) return null;
      const next = applySteerPart(message, frame.data);
      stream.messages.set(response.messageId, next);
      messages = messages.map((value) => (value.messageId === response.messageId ? next : value));
    } else if (frame.event === StepEvents.ON_RUN_STEP) {
      reduceStep(stream, { ...frame, data: { ...frame.data, runId: response.messageId } }, context);
    } else if (frame.event === StepEvents.ON_RUN_STEP_COMPLETED) {
      if (frame.data.result != null) {
        reduceStep(stream, { event: frame.event, data: { result: frame.data.result } }, context);
      }
    } else {
      reduceStep(stream, frame, context);
    }
  }
  const message = stream.messages.get(response.messageId);
  if (message == null) return null;
  const { events: _events, afterSequence: _afterSequence, mode: _mode, ...identity } = response;
  return {
    stream,
    snapshot: {
      ...identity,
      mode: 'snapshot',
      content: message.content ?? [],
      runSteps: materializeSteps ? Array.from(stream.steps.values()) : previous.snapshot.runSteps,
    },
  };
}

export const recoveredToolPart = (
  snapshot: SubagentTaskContentSnapshot,
  params: { partIndex: number; toolCallId?: string; stepId?: string; agentId?: string },
) => {
  const matches = (index: number) => {
    const part = snapshot.content[index];
    if (part?.type !== ContentTypes.TOOL_CALL) return false;
    const call = part.tool_call as FullToolCall;
    return (
      (params.toolCallId == null || call.id === params.toolCallId) &&
      (params.stepId == null || call.stepId === params.stepId) &&
      (params.agentId == null || part.agentId === params.agentId)
    );
  };
  let index = matches(params.partIndex) ? params.partIndex : -1;
  if (index < 0 && params.toolCallId != null) {
    for (let candidate = 0; candidate < snapshot.content.length; candidate++) {
      if (!matches(candidate)) continue;
      if (index >= 0) return null;
      index = candidate;
    }
  }
  const part = snapshot.content[index];
  return part?.type === ContentTypes.TOOL_CALL
    ? { partIndex: index, tool_call: part.tool_call as FullToolCall }
    : null;
};

export type TaskContentLoader = (
  afterSequence?: number,
  cursor?: string,
) => Promise<SubagentTaskContentResponse>;

/** Drain the sampled target before publishing it or asking for a newer suffix. */
export async function recoverTaskContent(
  previous: RecoveredContent | null,
  load: TaskContentLoader,
  signal?: AbortSignal,
): Promise<RecoveredContent> {
  const read: TaskContentLoader = async (afterSequence, cursor) => {
    if (signal?.aborted) throw new Error('subagent_content_cancelled');
    const response = cursor == null ? await load(afterSequence) : await load(afterSequence, cursor);
    if (signal?.aborted) throw new Error('subagent_content_cancelled');
    return response;
  };
  // Only this unpublished catch-up may reuse its mutable maps.
  const apply = (before: RecoveredContent | null, response: SubagentTaskContentResponse) =>
    applyRecoveredContent(
      before,
      response,
      before != null && before.stream !== previous?.stream,
      false,
    );
  let response = await read(previous?.snapshot.throughSequence);
  let next = apply(previous, response);
  if (next == null) {
    response = await read();
    next = apply(null, response);
  }
  let caughtUpTerminal = false;
  const seen = new Set<string>();
  while (true) {
    const target = response.targetThroughSequence;
    while (response.nextCursor != null) {
      const cursor = response.nextCursor;
      if (seen.has(cursor)) throw new Error('subagent_content_cursor_repeated');
      seen.add(cursor);
      const through = response.throughSequence;
      response = await read(undefined, cursor);
      if (response.targetThroughSequence !== target || response.throughSequence <= through) {
        throw new Error('subagent_content_cursor_mismatch');
      }
      next = apply(next, response);
      if (next == null) throw new Error('subagent_content_snapshot_required');
    }
    if (next == null || next.snapshot.throughSequence < target) {
      throw new Error('subagent_content_snapshot_incomplete');
    }
    if (
      caughtUpTerminal ||
      isLiveSubagentStatus(next.snapshot.status) ||
      next.snapshot.recovery === 'complete'
    ) {
      if (next === previous) return next;
      return {
        ...next,
        snapshot: { ...next.snapshot, runSteps: Array.from(next.stream.steps.values()) },
      };
    }
    // A pinned page can observe terminal status from a newer committed head.
    // Refresh once; a genuinely incomplete capture must remain partial.
    caughtUpTerminal = true;
    response = await read(next.snapshot.throughSequence);
    next = apply(next, response);
    if (next == null) throw new Error('subagent_content_snapshot_required');
  }
}
