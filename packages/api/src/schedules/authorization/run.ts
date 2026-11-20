import { Constants, DEFAULT_HOOK_TIMEOUT_MS } from '@librechat/agents';
import {
  Tools,
  AgentCapabilities,
  normalizeServerName,
  SCHEDULE_APPROVAL_REASON,
  Constants as ProviderConstants,
} from 'librechat-data-provider';
import type { HookCallback } from '@librechat/agents';
import type { ScheduleMCPExecution } from './execution';
import { ASK_USER_QUESTION_TOOL_NAME } from '~/agents/hitl/askUserQuestionTool';
import { SET_MEMORY_TOOL_NAME, DELETE_MEMORY_TOOL_NAME } from '~/agents/memory';
import { isStatefulCodeEnvironmentToolName } from '~/agents/hitl/byom';
import { CHECK_BACKGROUND_TASK_NAME } from '~/agents/background';
import { ScheduledMCPPolicyError } from './policy';

const MEMORY_TOOL_NAMES = new Set<string>([SET_MEMORY_TOOL_NAME, DELETE_MEMORY_TOOL_NAME]);
/** What the skill catalog registers for an agent: the tool that runs a skill, and its file reader. */
const SKILL_TOOL_NAMES = new Set<string>([Constants.SKILL_TOOL, Constants.READ_FILE]);

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

/** What the model is told when it calls a tool the schedule's owner did not allow. */
export const SCHEDULE_TOOL_NOT_ALLOWED =
  'The owner of this schedule has not allowed this tool. Continue without it.';

