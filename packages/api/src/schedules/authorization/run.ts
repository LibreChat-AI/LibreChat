import { Constants } from '@librechat/agents';
import type { HookCallback } from '@librechat/agents';
import type { ScheduleMCPExecution } from './execution';
import { ASK_USER_QUESTION_TOOL_NAME } from '~/agents/hitl/askUserQuestionTool';
import { ScheduledMCPPolicyError } from './policy';

interface PolicyTool {
  name: string;
  toolType?: string;
  serverName?: string;
  mcpRawServerName?: string;
}
export interface ScheduledMCPPolicyAgent {
  id: string;
  toolDefinitions?: readonly PolicyTool[];
  toolRegistry?: ReadonlyMap<string, PolicyTool>;
  subagentAgentConfigs?: readonly ScheduledMCPPolicyAgent[];
  subagentGraphConfigs?: readonly { memberConfigs: readonly ScheduledMCPPolicyAgent[] }[];
}

/** No direct actions, arbitrary code or unclassified tools in an enrolled read-only run. */
export function createScheduledMCPRunPolicy(
  execution: ScheduleMCPExecution,
  agents: readonly ScheduledMCPPolicyAgent[],
): {
  hook: HookCallback<'PreToolUse'>;
  registerAgent: (agent: ScheduledMCPPolicyAgent) => void;
} {
  const mcpTools = new Map<string, Set<string>>();
  const registerAgent = (root: ScheduledMCPPolicyAgent): void => {
    const queue = [root];
    const visited = new Set<ScheduledMCPPolicyAgent>();
    for (const agent of queue) {
      if (visited.has(agent)) continue;
      visited.add(agent);
      queue.push(...(agent.subagentAgentConfigs ?? []));
      for (const graph of agent.subagentGraphConfigs ?? []) queue.push(...graph.memberConfigs);
      const names = mcpTools.get(agent.id) ?? new Set<string>();
      for (const tool of agent.toolDefinitions ?? []) {
        if (tool.toolType === 'mcp' && tool.serverName) names.add(tool.name);
      }
      for (const [name, tool] of agent.toolRegistry ?? []) {
        if (tool.toolType === 'mcp' && (tool.mcpRawServerName || tool.serverName)) names.add(name);
      }
      mcpTools.set(agent.id, names);
    }
  };
  agents.forEach(registerAgent);
  const controls = new Set<string>([
    Constants.SUBAGENT,
    Constants.TOOL_SEARCH,
    ASK_USER_QUESTION_TOOL_NAME,
  ]);
  return {
    registerAgent,
    hook: async (input) => {
      const agentId = input.executingAgentId;
      if (
        mcpTools.has(execution.identity.agentId) &&
        agentId != null &&
        mcpTools.has(agentId) &&
        (controls.has(input.toolName) || mcpTools.get(agentId)!.has(input.toolName))
      )
        return {};
      // This hook only tightens tool approval. The final MCP boundary still reauthorizes.
      return {
        decision: 'deny',
        reason: new ScheduledMCPPolicyError('tool_policy_denied', '', agentId).message,
      };
    },
  };
}
