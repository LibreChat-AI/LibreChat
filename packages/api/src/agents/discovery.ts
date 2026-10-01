import { logger } from '@librechat/data-schemas';
import {
  ResourceType,
  PermissionBits,
  EModelEndpoint,
  MAX_SUBAGENT_GRAPH_NODES,
} from 'librechat-data-provider';
import type {
  Agent,
  GraphEdge,
  TModelsConfig,
  TEndpointOption,
  AgentSubagentGraph,
} from 'librechat-data-provider';
import type { Response as ServerResponse } from 'express';
import type {
  InitializedAgent,
  InitializeAgentParams,
  InitializeAgentDbMethods,
} from './initialize';
import type { ValidateAgentModelParams } from './validation';
import type { ServerRequest } from '~/types';
import { validateAgentModel as defaultValidateAgentModel } from './validation';
import { initializeAgent as defaultInitializeAgent } from './initialize';
import { createEdgeCollector, resolveReachableGraph } from './edges';
import { isFatalAgentInitializationError } from './errors';
import { createConcurrencyLimiter } from '~/utils/promise';
import { createSequentialChainEdges } from './chain';
import { detachOnAbort } from '~/utils/promises';

const SUBAGENT_GRAPH_LOAD_CONCURRENCY = 4;

/**
 * Callback invoked after a sub-agent is successfully initialized.
 * Used by callers that need to track per-agent tool context (e.g., for
 * the ON_TOOL_EXECUTE event handler closure).
 */
export type OnAgentInitializedCallback = (
  agentId: string,
  agent: Agent,
  config: InitializedAgent,
) => void;

/**
 * Minimal permission check signature used to verify VIEW access on a
 * candidate sub-agent before it is loaded into the run.
 */
export type CheckAgentPermission = (params: {
  userId: string;
  role?: string;
  resourceType: string;
  resourceId: unknown;
  requiredPermission: number;
}) => Promise<boolean>;

