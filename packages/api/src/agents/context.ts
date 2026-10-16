import { Constants } from 'librechat-data-provider';
import { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { Agent, TEphemeralAgent } from 'librechat-data-provider';
import type { LCTool } from '@librechat/agents';
import type { Logger } from 'winston';
import type { ParsedServerConfig } from '~/mcp/types';
import type { MCPManager } from '~/mcp/MCPManager';
import { ContextPartKeys, contributeContext } from './systemParts';

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

/** Request-scoped context for the system tail, from `AgentClient.buildMessages`. */
export interface RunContext {
  /** Context retrieved for the current message (RAG). */
  rag?: string;
  /** Formatted memory the agent may see. */
  memory?: string;
  /** Extracted text of the agent's own context files. */
  agentFiles?: string;
}

/**
 * Applies run context and MCP instructions to an agent's configuration.
 * Mutates the agent object in place.
 *
 * @param {Object} params
 * @param {Agent} params.agent - The agent to update
 * @param {RunContext} [params.runContext] - Request-scoped context for the system tail
 * @param {MCPManager} params.mcpManager - MCP manager instance
 * @param {Object} [params.ephemeralAgent] - Ephemeral agent config (for MCP override)
 * @param {string} [params.agentId] - Agent ID for logging
 * @param {Logger} [params.logger] - Optional logger instance
 * @returns {Promise<void>}
 */
export async function applyContextToAgent({
  agent,
  runContext = {},
  mcpManager,
  ephemeralAgent,
  agentId,
  logger,
  configServers,
}: {
  agent: AgentWithTools;
  runContext?: RunContext;
  mcpManager: MCPManager;
  ephemeralAgent?: TEphemeralAgent;
  agentId?: string;
  logger?: Logger;
  configServers?: Record<string, ParsedServerConfig>;
}): Promise<void> {
  const baseInstructions = agent.instructions || '';
  contributeContext(agent, ContextPartKeys.rag, runContext.rag);
  contributeContext(agent, ContextPartKeys.memory, runContext.memory);
  contributeContext(agent, ContextPartKeys.agentFiles, runContext.agentFiles);

  try {
    const mcpServers = ephemeralAgent?.mcp?.length ? ephemeralAgent.mcp : extractMCPServers(agent);
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

    if (agentId && logger) {
      logger.debug('[AgentContext] Applied context to agent');
    }
  } catch {
    agent.instructions = buildAgentInstructions({
      baseInstructions,
      mcpInstructions: '',
    });

    if (logger) {
      logger.error('[AgentContext] Failed to apply context; using base instructions only');
    }
  }
}
