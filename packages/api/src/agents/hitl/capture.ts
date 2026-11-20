import { MAX_SUBAGENT_GRAPH_NODES } from 'librechat-data-provider';
import type { Agents } from 'librechat-data-provider';
import type { MCPToolAlias } from '~/tools/classification';
import type { PendingActionContext } from './policy';
import { captureRunToolApprovalBindings, describeRememberedToolApprovals } from './modes';
import { captureCodeExecutionApprovalBinding } from '../execution';
import { isStatefulCodeEnvironmentToolName } from './byom';
import { collectAllowAlwaysAliases } from './allow';
import { buildPendingAction } from './policy';

export interface CaptureRunPendingActionInput {
  run: object;
  payload: Agents.HumanInterruptPayload;
  agents: Parameters<typeof captureCodeExecutionApprovalBinding>[0];
  /** Complete initialized graph, including lazy/executing child participants. */
  resumeAgentIds: readonly string[];
  aliases: readonly MCPToolAlias[];
  context: Omit<
    PendingActionContext,
    'codeExecutionBinding' | 'toolApprovalAliases' | 'resumeAgentIds'
  >;
}

/** Preserve the executing run's tool and code authority, not client-supplied approval metadata. */
export function captureRunPendingAction({
  run,
  payload,
  agents,
  resumeAgentIds,
  aliases,
  context,
}: CaptureRunPendingActionInput): Agents.PendingAction {
  const participants = [...new Set(resumeAgentIds)].sort();
  if (
    participants.length === 0 ||
    participants.length > MAX_SUBAGENT_GRAPH_NODES ||
    participants.some((id) => typeof id !== 'string' || !id)
  )
    throw new Error('Agent resume participants are unavailable');
  const codeExecutionBinding =
    payload.type === 'tool_approval' &&
    payload.action_requests.some(
      (action) =>
        typeof action?.name === 'string' && isStatefulCodeEnvironmentToolName(action.name),
    )
      ? captureCodeExecutionApprovalBinding(agents)
      : undefined;
  const toolApprovalBindings = captureRunToolApprovalBindings(run, payload);
  const action = buildPendingAction(
    describeRememberedToolApprovals(payload, toolApprovalBindings, run),
    {
      ...context,
      resumeAgentIds: participants,
      codeExecutionBinding,
      toolApprovalAliases: collectAllowAlwaysAliases(
        payload.type === 'tool_approval' ? payload : undefined,
        aliases,
      ),
    },
  );
  action.toolApprovalBindings = toolApprovalBindings;
  return action;
}
