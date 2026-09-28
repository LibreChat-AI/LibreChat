import {
  Tools,
  EModelEndpoint,
  AgentCapabilities,
  splitMCPToolKey,
  normalizeServerName,
  isEphemeralAgentId,
  normalizeEndpointName,
  parseEphemeralAgentId,
} from 'librechat-data-provider';
import type { Agent, TProgrammaticToolsConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';

/** Endpoint policy replaces the global policy as a whole, including its allowlist. */
export function resolveEndpointProgrammaticTools(
  appConfig: Pick<AppConfig, 'endpoints'> | undefined,
  endpoint: string,
): TProgrammaticToolsConfig | undefined {
  const endpoints = appConfig?.endpoints;
  if (!endpoints) {
    return undefined;
  }
  if (
    endpoint === EModelEndpoint.openAI ||
    endpoint === EModelEndpoint.anthropic ||
    endpoint === EModelEndpoint.bedrock
  ) {
    return endpoints[endpoint]?.programmaticTools ?? endpoints.all?.programmaticTools;
  }
  const custom = endpoints.custom?.find(
    (config) => normalizeEndpointName(config.name) === normalizeEndpointName(endpoint),
  );
  return custom ? (custom.programmaticTools ?? endpoints.all?.programmaticTools) : undefined;
}

/** Uses the executing descriptor's identity, including for parallel endpoint chats. */
export function resolveAgentProgrammaticTools(
  appConfig: Pick<AppConfig, 'endpoints'> | undefined,
  agentId: string | undefined,
): TProgrammaticToolsConfig | undefined {
  if (!agentId || !isEphemeralAgentId(agentId)) {
    return undefined;
  }
  const parsed = parseEphemeralAgentId(agentId);
  return parsed ? resolveEndpointProgrammaticTools(appConfig, parsed.endpoint) : undefined;
}

export function resolveAgentProgrammaticToolServers(
  appConfig: Pick<AppConfig, 'endpoints'> | undefined,
  agentId: string | undefined,
): string[] | undefined {
  const policy = resolveAgentProgrammaticTools(appConfig, agentId);
  if (!policy) {
    return undefined;
  }
  return policy.enabled ? [...policy.mcpServers] : [];
}

/** Endpoint-equipped MCP servers and code must be selected independently by parallel chats. */
export function getInheritedEndpointTools(
  appConfig: Pick<AppConfig, 'endpoints' | 'mcpConfig'> | undefined,
  primaryAgent: Pick<Agent, 'id' | 'tools'>,
): string[] {
  const policy = resolveAgentProgrammaticTools(appConfig, primaryAgent.id);
  if (!policy?.enabled || policy.mcpServers.length === 0) {
    return [...(primaryAgent.tools ?? [])];
  }
  const excludedServers = new Set(
    policy.mcpServers.flatMap((name) => [name, normalizeServerName(name)]),
  );
  const serverNames = [...Object.keys(appConfig?.mcpConfig ?? {}), ...policy.mcpServers];
  return (primaryAgent.tools ?? []).filter((name) => {
    const [, server] = splitMCPToolKey(name, serverNames);
    return name !== Tools.execute_code && (server == null || !excludedServers.has(server));
  });
}

/** PTC opt-in never grants code execution or ordinary tool permissions. */
export function applyEndpointProgrammaticCapabilities(
  appConfig: Pick<AppConfig, 'endpoints'> | undefined,
  agentId: string | undefined,
  capabilities: ReadonlySet<string>,
): Set<string> {
  const policy = resolveAgentProgrammaticTools(appConfig, agentId);
  if (!policy) {
    return new Set(capabilities);
  }
  const remaining = [...capabilities].filter(
    (value) => value !== AgentCapabilities.programmatic_tools,
  );
  return new Set(
    policy.enabled && capabilities.has(AgentCapabilities.tools)
      ? [...remaining, AgentCapabilities.programmatic_tools]
      : remaining,
  );
}