export interface DiscoverConnectedAgentsParams {
  req: ServerRequest;
  res: ServerResponse;
  /** Owning run signal used to distinguish cancellation from dependency aborts. */
  signal?: AbortSignal;
  /** The already-initialized primary agent config (starting point for BFS). */
  primaryConfig: InitializedAgent;
  /**
   * Optional legacy chain: agent IDs to append as sequential direct edges.
   * Used by the deprecated Agent Chain feature.
   */
  agent_ids?: string[];
  endpointOption?: Partial<TEndpointOption>;
  allowedProviders: Set<string>;
  modelsConfig: TModelsConfig;
  loadTools: InitializeAgentParams['loadTools'];
  requestFiles?: InitializeAgentParams['requestFiles'];
  conversationId?: string | null;
  parentMessageId?: string | null;
  /** Normalized runtime request metadata forwarded to MCP tool loading. */
  requestBody?: InitializeAgentParams['requestBody'];
  /**
   * ResourceType to check each sub-agent's access against. Defaults to
   * `AGENT` for the in-app chat flow. Callers whose entry-point gates on
   * a different resource type (e.g. the OpenAI-compat controllers gate on
   * `REMOTE_AGENT`) must pass the matching resource type so sub-agents
   * don't bypass the same sharing boundary enforced at the route.
   */
  resourceType?: string;
  /**
   * Optional per-sub-agent skill scoper. When provided, its return value
   * is forwarded to `initializeAgent` as `accessibleSkillIds` so each
   * handoff agent sees only the skills that match its own `skills`
   * allowlist (or the full accessible set when scoping is disabled).
   */
  computeAccessibleSkillIds?: (agent: Agent) => InitializeAgentParams['accessibleSkillIds'];
  /** Optional per-sub-agent skill authoring gate, paired with the scoped skill IDs. */
  computeSkillAuthoringAvailable?: (
    agent: Agent,
    accessibleSkillIds: InitializeAgentParams['accessibleSkillIds'],
  ) => InitializeAgentParams['skillAuthoringAvailable'];
  /** Per-user skill active/inactive state, forwarded to each sub-agent. */
  skillStates?: InitializeAgentParams['skillStates'];
  /** Default active-on-share flag, forwarded to each sub-agent. */
  defaultActiveOnShare?: InitializeAgentParams['defaultActiveOnShare'];
  /**
   * Whether the `execute_code` capability is enabled for the run. Forwarded
   * verbatim to each handoff sub-agent so `registerCodeExecutionTools` can
   * expand `agent.tools: ['execute_code']` into the `bash_tool` + `read_file`
   * pair. Omitted (or `undefined`) → the expansion is skipped, matching the
   * primary-agent gate; callers that already resolved the capability set
   * for the primary SHOULD forward the same value here or sub-agents lose
   * code-execution tooling even though their parent had it.
   */
  codeEnvAvailable?: InitializeAgentParams['codeEnvAvailable'];
  /**
   * Sibling of `codeEnvAvailable` for the other role-gated tool — the
   * `file_search` capability AND the caller's `FILE_SEARCH` grant. Forwarded
   * verbatim so a handoff agent re-hydrates prior-turn search files on exactly
   * the terms its parent did.
   */
  fileSearchAvailable?: InitializeAgentParams['fileSearchAvailable'];
  /**
   * The caller's `WEB_SEARCH` grant resolver, forwarded so a handoff or subagent
   * whose provider config turns native web search on is authorized by the same
   * request-memoized read as its parent.
   */
  resolveWebSearchGrant?: InitializeAgentParams['resolveWebSearchGrant'];
  /** Sibling of `codeEnvAvailable` — the `stateful_code_sessions` capability flag, forwarded to every handoff `initializeAgent`. */
  statefulSessionsAvailable?: InitializeAgentParams['statefulSessionsAvailable'];
  /** Deployment policy for stateful workspace scopes, forwarded unchanged to every referenced agent. */
  allowedStatefulCodeEnvironments?: InitializeAgentParams['allowedStatefulCodeEnvironments'];
  memoryAvailable?: InitializeAgentParams['memoryAvailable'];
  /**
   * Explicitly enables the authoritative ChatProject guidance/resources for
   * every discovered handoff and saved graph member. This is intentionally
   * independent of the request marker so remote callers can opt in without
   * broadening unrelated agent initialization.
   */
  useChatProjectContext?: InitializeAgentParams['useChatProjectContext'];
  /**
   * Run-level `run_in_background` capability gate. Forwarded verbatim so a
   * handoff/connected agent's own event-driven tools with
   * `tool_options[tool].run_in_background` (and its background-native code
   * pair) get the injected param + poll tool, matching how the same agent
   * behaves when run as the primary.
   */
  backgroundToolsAvailable?: InitializeAgentParams['backgroundToolsAvailable'];
  /**
   * Run-level `tool_intents` capability gate. Forwarded verbatim so a
   * handoff/connected agent's opted-in tools get the injected `intent` param,
   * matching how the same agent behaves when run as the primary.
   */
  toolIntentsAvailable?: InitializeAgentParams['toolIntentsAvailable'];
}

export interface DiscoverConnectedAgentsDeps {
  /** Fetch an agent by string id from the database. */
  getAgent: (filter: { id: string }) => Promise<Agent | null>;
  /** Permission check (typically a wrapper around PermissionService.checkPermission). */
  checkPermission: CheckAgentPermission;
  /** Violation logger passed through to validateAgentModel. */
  logViolation: ValidateAgentModelParams['logViolation'];
  /** DB methods consumed by initializeAgent for each sub-agent. */
  db: InitializeAgentDbMethods;
  /** Optional callback invoked after each sub-agent is initialized. */
  onAgentInitialized?: OnAgentInitializedCallback;
  /** Optional callback invoked when an agent id is skipped (missing or no access). */
  onAgentSkipped?: (agentId: string) => void;
  /**
   * Optional override for `initializeAgent`. Exists primarily so JS callers
   * can inject their test doubles via `jest.mock('@librechat/api')` — since
   * this module's own direct import would otherwise bypass that mock.
   */
  initializeAgent?: typeof defaultInitializeAgent;
  /** Optional override for `validateAgentModel` (same DI rationale). */
  validateAgentModel?: typeof defaultValidateAgentModel;
}

export interface DiscoverConnectedAgentsResult {
  /** Map of agentId -> initialized config for every discovered sub-agent. */
  agentConfigs: Map<string, InitializedAgent>;
  /** Deduplicated, orphan-filtered edges across the primary and sub-agents. */
  edges: GraphEdge[];
  /** Agent ids that were requested but could not be loaded (missing or no access). */
  skippedAgentIds: Set<string>;
  /** Merged MCP auth map from the primary and all sub-agents. */
  userMCPAuthMap?: Record<string, Record<string, string>>;
}

