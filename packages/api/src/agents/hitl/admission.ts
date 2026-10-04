import { Constants } from 'librechat-data-provider';
import type { TToolApprovalPolicy } from 'librechat-data-provider';
import type { AgentToolOptions } from 'librechat-data-provider';
import type { PluginHookSource } from '~/agents/hooks/source';
import type { MCPToolAlias } from '~/tools/classification';
import type { ResolvedToolApprovalHook } from './hooks';
import { isHITLEnabled, isToolApprovalPauseCapable, isToolDeniedByApprovalPolicy } from './policy';
import { ASK_USER_QUESTION_TOOL_NAME } from './askUserQuestionTool';
import { aliasMCPToolOptions } from '~/tools/classification';
import { resolvedToolApprovalHooksCanMatch } from './hooks';
import { buildEffectiveToolApprovalPolicy } from './allow';
import { isMCPAllPlaceholder } from '~/mcp/utils';

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
  readonly tool_options?: AgentToolOptions;
  readonly tools?: readonly (string | ApprovalToolReference)[];
  readonly toolRegistry?: ApprovalToolRegistry;
  readonly toolDefinitions?: readonly ApprovalToolReference[];
  readonly mcpToolAliases?: readonly MCPToolAlias[];
  readonly subagentAgentConfigs?: readonly (ToolApprovalAdmissionAgent | null | undefined)[];
  readonly lazySubagentConfigs?: readonly (ToolApprovalAdmissionAgent | null | undefined)[];
  readonly subagentGraphMemberMetadata?: readonly (ToolApprovalAdmissionAgent | null | undefined)[];
  readonly subagentGraphConfigs?: readonly ApprovalSubagentGraph[];
}

type AdmissionSurface = Pick<
  ToolApprovalAdmissionAgent,
  'tool_options' | 'tools' | 'toolRegistry' | 'toolDefinitions' | 'mcpToolAliases'
>;
const admissionSurfaces = new WeakMap<object, AdmissionSurface>();

function readAdmissionSurface(agent: ToolApprovalAdmissionAgent): ToolApprovalAdmissionAgent {
  const captured = admissionSurfaces.get(agent);
  return captured ? { ...captured, ...agent } : agent;
}

/** Retain only admission data across server-only lazy projections. */
export function copyToolApprovalAdmissionMetadata<T extends object>(
  target: T,
  source: ToolApprovalAdmissionAgent,
): T {
  const surface = readAdmissionSurface(source);
  admissionSurfaces.set(target, {
    tool_options:
      surface.tool_options &&
      Object.fromEntries(
        Object.entries(surface.tool_options).map(([name, option]) => [
          name,
          { approval_mode: option.approval_mode },
        ]),
      ),
    tools: surface.tools?.map((tool) => (typeof tool === 'string' ? tool : { name: tool.name })),
    toolRegistry: surface.toolRegistry,
    toolDefinitions: surface.toolDefinitions?.map(({ name }) => ({ name })),
    mcpToolAliases: surface.mcpToolAliases?.map((alias) => ({ ...alias })),
  });
  return target;
}

export interface ToolApprovalAdmissionInput {
  readonly policy: TToolApprovalPolicy | undefined;
  readonly agents: readonly (ToolApprovalAdmissionAgent | null | undefined)[];
  readonly hostGeneratedToolNames?: readonly string[];
  readonly resolvedProgrammaticHooks?: readonly ResolvedToolApprovalHook[];
  readonly pluginHookSource?: PluginHookSource;
  readonly askUserQuestionAdminDisabled?: boolean;
  /** Tools the conversation remembers; folded in exactly as `createRun` folds them. */
  readonly toolApprovalAllows?: readonly string[];
}

