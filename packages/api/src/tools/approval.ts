import { AsyncLocalStorage } from 'node:async_hooks';
import { digestMCPAuthorityValue } from '@librechat/data-schemas';
const bindingKey: unique symbol = Symbol.for('librechat.toolApprovalBinding');
const nameKey: unique symbol = Symbol.for('librechat.toolApprovalName');
const identityKey: unique symbol = Symbol.for('librechat.toolApprovalIdentity');
type BoundTool = { [bindingKey]?: string; [nameKey]?: string; [identityKey]?: string };

/** Object spreads retain the binding; JSON/provider payloads cannot expose it. */
export function bindToolApproval<T extends object>(
  tool: T,
  binding: string | undefined,
  name?: string,
  identity?: string,
): T {
  if (binding != null) (tool as BoundTool)[bindingKey] = binding;
  if (name != null) (tool as BoundTool)[nameKey] = name;
  if (identity != null) (tool as BoundTool)[identityKey] = identity;
  return tool;
}

export function getToolApprovalBinding(tool: object): string | undefined {
  return (tool as BoundTool)[bindingKey];
}

export function getToolApprovalName(tool: object): string | undefined {
  return (tool as BoundTool)[nameKey];
}

export function bindToolApprovalIdentity<T extends object>(
  tool: T,
  upstreamName: string,
  parameters?: object,
  description?: string,
): T {
  (tool as BoundTool)[identityKey] = digestMCPAuthorityValue({
    upstreamName,
    parameters,
    description,
  });
  return tool;
}

export function getToolApprovalIdentity(tool: object): string | undefined {
  return (tool as BoundTool)[identityKey];
}

export interface ToolApprovalInvocation {
  agentId?: string;
  toolCallId?: string;
}

export interface ToolApprovalExecution {
  validateExecution: (tool: { name: string }, invocation: ToolApprovalInvocation) => Promise<void>;
}

const executionContext = new AsyncLocalStorage<ToolApprovalExecution>();

/** Async context keeps policy capabilities out of checkpoint, request and model data. */
export function withToolApprovalExecution<T>(execution: ToolApprovalExecution, invoke: () => T): T {
  return executionContext.run(execution, invoke);
}

export async function assertToolApprovalExecution(
  tool: { name: string },
  config?: {
    toolCall?: { id?: string };
    metadata?: { executingAgentId?: string; activeAgentId?: string; agentId?: string };
  },
): Promise<void> {
  const execution = executionContext.getStore();
  if (!execution) return;
  await execution.validateExecution(tool, {
    agentId:
      config?.metadata?.executingAgentId ??
      config?.metadata?.activeAgentId ??
      config?.metadata?.agentId,
    toolCallId: config?.toolCall?.id,
  });
}
