import type { MCPLookupUser, ParsedServerConfig } from '~/mcp/types';
import { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import { isUserSourced, resolveServerInstructions, sortNames } from '~/mcp/utils';

/**
 * The instructions of the named MCP servers, in server-name order. Servers without
 * instructions, and the librechat.yaml servers hidden from `user`, are left out.
 */
export async function getMCPServerInstructions(
  serverNames: readonly string[],
  configServers?: Record<string, ParsedServerConfig>,
  user?: MCPLookupUser | null,
): Promise<Record<string, string>> {
  const registry = MCPServersRegistry.getInstance();
  const [configs, hidden] = await Promise.all([
    registry.getAllServerConfigs(undefined, configServers),
    registry.getUserHiddenServerNames(user ?? undefined),
  ]);
  const instructions: Record<string, string> = {};
  for (const name of sortNames(serverNames)) {
    const config = configs[name];
    if (config == null || (hidden.has(name) && !isUserSourced(config))) {
      continue;
    }
    const resolved = resolveServerInstructions(config);
    if (resolved != null) {
      instructions[name] = resolved;
    }
  }
  return instructions;
}
