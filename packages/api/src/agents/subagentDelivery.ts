import { Constants } from '@librechat/agents';
import { isEphemeralAgentId } from 'librechat-data-provider';
import type { HookCallback, PostToolUseHookOutput, SubagentTaskConfig } from '@librechat/agents';
import type { TAgentsEndpoint } from 'librechat-data-provider';

export const SUBAGENT_COMPLETION_DELIVERY = 'wakeup';

/** Host-owned detached-subagent scope with its model-facing result-delivery contract. */
export interface HostSubagentTaskConfig extends SubagentTaskConfig {
  completionDelivery?: typeof SUBAGENT_COMPLETION_DELIVERY;
}

export const SUBAGENT_WAKEUP_GUIDANCE =
  'Automatic completion delivery is enabled for this subagent task. Continue independent work if available; otherwise end this turn and the host will resume you when the task finishes. Do not repeatedly poll an unchanged running task. Use check_background_task only for explicit status or control, or as a fallback if automatic delivery is unavailable.';

/** Single-task poll guidance, secondary to the activity digest it accompanies. */
export const SUBAGENT_POLL_WAKEUP_GUIDANCE =
  'This subagent resumes you automatically when it finishes, so there is no need to check again. If you do, wait next_check_s and pass since: activity.cursor.';

export const SUBAGENT_POLL_GUIDANCE =
  'Results are not pushed for this subagent. Check again after next_check_s, passing since: activity.cursor to get only new activity.';

/** Automatic conversational completion is default-on and has one administrator opt-out. */
export function backgroundCompletionWakeupsEnabled(config: TAgentsEndpoint | undefined): boolean {
  return config?.backgroundTasks?.completionWakeups !== false;
}

export function usesSubagentCompletionWakeups(
  config: SubagentTaskConfig | undefined,
): config is HostSubagentTaskConfig {
  return (
    (config as HostSubagentTaskConfig | undefined)?.completionDelivery ===
    SUBAGENT_COMPLETION_DELIVERY
  );
}

/** Automatic delivery is agent-specific even though the SDK task scope is run-wide. */
export function agentUsesSubagentCompletionWakeups(
  config: SubagentTaskConfig | undefined,
  agentId: string | undefined,
): config is HostSubagentTaskConfig {
  return (
    usesSubagentCompletionWakeups(config) &&
    typeof agentId === 'string' &&
    agentId !== '' &&
    !isEphemeralAgentId(agentId)
  );
}

function parseOutput(output: unknown): Record<string, unknown> | undefined {
  if (typeof output === 'object' && output !== null && !Array.isArray(output)) {
    return output as Record<string, unknown>;
  }
  if (typeof output !== 'string') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(output) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Replaces the SDK's legacy poll-first handle with the host's durable delivery contract. */
export function createSubagentWakeupHandleHook(
  supportsWakeup: (agentId: string | undefined) => boolean = () => true,
): HookCallback<'PostToolUse'> {
  return async (input): Promise<PostToolUseHookOutput> => {
    if (input.toolName !== String(Constants.SUBAGENT) || !supportsWakeup(input.executingAgentId)) {
      return {};
    }
    const output = parseOutput(input.toolOutput);
    if (
      output?.status !== 'running' ||
      typeof output.background_task_id !== 'string' ||
      output.background_task_id === ''
    ) {
      return {};
    }
    /** The client recognizes a durable child handle by its exact host-owned shape
     * and by the message repeating the opaque task identity. Preserve that
     * anti-spoofing contract while replacing the legacy poll-first guidance. */
    const updated = {
      ...output,
      message: `Task handle: background_task_id "${output.background_task_id}". ${SUBAGENT_WAKEUP_GUIDANCE}`,
    };
    return {
      updatedOutput: typeof input.toolOutput === 'string' ? JSON.stringify(updated) : updated,
    };
  };
}
