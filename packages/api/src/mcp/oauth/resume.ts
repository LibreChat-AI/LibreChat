import { Constants } from 'librechat-data-provider';

import type { Agents } from 'librechat-data-provider';
import type * as t from '~/types';

const OAUTH_TOOL_PREFIX = `oauth${Constants.mcp_delimiter}`;

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function getStepId(event: NonNullable<t.ResumeState['replayEvents']>[number]): string | undefined {
  const data = getRecord(event.data);
  if (!data) {
    return undefined;
  }
  if (event.event === 'on_run_step_completed') {
    const result = getRecord(data.result);
    return typeof result?.id === 'string' ? result.id : undefined;
  }
  return typeof data.id === 'string' ? data.id : undefined;
}

function getOAuthToolCall(toolCalls: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(toolCalls)) {
    return undefined;
  }
  for (const toolCall of toolCalls) {
    const candidate = getRecord(toolCall);
    if (typeof candidate?.name === 'string' && candidate.name.startsWith(OAUTH_TOOL_PREFIX)) {
      return candidate;
    }
  }
  return undefined;
}

function getPreferredString(primary: unknown, fallback: unknown): string | undefined {
  if (typeof primary === 'string') {
    return primary;
  }
  return typeof fallback === 'string' ? fallback : undefined;
}

/**
 * Projects the current client-safe MCP OAuth prompts from the durable event
 * representation retained for mixed-version resume compatibility.
 */
export function projectPendingMCPOAuthPrompts(
  replayEvents: t.ResumeState['replayEvents'],
  runSteps: readonly Agents.RunStep[],
  now: number = Date.now(),
): Agents.PendingMCPOAuthPrompt[] | undefined {
  if (!replayEvents?.length) {
    return undefined;
  }

  const runStepsById = new Map(runSteps.map((runStep) => [runStep.id, runStep]));
  const terminalToolCallIds = new Map<string, string | undefined>();
  for (const event of replayEvents) {
    if (event.event !== 'on_run_step_completed') {
      continue;
    }
    const stepId = getStepId(event);
    if (stepId) {
      const data = getRecord(event.data);
      const result = getRecord(data?.result);
      const toolCall = getRecord(result?.tool_call);
      terminalToolCallIds.set(stepId, typeof toolCall?.id === 'string' ? toolCall.id : undefined);
    }
  }

  const prompts = new Map<string, Agents.PendingMCPOAuthPrompt>();
  for (const event of replayEvents) {
    if (event.event !== 'on_run_step_delta') {
      continue;
    }
    const data = getRecord(event.data);
    const delta = getRecord(data?.delta);
    const stepId = typeof data?.id === 'string' ? data.id : undefined;
    const authURL = typeof delta?.auth === 'string' ? delta.auth : undefined;
    if (!delta || !stepId || !authURL) {
      continue;
    }

    const expiresAt =
      typeof delta.expires_at === 'number' && Number.isFinite(delta.expires_at)
        ? delta.expires_at
        : undefined;
    if (expiresAt != null && expiresAt <= now) {
      continue;
    }

    const runStep = runStepsById.get(stepId);
    if (
      !runStep ||
      runStep.status === 'completed' ||
      runStep.status === 'cancelled' ||
      runStep.status === 'failed'
    ) {
      continue;
    }
    const runStepToolCalls =
      runStep.stepDetails.type === 'tool_calls' ? runStep.stepDetails.tool_calls : undefined;
    const deltaToolCall = getOAuthToolCall(delta.tool_calls);
    const runStepToolCall = getOAuthToolCall(runStepToolCalls);
    const toolName = getPreferredString(deltaToolCall?.name, runStepToolCall?.name);
    if (!toolName) {
      continue;
    }

    const deltaToolCallId = deltaToolCall?.id;
    const runStepToolCallId = runStepToolCall?.id;
    const toolCallId = getPreferredString(deltaToolCallId, runStepToolCallId);
    if (terminalToolCallIds.has(stepId)) {
      const terminalToolCallId = terminalToolCallIds.get(stepId);
      if (!terminalToolCallId || !toolCallId || terminalToolCallId === toolCallId) {
        continue;
      }
    }
    prompts.set(stepId, {
      stepId,
      runId: runStep.runId,
      index: runStep.index,
      toolCallId,
      toolName,
      authURL,
      expiresAt,
    });
  }

  return prompts.size > 0
    ? [...prompts.values()].sort((left, right) => left.index - right.index)
    : undefined;
}
