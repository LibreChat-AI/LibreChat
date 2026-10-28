import type { TMCPAppsPolicy } from 'librechat-data-provider';

export type MCPClientCapabilityProfile = 'standard' | 'apps';

export const STANDARD_MCP_CAPABILITY_PROFILE: MCPClientCapabilityProfile = 'standard';
export const MCP_APPS_CAPABILITY_PROFILE: MCPClientCapabilityProfile = 'apps';

/** Resolves the immutable capabilities negotiated by one MCP client session. */
export function resolveMCPClientCapabilityProfile(
  mcpApps?: Pick<TMCPAppsPolicy, 'enabled'>,
): MCPClientCapabilityProfile {
  return mcpApps?.enabled === true ? MCP_APPS_CAPABILITY_PROFILE : STANDARD_MCP_CAPABILITY_PROFILE;
}

/** Keeps internal pool keys distinct without changing the server's logical identity. */
export function getMCPConnectionPoolKey(
  serverName: string,
  capabilityProfile: MCPClientCapabilityProfile,
): string {
  return JSON.stringify([serverName, capabilityProfile]);
}

/** Decodes the private, profile-aware connection-pool identity. */
export function parseMCPConnectionPoolKey(poolKey: string): {
  serverName: string;
  capabilityProfile: MCPClientCapabilityProfile;
} {
  const parsed = JSON.parse(poolKey) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    (parsed[1] !== STANDARD_MCP_CAPABILITY_PROFILE && parsed[1] !== MCP_APPS_CAPABILITY_PROFILE)
  ) {
    throw new Error('Invalid MCP connection pool key');
  }
  return { serverName: parsed[0], capabilityProfile: parsed[1] };
}

/** Keeps per-user work distinct by logical server and immutable capability profile. */
export function getMCPUserConnectionPoolKey(
  userId: string,
  serverName: string,
  capabilityProfile: MCPClientCapabilityProfile,
): string {
  return JSON.stringify([userId, serverName, capabilityProfile]);
}