export type GraphSubagentHostConfig = InitializedAgent & {
  subagentGraphConfigs?: Array<{
    definition: AgentSubagentGraph;
    memberConfigs: InitializedAgent[];
  }>;
};

export interface ResolveSubagentGraphsParams extends DiscoverConnectedAgentsParams {
  /** Top-level primary/handoff configs whose saved graph spawn targets should be resolved. */
  rootConfigs: GraphSubagentHostConfig[];
}

async function initializeReferencedAgent(
  agentId: string,
  params: DiscoverConnectedAgentsParams,
  deps: DiscoverConnectedAgentsDeps,
): Promise<{ agent: Agent; config: InitializedAgent } | null> {
  const agent = await detachOnAbort(deps.getAgent({ id: agentId }), params.signal);
  if (!agent) {
    logger.warn(`[initializeReferencedAgent] Agent ${agentId} not found, skipping`);
    deps.onAgentSkipped?.(agentId);
    return null;
  }

  const userId = params.req.user?.id;
  if (!userId) {
    logger.warn(`[initializeReferencedAgent] No authenticated user, skipping agent ${agentId}`);
    deps.onAgentSkipped?.(agentId);
    return null;
  }

  const hasAccess = await detachOnAbort(
    deps.checkPermission({
      userId,
      role: params.req.user?.role,
      resourceType: params.resourceType ?? ResourceType.AGENT,
      resourceId: agent._id,
      requiredPermission: PermissionBits.VIEW,
    }),
    params.signal,
  );
  if (!hasAccess) {
    logger.warn(`[initializeReferencedAgent] User ${userId} lacks VIEW access to agent ${agentId}`);
    deps.onAgentSkipped?.(agentId);
    return null;
  }

  const validateAgentModel = deps.validateAgentModel ?? defaultValidateAgentModel;
  const validation = await detachOnAbort(
    validateAgentModel({
      req: params.req,
      res: params.res,
      agent,
      modelsConfig: params.modelsConfig,
      logViolation: deps.logViolation,
    }),
    params.signal,
  );
  if (!validation.isValid) {
    throw new Error(validation.error?.message);
  }

  const scopedSkillIds = params.computeAccessibleSkillIds?.(agent);
  const initializeAgent = deps.initializeAgent ?? defaultInitializeAgent;
  const config = await detachOnAbort(
    initializeAgent(
      {
        req: params.req,
        res: params.res,
        agent,
        loadTools: params.loadTools,
        requestFiles: params.requestFiles,
        conversationId: params.conversationId,
        parentMessageId: params.parentMessageId,
        requestBody: params.requestBody,
        endpointOption: {
          ...(params.endpointOption ?? {}),
          endpoint: EModelEndpoint.agents,
        },
        allowedProviders: params.allowedProviders,
        useChatProjectContext: params.useChatProjectContext,
        accessibleSkillIds: scopedSkillIds,
        skillAuthoringAvailable: params.computeSkillAuthoringAvailable?.(agent, scopedSkillIds),
        skillStates: params.skillStates,
        defaultActiveOnShare: params.defaultActiveOnShare,
        codeEnvAvailable: params.codeEnvAvailable,
        fileSearchAvailable: params.fileSearchAvailable,
        resolveWebSearchGrant: params.resolveWebSearchGrant,
        backgroundToolsAvailable: params.backgroundToolsAvailable,
        toolIntentsAvailable: params.toolIntentsAvailable,
        statefulSessionsAvailable: params.statefulSessionsAvailable,
        allowedStatefulCodeEnvironments: params.allowedStatefulCodeEnvironments,
        memoryAvailable: params.memoryAvailable,
        signal: params.signal,
      },
      deps.db,
    ),
    params.signal,
  );
  deps.onAgentInitialized?.(agentId, agent, config);
  return { agent, config };
}

