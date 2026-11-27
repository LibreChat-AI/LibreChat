import { logger } from '@librechat/data-schemas';
import { normalizeServerName, buildServerNameAliases } from 'librechat-data-provider';
import type { MCPOptions } from 'librechat-data-provider';
import type { ParsedServerConfig } from '~/mcp/types';

export interface MCPServerContext {
  /** Config-source servers that needed lazy initialization. */
  configServers: Record<string, ParsedServerConfig>;
  /** Every configured server, in the normalized form tool keys are built from. */
  serverNames: string[];
  /** Every configured server under its raw config name — the form the
   *  registry, config maps, tool cache, and plugin-auth rows are keyed by.
   *  Consumers that parse a (normalized) server out of a tool key resolve
   *  back to these via `buildServerNameAliases`. */
  rawServerNames: string[];
}

export interface ResolveMCPServerContextParams {
  mcpConfig: Record<string, MCPOptions>;
  ensureConfigServers: (
    mcpConfig: Record<string, MCPOptions>,
  ) => Promise<Record<string, ParsedServerConfig>>;
}

/**
 * Resolves the MCP server context for one request from a single config snapshot.
 *
 * `ensureConfigServers` deliberately skips unmodified YAML servers, so its keys are
 * not the configured set. Tool-key boundary resolution needs every configured name,
 * normalized the way keys embed it, or a server absent from the lazy-init result
 * silently falls back to positional parsing.
 */
export async function resolveMCPServerContext({
  mcpConfig,
  ensureConfigServers,
}: ResolveMCPServerContextParams): Promise<MCPServerContext> {
  const rawServerNames = Object.keys(mcpConfig);
  warnOnNormalizedNameCollisions(rawServerNames);
  /**
   * The name lists derive from the config snapshot alone and must survive a
   * transient lazy-init failure: without them, normalized tool keys cannot
   * resolve back to raw config names and every MCP tool silently drops for
   * the request — a strictly worse degradation than missing overlay configs.
   */
  let configServers: Record<string, ParsedServerConfig> = {};
  try {
    configServers = await ensureConfigServers(mcpConfig);
  } catch (error) {
    logger.warn(
      '[resolveMCPServerContext] Config server initialization failed; continuing with name lists only:',
      error,
    );
  }
  return {
    configServers,
    serverNames: rawServerNames.map(normalizeServerName),
    rawServerNames,
  };
}

const warnedCollisions = new Set<string>();

/**
 * Two configured names that normalize to the same value produce IDENTICAL
 * model-facing tool keys, so tool selection and config resolution cannot tell
 * the servers apart — `buildServerNameAliases` deterministically routes to the
 * first configured name. Surfaced once per colliding pair per process so the
 * operator can rename one server; silently last-wins routing could execute a
 * different server's tool than the one the agent selected.
 */
function warnOnNormalizedNameCollisions(rawServerNames: readonly string[]): void {
  const aliases = buildServerNameAliases(rawServerNames);
  for (const raw of rawServerNames) {
    if (!raw) {
      continue;
    }
    const normalized = normalizeServerName(raw);
    const winner = aliases.get(normalized);
    if (winner == null || winner === raw) {
      continue;
    }
    const signature = `${winner}::${raw}`;
    if (warnedCollisions.has(signature)) {
      continue;
    }
    warnedCollisions.add(signature);
    logger.warn(
      `[MCP] Server names "${winner}" and "${raw}" normalize to the same tool-key segment "${normalized}"; their tool keys are ambiguous and lookups resolve to "${winner}". Rename one server to disambiguate.`,
    );
  }
}
