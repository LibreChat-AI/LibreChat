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
import type { AppConfig } from '@librechat/data-schemas';
import type { LoadAgentDeps, LoadAgentParams } from '~/agents/load';
import { applyModelSpecPreset, resolveModelSpecForEndpoint } from '~/modelSpecs';
import { loadEphemeralAgent } from '~/agents/load';

export const ADDED_AGENT_ID = 'added_agent';

/**
 * Parses the added conversation as `buildEndpointOption` parses the primary
 * request: the endpoint's schema, then its model spec's preset. This keeps
 * provider settings such as `useResponsesApi` and reasoning options.
 */
async function parseAddedConversation(
  conversation: TConversation & { endpoint: string },
  appConfig: AppConfig | undefined,
  getEndpointsConfig: LoadAddedAgentDeps['getEndpointsConfig'],
): Promise<Record<string, unknown> | null> {
  const { endpoint, endpointType, spec } = conversation;
  /** Optional for built-in endpoints; the primary request also parses on without it. */
  let endpointsConfig: TEndpointsConfig | undefined;
  try {
    endpointsConfig = await getEndpointsConfig?.();
  } catch (err) {
    logger.error('[loadAddedAgent] Error fetching endpoints config', err);
  }
  const defaultParamsEndpoint = getDefaultParamsEndpoint(endpointsConfig, endpoint);
  const parsedBody = parseCompactConvo({
    endpoint: endpoint as EModelEndpoint,
    endpointType,
    conversation,
    defaultParamsEndpoint,
  });
  const modelSpecs = appConfig?.modelSpecs as
    | { list?: TModelSpec[]; enforce?: boolean }
    | undefined;
  if (!parsedBody || !spec || !modelSpecs?.list) {
    return parsedBody;
  }

  const resolution = resolveModelSpecForEndpoint({
    modelSpecs: { list: modelSpecs.list },
    spec,
    endpoint,
  });
  if (!('modelSpec' in resolution)) {
    return parsedBody;
  }
  return applyModelSpecPreset({
    modelSpec: resolution.modelSpec,
    parsedBody,
    endpoint,
    endpointType,
    defaultParamsEndpoint,
    includePresetDefaults: modelSpecs.enforce === true,
  }).parsedBody;
}

export interface LoadAddedAgentDeps extends LoadAgentDeps {
  /** Resolves `customParams.defaultParamsEndpoint` for custom endpoints, as the
   *  primary request's parser does. Omitted, custom endpoints parse as `custom`. */
  getEndpointsConfig?: () => Promise<TEndpointsConfig | undefined>;
}

interface LoadAddedAgentParams {
  req: { user?: { id?: string; role?: string }; config?: Record<string, unknown> };
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
  const parsedBody = await parseAddedConversation(
    { ...conversation, endpoint },
    agentReq.config,
    deps.getEndpointsConfig,
  );
  /** Same request-only fields `buildOptions` keeps out of the primary's parameters. */
  const {
    spec: _spec,
    iconURL: _iconURL,
    agent_id: _agentId,
    chatProjectId: _chatProjectId,
    ...model_parameters
  } = parsedBody ?? {};
  /** An ephemeral primary already resolved the shared badge selections. */
  const tools =
    primaryAgent && isEphemeralAgentId(primaryAgent.id) && Array.isArray(primaryAgent.tools)
      ? primaryAgent.tools
      : undefined;

  return loadEphemeralAgent(
    {
      req: agentReq,
      spec: spec ?? undefined,
      endpoint,
      model_parameters: { model, ...model_parameters } as LoadAgentParams['model_parameters'],
      body: { promptPrefix: promptPrefix ?? undefined, ephemeralAgent },
      index: 1,
      tools,
    },
    deps,
  );
}