/** Resolves saved graph spawn targets without promoting graph-only members to top-level nodes. */
export async function resolveSubagentGraphs(
  params: ResolveSubagentGraphsParams,
  deps: DiscoverConnectedAgentsDeps,
): Promise<Record<string, Record<string, string>> | undefined> {
  const configById = new Map(params.rootConfigs.map((config) => [config.id, config]));
  const attemptedGraphMemberIds = new Set<string>();
  const failedMemberIds = new Set<string>();
  const loadGraphMember = createConcurrencyLimiter(SUBAGENT_GRAPH_LOAD_CONCURRENCY);
  let userMCPAuthMap: Record<string, Record<string, string>> | undefined;
  for (const config of params.rootConfigs) {
    if (config.userMCPAuthMap) {
      userMCPAuthMap = { ...userMCPAuthMap, ...config.userMCPAuthMap };
    }
  }

  for (const rootConfig of params.rootConfigs) {
    const resolvedGraphs: NonNullable<GraphSubagentHostConfig['subagentGraphConfigs']> = [];
    for (const definition of rootConfig.subagents?.enabled === true
      ? (rootConfig.subagents.graphs ?? [])
      : []) {
      const memberIds = [...new Set(definition.agent_ids)];
      const newMemberIds = memberIds.filter(
        (memberId) => !configById.has(memberId) && !attemptedGraphMemberIds.has(memberId),
      );
      if (attemptedGraphMemberIds.size + newMemberIds.length > MAX_SUBAGENT_GRAPH_NODES) {
        logger.warn('[resolveSubagentGraphs] Subagent graph node limit exceeded', {
          parentAgentId: rootConfig.id,
          graphType: definition.type,
          loadedSubagentCount: attemptedGraphMemberIds.size,
          stagedSubagentCount: newMemberIds.length,
          maxSubagentGraphNodes: MAX_SUBAGENT_GRAPH_NODES,
        });
        continue;
      }
      for (const memberId of newMemberIds) {
        attemptedGraphMemberIds.add(memberId);
      }

      const resolvedMembers = await Promise.all(
        memberIds.map((memberId) => {
          const existing = configById.get(memberId);
          if (existing) {
            return Promise.resolve({ config: existing });
          }
          if (failedMemberIds.has(memberId)) {
            return Promise.resolve(null);
          }
          return loadGraphMember(async () => {
            try {
              const resolved = await initializeReferencedAgent(memberId, params, {
                ...deps,
                onAgentInitialized: undefined,
              });
              if (!resolved) {
                failedMemberIds.add(memberId);
              }
              return resolved;
            } catch (error) {
              if (isFatalAgentInitializationError(error, { signal: params.signal })) {
                throw error;
              }
              failedMemberIds.add(memberId);
              logger.error(
                `[resolveSubagentGraphs] Error processing graph member ${memberId}:`,
                error,
              );
              deps.onAgentSkipped?.(memberId);
              return null;
            }
          });
        }),
      );
      for (let index = 0; index < memberIds.length; index++) {
        const resolvedMember = resolvedMembers[index];
        if (!resolvedMember) {
          continue;
        }
        const memberId = memberIds[index];
        configById.set(memberId, resolvedMember.config);
        if (resolvedMember.config.userMCPAuthMap) {
          userMCPAuthMap = {
            ...userMCPAuthMap,
            ...resolvedMember.config.userMCPAuthMap,
          };
        }
        if ('agent' in resolvedMember) {
          deps.onAgentInitialized?.(memberId, resolvedMember.agent, resolvedMember.config);
        }
      }
      if (resolvedMembers.some((member) => member == null)) {
        logger.warn('[resolveSubagentGraphs] Skipping incomplete graph subagent', {
          parentAgentId: rootConfig.id,
          graphType: definition.type,
          expectedMemberCount: memberIds.length,
          resolvedMemberCount: resolvedMembers.filter(Boolean).length,
        });
        continue;
      }
      const memberConfigs: InitializedAgent[] = [];
      for (let index = 0; index < memberIds.length; index++) {
        const resolvedMember = resolvedMembers[index] as {
          config: InitializedAgent;
        };
        memberConfigs.push(resolvedMember.config);
      }
      resolvedGraphs.push({
        definition,
        memberConfigs,
      });
    }
    rootConfig.subagentGraphConfigs = resolvedGraphs;
  }
  return userMCPAuthMap;
}

/**
 * Discovers and initializes all agents reachable from `primaryConfig.edges`
 * via BFS. This is the shared graph-topology discovery logic that enables
 * multi-agent handoffs (A -> B -> C) in both the primary chat flow and the
 * OpenAI-compatible / Responses API controllers.
 *
 * Skips agents the caller cannot load (missing from DB or lacking VIEW
 * permission) and filters out orphaned edges so `createRun` never sees an
 * edge pointing at a missing node — which would otherwise trigger a
 * `Found edge ending at unknown node` validation error from StateGraph.
 */
