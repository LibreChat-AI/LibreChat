import { createHash } from 'crypto';
import { logger } from '@librechat/data-schemas';
import type { Agent, CodeWorkspaceSelectionErrorReason } from 'librechat-data-provider';
import type { CodeExecutionContext } from './execution';
import {
  CodeWorkspaceSelectionError,
  describeCodeWorkspaceUnavailableSubagent,
  getSubagentCodeWorkspaceUnavailableReason,
} from '~/code/errors';

type VersionedAgent = Pick<
  Agent,
  | 'id'
  | 'name'
  | 'description'
  | 'instructions'
  | 'additional_instructions'
  | 'endpoint'
  | 'provider'
  | 'model'
  | 'model_parameters'
  | 'tools'
  | 'tool_kwargs'
  | 'tool_options'
  | 'tool_resources'
  | 'skills'
  | 'skills_enabled'
  | 'skill_authoring_enabled'
  | 'skills_scope'
  | 'stateful_code_sessions'
  | 'stateful_code_environment'
  | 'code_environment_id'
  | 'code_environment_ids'
  | 'git_identity'
  | 'artifacts'
  | 'recursion_limit'
  | 'agent_ids'
  | 'edges'
  | 'end_after_tools'
  | 'hide_sequential_outputs'
  | 'subagents'
  | 'memory_scope'
  | 'instructionsPrompt'
> & {
  version?: number;
  actions?: string[];
  mcpServerNames?: string[];
};

const sensitiveKeyPattern =
  /(?:^|[_-])(?:api[_-]?key|authorization|credentials?|password|secret|(?:access|refresh|id|auth)?[_-]?token)(?:$|[_-])/i;

function isSensitiveKey(key: string): boolean {
  return sensitiveKeyPattern.test(key);
}

