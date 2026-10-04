import { createHash } from 'crypto';
import type { Agent } from 'librechat-data-provider';

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
