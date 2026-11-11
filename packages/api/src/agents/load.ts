import { logger } from '@librechat/data-schemas';
import {
  Constants,
  isAgentsEndpoint,
  isEphemeralAgentId,
  getEphemeralSender,
  resolveSpecArtifacts,
  encodeEphemeralAgentId,
  resolveMCPAppsPolicy,
  resolveSpecUserToggles,
  resolveSpecSkillsEnabled,
} from 'librechat-data-provider';
import type {
  AgentModelParameters,
  TEphemeralAgent,
  TModelSpec,
  Agent,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { MCPClientCapabilityProfile } from '~/mcp/capabilities';
import type { ParsedServerConfig } from '~/mcp/types';
import {
  resolveEphemeralTools,
  resolveEphemeralMCPServers,
  synthesizeToggleToolOptions,
} from '~/agents/toggles';
import { requiresEphemeralUserConnection, validateMCPServerConfig } from '~/mcp/utils';
import { resolveMCPClientCapabilityProfile } from '~/mcp/capabilities';
import { getLookupConcurrency } from '~/utils/concurrency';
import { getCustomEndpointConfig } from '~/app/config';
import { mapWithConcurrency } from '~/utils/promise';

const { mcp_all, mcp_delimiter } = Constants;
type ModelParametersWithPromptPrefix = AgentModelParameters & { promptPrefix?: string | null };

export interface LoadAgentDeps {
  /** Resolves the agent without its `versions` history; `version` carries the count. */
  getAgent: (searchParameter: {
    id: string;
  }) => Promise<(Agent & { version?: number; versions?: { length: number } }) | null>;
  getMCPServerTools: (
    userId: string,
    serverName: string,
    serverConfig?: ParsedServerConfig,
    capabilityProfile?: MCPClientCapabilityProfile,
  ) => Promise<Record<string, unknown> | null>;
  /** The MCP servers this user can reach, with the registry's tier precedence
   *  already applied — the resolution behind the client's catalog. Omitted, the
   *  chat selection is used as sent. */
  getAccessibleMCPServers?: (
    userId: string,
    role?: string,
  ) => Promise<Record<string, ParsedServerConfig>>;
}

export interface LoadAgentParams {
  req: {
    user?: { id?: string; role?: string };
    config?: AppConfig;
    body?: {
      promptPrefix?: string;
      ephemeralAgent?: TEphemeralAgent;
    };
  };
  spec?: string;
  agent_id: string;
  endpoint: string;
  model_parameters?: AgentModelParameters & { model?: string };
}

/**
 * Load an ephemeral agent based on the request parameters.
 */
export async function loadEphemeralAgent(
  { req, spec, endpoint, model_parameters: _m }: Omit<LoadAgentParams, 'agent_id'>,
  deps: LoadAgentDeps,
): Promise<Agent | null> {
  const { model, ...model_parameters } = _m ?? ({} as unknown as AgentModelParameters);
  const modelSpecs = req.config?.modelSpecs as { list?: TModelSpec[] } | undefined;
  let modelSpec: TModelSpec | null = null;
  if (spec != null && spec !== '') {
    modelSpec = modelSpecs?.list?.find((s) => s.name === spec) ?? null;
  }
  const requestAgent: TEphemeralAgent | undefined = req.body?.ephemeralAgent;
  /** A spec that gives the user no control over its tools makes what it
   *  configures unconditional, so a request toggle against one is dropped. */
  const ephemeralAgent: TEphemeralAgent | undefined = resolveSpecUserToggles(
    requestAgent,
    modelSpec,
  );
  const userId = req.user?.id ?? '';
  const capabilityProfile = resolveMCPClientCapabilityProfile(
    resolveMCPAppsPolicy(req.config?.mcpSettings?.apps),
  );
  const mcpServers = new Set<string>(
    await resolveEphemeralMCPServers({
      selected: ephemeralAgent?.mcp,
      specServers: modelSpec?.mcpServers,
      userId,
      role: req.user?.role,
      getAccessibleMCPServers: deps.getAccessibleMCPServers,
    }),
  );
  /** Publish the servers this request will actually use back onto the body. The
   *  instruction path reads `req.body.ephemeralAgent.mcp` directly and prefers
   *  it over the agent's tools, so it would otherwise both inject a deselected
   *  or hidden server's `serverInstructions` and omit a spec-pinned server's. */
  if (requestAgent != null && Array.isArray(requestAgent.mcp)) {
    requestAgent.mcp = [...mcpServers];
  }
  /** Spec flags are defaults an explicit request toggle overrides. Same
   *  downstream gating as persisted agents still applies: `createRun` only
   *  equips `ask_user_question` when the request is HITL-capable, the agent is
   *  not a subagent, and the admin hasn't excluded it. */
  const tools: string[] = resolveEphemeralTools(ephemeralAgent, modelSpec);

  if (mcpServers.size > 0) {
    const serverToolKeys = await mapWithConcurrency(
      [...mcpServers],
      getLookupConcurrency(req.config, 'mcpCatalogLookups'),
      async (mcpServer): Promise<string[]> => {
        /** Address durable catalogs by the effective request overlay; request-scoped
         *  overlays still expand fresh through `mcp_all`. */
        const rawOverlayConfig = req.config?.mcpConfig?.[mcpServer];
        const overlayConfig = rawOverlayConfig
          ? validateMCPServerConfig(rawOverlayConfig)
          : undefined;
        const serverTools =
          overlayConfig && requiresEphemeralUserConnection(overlayConfig)
            ? null
            : await deps.getMCPServerTools(userId, mcpServer, overlayConfig, capabilityProfile);
        return serverTools ? Object.keys(serverTools) : [`${mcp_all}${mcp_delimiter}${mcpServer}`];
      },
    );
    for (const keys of serverToolKeys) {
      tools.push(...keys);
    }
  }

  const requestPromptPrefix = req.body?.promptPrefix;
  const { promptPrefix: modelPromptPrefix, ...safeModelParameters } =
    model_parameters as ModelParametersWithPromptPrefix;
  const instructions =
    typeof modelPromptPrefix === 'string' ? modelPromptPrefix : requestPromptPrefix;

  // Get endpoint config for modelDisplayLabel fallback
  const appConfig = req.config;
  const endpoints = appConfig?.endpoints;
  let endpointConfig = endpoints?.[endpoint as keyof typeof endpoints];
  if (!isAgentsEndpoint(endpoint) && !endpointConfig) {
    try {
      endpointConfig = getCustomEndpointConfig({ endpoint, appConfig });
    } catch (err) {
      logger.error('[loadEphemeralAgent] Error getting custom endpoint config', err);
    }
  }

  const sender = getEphemeralSender({
    modelLabel: (model_parameters as AgentModelParameters & { modelLabel?: string })?.modelLabel,
    specLabel: modelSpec?.label,
    modelDisplayLabel: (endpointConfig as { modelDisplayLabel?: string } | undefined)
      ?.modelDisplayLabel,
  });

  // Encode ephemeral agent ID with endpoint, model, and computed sender for display
  const ephemeralId = encodeEphemeralAgentId({
    endpoint,
    model: model as string,
    sender,
  });

  const result: Partial<Agent> = {
    id: ephemeralId,
    instructions,
    provider: endpoint,
    model_parameters: safeModelParameters as AgentModelParameters,
    model,
    tools,
  };

  const toggleToolOptions = synthesizeToggleToolOptions({ ephemeralAgent, modelSpec });
  if (toggleToolOptions) {
    result.tool_options = toggleToolOptions;
  }

  const artifacts = resolveSpecArtifacts(ephemeralAgent?.artifacts, modelSpec?.artifacts);
  if (artifacts != null) {
    result.artifacts = artifacts;
  }
  if (modelSpec?.subagents) {
    result.subagents = modelSpec.subagents;
  }
  if (modelSpec && Object.prototype.hasOwnProperty.call(modelSpec, 'skills')) {
    const skillsEnabled = resolveSpecSkillsEnabled(ephemeralAgent?.skills, modelSpec.skills);
    result.skills_enabled = skillsEnabled;
    if (!skillsEnabled || Array.isArray(modelSpec.skills)) {
      result.skills = [];
    }
  }
  return result as Agent;
}

/**
 * Load an agent based on the provided ID.
 * For ephemeral agents, builds a synthetic agent from request parameters.
 * For persistent agents, fetches from the database.
 */
export async function loadAgent(
  params: LoadAgentParams,
  deps: LoadAgentDeps,
): Promise<Agent | null> {
  const { req, spec, agent_id, endpoint, model_parameters } = params;
  if (!agent_id) {
    return null;
  }
  if (isEphemeralAgentId(agent_id)) {
    return loadEphemeralAgent({ req, spec, endpoint, model_parameters }, deps);
  }
  const agent = await deps.getAgent({ id: agent_id });

  if (!agent) {
    return null;
  }

  agent.version ??= agent.versions?.length ?? 0;
  return agent;
}
