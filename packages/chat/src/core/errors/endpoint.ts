import {
  Constants,
  getEndpointField,
  isAgentsEndpoint,
  isEphemeralAgentId,
  stripAgentIdSuffix,
  isAssistantsEndpoint,
  parseEphemeralAgentId,
} from 'librechat-data-provider';
import type {
  Agent,
  TConfig,
  AgentDisplay,
  EModelEndpoint,
  TConversation,
  TEndpointsConfig,
} from 'librechat-data-provider';
import type { ErrorSource } from './source';
import { getProviderName } from './payload';

/**
 * Whether an endpoint config requires a user-provided credential — an API key or
 * any Bedrock credential field. `userProvideURL` alone is excluded: a user-provided
 * base URL does not imply a user-managed key.
 */
export function isUserProvidedEndpointConfig(config?: TConfig | null): boolean {
  if (!config) {
    return false;
  }
  return (
    !!config.userProvide ||
    !!config.userProvideAccessKeyId ||
    !!config.userProvideSecretAccessKey ||
    !!config.userProvideSessionToken ||
    !!config.userProvideBearerToken
  );
}

/**
 * An Assistants thread lives on the provider, so a summary inserted into the
 * local history would compact nothing. Callers hide the action there.
 */
export function supportsCompaction(endpoint?: string | null): boolean {
  return endpoint != null && endpoint !== '' && !isAssistantsEndpoint(endpoint);
}

/** Agents by id, as a transcript resolves them: saved agents and the presets a run handed off to. */
export type TranscriptAgentsMap = Record<string, AgentDisplay | undefined>;

export type ErrorEndpoint = {
  /** The endpoint the failed request ran against, when it is knowable. */
  endpoint?: string;
  endpointType?: EModelEndpoint;
  /** Display name for the provider; undefined when the endpoint cannot be resolved. */
  provider?: string;
  /** The model that produced the failure. */
  model?: string;
  /** The saved agent that produced the failure, when the agents map can resolve it. */
  agent?: Agent;
  /**
   * The reader, not the deployment, maintains the endpoint's credentials (key, URL or both).
   * Undefined where no endpoint configuration is available to this viewer, as on a shared link.
   */
  userProvidesCredentials?: boolean;
  /**
   * Manual context compaction can be triggered for this conversation. It is only offered from the
   * chat composer's context usage popover, so neither a surface outside the chat (search, a shared
   * link) nor a deployment that hides that indicator has compaction to suggest.
   */
  compactionAvailable: boolean;
  endpointsConfig?: TEndpointsConfig;
};

/** The conversation fields an error with no row of its own falls back to. */
export type ErrorConversation = Pick<TConversation, 'endpoint' | 'model' | 'agent_id'>;

/** What the app knows beyond the row: the chat it renders in, its agents and its configuration. */
export type ErrorEnvironment = {
  /** The conversation the chat shows; absent outside the chat (search results, a shared link). */
  conversation?: ErrorConversation | null;
  /** Agents the transcript can name, presets included. */
  agentsMap?: TranscriptAgentsMap;
  /** The reader's saved agents, with the contacts and permissions an agent error reads. */
  savedAgents?: Record<string, Agent | undefined>;
  endpointsConfig?: TEndpointsConfig;
  /** The deployment offers manual compaction where this error renders. */
  compactionEnabled?: boolean;
};

/** What an agent ran against: its provider (an endpoint id) and model, and the saved agent if any. */
type AgentIdentity = { agent?: AgentDisplay; endpoint?: string; model?: string };

/**
 * Resolves an agent id the way the transcript's sibling headers do: a saved agent through the
 * agents map (without the `____N` suffix parallel runs append), an ephemeral agent through the
 * endpoint and model its id encodes.
 */
function resolveAgentId(
  agentsMap: TranscriptAgentsMap | undefined,
  agentId: string,
): AgentIdentity {
  const agent = agentsMap?.[stripAgentIdSuffix(agentId)];
  if (agent != null) {
    return { agent, endpoint: agent.provider || undefined, model: agent.model ?? undefined };
  }
  if (stripAgentIdSuffix(agentId).startsWith(Constants.MODEL_SPEC_AGENT_PREFIX)) return {};
  const ephemeral = isEphemeralAgentId(agentId) ? parseEphemeralAgentId(agentId) : undefined;
  return ephemeral == null ? {} : { endpoint: ephemeral.endpoint, model: ephemeral.model };
}

/**
 * Who ran the failing part of an agents row. The part's own agent (its parallel lane's, or the one
 * a handoff made active) comes first. Otherwise the row's `model` says: a saved agent's rows,
 * including the live placeholder the client builds, store the agent id there, and an ephemeral
 * agent's store its encoded id or the model itself. The conversation's agent is read only for an
 * error with no row at all. An id that resolves to nothing names nothing, so neither an agent id
 * nor a placeholder is ever shown as a model, while a plain model name is kept.
 */