/**
 * An enrolled run uses what its owner allowed: the MCP tools and the other tools the grant
 * lists, the SDK's own controls, and nothing else.
 */
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
  /**
   * MCP tools an agent has that the owner did not allow. Only a tool whose server and name
   * can be read off its key is listed: anything else is left to the check at the call.
   */
  const leftOut = new Map<string, Set<string>>();
  const isLeftOut = (agentId: string, name: string, tool: PolicyTool): boolean => {
    if (!execution.enrolled) return false;
    const servers = [tool.mcpRawServerName, tool.serverName].filter((server): server is string =>
      Boolean(server),
    );
    const selections = servers.flatMap((server) =>
      [server, normalizeServerName(server)]
        .map((spelling) => `${ProviderConstants.mcp_delimiter}${spelling}`)
        .filter((suffix) => name.endsWith(suffix) && name.length > suffix.length)
        .map((suffix) => name.slice(0, -suffix.length)),
    );
    return (
      selections.length > 0 &&
      !servers.some((server) =>
        selections.some((selection) => execution.grants(agentId, server, selection)),
      )
    );
  };
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
      const left = leftOut.get(agent.id) ?? new Set<string>();
      const register = (name: string, tool: PolicyTool): void => {
        names.add(name);
        if (isLeftOut(agent.id, name, tool)) left.add(name);
      };
      for (const tool of agent.toolDefinitions ?? []) {
        if (tool.toolType === 'mcp' && tool.serverName) register(tool.name, tool);
      }
      for (const [name, tool] of agent.toolRegistry ?? []) {
        if (tool.toolType === 'mcp' && (tool.mcpRawServerName || tool.serverName))
          register(name, tool);
      }
      mcpTools.set(agent.id, names);
      leftOut.set(agent.id, left);
      backgroundTools.set(agent.id, new Set(agent.backgroundToolNames ?? []));
    }
  };
  agents.forEach(registerAgent);
  registerGraph(agents, edges);
  /**
   * Tools the host or the SDK adds to a run, which no owner selects and no grant lists. The
   * background poll is one: a run that may send work to the background must be able to ask
   * what became of it.
   */
  const controls = new Set<string>([
    Constants.SUBAGENT,
    Constants.TOOL_SEARCH,
    ASK_USER_QUESTION_TOOL_NAME,
    CHECK_BACKGROUND_TASK_NAME,
  ]);
  /**
   * Whether the grant lists this tool of the agent's, one that is not an MCP tool. Some items
   * the owner allows run as tools of other names: the code environment's tools are all allowed
   * by code execution, the two memory tools by memory, and the tools an agent reads and
   * runs its skills with by skills.
   */
  const allowsTool = (agentId: string, name: string): boolean =>
    execution.grantsTool(agentId, name) ||
    (isStatefulCodeEnvironmentToolName(name) &&
      execution.grantsTool(agentId, Tools.execute_code)) ||
    (MEMORY_TOOL_NAMES.has(name) && execution.grantsTool(agentId, Tools.memory)) ||
    (SKILL_TOOL_NAMES.has(name) && execution.grantsTool(agentId, AgentCapabilities.skills));
  const denied = (input: Parameters<HookCallback<'PreToolUse'>>[0]): boolean => {
    const agentId = input.executingAgentId;
    // A run held without a grant starts nothing in the background: what it started would
    // finish in a turn of its own, after this hook. Under a grant whose subject that turn can
    // find again (`detaches`), the turn resolves the grant itself, so background work is
    // allowed like any other use of the tool. Under any other grant it stays refused.
    if (
      !(execution.enrolled && execution.detaches) &&
      input.toolInput.run_in_background === true &&
      (input.toolName === Constants.SUBAGENT ||
        (agentId != null && backgroundTools.get(agentId)?.has(input.toolName)))
    )
      return true;
    return !(
      // An ordinary run is the schedule's graph, root included. A completion turn is addressed
      // to the agent that started the work, which the root may only have handed off to.
      (
        (execution.completion || mcpTools.has(execution.identity.agentId)) &&
        agentId != null &&
        mcpTools.has(agentId) &&
        (controls.has(input.toolName) ||
          handoffs.get(agentId)?.has(input.toolName) === true ||
          mcpTools.get(agentId)!.has(input.toolName) ||
          allowsTool(agentId, input.toolName))
      )
    );
  };
  const decisions = new WeakMap<object, Promise<ScheduledMCPPolicyError | undefined>>();
  const failure = (input: Parameters<HookCallback<'PreToolUse'>>[0]) => {
    const pending = decisions.get(input);
    if (pending) return pending;
    const evaluated = (async () => {
      // One deadline for both reads: a slow first leaves the second only what remains, so the
      // refusal is always returned before the SDK gives up on the hook and lets the tool run.
      const deadline = Date.now() + DEFAULT_HOOK_TIMEOUT_MS / 2;
      try {
        await execution.checkEnrollment(deadline);
      } catch (error) {
        return new ScheduledMCPPolicyError(
          error instanceof ScheduledMCPPolicyError
            ? error.failure.reason
            : 'dependency_unavailable',
          '',
          input.executingAgentId,
        );
      }
      if (execution.enrolled)
        return denied(input)
          ? new ScheduledMCPPolicyError('tool_policy_denied', '', input.executingAgentId)
          : undefined;
      // No grant. Once one is required the run may use none of its tools: an MCP call is
      // refused where it is made, and any other tool here, with the same reason.
      let held: boolean;
      try {
        held = denied(input) && (await execution.needsGrant(deadline));
      } catch {
        return new ScheduledMCPPolicyError('dependency_unavailable', '', input.executingAgentId);
      }
      return held
        ? new ScheduledMCPPolicyError('consent_missing', '', input.executingAgentId)
        : undefined;
    })();
    decisions.set(input, evaluated);
    return evaluated;
  };
  return {
    registerAgent,
    hook: async (input) => {
      const error = await failure(input);
      if (error) return { decision: 'deny', reason: error.message };
      if (input.executingAgentId == null) return {};
      // The owner left this tool out on purpose. The model is told and the run goes on: it is
      // not a failure of the schedule, so nothing is recorded against the run. Should this hook
      // be skipped, the call is still refused where it is made, and that refusal is recorded.
      if (leftOut.get(input.executingAgentId)?.has(input.toolName) === true)
        return { decision: 'deny', reason: SCHEDULE_TOOL_NOT_ALLOWED };
      // Pauses the run where it can pause. The call itself is checked again when it is made.
      return execution.asksAbout(input.executingAgentId, input.toolName)
        ? { decision: 'ask', reason: SCHEDULE_APPROVAL_REASON }
        : {};
    },
    // Separate hook: a failed or timed-out receipt must never erase the immediate deny.
    receipt: async (input) => {
      const error = await failure(input);
      if (error) await recordDenial?.(error);
      return {};
    },
  };
}