export async function discoverConnectedAgents(
  params: DiscoverConnectedAgentsParams,
  deps: DiscoverConnectedAgentsDeps,
): Promise<DiscoverConnectedAgentsResult> {
  const { primaryConfig, agent_ids } = params;
  const { onAgentSkipped } = deps;

  const agentConfigs = new Map<string, InitializedAgent>();
  const skippedAgentIds = new Set<string>();
  // Shallow-clone so the sub-agent merges below don't silently mutate
  // `primaryConfig.userMCPAuthMap` on the caller's object.
  let userMCPAuthMap: Record<string, Record<string, string>> | undefined =
    primaryConfig.userMCPAuthMap ? { ...primaryConfig.userMCPAuthMap } : undefined;

  const markSkipped = (agentId: string): void => {
    skippedAgentIds.add(agentId);
    onAgentSkipped?.(agentId);
  };

  const processAgent = async (agentId: string): Promise<Agent | null> => {
    const loaded = await initializeReferencedAgent(agentId, params, {
      ...deps,
      onAgentSkipped: markSkipped,
    });
    if (!loaded) {
      return null;
    }
    const { agent, config } = loaded;

    if (userMCPAuthMap != null) {
      Object.assign(userMCPAuthMap, config.userMCPAuthMap ?? {});
    } else if (config.userMCPAuthMap) {
      // Clone so subsequent sub-agent merges don't mutate the first
      // sub-agent's own `config.userMCPAuthMap` in place — symmetric with
      // the shallow clone applied to the primary's map above.
      userMCPAuthMap = { ...config.userMCPAuthMap };
    }

    agentConfigs.set(agentId, config);
    return agent;
  };

  const checkAgentInit = (agentId: string): boolean =>
    agentId === primaryConfig.id || agentConfigs.has(agentId);

  const { edgeMap, agentsToProcess, collectEdges } = createEdgeCollector(
    checkAgentInit,
    skippedAgentIds,
  );

  collectEdges(primaryConfig.edges);

  while (agentsToProcess.size > 0) {
    const agentId = agentsToProcess.values().next().value as string;
    agentsToProcess.delete(agentId);
    try {
      const agent = await processAgent(agentId);
      if (agent?.edges?.length) {
        collectEdges(agent.edges);
      }
    } catch (err) {
      if (isFatalAgentInitializationError(err, { signal: params.signal })) {
        throw err;
      }
      logger.error(`[discoverConnectedAgents] Error processing agent ${agentId}:`, err);
      markSkipped(agentId);
    }
  }

  /** @deprecated Agent Chain — sequential direct-edge fallback */
  if (agent_ids?.length) {
    for (const agentId of agent_ids) {
      if (checkAgentInit(agentId)) {
        continue;
      }
      try {
        await processAgent(agentId);
      } catch (err) {
        if (isFatalAgentInitializationError(err, { signal: params.signal })) {
          throw err;
        }
        logger.error(`[discoverConnectedAgents] Error processing chain agent ${agentId}:`, err);
        markSkipped(agentId);
      }
    }
    /**
     * `createSequentialChainEdges` is typed against `@librechat/agents`'s
     * `GraphEdge` (which uses `BaseMessage` from `@langchain/core`) whereas
     * `collectEdges` uses the `librechat-data-provider` variant (structural
     * `BaseMessage`). The produced chain edges are structurally identical and
     * only carry `edgeType`, `from`, `to`, `prompt`, `excludeResults` —
     * interchangeable for edge collection purposes.
     */
    const chain = await createSequentialChainEdges([primaryConfig.id].concat(agent_ids), '{convo}');
    collectEdges(chain as unknown as GraphEdge[]);
  }

  const preFilterEdges = Array.from(edgeMap.values());
  const { reachable, edges } = resolveReachableGraph(
    [primaryConfig.id],
    agentConfigs.keys(),
    preFilterEdges,
    skippedAgentIds,
  );

  for (const agentId of [...agentConfigs.keys()]) {
    if (!reachable.has(agentId)) {
      agentConfigs.delete(agentId);
    }
  }

  return {
    agentConfigs,
    edges,
    skippedAgentIds,
    userMCPAuthMap,
  };
}
