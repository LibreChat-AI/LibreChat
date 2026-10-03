import { AsyncLocalStorage } from 'node:async_hooks';
import { digestMCPAuthorityValue } from '@librechat/data-schemas';
import type { SubagentExecutionContext } from '@librechat/agents';
const bindingKey: unique symbol = Symbol.for('librechat.toolApprovalBinding');
const nameKey: unique symbol = Symbol.for('librechat.toolApprovalName');
const identityKey: unique symbol = Symbol.for('librechat.toolApprovalIdentity');
const reviewAuthorityKey: unique symbol = Symbol.for('librechat.toolReviewAuthority');
type BoundTool = {
  [bindingKey]?: string;
  [nameKey]?: string;
  [identityKey]?: string;
  [reviewAuthorityKey]?: string;
};

/** Object spreads retain the binding; JSON/provider payloads cannot expose it. */
export function bindToolApproval<T extends object>(
  tool: T,
  binding: string | undefined,
  name?: string,
  identity?: string,
  reviewAuthority?: string,
): T {
  if (binding != null) (tool as BoundTool)[bindingKey] = binding;
  if (name != null) (tool as BoundTool)[nameKey] = name;
  if (identity != null) (tool as BoundTool)[identityKey] = identity;
  if (reviewAuthority != null) (tool as BoundTool)[reviewAuthorityKey] = reviewAuthority;
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

export function bindToolReviewAuthority<T extends object>(
  tool: T,
  authority: string | undefined,
): T {
  if (authority != null) (tool as BoundTool)[reviewAuthorityKey] = authority;
  return tool;
}

export function getToolReviewAuthority(tool: object): string | undefined {
  return (tool as BoundTool)[reviewAuthorityKey] ?? getToolApprovalBinding(tool);
}

export interface ToolApprovalInvocation {
  agentId?: string;
  toolCallId?: string;
  executionScope?: string;
  background?: boolean;
}

export function getToolApprovalExecutionScope(
  context?: Pick<SubagentExecutionContext, 'ancestry'>,
): string | undefined {
  const ancestry = context?.ancestry;
  return ancestry?.length ? ancestry[ancestry.length - 1].subagentRunId : undefined;
}

export interface ToolApprovalExecution {
  validateExecution: (tool: { name: string }, invocation: ToolApprovalInvocation) => Promise<void>;
  noteDispatch?: (invocation: ToolApprovalInvocation) => void;
  finishDispatch?: (invocation: ToolApprovalInvocation) => void;
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
    configurable?: { __librechatBackgroundToolInvocation?: boolean };
    metadata?: {
      executingAgentId?: string;
      activeAgentId?: string;
      agentId?: string;
      executionContext?: SubagentExecutionContext;
    };
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
    executionScope: getToolApprovalExecutionScope(config?.metadata?.executionContext),
    background: config?.configurable?.__librechatBackgroundToolInvocation === true,
  });
}

export function noteToolApprovalDispatch(invocation: ToolApprovalInvocation): void {
  executionContext.getStore()?.noteDispatch?.(invocation);
}

export function finishToolApprovalDispatch(invocation: ToolApprovalInvocation): void {
  executionContext.getStore()?.finishDispatch?.(invocation);
}