function canonicalize(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (typeof value !== 'object') {
    return 'null';
  }

  const entries = Object.entries(value)
    .filter(([key, entry]) => !isSensitiveKey(key) && entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(',')}}`;
}

/**
 * Returns only persisted fields that can change the initialized child graph.
 * `name` and `description` are intentionally included because they are
 * advertised to the parent model; request state, ACL-only display fields, and
 * secret values are excluded.
 */
export function selectLazySubagentConfig(agent: VersionedAgent): Omit<VersionedAgent, 'version'> {
  const {
    id,
    name,
    description,
    instructions,
    additional_instructions,
    instructionsPrompt,
    endpoint,
    provider,
    model,
    model_parameters,
    tools,
    tool_kwargs,
    tool_options,
    tool_resources,
    skills,
    skills_enabled,
    skill_authoring_enabled,
    skills_scope,
    stateful_code_sessions,
    stateful_code_environment,
    code_environment_id,
    code_environment_ids,
    git_identity,
    artifacts,
    recursion_limit,
    agent_ids,
    edges,
    end_after_tools,
    hide_sequential_outputs,
    subagents,
    memory_scope,
    actions,
    mcpServerNames,
  } = agent;
  return {
    id,
    name,
    description,
    instructions,
    additional_instructions,
    instructionsPrompt,
    endpoint,
    provider,
    model,
    model_parameters,
    tools,
    tool_kwargs,
    tool_options,
    tool_resources,
    skills,
    skills_enabled,
    skill_authoring_enabled,
    skills_scope,
    stateful_code_sessions,
    stateful_code_environment,
    code_environment_id,
    code_environment_ids,
    git_identity,
    artifacts,
    recursion_limit,
    agent_ids,
    edges,
    end_after_tools,
    hide_sequential_outputs,
    subagents,
    memory_scope,
    actions,
    mcpServerNames,
  };
}

/** Deterministic descriptor identity for a persisted lazy subagent. */
export function getLazySubagentConfigId(agent: VersionedAgent): string {
  const version =
    agent.version != null && Number.isInteger(agent.version) && agent.version >= 0
      ? agent.version
      : 0;
  const fingerprint = createHash('sha256')
    .update(canonicalize(selectLazySubagentConfig(agent)))
    .digest('hex');
  return `${agent.id}:${version}:${fingerprint}`;
}

/**
 * Memoizes one read and one VIEW check per subagent for the life of a request, so machine
 * inheritance, lazy descriptors and graph members share them. A missing or unviewable agent
 * resolves to `null`; a failed read rejects for every caller, which each handles as before.
 */
export function createViewableSubagentLoader<TAgent>({
  getAgent,
  canView,
}: {
  getAgent: (agentId: string) => Promise<TAgent | null | undefined>;
  canView: (agent: TAgent, agentId: string) => Promise<boolean>;
}): (agentId: string) => Promise<TAgent | null> {
  const loads = new Map<string, Promise<TAgent | null>>();
  return (agentId) => {
    let loading = loads.get(agentId);
    if (loading == null) {
      loading = getAgent(agentId).then(async (agent) =>
        agent != null && (await canView(agent, agentId)) ? agent : null,
      );
      loads.set(agentId, loading);
    }
    return loading;
  };
}

/** The SDK-facing context a routed graph member initializes under. */
export interface RoutedGraphMemberContext {
  signal: AbortSignal;
  /** The per-call-routed parent execution the member follows. */
  parentRunId: string;
  /** Stable per parent and member; routing groups the member's route with the parent's. */
  executionId: string;
}

/**
 * Loads the graph members a per-call-routed parent resolves. A member already shared
 * this request (initialized on its own route) is reused; otherwise it initializes as
 * a child of the parent's execution so it may follow the parent's machine, and its
 * config stays with that execution rather than the request-wide graph cache.
 */
export function createRoutedGraphMemberLoader<TAgent, TConfig>({
  getShared,
  isSkipped,
  skip,
  getAgent,
  canView,
  initialize,
  isFatal,
}: {
  getShared: (memberId: string) => TConfig | undefined;
  isSkipped: (memberId: string) => boolean;
  skip: (memberId: string) => void;
  getAgent: (memberId: string, signal: AbortSignal) => Promise<TAgent | null | undefined>;
  canView: (agent: TAgent, memberId: string, signal: AbortSignal) => Promise<boolean>;
  initialize: (input: {
    agent: TAgent;
    memberId: string;
    context: RoutedGraphMemberContext;
  }) => Promise<TConfig>;
  isFatal: (error: unknown, signal: AbortSignal) => boolean;
}): (memberId: string, parentRunId: string, signal: AbortSignal) => Promise<TConfig | null> {
  return async (memberId, parentRunId, signal) => {
    if (signal.aborted) {
      throw signal.reason ?? new Error('Subagent resolution was aborted.');
    }
    const shared = getShared(memberId);
    if (shared != null) {
      return shared;
    }
    if (isSkipped(memberId)) {
      return null;
    }
    const agent = await getAgent(memberId, signal);
    if (agent == null || !(await canView(agent, memberId, signal))) {
      skip(memberId);
      return null;
    }
    const executionId = `${parentRunId}:graph:${memberId}`;
    try {
      return await initialize({ agent, memberId, context: { signal, parentRunId, executionId } });
    } catch (error) {
      if (isFatal(error, signal)) {
        throw error;
      }
      logger.error(`[lazySubagents] Error initializing routed graph member ${memberId}:`, error);
      return null;
    }
  };
}

export interface SubagentCodeAvailability {
  codeEnvAvailable: boolean;
  statefulCodeSessions: boolean;
  codeExecutionContext?: CodeExecutionContext;
  /** Set when the subagent's machine has no usable workspace in this conversation. */
  codeWorkspaceUnavailable?: Exclude<CodeWorkspaceSelectionErrorReason, 'locked'>;
}

/**
 * Resolves a lazy subagent's code route for its descriptor. A subagent whose machine has no usable
 * workspace is reported unavailable, with code off, instead of failing its parent's turn; a locked
 * decision and every other error still propagate.
 */
export async function resolveSubagentCodeAvailability({
  agentId,
  codeEnvAvailable,
  statefulCodeSessions,
  resolveContext,
}: {
  agentId: string;
  codeEnvAvailable: boolean;
  statefulCodeSessions: boolean;
  resolveContext: () => Promise<CodeExecutionContext | undefined>;
}): Promise<SubagentCodeAvailability> {
  try {
    return { codeEnvAvailable, statefulCodeSessions, codeExecutionContext: await resolveContext() };
  } catch (error) {
    const codeWorkspaceUnavailable = getSubagentCodeWorkspaceUnavailableReason(error);
    if (!codeWorkspaceUnavailable) {
      throw error;
    }
    logger.warn('[resolveSubagentCodeAvailability] Subagent advertised without a code workspace', {
      agentId,
      reason: codeWorkspaceUnavailable,
    });
    return { codeEnvAvailable: false, statefulCodeSessions: false, codeWorkspaceUnavailable };
  }
}

/**
 * Keeps an unavailable subagent listed so its parent learns why, while its resolver rejects with
 * the same `CODE_WORKSPACE_UNAVAILABLE` error so it can never run.
 */
export function guardUnavailableSubagent<TContext, TConfig>({
  description,
  codeWorkspaceUnavailable,
  resolve,
}: {
  description?: string;
  codeWorkspaceUnavailable?: CodeWorkspaceSelectionErrorReason;
  resolve: (context: TContext) => Promise<TConfig>;
}): { description?: string; resolve: (context: TContext) => Promise<TConfig> } {
  if (!codeWorkspaceUnavailable) {
    return { description, resolve };
  }
  return {
    description: describeCodeWorkspaceUnavailableSubagent(description, codeWorkspaceUnavailable),
    resolve: async () => {
      throw new CodeWorkspaceSelectionError(codeWorkspaceUnavailable);
    },
  };
}