/** Catalog-free legacy selection is a possible alias, not a verified identity. */
function unresolvedLegacySelectionCanAsk(
  name: string,
  options: AgentToolOptions,
  policy: TToolApprovalPolicy | undefined,
): boolean {
  if (options[name] != null || isToolDeniedByApprovalPolicy(policy, name)) return false;
  let delimiter = name.indexOf(Constants.mcp_delimiter);
  while (delimiter >= 0) {
    const upstream = name.slice(0, delimiter);
    const server = name.slice(delimiter + Constants.mcp_delimiter.length);
    const prefix = `${server}_`;
    if (server && upstream.startsWith(prefix)) {
      const candidate = `${upstream.slice(prefix.length)}${Constants.mcp_delimiter}${server}`;
      const mode = options[candidate]?.approval_mode;
      if (mode != null && mode !== 'allow' && !isToolDeniedByApprovalPolicy(policy, candidate))
        return true;
    }
    delimiter = name.indexOf(Constants.mcp_delimiter, delimiter + Constants.mcp_delimiter.length);
  }
  return false;
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
  lazyAgents: Set<ToolApprovalAdmissionAgent>;
} {
  const agents: ToolApprovalAdmissionAgent[] = [];
  const visited = new Set<ToolApprovalAdmissionAgent>();
  const pending = [...roots];
  const lazyAgentIds = new Set<string | undefined>();
  const lazyAgents = new Set<ToolApprovalAdmissionAgent>();

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
        if (lazyAgent) lazyAgents.add(lazyAgent);
      }
      pending.push(...(agent.lazySubagentConfigs ?? []));
    }
    for (const member of agent.subagentGraphMemberMetadata ?? []) {
      lazyAgentIds.add(member?.id);
      if (member) lazyAgents.add(member);
      pending.push(member);
    }
    for (const graph of agent.subagentGraphConfigs ?? []) {
      pending.push(...(graph.memberConfigs ?? []));
    }
  }

  return { agents, lazyAgentIds, lazyAgents };
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
  toolApprovalAllows,
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
  const reviewGatedTools = new Set<string>();
  let unresolvedModeCanAsk = false;
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
    const surface = readAdmissionSurface(agent);
    const reachable = new Set<string>();
    for (const tool of surface.tools ?? []) {
      const name = typeof tool === 'string' ? tool : tool.name;
      if (name) reachable.add(name);
    }
    for (const name of surface.toolRegistry?.keys() ?? []) reachable.add(name);
    for (const definition of surface.toolDefinitions ?? []) {
      if (definition.name) reachable.add(definition.name);
    }
    const options = { ...surface.tool_options };
    aliasMCPToolOptions(surface.mcpToolAliases ?? [], options);
    for (const name of reachable) {
      addToolName(name, agent.id);
      const mode = options[name]?.approval_mode;
      if (mode != null && mode !== 'allow') reviewGatedTools.add(name);
    }
    if (
      approvalGraph.lazyAgents.has(agent) &&
      surface.toolRegistry == null &&
      surface.toolDefinitions == null
    ) {
      unresolvedModeCanAsk ||= [...reachable].some((name) =>
        unresolvedLegacySelectionCanAsk(name, options, policy),
      );
    }
    // A lazy descriptor without a concrete surface can still resolve review-gated tools.
    if (
      approvalGraph.lazyAgents.has(agent) &&
      surface.toolRegistry == null &&
      surface.toolDefinitions == null &&
      (surface.tools == null || [...reachable].some(isMCPAllPlaceholder))
    ) {
      unresolvedModeCanAsk ||= Object.entries(options).some(
        ([name, option]) =>
          option.approval_mode != null &&
          option.approval_mode !== 'allow' &&
          !isToolDeniedByApprovalPolicy(policy, name),
      );
    }
    for (const alias of surface.mcpToolAliases ?? []) {
      aliases.push(alias);
      const names = aliasesByToolName.get(alias.name) ?? [];
      names.push(alias.aliasName);
      aliasesByToolName.set(alias.name, names);
    }
  }

  const effectivePolicy = buildEffectiveToolApprovalPolicy(policy, aliases, toolApprovalAllows);
  const knownToolCanPause = Array.from(toolOwners).some(([toolName, agentIds]) => {
    if (reviewGatedTools.has(toolName) && !isToolDeniedByApprovalPolicy(effectivePolicy, toolName))
      return true;
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
    if (staticPolicyCanAsk || unresolvedHookCanAsk || unresolvedModeCanAsk) {
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
