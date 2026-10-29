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
  aliases: readonly MCPToolAlias[];
  context: Omit<PendingActionContext, 'codeExecutionBinding' | 'toolApprovalAliases'>;
}

/** Preserve the executing run's tool and code authority, not client-supplied approval metadata. */
export function captureRunPendingAction({
  run,
  payload,
  agents,
  aliases,
  context,
}: CaptureRunPendingActionInput): Agents.PendingAction {
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
