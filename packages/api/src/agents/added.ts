import { logger } from '@librechat/data-schemas';
import {
  parseCompactConvo,
  isEphemeralAgentId,
  appendAgentIdSuffix,
  getDefaultParamsEndpoint,
} from 'librechat-data-provider';
import type {
  Agent,
  TModelSpec,
  TConversation,
  EModelEndpoint,
  TEphemeralAgent,
  TEndpointsConfig,
} from 'librechat-data-provider';
import type { LoadAgentDeps, LoadAgentParams } from '~/agents/load';
import { applyModelSpecPreset, resolveModelSpecForEndpoint } from '~/modelSpecs';
import { loadEphemeralAgent } from '~/agents/load';

export const ADDED_AGENT_ID = 'added_agent';

type ModelSpecsConfig = { list?: TModelSpec[]; enforce?: boolean };

type AddedModelSpecResult =
  | { ok: true; modelSpec?: TModelSpec }
  | { ok: false; error: 'model-spec-required' | 'invalid-model-spec' | 'model-spec-mismatch' };

/**
 * Applies the primary request's spec rules (`buildEndpointOption`) to the added
 * conversation: an enforced config requires a spec that serves the endpoint, and
 * a spec for another endpoint is refused either way. Only an accepted spec may
 * contribute its preset, tools, MCP servers, skills or subagents.
 */
function resolveAddedModelSpec(
  spec: string | null | undefined,
  endpoint: string,
  modelSpecs: ModelSpecsConfig | undefined,
): AddedModelSpecResult {
  const list = modelSpecs?.list;
  const enforce = modelSpecs?.enforce === true && list != null && list.length > 0;
  if (!spec || !list) {
    return enforce ? { ok: false, error: 'model-spec-required' } : { ok: true };
  }

  const resolution = resolveModelSpecForEndpoint({ modelSpecs: { list }, spec, endpoint });
  if ('modelSpec' in resolution) {
    return { ok: true, modelSpec: resolution.modelSpec };
  }
  if (enforce || resolution.error === 'model-spec-mismatch') {
    return { ok: false, error: resolution.error };
  }
  return { ok: true };
}

/**
 * Parses the added conversation as `buildEndpointOption` parses the primary
 * request: the endpoint's schema, then its model spec's preset. This keeps
 * provider settings such as `useResponsesApi` and reasoning options.
 */
function parseAddedConversation({
  conversation,
  modelSpec,
  enforce,
  endpointsConfig,
}: {
  conversation: TConversation & { endpoint: string };
  modelSpec?: TModelSpec;
  enforce: boolean;
  endpointsConfig?: TEndpointsConfig;
}):
  | { ok: true; parsedBody: Record<string, unknown> | null }
  | { ok: false; error: 'unknown-endpoint' } {
  const { endpoint } = conversation;
  /** The client derives the primary's `endpointType` from the endpoints config
   *  but sends the added conversation as stored, which may lack it. */
  const endpointType = conversation.endpointType ?? endpointsConfig?.[endpoint]?.type;
  const defaultParamsEndpoint = getDefaultParamsEndpoint(endpointsConfig, endpoint);
  let parsedBody: Record<string, unknown> | null;
  try {
    parsedBody = parseCompactConvo({
      endpoint: endpoint as EModelEndpoint,
      endpointType,
      conversation,
      defaultParamsEndpoint,
    });
  } catch {
    /** Thrown only when no schema serves the endpoint; the primary request
     *  rejects the same input in `buildEndpointOption`. */
    return { ok: false, error: 'unknown-endpoint' };
  }
  if (!parsedBody || !modelSpec) {
    return { ok: true, parsedBody };
  }
  return {
    ok: true,
    parsedBody: applyModelSpecPreset({
      modelSpec,
      parsedBody,
      endpoint,
      endpointType,
      defaultParamsEndpoint,
      includePresetDefaults: enforce,
    }).parsedBody,
  };
}

export type LoadAddedAgentDeps = LoadAgentDeps;

interface LoadAddedAgentParams {
  req: {
    user?: { id?: string; role?: string };
    config?: Record<string, unknown>;
    /** Loaded by `buildEndpointOption` for this request; resolves a custom
     *  endpoint's `defaultParamsEndpoint` without loading it again. */
    endpointsConfig?: TEndpointsConfig;
  };
  conversation: TConversation | null;
  primaryAgent?: Agent | null;
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

  if (conversation.agent_id && !isEphemeralAgentId(conversation.agent_id)) {
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

  const { model, endpoint, promptPrefix, spec, ephemeralAgent } = conversation as TConversation & {
    ephemeralAgent?: TEphemeralAgent;
  };
  if (!endpoint || !model) {
    logger.warn('[loadAddedAgent] Missing required endpoint or model for ephemeral agent');
    return null;
  }

  const agentReq = req as LoadAgentParams['req'];
  const modelSpecs = agentReq.config?.modelSpecs as ModelSpecsConfig | undefined;
  const specResult = resolveAddedModelSpec(spec, endpoint, modelSpecs);
  if (!specResult.ok) {
    logger.warn(`[loadAddedAgent] Added conversation refused: ${specResult.error}`);
    return null;
  }
  const { modelSpec } = specResult;
  const parseResult = parseAddedConversation({
    conversation: { ...conversation, endpoint },
    modelSpec,
    enforce: modelSpecs?.enforce === true,
    endpointsConfig: req.endpointsConfig,
  });
  if (!parseResult.ok) {
    logger.warn(`[loadAddedAgent] Added conversation refused: ${parseResult.error}`);
    return null;
  }
  /** Same request-only fields `buildOptions` keeps out of the primary's parameters. */
  const {
    spec: _spec,
    iconURL: _iconURL,
    agent_id: _agentId,
    chatProjectId: _chatProjectId,
    ...model_parameters
  } = parseResult.parsedBody ?? {};
  /** An ephemeral primary already resolved the shared badge selections. */
  const tools =
    primaryAgent && isEphemeralAgentId(primaryAgent.id) && Array.isArray(primaryAgent.tools)
      ? primaryAgent.tools
      : undefined;

  return loadEphemeralAgent(
    {
      req: agentReq,
      spec: modelSpec?.name,
      endpoint,
      model_parameters: { model, ...model_parameters } as LoadAgentParams['model_parameters'],
      body: { promptPrefix: promptPrefix ?? undefined, ephemeralAgent },
      index: 1,
      tools,
    },
    deps,
  );
}
