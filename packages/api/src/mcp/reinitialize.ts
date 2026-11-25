import type { MCPReinitializeFailureReason } from 'librechat-data-provider';
import type { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import type { ParsedServerConfig } from '~/mcp/types';

/** Result that ends a reinitialization before it connects. */
export interface MCPReinitializeStopResult {
  availableTools: null;
  success: false;
  message: string;
  failureReason: MCPReinitializeFailureReason;
  oauthRequired: false;
  serverName: string;
  oauthUrl: null;
  tools: null;
}

/** The config a reinitialization connects with, or the result that ends it first. */
export type MCPReinitializeConfigResolution =
  | { serverConfig: ParsedServerConfig | undefined; result?: undefined }
  | { serverConfig?: undefined; result: MCPReinitializeStopResult };

/**
 * Resolves the server config a reinitialization connects with. A config that failed inspection
 * is recovered through the registry, so a caller holding the stub connects with what inspection
 * stored, including a recovery another request made. While the server stays unreachable, the
 * reinitialization stops with an `unreachable` result.
 */
export async function resolveMCPReinitializeConfig(
  registry: Pick<MCPServersRegistry, 'recoverServerConfig'>,
  serverName: string,
  serverConfig: ParsedServerConfig | undefined,
  userId?: string,
): Promise<MCPReinitializeConfigResolution> {
  if (!serverConfig?.inspectionFailed) {
    return { serverConfig };
  }
  const recovered = await registry.recoverServerConfig(serverName, serverConfig, userId);
  if (recovered) {
    return { serverConfig: recovered };
  }
  return {
    result: {
      availableTools: null,
      success: false,
      message: `MCP server '${serverName}' is still unreachable`,
      failureReason: 'unreachable',
      oauthRequired: false,
      serverName,
      oauthUrl: null,
      tools: null,
    },
  };
}
