import { Constants } from '@librechat/agents';
import type { HookCallback } from '@librechat/agents';
import type { ScheduleMCPExecution } from './execution';
import { ASK_USER_QUESTION_TOOL_NAME } from '~/agents/hitl/askUserQuestionTool';
import { ScheduledMCPPolicyError } from './policy';

interface HandoffEdge {
  from: string | string[];
  to: string | string[];
  edgeType?: 'handoff' | 'direct';
  /** Only presence is used; evaluation and destination validation remain SDK-owned. */
  condition?: unknown;
}

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
  backgroundToolNames?: readonly string[];
  subagentAgentConfigs?: readonly ScheduledMCPPolicyAgent[];
  subagentGraphConfigs?: readonly {
    definition?: { edges: readonly HandoffEdge[] };
    memberConfigs: readonly ScheduledMCPPolicyAgent[];
  }[];
}

/** No direct actions, arbitrary code or unclassified tools in an enrolled read-only run. */
export function createScheduledMCPRunPolicy(
  execution: ScheduleMCPExecution,
  agents: readonly ScheduledMCPPolicyAgent[],
  edges: readonly HandoffEdge[] = [],
  recordDenial?: (error: ScheduledMCPPolicyError) => Promise<boolean>,
): {
  hook: HookCallback<'PreToolUse'>;
  receipt: HookCallback<'PreToolUse'>;
  registerAgent: (agent: ScheduledMCPPolicyAgent) => void;
} {
  const mcpTools = new Map<string, Set<string>>();
  const handoffs = new Map<string, Set<string>>();
  const backgroundTools = new Map<string, Set<string>>();
  const registerGraph = (
    members: readonly ScheduledMCPPolicyAgent[],
    admittedEdges: readonly HandoffEdge[],
  ): void => {
    const ids = new Set(members.map(({ id }) => id));
    for (const edge of admittedEdges) {
      const sources = Array.isArray(edge.from) ? edge.from : [edge.from];
      const targets = Array.isArray(edge.to) ? edge.to : [edge.to];
      // Match SDK categorization, including its implicit one-to-many direct edge.
      if (
        edge.edgeType === 'direct' ||
        (edge.edgeType == null &&
          edge.condition == null &&
          sources.length === 1 &&
          targets.length > 1) ||
        !targets.length ||
        !targets.every((id) => ids.has(id))
      )
        continue;
      const names =
        edge.condition != null
          ? ['conditional_transfer']
          : targets.map((id) => `${Constants.LC_TRANSFER_TO_}${id}`);
      for (const source of sources) {
        if (!ids.has(source)) continue;
        const controls = handoffs.get(source) ?? new Set<string>();
        for (const name of names) controls.add(name);
        handoffs.set(source, controls);
      }
    }
  };
  const registerAgent = (root: ScheduledMCPPolicyAgent): void => {
    const queue = [root];
    const visited = new Set<ScheduledMCPPolicyAgent>();
    for (const agent of queue) {
      if (visited.has(agent)) continue;
      visited.add(agent);
      queue.push(...(agent.subagentAgentConfigs ?? []));
      for (const graph of agent.subagentGraphConfigs ?? []) {
        queue.push(...graph.memberConfigs);
        registerGraph(graph.memberConfigs, graph.definition?.edges ?? []);
      }
      const names = mcpTools.get(agent.id) ?? new Set<string>();
      for (const tool of agent.toolDefinitions ?? []) {
        if (tool.toolType === 'mcp' && tool.serverName) names.add(tool.name);
      }
      for (const [name, tool] of agent.toolRegistry ?? []) {
        if (tool.toolType === 'mcp' && (tool.mcpRawServerName || tool.serverName)) names.add(name);
      }
      mcpTools.set(agent.id, names);
      backgroundTools.set(agent.id, new Set(agent.backgroundToolNames ?? []));
    }
  };
  agents.forEach(registerAgent);
  registerGraph(agents, edges);
  const controls = new Set<string>([
    Constants.SUBAGENT,
    Constants.TOOL_SEARCH,
    ASK_USER_QUESTION_TOOL_NAME,
  ]);
  const denied = (input: Parameters<HookCallback<'PreToolUse'>>[0]): boolean => {
    const agentId = input.executingAgentId;
    // Foreground delegation stays in this guarded run; detached continuations do not.
    if (
      input.toolInput.run_in_background === true &&
      (input.toolName === Constants.SUBAGENT ||
        (agentId != null && backgroundTools.get(agentId)?.has(input.toolName)))
    )
      return true;
    return !(
      mcpTools.has(execution.identity.agentId) &&
      agentId != null &&
      mcpTools.has(agentId) &&
      (controls.has(input.toolName) ||
        handoffs.get(agentId)?.has(input.toolName) === true ||
        mcpTools.get(agentId)!.has(input.toolName))
    );
  };
  const decisions = new WeakMap<object, Promise<ScheduledMCPPolicyError | undefined>>();
  const failure = (input: Parameters<HookCallback<'PreToolUse'>>[0]) => {
    const pending = decisions.get(input);
    if (pending) return pending;
    const evaluated = (async () => {
      try {
        await execution.checkEnrollment();
      } catch (error) {
        return new ScheduledMCPPolicyError(
          error instanceof ScheduledMCPPolicyError
            ? error.failure.reason
            : 'dependency_unavailable',
          '',
          input.executingAgentId,
        );
      }
      if (!execution.enrolled || !denied(input)) return;
      return new ScheduledMCPPolicyError('tool_policy_denied', '', input.executingAgentId);
    })();
    decisions.set(input, evaluated);
    return evaluated;
  };
  return {
    registerAgent,
    hook: async (input) => {
      const error = await failure(input);
      return error ? { decision: 'deny', reason: error.message } : {};
    },
    // Separate hook: a failed or timed-out receipt must never erase the immediate deny.
    receipt: async (input) => {
      const error = await failure(input);
      if (error) await recordDenial?.(error);
      return {};
    },
  };
}
