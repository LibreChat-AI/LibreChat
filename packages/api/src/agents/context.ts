import { Constants } from 'librechat-data-provider';
import { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { Agent, TEphemeralAgent } from 'librechat-data-provider';
import type { LCTool } from '@librechat/agents';
import type { Logger } from 'winston';
import type { ParsedServerConfig } from '~/mcp/types';
import type { MCPManager } from '~/mcp/MCPManager';

/**
 * Agent type with optional tools array that can contain DynamicStructuredTool or string.
 * For context operations, we only require id and instructions, other Agent fields are optional.
 */
export type AgentWithTools = Pick<Agent, 'id'> &
  Partial<Omit<Agent, 'id' | 'tools'>> & {
    tools?: Array<DynamicStructuredTool | string>;
    /** Serializable tool definitions for event-driven mode */
    toolDefinitions?: LCTool[];
  };

/**
 * Extracts unique MCP server names from an agent's tools or tool definitions.
 * Supports both full tool instances (tools) and serializable definitions (toolDefinitions).
 * @param agent - The agent with tools and/or tool definitions
 * @returns Array of unique MCP server names
 */
export function extractMCPServers(agent: AgentWithTools): string[] {
  const mcpServers = new Set<string>();

  /** Check tool instances (non-event-driven mode) */
  if (agent?.tools?.length) {
    for (const tool of agent.tools) {
      if (tool instanceof DynamicStructuredTool && tool.name.includes(Constants.mcp_delimiter)) {
        const carried = (tool as { mcpRawServerName?: string }).mcpRawServerName;
        const serverName = carried ?? tool.name.split(Constants.mcp_delimiter).pop();
        if (serverName) {
          mcpServers.add(serverName);
        }
      }
    }
  }

  /** Check tool definitions (event-driven mode) */
  if (agent?.toolDefinitions?.length) {
    for (const toolDef of agent.toolDefinitions) {
      if (toolDef.name?.includes(Constants.mcp_delimiter)) {
        const serverName = toolDef.serverName ?? toolDef.name.split(Constants.mcp_delimiter).pop();
        if (serverName) {
          mcpServers.add(serverName);
        }
      }
    }
  }

  return Array.from(mcpServers);
}

/**
 * Resolves which MCP servers should receive injected instruction blocks.
 *
 * Loaded tool instances and definitions are the source of truth, so
 * instructions track servers that actually contributed tools. Selecting only
 * some tools from a server still retains that server. A server with zero
 * loaded tools is not injected merely because it appears on the request-level
 * `ephemeralAgent.mcp` list.
 *
 * When `extractMCPServers` is empty, the request list is used as a fallback
 * for callers that apply context before tool instances or definitions are
 * attached. Once any MCP tools exist, the loaded set always wins — including
 * the reverse mismatch where a loaded server is omitted from the request list.
 */
export function resolveInstructionMCPServers(
  agent: AgentWithTools,
  ephemeralAgent?: TEphemeralAgent,
): string[] {
  const loadedServers = extractMCPServers(agent);
  if (loadedServers.length > 0) {
    return loadedServers;
  }

  return ephemeralAgent?.mcp ?? [];
}

/**
 * Fetches MCP instructions for the given server names.
 * @param {string[]} mcpServers - Array of MCP server names
 * @param {MCPManager} mcpManager - MCP manager instance
 * @param {Logger} [logger] - Optional logger instance
 * @returns {Promise<string>} MCP instructions string, empty if none
 */
export async function getMCPInstructionsForServers(
  mcpServers: string[],
  mcpManager: MCPManager,
  logger?: Logger,
  configServers?: Record<string, ParsedServerConfig>,
): Promise<string> {
  if (!mcpServers.length) {
    return '';
  }
  try {
    const mcpInstructions = await mcpManager.formatInstructionsForContext(
      mcpServers,
      configServers,
    );
    if (mcpInstructions && logger) {
      logger.debug('[AgentContext] Fetched MCP instructions', {
        serverCount: mcpServers.length,
      });
    }
    return mcpInstructions || '';
  } catch {
    if (logger) {
      logger.error('[AgentContext] Failed to get MCP instructions');
    }
    return '';
  }
}

/**
 * Builds stable instructions for an agent by combining agent-specific context and MCP context.
 * Order: baseInstructions -> mcpInstructions
 *
 * @param {Object} params
 * @param {string} [params.baseInstructions] - Agent's base instructions
 * @param {string} [params.mcpInstructions] - Agent's MCP server instructions
 * @returns {string | undefined} Combined instructions, or undefined if empty
 */
export function buildAgentInstructions({
  baseInstructions,
  mcpInstructions,
}: {
  baseInstructions?: string;
  mcpInstructions?: string;
}): string | undefined {
  const parts = [baseInstructions, mcpInstructions].filter(Boolean);
  const combined = parts.join('\n\n').trim();
  return combined || undefined;
}

/**
 * Builds dynamic system-tail instructions for an agent.
 * Order: existing additional instructions -> shared run context.
 */
export function buildAgentAdditionalInstructions({
  additionalInstructions,
  sharedRunContext,
}: {
  additionalInstructions?: string;
  sharedRunContext?: string;
}): string | undefined {
  const parts = [additionalInstructions, sharedRunContext].filter(Boolean);
  const combined = parts.join('\n\n').trim();
  return combined || undefined;
}

/**
 * Applies run context and MCP instructions to an agent's configuration.
 * Mutates the agent object in place.
 *
 * @param {Object} params
 * @param {Agent} params.agent - The agent to update
 * @param {string} params.sharedRunContext - Run-level shared context
 * @param {MCPManager} params.mcpManager - MCP manager instance
 * @param {Object} [params.ephemeralAgent] - Ephemeral agent config; MCP list is a fallback when no tools have loaded yet
 * @param {string} [params.agentId] - Agent ID for logging
 * @param {Logger} [params.logger] - Optional logger instance
 * @returns {Promise<void>}
 */
export async function applyContextToAgent({
  agent,
  sharedRunContext,
  mcpManager,
  ephemeralAgent,
  agentId,
  logger,
  configServers,
}: {
  agent: AgentWithTools;
  sharedRunContext: string;
  mcpManager: MCPManager;
  ephemeralAgent?: TEphemeralAgent;
  agentId?: string;
  logger?: Logger;
  configServers?: Record<string, ParsedServerConfig>;
}): Promise<void> {
  const baseInstructions = agent.instructions || '';
  const additionalInstructions = agent.additional_instructions || '';

  try {
    const mcpServers = resolveInstructionMCPServers(agent, ephemeralAgent);
    const mcpInstructions = await getMCPInstructionsForServers(
      mcpServers,
      mcpManager,
      logger,
      configServers,
    );

    agent.instructions = buildAgentInstructions({
      baseInstructions,
      mcpInstructions,
    });
    agent.additional_instructions = buildAgentAdditionalInstructions({
      additionalInstructions,
      sharedRunContext,
    });

    if (agentId && logger) {
      logger.debug('[AgentContext] Applied context to agent');
    }
  } catch {
    agent.instructions = buildAgentInstructions({
      baseInstructions,
      mcpInstructions: '',
    });
    agent.additional_instructions = buildAgentAdditionalInstructions({
      additionalInstructions,
      sharedRunContext,
    });

    if (logger) {
      logger.error('[AgentContext] Failed to apply context; using base instructions only');
    }
  }
}
