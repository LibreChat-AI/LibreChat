import { createHash } from 'node:crypto';
import { Constants as AgentConstants } from '@librechat/agents';
import { Constants, isActionTool } from 'librechat-data-provider';
import type {
  ScheduledMCPReadOnlyPolicy,
  ScheduledMCPToolSelection,
  ScheduledMCPFailureReason,
  ScheduleMCPOutcome,
} from 'librechat-data-provider';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ScheduledMCPFailure } from './contract';
import { failureFixtures } from './failures';

/** Only MCP selections and side-effect-free SDK controls belong to this consent phase. */
export function isScheduledMCPCandidate(name: string): boolean {
  if (isActionTool(name)) return false;
  return (
    (name.includes(Constants.mcp_delimiter) &&
      !name.startsWith(`${Constants.mcp_server}${Constants.mcp_delimiter}`) &&
      !name.startsWith(`${Constants.mcp_all}${Constants.mcp_delimiter}`)) ||
    name === AgentConstants.SUBAGENT ||
    name === AgentConstants.TOOL_SEARCH ||
    name === 'ask_user_question'
  );
}

/** Stable across object insertion order. Arrays retain their semantic order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

/** A pin binds trusted service policy to the full upstream definition, not its hints. */
export function getScheduledMCPToolDefinitionDigest(tool: Tool): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(tool)))
    .digest('hex');
}

export function getScheduledMCPPolicyRevision(
  selections: readonly ScheduledMCPToolSelection[],
  policy?: ScheduledMCPReadOnlyPolicy,
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical({ selections, policy: policy ?? null })))
    .digest('hex');
}

export function isScheduledMCPToolReadOnly(
  tool: Tool,
  policy?: ScheduledMCPReadOnlyPolicy,
): boolean {
  const pin = policy?.tools[tool.name];
  return (
    pin?.effect === 'read_only' &&
    pin.definitionSha256 === getScheduledMCPToolDefinitionDigest(tool)
  );
}

/** Expected denial. Only the approved projection can reach a client or persisted run. */
export class ScheduledMCPPolicyError extends Error {
  readonly failure: ScheduledMCPFailure;
  readonly outcomes: ScheduleMCPOutcome[];
  readonly code: ScheduledMCPFailure['status'];
  readonly statusCode: number;
  readonly retryable = false;

  constructor(reason: ScheduledMCPFailureReason, server: string, agentId?: string) {
    const failure = failureFixtures[reason];
    const outcomes = [{ server, ...(agentId ? { agentId } : {}), ...failure }];
    super(`${failure.status}: ${JSON.stringify(outcomes)}`);
    this.name = 'ScheduledMCPPolicyError';
    this.failure = failure;
    this.outcomes = outcomes;
    this.code = failure.status;
    this.statusCode = failure.status === 'mcp_unavailable' ? 503 : 403;
  }
}
