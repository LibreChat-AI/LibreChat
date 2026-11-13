import type { Agents } from 'librechat-data-provider';

const DEFAULT_REVIEW_DECISIONS: Agents.ToolApprovalDecisionType[] = ['approve', 'reject', 'edit'];

/** Tool-call shape consumed by {@link buildToolApprovalPayload}. */
export interface ToolApprovalCallInput {
  name: string;
  arguments: string | Record<string, unknown>;
  tool_call_id: string;
  description?: string;
}

/** Builds a tool-approval interrupt payload from one or more paused tool calls, as the SDK emits it. */
export function buildToolApprovalPayload(
  toolCalls: ToolApprovalCallInput[],
  decisionsByToolName?: Record<string, Agents.ToolApprovalDecisionType[]>,
): Agents.ToolApprovalInterruptPayload {
  return {
    type: 'tool_approval',
    action_requests: toolCalls.map((tc) => ({
      name: tc.name,
      arguments: tc.arguments,
      tool_call_id: tc.tool_call_id,
      description: tc.description,
    })),
    review_configs: toolCalls.map((tc) => ({
      action_name: tc.name,
      tool_call_id: tc.tool_call_id,
      allowed_decisions: decisionsByToolName?.[tc.name] ?? DEFAULT_REVIEW_DECISIONS,
    })),
  };
}