function resolveAgentRow(
  agentsMap: TranscriptAgentsMap | undefined,
  {
    partAgentId,
    rowModel,
    conversationAgentId,
  }: { partAgentId?: string; rowModel?: string; conversationAgentId?: string },
): AgentIdentity {
  const agentId = partAgentId ?? conversationAgentId;
  if (agentId != null) {
    return resolveAgentId(agentsMap, agentId);
  }
  if (rowModel == null || rowModel === Constants.EPHEMERAL_AGENT_ID) {
    return {};
  }
  const resolved = resolveAgentId(agentsMap, rowModel);
  if (
    resolved.endpoint != null ||
    !isEphemeralAgentId(rowModel) ||
    stripAgentIdSuffix(rowModel).startsWith(Constants.MODEL_SPEC_AGENT_PREFIX)
  ) {
    return resolved;
  }
  return { model: rowModel };
}

/**
 * Whether the reader maintains an endpoint's credentials. A user-provided base URL counts even with
 * a deployment key: the server then reads both the key and the URL from the reader's own record,
 * so the key dialog, which edits both, is the fix for its failures too.
 */
const readerOwnsCredentials = (config?: TConfig | null): boolean =>
  isUserProvidedEndpointConfig(config) || config?.userProvideURL === true;

/** Without a loaded endpoint configuration, ownership is unknown rather than the deployment's. */
function resolveCredentialOwnership(
  endpointsConfig: TEndpointsConfig | undefined,
  endpoint: string | undefined,
): boolean | undefined {
  if (endpoint == null) {
    return false;
  }
  return endpointsConfig == null ? undefined : readerOwnsCredentials(endpointsConfig[endpoint]);
}

/**
 * The row identity an error resolves against, and the agent id that names its agent (the key an
 * agents map is looked up with). A row's own identity is authoritative even where it lacks a
 * field: borrowing the conversation's current selection, or its current agent, would attribute an
 * old failure to whatever the reader picked since. Only an error rendered with no row at all reads
 * the conversation.
 */
export function resolveErrorIdentity(
  source: ErrorSource | undefined,
  conversation: ErrorConversation | null | undefined,
): {
  rowEndpoint?: string;
  rowModel?: string;
  conversationAgentId?: string;
  partAgentId?: string;
  agentKey: string;
} {
  const identity = source ?? conversation ?? undefined;
  const rowEndpoint = identity?.endpoint ?? undefined;
  const rowModel = identity?.model ?? undefined;
  const conversationAgentId =
    source == null && conversation?.agent_id !== Constants.EPHEMERAL_AGENT_ID
      ? (conversation?.agent_id ?? undefined)
      : undefined;
  const partAgentId = source?.partAgentId;
  return {
    rowEndpoint,
    rowModel,
    conversationAgentId,
    partAgentId,
    agentKey: partAgentId ?? rowModel ?? conversationAgentId ?? '',
  };
}

/**
 * Resolves who produced the failure.
 *
 * Error content renders in the chat, in search results and in shared links, and only the chat
 * knows its conversation and configuration. Copy therefore has to work without a provider name,
 * which is why `provider` and `model` are optional.
 *
 * A saved agent's row names the `agents` endpoint and carries the agent id as its model, while the
 * request ran against the agent's own provider and model, so those are what identity, key
 * ownership and the key dialog resolve against; after a handoff, that is the agent the handoff
 * made active, and in a parallel run, the agent of the error's own lane. An endpoint named by the
 * payload itself outranks all of them. Compaction is a conversation action, so it stays keyed to
 * the row's endpoint.
 */
export function resolveErrorEndpoint(
  source: ErrorSource | undefined,
  payloadEndpoint: string | undefined,
  environment: ErrorEnvironment,
): ErrorEndpoint {
  const { agentsMap, savedAgents, endpointsConfig, conversation } = environment;
  const { rowEndpoint, rowModel, conversationAgentId, partAgentId } = resolveErrorIdentity(
    source,
    conversation,
  );
  const agentRow = partAgentId != null || isAgentsEndpoint(rowEndpoint);
  const agentIdentity = agentRow
    ? resolveAgentRow(agentsMap, { partAgentId, rowModel, conversationAgentId })
    : undefined;
  const rowProvider = agentRow ? agentIdentity?.endpoint : rowEndpoint;
  const endpoint = payloadEndpoint ?? rowProvider;
  const endpointType = endpoint
    ? (getEndpointField(endpointsConfig, endpoint, 'type') as EModelEndpoint | undefined)
    : undefined;
  return {
    endpoint,
    endpointType,
    provider: endpoint ? getProviderName(endpoint) : undefined,
    model: agentRow ? agentIdentity?.model : rowModel,
    agent: agentIdentity?.agent
      ? savedAgents?.[stripAgentIdSuffix(agentIdentity.agent.id)]
      : undefined,
    userProvidesCredentials: resolveCredentialOwnership(endpointsConfig, endpoint),
    compactionAvailable: environment.compactionEnabled === true && supportsCompaction(rowEndpoint),
    endpointsConfig,
  };
}
