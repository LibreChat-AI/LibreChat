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

  const knownNames = [...boundaryNames];
  const stampPart = (part: PersistedMcpContentPart): void => {
    const toolCall = part?.tool_call;
    if (!toolCall || typeof toolCall.name !== 'string') {
      return;
    }

    let serverName = toolCall.mcpServerName ?? serverByToolName.get(toolCall.name);
    if (serverName == null && toolCall.name.includes(Constants.mcp_delimiter)) {
      const [toolName, parsedServerName] = splitMCPToolKey(toolCall.name, knownNames);
      if (toolName && parsedServerName) {
        serverName = parsedServerName;
      }
    }
    if (typeof serverName === 'string') {
      toolCall.mcpServerName = normalizeServerName(serverName);
    }
    toolCall.subagent_content?.forEach(stampPart);
  };

  contentParts.forEach(stampPart);
}
