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

/**
 * The librechat.yaml MCP servers hidden from `user`. Hiding is an access boundary, so a failed
 * read propagates; only a process without an MCP registry has nothing to hide.
 */
export async function getHiddenMCPServerNames(
  user?: MCPLookupUser | null,
): Promise<ReadonlySet<string>> {
  let registry: MCPServersRegistry;
  try {
    registry = MCPServersRegistry.getInstance();
  } catch {
    return new Set();
  }
  return registry.getUserHiddenServerNames(user ?? undefined);
}
