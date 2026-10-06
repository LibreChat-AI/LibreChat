import { logger } from '@librechat/data-schemas';
import { Constants, buildServerNameAliases } from 'librechat-data-provider';
import type { PluginAuthMethods } from '@librechat/data-schemas';
import type { GenericTool } from '@librechat/agents';
import { getPluginAuthMap } from '~/agents/auth';
import { splitMCPToolKey } from './utils';

/** Reads one server's customUserVars from a `getUserMCPAuthMap` result */
export function getServerCustomUserVars(
  userMCPAuthMap: Record<string, Record<string, string>> | undefined,
  serverName: string,
): Record<string, string> | undefined {
  return userMCPAuthMap?.[`${Constants.mcp_prefix}${serverName}`];
}

export async function getUserMCPAuthMap({
  userId,
  tools,
  servers,
  toolInstances,
  serverNames,
  findPluginAuthsByKeys,
  throwOnError = false,
}: {
  userId: string;
  tools?: (string | undefined)[];
  servers?: (string | undefined)[];
  toolInstances?: (GenericTool | null)[];
  /**
   * Configured server names in their RAW config form. Tool keys embed the
   * normalized form, so the boundary is resolved against both spellings and
   * the auth-map key is always built from the raw name — the form plugin-auth
   * rows are stored under and every reader passes.
   */
  serverNames?: readonly string[];
  findPluginAuthsByKeys: PluginAuthMethods['findPluginAuthsByKeys'];
  /**
   * Propagate lookup/decryption failures instead of degrading to an empty map. Callers that must
   * distinguish "this user has no vars" from "we could not read them" (and fail closed rather than
   * proceed with unresolved credentials) opt in; every other caller keeps the swallowing default.
   */
  throwOnError?: boolean;
}): Promise<Record<string, Record<string, string>>> {
  let allMcpCustomUserVars: Record<string, Record<string, string>> = {};
  let mcpPluginKeysToFetch: string[] = [];
  try {
    const uniqueMcpServers = new Set<string>();

    if (servers != null && servers.length) {
      for (const serverName of servers) {
        if (!serverName) {
          continue;
        }
        uniqueMcpServers.add(`${Constants.mcp_prefix}${serverName}`);
      }
    } else if (tools != null && tools.length) {
      const aliases = buildServerNameAliases(serverNames ?? []);
      /** Keys may carry either spelling (normalized going forward, raw in
       *  legacy agent documents), so both forms resolve the boundary. */
      const candidates = [...(serverNames ?? []), ...aliases.keys()];
      for (const toolName of tools) {
        if (!toolName) {
          continue;
        }
        const [, mcpServer] = splitMCPToolKey(toolName, candidates);
        if (!mcpServer) continue;
        uniqueMcpServers.add(`${Constants.mcp_prefix}${mcpServer}`);
        /** A normalized match could equally belong to a user-DB server named
         *  exactly like it, so fetch auth under BOTH spellings — consumers
         *  read by their own server name and pick theirs. */
        const aliasedRaw = aliases.get(mcpServer);
        if (aliasedRaw != null && aliasedRaw !== mcpServer) {
          uniqueMcpServers.add(`${Constants.mcp_prefix}${aliasedRaw}`);
        }
      }
    } else if (toolInstances != null && toolInstances.length) {
      for (const tool of toolInstances) {
        if (!tool) {
          continue;
        }
        const mcpTool = tool as GenericTool & { mcpRawServerName?: string };
        if (mcpTool.mcpRawServerName) {
          uniqueMcpServers.add(`${Constants.mcp_prefix}${mcpTool.mcpRawServerName}`);
        }
      }
    }

    if (uniqueMcpServers.size === 0) {
      return {};
    }

    mcpPluginKeysToFetch = Array.from(uniqueMcpServers);
    allMcpCustomUserVars = await getPluginAuthMap({
      userId,
      pluginKeys: mcpPluginKeysToFetch,
      throwError: throwOnError,
      findPluginAuthsByKeys,
    });
  } catch (err) {
    logger.error(
      `[handleTools] Error batch fetching customUserVars for MCP tools (keys: ${mcpPluginKeysToFetch.join(
        ', ',
      )}), user ${userId}: ${err instanceof Error ? err.message : 'Unknown error'}`,
      err,
    );
    if (throwOnError) {
      throw err;
    }
  }

  return allMcpCustomUserVars;
}
