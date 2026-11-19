import { createHash } from 'node:crypto';
import { Constants as AgentConstants } from '@librechat/agents';
import { Constants, isActionTool, normalizeServerName } from 'librechat-data-provider';
import type {
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

/**
 * A tool an agent carries that is neither an MCP tool nor one of the SDK's own controls:
 * code execution, web search, file search, an action. Each is its own item for the owner to
 * allow or leave out.
 */
export function isScheduledToolItem(name: string): boolean {
  return !name.includes(Constants.mcp_delimiter) && !isScheduledMCPCandidate(name);
}

/**
 * Every key a tool on a server could be listed under among an agent's other tools: by either
 * spelling of the server, by name or as part of a selection of the whole server. The tools of
 * a server the operator declared nothing for are listed that way. Built from the server's
 * own name, never by splitting a key: a server name may contain the delimiter.
 */
export function listedMCPKeys(serverName: string, selectionName: string): string[] {
  return [serverName, normalizeServerName(serverName)].flatMap((spelling) => [
    `${selectionName}${Constants.mcp_delimiter}${spelling}`,
    `${Constants.mcp_all}${Constants.mcp_delimiter}${spelling}`,
  ]);
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

/** Covers the whole upstream definition: name, description, schemas and annotations. */
export function getScheduledMCPToolDefinitionDigest(tool: Tool): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(tool)))
    .digest('hex');
}

/** Identifies one set of permitted selections; a grant and its bearer cache entries bind to it. */
export function getScheduledMCPPolicyRevision(
  selections: readonly ScheduledMCPToolSelection[],
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical({ selections })))
    .digest('hex');
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
