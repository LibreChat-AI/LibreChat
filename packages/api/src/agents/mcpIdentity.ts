import { Constants, normalizeServerName, splitMCPToolKey } from 'librechat-data-provider';
import type { ReachableAgent } from './traversal';
import { collectReachableAgents } from './traversal';

interface McpToolDefinitionLike {
  name?: string;
  serverName?: string;
}

interface McpRegisteredToolLike {
  mcpRawServerName?: string;
}

export interface McpIdentityAgent extends ReachableAgent<McpIdentityAgent> {
  accessibleMcpServerNames?: readonly string[];
  historicalMcpServerNames?: readonly string[];
  toolDefinitions?: readonly McpToolDefinitionLike[];
  toolRegistry?: Iterable<readonly [string, McpRegisteredToolLike]>;
}

export interface PersistedMcpToolCall {
  name?: string;
  mcpServerName?: string;
  subagent_content?: PersistedMcpContentPart[];
}

export interface PersistedMcpContentPart {
  tool_call?: PersistedMcpToolCall;
}

export interface StampMcpServerIdentitiesParams {
  contentParts?: PersistedMcpContentPart[];
  roots: readonly (McpIdentityAgent | null | undefined)[];
}

export interface StampMcpServerIdentitiesOnMessagesParams {
  messages?: Iterable<unknown> | null;
  roots: readonly (McpIdentityAgent | null | undefined)[];
}

export interface McpServerNameResolveContext {
  toolRegistry?: {
    get?: (toolName: string) => McpRegisteredToolLike | undefined;
  };
  mcpAvailableTools?: Record<string, Record<string, { function?: unknown } | undefined>>;
}

interface ResolvableToolCall {
  name?: string;
  mcpServerName?: string;
  function?: { name?: string };
  subagent_content?: PersistedMcpContentPart[];
}

function buildMcpIdentityMaps(roots: readonly (McpIdentityAgent | null | undefined)[]): {
  serverByToolName: Map<string, string>;
  knownNames: string[];
} {
  const serverByToolName = new Map<string, string>();
  const boundaryNames = new Set<string>();
  for (const agent of collectReachableAgents(roots)) {
    for (const rawName of [
      ...(agent.accessibleMcpServerNames ?? []),
      ...(agent.historicalMcpServerNames ?? []),
    ]) {
      boundaryNames.add(rawName);
      boundaryNames.add(normalizeServerName(rawName));
    }
    for (const definition of agent.toolDefinitions ?? []) {
      if (typeof definition.name === 'string' && typeof definition.serverName === 'string') {
        serverByToolName.set(definition.name, definition.serverName);
      }
    }
    for (const [name, tool] of agent.toolRegistry ?? []) {
      if (typeof tool?.mcpRawServerName === 'string') {
        serverByToolName.set(name, tool.mcpRawServerName);
      }
    }
  }
  return { serverByToolName, knownNames: [...boundaryNames] };
}

function resolveServerNameForToolCall(
  toolCall: ResolvableToolCall,
  serverByToolName: Map<string, string>,
  knownNames: string[],
): string | undefined {
  const name = toolCall.name ?? toolCall.function?.name;
  if (typeof name !== 'string') {
    return undefined;
  }
  if (toolCall.name == null) {
    toolCall.name = name;
  }

  let serverName = toolCall.mcpServerName ?? serverByToolName.get(name);
  if (serverName == null && name.includes(Constants.mcp_delimiter)) {
    const [toolName, parsedServerName] = splitMCPToolKey(name, knownNames);
    if (toolName && parsedServerName) {
      serverName = parsedServerName;
    }
  }
  return typeof serverName === 'string' ? normalizeServerName(serverName) : undefined;
}

function stampResolvableToolCall(
  toolCall: ResolvableToolCall,
  serverByToolName: Map<string, string>,
  knownNames: string[],
  stampPart: (part: PersistedMcpContentPart) => void,
): void {
  const serverName = resolveServerNameForToolCall(toolCall, serverByToolName, knownNames);
  if (serverName != null) {
    toolCall.mcpServerName = serverName;
  }
  toolCall.subagent_content?.forEach(stampPart);
}

/**
 * Stamps durable MCP server identities onto persisted native tool calls.
 *
 * Exact execution metadata wins. Tool registries and definitions provide a
 * server-owned fallback, followed by boundary-aware parsing for legacy calls.
 */
