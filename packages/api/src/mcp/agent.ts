import type { MCPManager } from './MCPManager';
import type { RequestBody } from '~/types';
import { withMCPAgentContext } from './request';

type ToolInvocation = Parameters<MCPManager['callTool']>[0];
export type AgentMCPToolInvoker = (
  manager: Pick<MCPManager, 'callTool'>,
  invocation: ToolInvocation,
) => ReturnType<MCPManager['callTool']>;

/** Own the tool identity across construction, runtime overrides, and invocation retries. */
export function createAgentMCPTool<T extends { agentId?: string; requestBody?: RequestBody }, R>(
  input: T,
  construct: (bound: T & { invokeTool: AgentMCPToolInvoker }) => R,
): R {
  const agentId = input.agentId;
  return construct({
    ...input,
    requestBody: withMCPAgentContext(input.requestBody, agentId),
    invokeTool: (manager, invocation) =>
      manager.callTool({
        ...invocation,
        requestBody: withMCPAgentContext(invocation.requestBody, agentId),
      }),
  });
}
