import { logger } from '@librechat/data-schemas';
import {
  Constants,
  EModelEndpoint,
  isAgentsEndpoint,
  parseCompactConvo,
  isEphemeralAgentId,
  getEphemeralSender,
  appendAgentIdSuffix,
  resolveSpecArtifacts,
  encodeEphemeralAgentId,
  resolveMCPAppsPolicy,
  resolveSpecUserToggles,
  resolveSpecSkillsEnabled,
  getWithheldToggles,
} from 'librechat-data-provider';
import type { Agent, TModelSpec, TConversation, TEphemeralAgent } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { MCPClientCapabilityProfile } from '~/mcp/capabilities';
import type { ModelSpecParsedBody } from '~/modelSpecs';
import type { ParsedServerConfig } from '~/mcp/types';
import {
  resolveEphemeralTools,
  withRequestedMCPSelection,
  resolveEphemeralMCPServers,
  synthesizeToggleToolOptions,
} from '~/agents/toggles';
import { requiresEphemeralUserConnection, validateMCPServerConfig } from '~/mcp/utils';
import { applyModelSpecPreset, resolveModelSpecForEndpoint } from '~/modelSpecs';
import { resolveMCPClientCapabilityProfile } from '~/mcp/capabilities';
import { getLookupConcurrency } from '~/utils/concurrency';
import { getAgentInferencePolicy } from '~/agents/input';
import { getCustomEndpointConfig } from '~/app/config';
import { getSafeErrorMetadata } from '~/utils/errors';
import { mapWithConcurrency } from '~/utils/promise';

const { mcp_all, mcp_delimiter } = Constants;

export const ADDED_AGENT_ID = 'added_agent';

function applyModelSpecSkills(
  result: Record<string, unknown>,
  modelSpec: Pick<TModelSpec, 'skills'> | null | undefined,
  ephemeralSkills: boolean | undefined,
): void {
  if (!modelSpec || !Object.prototype.hasOwnProperty.call(modelSpec, 'skills')) {
    /** With no spec default to resolve against there is still a decision to
     *  record: the run-level `ephemeralSkillsToggle` this pane would otherwise
     *  fall back to belongs to the PRIMARY request, so leaving `skills_enabled`
     *  unset lets the other pane's badge scope this one. */
    if (typeof ephemeralSkills === 'boolean') {
      result.skills_enabled = ephemeralSkills;
      if (!ephemeralSkills) {
        result.skills = [];
      }
    }
    return;
  }
  const skillsEnabled = resolveSpecSkillsEnabled(ephemeralSkills, modelSpec.skills);
  result.skills_enabled = skillsEnabled;
  if (!skillsEnabled || Array.isArray(modelSpec.skills)) {
    result.skills = [];
    return;
  }
  delete result.skills;
}

function applyModelSpecSubagents(
  result: Record<string, unknown>,
  modelSpec: Pick<TModelSpec, 'subagents'> | null | undefined,
): void {
  if (modelSpec?.subagents) {
    result.subagents = modelSpec.subagents;
  }
}

