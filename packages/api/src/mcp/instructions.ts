import type { ParsedServerConfig } from '~/mcp/types';
import { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import { resolveServerInstructions, sortNames } from '~/mcp/utils';

/**
 * The instructions of the named MCP servers, in server-name order. Servers without
 * instructions are left out.
 */
export async function getMCPServerInstructions(
  serverNames: readonly string[],
  configServers?: Record<string, ParsedServerConfig>,
): Promise<Record<string, string>> {
  const configs = await MCPServersRegistry.getInstance().getAllServerConfigs(
    undefined,
    configServers,
  );
  const instructions: Record<string, string> = {};
  for (const name of sortNames(serverNames)) {
    const resolved = configs[name] != null ? resolveServerInstructions(configs[name]) : undefined;
    if (resolved != null) {
      instructions[name] = resolved;
    }
  }
  return instructions;
}
