import { Constants, ContentTypes } from 'librechat-data-provider';
import type { TMessage, SubagentUpdateEvent } from 'librechat-data-provider';
import type { StreamState, StepEffect } from './state';
import { subagentProgressKey } from './state';

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
export function claimSubagentUpdate(
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