export function stampMcpServerIdentities({
  contentParts,
  roots,
}: StampMcpServerIdentitiesParams): void {
  if (!Array.isArray(contentParts)) {
    return;
  }

  const { serverByToolName, knownNames } = buildMcpIdentityMaps(roots);
  const stampPart = (part: PersistedMcpContentPart): void => {
    const toolCall = part?.tool_call;
    if (!toolCall || typeof toolCall.name !== 'string') {
      return;
    }
    stampResolvableToolCall(toolCall, serverByToolName, knownNames, stampPart);
  };

  contentParts.forEach(stampPart);
}

/**
 * Stamps MCP identities onto message history used by OpenAI-compatible and
 * Responses runs — both LibreChat content-part tool calls and OpenAI-shaped
 * `tool_calls` arrays — so `buildRunToolSet` can keep the chat-path default
 * (reject ambiguous delimiter-bearing names without identity).
 */
export function stampMcpServerIdentitiesOnMessages({
  messages,
  roots,
}: StampMcpServerIdentitiesOnMessagesParams): void {
  const { serverByToolName, knownNames } = buildMcpIdentityMaps(roots);
  const stampPart = (part: PersistedMcpContentPart): void => {
    const toolCall = part?.tool_call;
    if (!toolCall) {
      return;
    }
    stampResolvableToolCall(toolCall, serverByToolName, knownNames, stampPart);
  };
  const stampCall = (value: unknown): void => {
    if (value == null || typeof value !== 'object') {
      return;
    }
    stampResolvableToolCall(value as ResolvableToolCall, serverByToolName, knownNames, stampPart);
  };

  for (const value of messages ?? []) {
    if (value == null || typeof value !== 'object') {
      continue;
    }
    const message = value as {
      content?: unknown;
      tool_calls?: unknown;
      additional_kwargs?: { tool_calls?: unknown };
    };
    if (Array.isArray(message.content)) {
      message.content.forEach((part) => stampPart(part as PersistedMcpContentPart));
    }
    if (Array.isArray(message.tool_calls)) {
      message.tool_calls.forEach(stampCall);
    }
    if (Array.isArray(message.additional_kwargs?.tool_calls)) {
      message.additional_kwargs.tool_calls.forEach(stampCall);
    }
  }
}

/**
 * Resolves an MCP server name from a per-agent tool context map — same lookup
 * the chat path uses in `initialize.js` / `callbacks.js`.
 */
export function createMcpServerNameResolver(
  agentToolContexts: Map<string, McpServerNameResolveContext | undefined>,
): (toolName: string, agentId?: string) => string | undefined {
  return (toolName, agentId) => {
    if (typeof toolName !== 'string' || typeof agentId !== 'string') {
      return undefined;
    }
    const context = agentToolContexts.get(agentId);
    const registered = context?.toolRegistry?.get?.(toolName);
    if (typeof registered?.mcpRawServerName === 'string') {
      return normalizeServerName(registered.mcpRawServerName);
    }
    for (const [serverName, tools] of Object.entries(context?.mcpAvailableTools ?? {})) {
      if (tools?.[toolName]?.function) {
        return normalizeServerName(serverName);
      }
    }
    return undefined;
  };
}

/**
 * Stamps `mcpServerName` onto live run-step / subagent tool calls using a
 * host-resolved name callback (parity with `getDefaultHandlers` in callbacks).
 */
export function stampLiveMcpToolCallIdentities(
  toolCalls: Iterable<ResolvableToolCall | null | undefined> | null | undefined,
  resolveMcpServerName: ((toolName: string, agentId?: string) => string | undefined) | null,
  agentId?: string,
): void {
  if (resolveMcpServerName == null || toolCalls == null) {
    return;
  }
  for (const toolCall of toolCalls) {
    if (toolCall == null) {
      continue;
    }
    const toolName = toolCall.name ?? toolCall.function?.name;
    if (toolCall.name == null && typeof toolName === 'string') {
      toolCall.name = toolName;
    }
    if (typeof toolName !== 'string') {
      continue;
    }
    const serverName = resolveMcpServerName(toolName, agentId);
    if (serverName) {
      toolCall.mcpServerName = serverName;
    }
  }
}