export interface LoadAddedAgentDeps {
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

interface LoadAddedAgentParams {
  req: {
    user?: { id?: string; role?: string };
    config?: Record<string, unknown>;
    body?: { ephemeralAgent?: TEphemeralAgent; spec?: string | null };
  };
  conversation: TConversation | null;
  primaryAgent?: Agent | null;
}

type AddedModelSpec =
  | { ok: true; modelSpec: TModelSpec | null; enforce: boolean }
  | { ok: false; error: 'model-spec-required' | 'invalid-model-spec' | 'model-spec-mismatch' };

/**
 * Holds the added conversation to the model spec rules `buildEndpointOption`
 * applies to the primary request: with `modelSpecs.enforce` it needs a spec that
 * serves its endpoint, and a spec for another endpoint is refused either way. An
 * unknown spec without enforcement leaves the pane without one.
 */
function resolveAddedModelSpec(
  conversation: Pick<TConversation, 'spec' | 'endpoint'>,
  modelSpecs: AppConfig['modelSpecs'],
): AddedModelSpec {
  /** Read as `loadEphemeralAgent` reads it: a loaded config holds validated specs. */
  const { list, enforce: enforced } = (modelSpecs ?? {}) as {
    list?: TModelSpec[];
    enforce?: boolean;
  };
  const enforce = Boolean(list?.length) && enforced === true;
  const spec = typeof conversation.spec === 'string' ? conversation.spec : '';
  if (!spec || !list) {
    return enforce
      ? { ok: false, error: 'model-spec-required' }
      : { ok: true, modelSpec: null, enforce };
  }

  const resolution = resolveModelSpecForEndpoint({
    modelSpecs: { list },
    spec,
    endpoint: conversation.endpoint,
  });
  if ('modelSpec' in resolution) {
    return { ok: true, modelSpec: resolution.modelSpec, enforce };
  }
  if (enforce || resolution.error === 'model-spec-mismatch') {
    return { ok: false, error: resolution.error };
  }
  return { ok: true, modelSpec: null, enforce };
}

/** An enforced spec's preset names the model, as `buildEndpointOption` decides the primary's. */
function getAddedModel<Model extends string | null | undefined>(
  model: Model,
  { modelSpec, enforce }: { modelSpec: TModelSpec | null; enforce: boolean },
): string | Model {
  return (enforce && modelSpec?.preset.model) || model;
}

/** The model `loadAddedAgent` gives an ephemeral added pane, known before the turn starts. */
export function resolveAddedModel(
  conversation: Pick<TConversation, 'spec' | 'endpoint' | 'model'>,
  modelSpecs: AppConfig['modelSpecs'],
): string | null | undefined {
  const spec = resolveAddedModelSpec(conversation, modelSpecs);
  return spec.ok ? getAddedModel(conversation.model, spec) : conversation.model;
}

/**
 * Parses the added conversation the way `buildEndpointOption` parses the primary
 * request: through its endpoint's schema, then its spec's preset. Clients never
 * receive a spec's private fields such as `promptPrefix`, so only this step can
 * supply them.
 */
function parseAddedConversation({
  conversation,
  endpoint,
  appConfig,
  modelSpec,
  enforce,
}: {
  conversation: TConversation;
  endpoint: string;
  appConfig?: AppConfig;
  modelSpec: TModelSpec | null;
  enforce: boolean;
}): ModelSpecParsedBody | null {
  /** Only a custom endpoint has no schema of its own, and the pane is sent as
   *  stored, without the `endpointType` the client derives for the primary. */
  const endpointType = conversation.endpointType ?? EModelEndpoint.custom;
  const { customParams } = getAgentInferencePolicy(endpoint, appConfig);
  const defaultParamsEndpoint = customParams?.defaultParamsEndpoint;
  try {
    const parsedBody: ModelSpecParsedBody =
      parseCompactConvo({
        endpoint: endpoint as EModelEndpoint,
        endpointType,
        conversation,
        defaultParamsEndpoint,
      }) ?? {};
    if (!modelSpec) {
      return parsedBody;
    }
    return applyModelSpecPreset({
      modelSpec,
      parsedBody,
      endpoint,
      endpointType,
      defaultParamsEndpoint,
      includePresetDefaults: enforce,
    }).parsedBody;
  } catch (error) {
    logger.warn(
      '[loadAddedAgent] Error parsing the added conversation',
      getSafeErrorMetadata(error),
    );
    return null;
  }
}

/**
 * Loads an agent from an added conversation (for multi-convo parallel agent execution).
 * Returns the agent config as a plain object, or null if invalid.
 */
export async function loadAddedAgent(
  { req, conversation, primaryAgent }: LoadAddedAgentParams,
  deps: LoadAddedAgentDeps,
): Promise<Agent | null> {
  if (!conversation) {
    return null;
  }

  const appConfig = req.config as AppConfig | undefined;
  const specResult = resolveAddedModelSpec(conversation, appConfig?.modelSpecs);
  if (!specResult.ok) {
    logger.warn(`[loadAddedAgent] Added conversation refused: ${specResult.error}`);
    return null;
  }
  const { modelSpec, enforce } = specResult;

  if (conversation.agent_id && !isEphemeralAgentId(conversation.agent_id)) {
    /** An enforced spec decides the primary's agent, while the added agent's
     *  access was checked under its own id, so the two have to agree. */
    if (enforce && modelSpec?.preset.agent_id !== conversation.agent_id) {
      logger.warn('[loadAddedAgent] Added conversation refused: model-spec-mismatch');
      return null;
    }
    const reqRecord = req as Record<string, unknown>;
    let agent = reqRecord.resolvedAddedAgent as Agent | null | undefined;
    if (!agent) {
      agent = await deps.getAgent({ id: conversation.agent_id });
    }
    if (!agent) {
      logger.warn(`[loadAddedAgent] Agent ${conversation.agent_id} not found`);
      return null;
    }

    const agentRecord = agent as Agent & { version?: number; versions?: { length: number } };
    agentRecord.version ??= agentRecord.versions?.length ?? 0;
    agent.id = appendAgentIdSuffix(agent.id, 1);
    return agent;
  }

  const { model, endpoint, ...rest } = conversation as TConversation & {
    ephemeralAgent?: TEphemeralAgent;
    [key: string]: unknown;
  };

  if (!endpoint || !model) {
    logger.warn('[loadAddedAgent] Missing required endpoint or model for ephemeral agent');
    return null;
  }

  const parsedBody = parseAddedConversation({
    conversation,
    endpoint,
    appConfig,
    modelSpec,
    enforce,
  });
  if (!parsedBody) {
    return null;
  }
  /** Kept out of the parameters as `buildOptions` and `loadEphemeralAgent` keep
   *  them out of the primary's: request fields, the model and the prompt. */
  const {
    spec: _spec,
    iconURL: _iconURL,
    agent_id: _agentId,
    chatProjectId: _chatProjectId,
    model: _model,
    promptPrefix,
    ...model_parameters
  } = parsedBody;
  const agentModel = getAddedModel(model, specResult);
  const instructions = typeof promptPrefix === 'string' ? promptPrefix : '';

  const capabilityProfile = resolveMCPClientCapabilityProfile(
    resolveMCPAppsPolicy(appConfig?.mcpSettings?.apps),
  );

  /** An added pane carries no toggles of its own — one badge row is shared by
   *  both panes and submits a single `ephemeralAgent` — so the request's state
   *  stands in, field by field, for whatever the pane leaves unset. Merged
   *  rather than substituted so a pane that does carry a partial object still
   *  inherits the toggles it omits.
   *
   *  A pane whose spec gives the user no control over its tools is exempt:
   *  those toggles were never offered for it, so the other pane's choices must
   *  not silently strip the capabilities its spec configured. */
  const requestAgent = resolveSpecUserToggles(
    withRequestedMCPSelection(req.body?.ephemeralAgent),
    modelSpec,
  );
  const paneAgent = resolveSpecUserToggles(rest.ephemeralAgent, modelSpec);
  const ephemeralAgent: TEphemeralAgent | undefined =
    requestAgent || paneAgent ? { ...requestAgent, ...paneAgent } : undefined;

  /** The primary's resolved tools stand in for this pane's, since one badge row
   *  drives both — unless this pane's own spec differs and governs tools the
   *  primary's resolution never saw: configured toggles it withholds, MCP
   *  servers it pins, or `askUserQuestion`, which has no badge to carry it.
   *  Only the full resolution below applies those. */
  const primaryIsEphemeral = primaryAgent && isEphemeralAgentId(primaryAgent.id);
  const governsOwnTools =
    (spec || '') !== (req.body?.spec || '') &&
    ((modelSpec?.mcpServers?.length ?? 0) > 0 ||
      modelSpec?.askUserQuestion != null ||
      getWithheldToggles(modelSpec).size > 0);
  if (primaryIsEphemeral && !governsOwnTools && Array.isArray(primaryAgent.tools)) {
    let endpointConfig = (appConfig?.endpoints as Record<string, unknown> | undefined)?.[
      endpoint
    ] as Record<string, unknown> | undefined;
    if (!isAgentsEndpoint(endpoint) && !endpointConfig) {
      try {
        endpointConfig = getCustomEndpointConfig({ endpoint, appConfig }) as
          | Record<string, unknown>
          | undefined;
      } catch (err) {
        logger.error('[loadAddedAgent] Error getting custom endpoint config', err);
      }
    }

    const sender = getEphemeralSender({
      modelLabel: model_parameters.modelLabel,
      specLabel: modelSpec?.label,
      modelDisplayLabel: endpointConfig?.modelDisplayLabel as string | undefined,
    });
    const ephemeralId = encodeEphemeralAgentId({ endpoint, model: agentModel, sender, index: 1 });

    const result: Record<string, unknown> = {
      id: ephemeralId,
      instructions,
      provider: endpoint,
      model_parameters,
      model: agentModel,
      tools: [...primaryAgent.tools],
    };
    applyModelSpecSkills(result, modelSpec, ephemeralAgent?.skills);
    applyModelSpecSubagents(result, modelSpec);
    const mirroredArtifacts = resolveSpecArtifacts(ephemeralAgent?.artifacts, modelSpec?.artifacts);
    if (mirroredArtifacts != null) {
      result.artifacts = mirroredArtifacts;
    }
    const primaryToggleToolOptions = synthesizeToggleToolOptions({ ephemeralAgent, modelSpec });
    if (primaryToggleToolOptions) {
      result.tool_options = primaryToggleToolOptions;
    }
    return result as unknown as Agent;
  }

  const userId = req.user?.id ?? '';
  const mcpServers = new Set<string>(
    await resolveEphemeralMCPServers({
      selected: ephemeralAgent?.mcp,
      specServers: modelSpec?.mcpServers,
      userId,
      role: req.user?.role,
      getAccessibleMCPServers: deps.getAccessibleMCPServers,
    }),
  );

  /** Mirror the primary ephemeral loader (`loadEphemeralAgent`): spec flags are
   *  defaults an explicit conversation toggle overrides, and downstream
   *  `createRun` gating (hitlCapable, non-subagent, admin filter) is uniform. */
  const tools: string[] = resolveEphemeralTools(ephemeralAgent, modelSpec);

  const serverToolKeys = await mapWithConcurrency(
    [...mcpServers],
    getLookupConcurrency(appConfig, 'mcpCatalogLookups'),
    async (mcpServer): Promise<string[]> => {
      /** Address durable catalogs by the effective request overlay; request-scoped
       *  overlays still expand fresh through `mcp_all`. */
      const rawOverlayConfig = appConfig?.mcpConfig?.[mcpServer];
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

  let endpointConfig = (appConfig?.endpoints as Record<string, unknown> | undefined)?.[endpoint] as
    | Record<string, unknown>
    | undefined;
  if (!isAgentsEndpoint(endpoint) && !endpointConfig) {
    try {
      endpointConfig = getCustomEndpointConfig({ endpoint, appConfig }) as
        | Record<string, unknown>
        | undefined;
    } catch (err) {
      logger.error('[loadAddedAgent] Error getting custom endpoint config', err);
    }
  }

  const sender = getEphemeralSender({
    modelLabel: model_parameters.modelLabel,
    specLabel: modelSpec?.label,
    modelDisplayLabel: endpointConfig?.modelDisplayLabel as string | undefined,
  });
  const ephemeralId = encodeEphemeralAgentId({ endpoint, model: agentModel, sender, index: 1 });

  const result: Record<string, unknown> = {
    id: ephemeralId,
    instructions,
    provider: endpoint,
    model_parameters,
    model: agentModel,
    tools,
  };

  const artifacts = resolveSpecArtifacts(ephemeralAgent?.artifacts, modelSpec?.artifacts);
  if (artifacts != null) {
    result.artifacts = artifacts;
  }
  applyModelSpecSubagents(result, modelSpec);
  applyModelSpecSkills(result, modelSpec, ephemeralAgent?.skills);

  const toggleToolOptions = synthesizeToggleToolOptions({ ephemeralAgent, modelSpec });
  if (toggleToolOptions) {
    result.tool_options = toggleToolOptions;
  }

  return result as unknown as Agent;
}
