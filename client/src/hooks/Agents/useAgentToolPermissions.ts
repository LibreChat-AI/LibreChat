import { useMemo } from 'react';
import { Tools, EToolResources } from 'librechat-data-provider';
import type { Agent, TEphemeralAgent } from 'librechat-data-provider';
import { useGetAgentByIdQuery } from '~/data-provider';
import { useAgentsMapContext } from '~/Providers';
import { isEphemeralAgent } from '~/common';

interface AgentToolPermissionsResult {
  fileSearchAllowedByAgent: boolean;
  codeAllowedByAgent: boolean;
  statefulCodeSessionsAllowedByAgent: boolean;
  tools: string[] | undefined;
  provider?: string;
  codeEnvironmentId?: string | null;
  agent?: Agent;
}

/**
 * Hook to determine whether specific tools are allowed for a given agent.
 *
 * @param agentId - The ID of the agent. If null/undefined/empty, checks ephemeralAgent settings
 * @param ephemeralAgent - Optional ephemeral agent settings for tool permissions
 * @returns Object with boolean flags for file_search and execute_code permissions, plus the tools array
 */
export default function useAgentToolPermissions(
  agentId: string | null | undefined,
  ephemeralAgent?: TEphemeralAgent | null,
): AgentToolPermissionsResult {
  const agentsMap = useAgentsMapContext();

  const selectedAgent = useMemo(() => {
    return agentId != null && agentId !== '' ? agentsMap?.[agentId] : undefined;
  }, [agentId, agentsMap]);

  const { data: agentData } = useGetAgentByIdQuery(agentId);

  const tools = useMemo(
    () =>
      (agentData?.tools as string[] | undefined) || (selectedAgent?.tools as string[] | undefined),
    [agentData?.tools, selectedAgent?.tools],
  );

  const provider = useMemo(
    () => agentData?.provider || selectedAgent?.provider,
    [agentData?.provider, selectedAgent?.provider],
  );

  const codeEnvironmentId = useMemo(
    () => agentData?.code_environment_id ?? selectedAgent?.code_environment_id,
    [agentData?.code_environment_id, selectedAgent?.code_environment_id],
  );

  const statefulCodeSessionsAllowedByAgent = useMemo(
    () => agentData?.stateful_code_sessions ?? selectedAgent?.stateful_code_sessions ?? false,
    [agentData?.stateful_code_sessions, selectedAgent?.stateful_code_sessions],
  );

  const fileSearchAllowedByAgent = useMemo(() => {
    // Check ephemeral agent settings
    if (isEphemeralAgent(agentId)) {
      return ephemeralAgent?.[EToolResources.file_search] ?? false;
    }
    // If agentId exists but agent not found, disallow
    if (!selectedAgent) return false;
    // Check if the agent has the file_search tool
    return tools?.includes(Tools.file_search) ?? false;
  }, [agentId, selectedAgent, tools, ephemeralAgent]);

  const codeAllowedByAgent = useMemo(() => {
    // Check ephemeral agent settings
    if (isEphemeralAgent(agentId)) {
      return ephemeralAgent?.[EToolResources.execute_code] ?? false;
    }
    // If agentId exists but agent not found, disallow
    if (!selectedAgent) return false;
    // Check if the agent has the execute_code tool
    return tools?.includes(Tools.execute_code) ?? false;
  }, [agentId, selectedAgent, tools, ephemeralAgent]);

  const agent = useMemo(() => {
    if (selectedAgent == null) return agentData;
    if (agentData == null) return selectedAgent;
    return { ...selectedAgent, ...agentData };
  }, [agentData, selectedAgent]);

  return {
    fileSearchAllowedByAgent,
    codeAllowedByAgent,
    statefulCodeSessionsAllowedByAgent,
    codeEnvironmentId,
    agent,
    provider,
    tools,
  };
}
