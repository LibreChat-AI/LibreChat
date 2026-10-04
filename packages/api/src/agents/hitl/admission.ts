import {
  Constants,
  normalizeServerName,
  stripServerNamePrefix,
  splitMCPToolKey,
  buildServerNameAliases,
} from 'librechat-data-provider';
import type { TToolApprovalPolicy } from 'librechat-data-provider';
import type { AgentToolOptions } from 'librechat-data-provider';
import type { PluginHookSource } from '~/agents/hooks/source';
import type { MCPToolAlias } from '~/tools/classification';
import type { SkillPrimeWithTools } from '~/agents/skills';
import type { ResolvedToolApprovalHook } from './hooks';
import { isHITLEnabled, isToolApprovalPauseCapable, isToolDeniedByApprovalPolicy } from './policy';
import { selectSkillPrimesForTurn, unionPrimeAllowedTools } from '~/agents/skills';
import { isMCPAllPlaceholder, normalizeAgentToolKeys } from '~/mcp/utils';
import { ASK_USER_QUESTION_TOOL_NAME } from './askUserQuestionTool';
import { aliasMCPToolOptions } from '~/tools/classification';
import { resolvedToolApprovalHooksCanMatch } from './hooks';
import { buildEffectiveToolApprovalPolicy } from './allow';

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
> & { readonly rawMcpServerNames?: readonly string[] };
const admissionSurfaces = new WeakMap<object, AdmissionSurface>();

function readAdmissionSurface(
  agent: ToolApprovalAdmissionAgent,
): ToolApprovalAdmissionAgent & AdmissionSurface {
  const captured = admissionSurfaces.get(agent);
  return captured ? { ...captured, ...agent } : agent;
}

interface AdmissionProjectionContext {
  readonly skillPrimes?: readonly SkillPrimeWithTools[];
  readonly rawMcpServerNames?: readonly string[];
  readonly toolsAvailable?: boolean;
}

/** Retain only admission data across server-only lazy projections. */
export function copyToolApprovalAdmissionMetadata<T extends object>(
  target: T,
  source: ToolApprovalAdmissionAgent,
  context: AdmissionProjectionContext = {},
): T {
  const surface = readAdmissionSurface(source);
  const selectedTools: string[] | undefined = surface.tools == null ? undefined : [];
  for (const tool of surface.tools ?? []) {
    const name = typeof tool === 'string' ? tool : tool.name;
    if (name) selectedTools!.push(name);
  }
  const { alwaysApplySkillPrimes } = selectSkillPrimesForTurn({
    manualSkillPrimes: [],
    alwaysApplySkillPrimes: context.skillPrimes ?? [],
  });
  const { extraToolNames } = unionPrimeAllowedTools({
    primes: alwaysApplySkillPrimes,
    agentToolNames: selectedTools ?? [],
  });
  const skillTools =
    context.toolsAvailable === false
      ? extraToolNames.filter((name) => !name.includes(Constants.mcp_delimiter))
      : extraToolNames;
  const normalized = normalizeAgentToolKeys({
    tools:
      selectedTools == null && skillTools.length === 0
        ? undefined
        : [...(selectedTools ?? []), ...skillTools],
    toolOptions: surface.tool_options,
    rawServerNames: context.rawMcpServerNames ?? surface.rawMcpServerNames ?? [],
  });
  admissionSurfaces.set(target, {
    tool_options:
      normalized.toolOptions &&
      Object.fromEntries(
        Object.entries(normalized.toolOptions).map(([name, option]) => [
          name,
          { approval_mode: option.approval_mode },
        ]),
      ),
    tools: normalized.tools,
    rawMcpServerNames: context.rawMcpServerNames?.slice() ?? surface.rawMcpServerNames,
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

/** Unresolved spellings predict review only; they never establish tool identity. */
function createUnresolvedReviewMatcher(
  options: AgentToolOptions,
  policy: TToolApprovalPolicy | undefined,
  toolNames: ReadonlySet<string>,
  rawServerNames: readonly string[] = [],
): (name?: string) => boolean {
  const wildcardServers: string[] = [];
  for (const name of toolNames) {
    if (isMCPAllPlaceholder(name)) {
      wildcardServers.push(name.slice(`${Constants.mcp_all}${Constants.mcp_delimiter}`.length));
    }
  }
  const declaredAliases = buildServerNameAliases(rawServerNames);
  const declaredNames = new Set(rawServerNames);
  // Do not let a normalized wildcard spelling invent a direct server over its raw owner.
  const serverNames = [
    ...rawServerNames,
    ...wildcardServers.filter(
      (server) => !declaredNames.has(server) && !declaredAliases.has(server),
    ),
  ];
  const directNames = new Set(serverNames);
  const serverAliases = buildServerNameAliases(serverNames);
  const knownNames = [...new Set([...serverNames, ...serverNames.map(normalizeServerName)])];
  const knownNameSet = new Set(knownNames);
  const resolveServer = (server: string) =>
    directNames.has(server) ? server : (serverAliases.get(server) ?? server);
  const key = (server: string, tool: string) => JSON.stringify([resolveServer(server), tool]);
  const visitParts = (name: string, visit: (tool: string, server: string) => boolean): boolean => {
    const [tool, server] = splitMCPToolKey(name, knownNames);
    if (server && knownNameSet.has(server)) return visit(tool, server);
    // Without catalog knowledge either half may contain the delimiter. Keep possible boundaries.
    let delimiter = name.indexOf(Constants.mcp_delimiter);
    while (delimiter >= 0) {
      const suffix = name.slice(delimiter + Constants.mcp_delimiter.length);
      if (suffix && visit(name.slice(0, delimiter), suffix)) return true;
      delimiter = name.indexOf(Constants.mcp_delimiter, delimiter + Constants.mcp_delimiter.length);
    }
    return false;
  };
  const originalNames = new Set<string>();
  const strippedNames = new Set<string>();
  const reviewServers = new Set<string>();
  let unknownCanAsk = false;
  for (const [name, option] of Object.entries(options)) {
    if (
      option.approval_mode == null ||
      option.approval_mode === 'allow' ||
      isToolDeniedByApprovalPolicy(policy, name)
    )
      continue;
    unknownCanAsk = true;
    visitParts(name, (tool, server) => {
      reviewServers.add(resolveServer(server));
      originalNames.add(key(server, tool));
      const stripped = stripServerNamePrefix(tool, normalizeServerName(server));
      if (stripped !== tool) strippedNames.add(key(server, stripped));
      return false;
    });
  }
  return (name) => {
    if (name == null) return unknownCanAsk;
    if (isMCPAllPlaceholder(name)) {
      const server = name.slice(`${Constants.mcp_all}${Constants.mcp_delimiter}`.length);
      return reviewServers.has(resolveServer(server));
    }
    if (options[name] != null || isToolDeniedByApprovalPolicy(policy, name)) return false;
    return visitParts(name, (tool, server) => {
      if (strippedNames.has(key(server, tool))) return true;
      const stripped = stripServerNamePrefix(tool, normalizeServerName(server));
      return stripped !== tool && originalNames.has(key(server, stripped));
    });
  };
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
      !unresolvedModeCanAsk &&
      approvalGraph.lazyAgents.has(agent) &&
      surface.toolRegistry == null &&
      surface.toolDefinitions == null
    ) {
      const canAsk = createUnresolvedReviewMatcher(
        options,
        policy,
        reachable,
        surface.rawMcpServerNames,
      );
      unresolvedModeCanAsk = surface.tools == null ? canAsk() : [...reachable].some(canAsk);
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
