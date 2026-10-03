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
 * Records the author's `additional_instructions` before anything runtime-scoped
 * joins that field, because the prompt cache identity follows the configured
 * half and nothing downstream can separate the two again.
 *
 * Idempotent on purpose, and called from both places that write to the field:
 * `initializeAgent` moves temporally resolved instructions into it (a value
 * that changes every day and must stay out of the identity), and
 * `applyContextToAgent` appends this run's memory, file and MCP context. The
 * first caller wins, so whichever runs first records the configured text.
 */
export function captureConfiguredAdditionalInstructions(agent: {
  additional_instructions?: string | null;
  configuredAdditionalInstructions?: string;
}): void {
  if ('configuredAdditionalInstructions' in agent) {
    return;
  }
  agent.configuredAdditionalInstructions = agent.additional_instructions || undefined;
}

/**
 * Appends to an agent's dynamic instruction tail, recording the contribution
 * as part of the prompt cache identity unless it is explicitly request-scoped.
 *
 * Stable by default on purpose. The identity has to cover every
 * configuration-derived addition to this field — the artifact prompt, the
 * skill catalog, the memory-tool guard — and the recurring defect was an
 * addition that nobody remembered to record, which silently reused a key for
 * a different system prefix. Forgetting the flag now over-partitions (a cache
 * miss) instead, and only three writers pass `stable: false`: the temporally
 * resolved instruction block, this run's context, and the per-run dynamic tool
 * instructions.
 */
/**
 * Prepends to an agent's dynamic instruction tail, ahead of everything already
 * there, without recording the text as part of the identity.
 *
 * The direction is the point. The tail is sent after the instructions field,
 * so a block moved out of that field and appended lands behind the repository
 * instructions, the memory guard and the author's own tail, reversing an order
 * the agent was saved with. One caller: instructions carrying temporal
 * variables, whose resolved text leaves the cached prefix but must keep its
 * place in what the model reads.
 *
 * `configured` is the identity's form of the same block, written to the same
 * end of the recorded text. One writer owns both halves on purpose: the digest
 * is a join of this field, so text placed first on the wire and recorded last
 * makes two different prefixes read as one identity. They cannot drift while
 * the same call places both.
 */
export function prependAgentInstructionTail(
  agent: {
    additional_instructions?: string | null;
    configuredAdditionalInstructions?: string;
  },
  text?: string | null,
  options: { configured?: string | null } = {},
): void {
  if (text == null || text === '') {
    return;
  }
  captureConfiguredAdditionalInstructions(agent);
  agent.additional_instructions = [text, agent.additional_instructions ?? '']
    .filter(Boolean)
    .join('\n\n');
  const configured = options.configured;
  if (configured == null || configured === '') {
    return;
  }
  agent.configuredAdditionalInstructions = [configured, agent.configuredAdditionalInstructions]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n\n');
}

export function appendAgentInstructionTail(
  agent: {
    additional_instructions?: string | null;
    configuredAdditionalInstructions?: string;
  },
  text?: string | null,
  options: { stable?: boolean } = {},
): void {
  if (text == null || text === '') {
    return;
  }
  agent.additional_instructions = [agent.additional_instructions ?? '', text]
    .filter(Boolean)
    .join('\n\n');
  if (options.stable === false) {
    return;
  }
  agent.configuredAdditionalInstructions = [agent.configuredAdditionalInstructions, text]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n\n');
}

/**
 * Applies run context and MCP instructions to an agent's configuration.
 * Mutates the agent object in place.
 *
 * @param {Object} params
 * @param {Agent} params.agent - The agent to update
 * @param {string} params.sharedRunContext - Run-level shared context
 * @param {MCPManager} params.mcpManager - MCP manager instance
 * @param {Object} [params.ephemeralAgent] - Ephemeral agent config (for MCP override)
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
  captureConfiguredAdditionalInstructions(agent);

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
