import type { TToolApprovalPolicy } from 'librechat-data-provider';
import type { PluginHookSource } from '~/agents/hooks/source';
import type { MCPToolAlias } from '~/tools/classification';
import type { ResolvedToolApprovalHook } from './hooks';
import {
  healToolApprovalPolicy,
  isHITLEnabled,
  isToolApprovalPauseCapable,
  isToolDeniedByApprovalPolicy,
} from './policy';
import { ASK_USER_QUESTION_TOOL_NAME } from './askUserQuestionTool';
import { resolvedToolApprovalHooksCanMatch } from './hooks';

interface ApprovalToolReference {
  readonly name?: string;
}

interface ApprovalToolRegistry {
  keys(): Iterable<string>;
  has(name: string): boolean;
}

interface ApprovalSubagentGraph {
  readonly memberConfigs?: readonly (ToolApprovalAdmissionAgent | null | undefined)[];
}

export interface ToolApprovalAdmissionAgent {
  readonly id?: string;
  readonly tools?: readonly (string | ApprovalToolReference)[];
  readonly toolRegistry?: ApprovalToolRegistry;
  readonly toolDefinitions?: readonly ApprovalToolReference[];
  readonly mcpToolAliases?: readonly MCPToolAlias[];
  readonly subagentAgentConfigs?: readonly (ToolApprovalAdmissionAgent | null | undefined)[];
  readonly lazySubagentConfigs?: readonly (ToolApprovalAdmissionAgent | null | undefined)[];
  readonly subagentGraphMemberMetadata?: readonly (ToolApprovalAdmissionAgent | null | undefined)[];
  readonly subagentGraphConfigs?: readonly ApprovalSubagentGraph[];
}

export interface ToolApprovalAdmissionInput {
  readonly policy: TToolApprovalPolicy | undefined;
  readonly agents: readonly (ToolApprovalAdmissionAgent | null | undefined)[];
  readonly hostGeneratedToolNames?: readonly string[];
  readonly resolvedProgrammaticHooks?: readonly ResolvedToolApprovalHook[];
  readonly pluginHookSource?: PluginHookSource;
  readonly askUserQuestionAdminDisabled?: boolean;
}

function agentHasTool(agent: ToolApprovalAdmissionAgent, toolName: string): boolean {
  return (
    agent.tools?.some((tool) => (typeof tool === 'string' ? tool : tool.name) === toolName) ===
      true ||
    agent.toolRegistry?.has(toolName) === true ||
    agent.toolDefinitions?.some((definition) => definition.name === toolName) === true
  );
}

function collectApprovalAgents(roots: readonly (ToolApprovalAdmissionAgent | null | undefined)[]): {
  agents: ToolApprovalAdmissionAgent[];
  lazyAgentIds: Set<string | undefined>;
} {
  const agents: ToolApprovalAdmissionAgent[] = [];
  const visited = new Set<ToolApprovalAdmissionAgent>();
  const pending = [...roots];
  const lazyAgentIds = new Set<string | undefined>();

  for (let index = 0; index < pending.length; index++) {
    const agent = pending[index];
    if (agent == null || visited.has(agent)) {
      continue;
    }
    visited.add(agent);
    agents.push(agent);
    pending.push(...(agent.subagentAgentConfigs ?? []));
    if ((agent.lazySubagentConfigs?.length ?? 0) > 0) {
      for (const lazyAgent of agent.lazySubagentConfigs ?? []) {
        lazyAgentIds.add(lazyAgent?.id);
      }
      pending.push(...(agent.lazySubagentConfigs ?? []));
    }
    pending.push(...(agent.subagentGraphMemberMetadata ?? []));
    for (const graph of agent.subagentGraphConfigs ?? []) {
      pending.push(...(graph.memberConfigs ?? []));
    }
  }

  return { agents, lazyAgentIds };
}

/**
 * Whether an initialized run can pause through tool approval or a top-level
 * `ask_user_question`. Eager tools are matched exactly across every subagent
 * form; unresolved lazy surfaces are classified conservatively. The interrupt
 * boundary remains the final fail-closed durability check.
 */
