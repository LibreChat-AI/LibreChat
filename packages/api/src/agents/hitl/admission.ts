import {
  Constants,
  isActionTool,
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
import {
  isHITLEnabled,
  isToolApprovalPauseCapable,
  isToolDeniedByApprovalPolicy,
  isToolBlockedByApprovalPolicy,
  healToolApprovalPolicy,
} from './policy';
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
  const effectiveTools =
    selectedTools == null && extraToolNames.length === 0
      ? undefined
      : [...(selectedTools ?? []), ...extraToolNames];
  const normalized = normalizeAgentToolKeys({
    tools:
      context.toolsAvailable === false
        ? effectiveTools?.filter(
            (name) => isActionTool(name) || !name.includes(Constants.mcp_delimiter),
          )
        : effectiveTools,
    toolOptions: surface.tool_options,
    rawServerNames: context.rawMcpServerNames ?? surface.rawMcpServerNames ?? [],
  });
  admissionSurfaces.set(target, {
    tool_options:
      normalized.toolOptions &&
      Object.fromEntries(
        Object.entries(normalized.toolOptions)
          .filter(
            ([name]) =>
              context.toolsAvailable !== false ||
              isActionTool(name) ||
              !name.includes(Constants.mcp_delimiter),
          )
          .map(([name, option]) => [name, { approval_mode: option.approval_mode }]),
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

/** Exact trusted matchers provide case-preserving candidates; other regexes remain unresolved. */
function literalHookNames(matcher?: string): string[] | undefined {
  if (!matcher?.startsWith('^') || !matcher.endsWith('$')) return undefined;
  let pattern = matcher.slice(1, -1);
  if (pattern.startsWith('(?:') && pattern.endsWith(')')) pattern = pattern.slice(3, -1);
  else if (pattern.includes('|')) return undefined;
  const names = pattern.split('|');
  if (names.some((name) => !/^[A-Za-z0-9 _-]+$/.test(name.replace(/\\[.-]/g, '_'))))
    return undefined;
  return names.map((name) => name.replace(/\\([.-])/g, '$1'));
}

/** Possible catalog spellings are admission hints, never authorization aliases. */
function unresolvedHookSpellings(name: string, rawServerNames: readonly string[]): string[] {
  if (isActionTool(name) || isMCPAllPlaceholder(name)) return [name];
  const aliases = buildServerNameAliases(rawServerNames);
  const known = [...rawServerNames, ...aliases.keys()];
  const spellings = new Set([name]);
  const add = (tool: string, server: string): void => {
    const raw = rawServerNames.includes(server) ? server : (aliases.get(server) ?? server);
    const normalized = normalizeServerName(raw);
    const suffixes =
      aliases.get(normalized) == null || aliases.get(normalized) === raw
        ? new Set([server, raw, normalized])
        : new Set([server]);
    const stripped = stripServerNamePrefix(tool, normalized);
    const tools = new Set([tool, stripped]);
    for (const prefix of new Set([normalized, normalized.toLowerCase()])) {
      const legacy = `${prefix}_${stripped}`;
      if (stripServerNamePrefix(legacy, normalized) === stripped) tools.add(legacy);
    }
    for (const suffix of suffixes)
      for (const candidate of tools)
        spellings.add(`${candidate}${Constants.mcp_delimiter}${suffix}`);
  };
  const [tool, server] = splitMCPToolKey(name, known);
  if (server != null && known.includes(server)) add(tool, server);
  else {
    let delimiter = name.indexOf(Constants.mcp_delimiter);
    while (delimiter >= 0) {
      const suffix = name.slice(delimiter + Constants.mcp_delimiter.length);
      if (suffix) add(name.slice(0, delimiter), suffix);
      delimiter = name.indexOf(Constants.mcp_delimiter, delimiter + Constants.mcp_delimiter.length);
    }
  }
  return [...spellings];
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
  const originalNames = new Map<string, string[]>();
  const strippedNames = new Map<string, string[]>();
  const index = (names: Map<string, string[]>, key: string, name: string) => {
    const entries = names.get(key) ?? [];
    entries.push(name);
    names.set(key, entries);
  };
  const canReview = (name: string, aliasName = name) =>
    !isToolBlockedByApprovalPolicy(healToolApprovalPolicy(policy, [{ name, aliasName }]), name);
  const reviewServers = new Set<string>();
  let unknownCanAsk = false;
  for (const [name, option] of Object.entries(options)) {
    if (
      option.approval_mode == null ||
      option.approval_mode === 'allow' ||
      isToolDeniedByApprovalPolicy(policy, name)
    )
      continue;
    unknownCanAsk ||= canReview(name);
    visitParts(name, (tool, server) => {
      index(originalNames, key(server, tool), name);
      const stripped = stripServerNamePrefix(tool, normalizeServerName(server));
      const canonical = `${stripped}${Constants.mcp_delimiter}${server}`;
      if (canReview(name, canonical) || canReview(canonical, name)) {
        reviewServers.add(resolveServer(server));
        unknownCanAsk = true;
      }
      if (stripped !== tool) index(strippedNames, key(server, stripped), name);
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
      if (strippedNames.get(key(server, tool))?.some((alias) => canReview(name, alias)))
        return true;
      const stripped = stripServerNamePrefix(tool, normalizeServerName(server));
      return (
        stripped !== tool &&
        originalNames.get(key(server, stripped))?.some((alias) => canReview(name, alias)) === true
      );
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
        buildEffectiveToolApprovalPolicy(policy, surface.mcpToolAliases ?? [], toolApprovalAllows),
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
    if (isToolBlockedByApprovalPolicy(effectivePolicy, toolName)) return false;
    if (reviewGatedTools.has(toolName)) return true;
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
    const exceptions = [...(effectivePolicy?.ask ?? []), ...(effectivePolicy?.allow ?? [])];
    const unboundedHookCanAsk =
      isToolApprovalPauseCapable(effectivePolicy, true) &&
      (effectivePolicy?.mode !== 'dontAsk' || exceptions.length > 0);
    const finitePolicyNames =
      effectivePolicy?.mode === 'dontAsk' && exceptions.every((name) => !name.includes('*'))
        ? exceptions
        : undefined;
    const unresolvedHookCanAsk = Array.from(approvalGraph.lazyAgents).some((agent) => {
      const surface = readAdmissionSurface(agent);
      const knownCatalog = surface.toolRegistry != null || surface.toolDefinitions != null;
      const rawNames = surface.rawMcpServerNames ?? [];
      const cache = new Map<string, string[]>();
      const spellings = (name: string): string[] => {
        let names = cache.get(name);
        if (!names) {
          names = knownCatalog ? [name] : unresolvedHookSpellings(name, rawNames);
          cache.set(name, names);
        }
        return names;
      };
      const canAskAs = (name: string, matches: (names: readonly string[]) => boolean): boolean =>
        spellings(name).some((aliasName) => {
          const possible = name === aliasName ? [name] : [name, aliasName];
          const predictedPolicy = healToolApprovalPolicy(effectivePolicy, [{ name, aliasName }]);
          return !isToolBlockedByApprovalPolicy(predictedPolicy, name) && matches(possible);
        });
      const selected: string[] | undefined = surface.tools
        ?.map((tool) => (typeof tool === 'string' ? tool : (tool.name ?? '')))
        .filter(Boolean);
      const rawAliases = buildServerNameAliases(rawNames);
      const resolveServer = (server: string) =>
        rawNames.includes(server) ? server : (rawAliases.get(server) ?? server);
      const wildcardServers = new Set(
        (selected ?? [])
          .filter(isMCPAllPlaceholder)
          .map((name) =>
            resolveServer(name.slice(`${Constants.mcp_all}${Constants.mcp_delimiter}`.length)),
          ),
      );
      const candidates = (names: readonly string[]): readonly string[] => {
        if (knownCatalog) return [];
        if (selected == null) return names;
        const concrete = selected.filter((name) => !isMCPAllPlaceholder(name));
        return [
          ...new Set([
            ...concrete,
            ...names.filter((name) => {
              // Strip the actual matcher spelling, not a guessed casing of the upstream prefix.
              if (spellings(name).some((candidate) => concrete.includes(candidate))) return true;
              const [, server] = splitMCPToolKey(name, [
                ...rawNames,
                ...rawAliases.keys(),
                ...wildcardServers,
              ]);
              return server != null && wildcardServers.has(resolveServer(server));
            }),
          ]),
        ];
      };
      return (
        resolvedProgrammaticHooks.some((hook) => {
          if (hook.agentIds != null && (agent.id == null || !hook.agentIds.has(agent.id)))
            return false;
          if (knownCatalog) return false;
          const literalNames = literalHookNames(hook.matcher);
          const names = hook.toolNames ?? literalNames ?? finitePolicyNames;
          if (names == null) return unboundedHookCanAsk;
          if (
            (hook.toolNames ?? candidates(names)).some((name) =>
              canAskAs(name, (possible) =>
                resolvedToolApprovalHooksCanMatch([hook], possible, agent.id),
              ),
            )
          )
            return true;
          if (hook.toolNames != null || literalNames != null || hook.matcher == null) return false;
          try {
            new RegExp(hook.matcher);
          } catch {
            return false;
          }
          // A catalog-free case-insensitive prefix can match a nonliteral regex in unknown casing.
          return candidates(finitePolicyNames ?? []).some(
            (name) => spellings(name).length > 1 && canAskAs(name, () => true),
          );
        }) ||
        (pluginHookCanAsk &&
          !knownCatalog &&
          (finitePolicyNames == null
            ? unboundedHookCanAsk
            : candidates(finitePolicyNames).some((name) =>
                canAskAs(
                  name,
                  (possible) =>
                    pluginHookSource?.hasToolApprovalHooks?.(possible) === true ||
                    spellings(name).length > 1,
                ),
              )))
      );
    });
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
