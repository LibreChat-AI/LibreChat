import {
  ACTIVITY_LABEL_RUN_NAME,
  ACTIVITY_PHASE_RUN_NAME,
  STANDARD_GRAPH_RUN_NAME,
  REASONING_LABEL_RUN_NAME,
  AGENT_MODEL_CALL_RUN_NAME,
  MULTI_AGENT_GRAPH_RUN_NAME,
  ACTIVITY_PHASE_LABEL_RUN_NAME,
} from '@librechat/agents';
import type { TTraceRecord, TTraceRecordRole } from 'librechat-data-provider';

/** Span names the agents SDK assigns while shaping a trace for export, which it does not export. */
const AGENT_NODE_NAME = 'agent';
const PROMPT_NAME = 'prompt';
const MODEL_CALL_NAME = 'llm';
/** One round of tool calls; the SDK scopes its input to the calls the round ran. */
export const TOOL_ROUND_NAME = 'tool-dispatch';
/** The SDK names an agent's workflow node with the saved agent's bare id. */
const SAVED_AGENT_ID = /^agent_[A-Za-z0-9_-]+$/;

const ROLE_BY_NAME: Record<string, TTraceRecordRole> = {
  [STANDARD_GRAPH_RUN_NAME]: 'run',
  [MULTI_AGENT_GRAPH_RUN_NAME]: 'run',
  [AGENT_NODE_NAME]: 'plumbing',
  [AGENT_MODEL_CALL_RUN_NAME]: 'plumbing',
  [PROMPT_NAME]: 'plumbing',
  [ACTIVITY_PHASE_RUN_NAME]: 'plumbing',
  [MODEL_CALL_NAME]: 'model',
  [TOOL_ROUND_NAME]: 'tools',
  [ACTIVITY_LABEL_RUN_NAME]: 'stepLabel',
  [REASONING_LABEL_RUN_NAME]: 'reasoningLabel',
  [ACTIVITY_PHASE_LABEL_RUN_NAME]: 'phaseLabel',
};

/** A tool or a model call may carry any name a deployment gave it, so only the SDK's own spans have a role. */
const NAMED_BY_SDK: ReadonlySet<TTraceRecord['kind']> = new Set(['agent', 'span', 'generation']);
const MODEL_CALL_ROLES: ReadonlySet<TTraceRecordRole> = new Set([
  'model',
  'stepLabel',
  'reasoningLabel',
  'phaseLabel',
]);

/** What a record did in the run, read from the names the agents SDK gives the spans it exports. */
export function resolveTraceRole(
  kind: TTraceRecord['kind'],
  name: string,
): Pick<TTraceRecord, 'role' | 'agentId'> {
  if (!NAMED_BY_SDK.has(kind)) {
    return {};
  }
  if (kind !== 'generation' && SAVED_AGENT_ID.test(name)) {
    return { role: 'agent', agentId: name };
  }
  const role = ROLE_BY_NAME[name];
  if (role == null || (kind === 'generation') !== MODEL_CALL_ROLES.has(role)) {
    return {};
  }
  return { role };
}