export function canAgentGraphPause({
  policy,
  agents,
  hostGeneratedToolNames = [],
  resolvedProgrammaticHooks = [],
  pluginHookSource,
  askUserQuestionAdminDisabled = false,
}: ToolApprovalAdmissionInput): boolean {
  const asksUserQuestion =
    !askUserQuestionAdminDisabled &&
    !isToolDeniedByApprovalPolicy(policy, ASK_USER_QUESTION_TOOL_NAME) &&
    agents.some((agent) => agent != null && agentHasTool(agent, ASK_USER_QUESTION_TOOL_NAME));
  if (!isHITLEnabled(policy)) {
    return asksUserQuestion;
  }

  const approvalGraph = collectApprovalAgents(agents);
  const toolOwners = new Map<string, Set<string | undefined>>();
  const aliases: MCPToolAlias[] = [];
  const aliasesByToolName = new Map<string, string[]>();
  const addToolName = (name: unknown, agentId?: string) => {
    if (typeof name === 'string' && name !== ASK_USER_QUESTION_TOOL_NAME) {
      const owners = toolOwners.get(name) ?? new Set<string | undefined>();
      owners.add(agentId);
      toolOwners.set(name, owners);
    }
  };

  for (const name of hostGeneratedToolNames) {
    addToolName(name);
  }

  for (const agent of approvalGraph.agents) {
    for (const tool of agent.tools ?? []) {
      addToolName(typeof tool === 'string' ? tool : tool.name, agent.id);
    }
    if (agent.toolRegistry) {
      for (const name of agent.toolRegistry.keys()) {
        addToolName(name, agent.id);
      }
    }
    for (const definition of agent.toolDefinitions ?? []) {
      addToolName(definition.name, agent.id);
    }
    for (const alias of agent.mcpToolAliases ?? []) {
      aliases.push(alias);
      const names = aliasesByToolName.get(alias.name) ?? [];
      names.push(alias.aliasName);
      aliasesByToolName.set(alias.name, names);
    }
  }

  const effectivePolicy = healToolApprovalPolicy(policy, aliases);
  const knownToolCanPause = Array.from(toolOwners).some(([toolName, agentIds]) => {
    const matcherNames = [toolName, ...(aliasesByToolName.get(toolName) ?? [])];
    const pluginHookCanAsk = pluginHookSource?.hasToolApprovalHooks?.([toolName]) === true;
    return Array.from(agentIds).some((agentId) => {
      const requestHookCanAsk = resolvedToolApprovalHooksCanMatch(
        resolvedProgrammaticHooks,
        matcherNames,
        agentId,
      );
      return isToolApprovalPauseCapable(effectivePolicy, requestHookCanAsk || pluginHookCanAsk, [
        toolName,
      ]);
    });
  });
  if (knownToolCanPause) {
    return true;
  }
  if (approvalGraph.lazyAgentIds.size > 0) {
    const pluginHookCanAsk = pluginHookSource?.hasToolApprovalHooks?.() === true;
    const unresolvedHookCanAsk = Array.from(approvalGraph.lazyAgentIds).some(
      (agentId) =>
        resolvedProgrammaticHooks.some(
          ({ agentIds }) => agentIds == null || (agentId != null && agentIds.has(agentId)),
        ) || pluginHookCanAsk,
    );
    const staticPolicyCanAsk = isToolApprovalPauseCapable(effectivePolicy);
    if (staticPolicyCanAsk || unresolvedHookCanAsk) {
      return true;
    }
  }
  return asksUserQuestion;
}

/**
 * Whether `createRun` attaches a checkpointer for this initialization.
 * Cleanup follows attachment, not current pause capability: a retry must not
 * restore remnants written before a policy or request-hook change.
 */
export function agentRunUsesCheckpointer({
  policy,
  agents,
  askUserQuestionAdminDisabled = false,
}: Pick<
  ToolApprovalAdmissionInput,
  'policy' | 'agents' | 'askUserQuestionAdminDisabled'
>): boolean {
  return (
    isHITLEnabled(policy) ||
    (!askUserQuestionAdminDisabled &&
      agents.some((agent) => agent != null && agentHasTool(agent, ASK_USER_QUESTION_TOOL_NAME)))
  );
}
