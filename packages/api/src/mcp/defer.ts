import {
  Constants,
  normalizeServerName,
  splitMCPToolKey,
  stripServerNamePrefix,
} from 'librechat-data-provider';
import type { AgentToolOptions } from 'librechat-data-provider';
import type { LCAvailableTools, ParsedServerConfig } from '~/mcp/types';
import { canDeferOAuthSignIn, isMCPAllPlaceholder } from '~/mcp/utils';
import { resolveToolOption } from '~/agents/selection';
import { formatMCPServerTools } from '~/mcp/tools';

const serverPinPrefix = `${Constants.mcp_server}${Constants.mcp_delimiter}`;

/**
 * The catalog key a selected tool resolves to, matching the definitions loader: the key itself,
 * or the server-prefix-stripped key whose entry keeps the stored spelling as `serverToolName`.
 */
function catalogKeyFor(
  catalog: LCAvailableTools,
  tool: string,
  toolPart: string,
  keyServerName: string,
): string | undefined {
  if (catalog[tool] != null) {
    return tool;
  }
  const strippedPart = stripServerNamePrefix(toolPart, keyServerName);
  if (strippedPart === toolPart) {
    return undefined;
  }
  const strippedKey = `${strippedPart}${Constants.mcp_delimiter}${keyServerName}`;
  return catalog[strippedKey]?.serverToolName === toolPart ? strippedKey : undefined;
}

/**
 * The tool's other spelling, from which the definitions loader's `aliasMCPToolOptions` heals
 * `tool_options`: the current catalog key for a stored pre-strip key, or the pre-strip name for
 * a current key whose entry keeps one.
 */
function optionsAliasFor(
  catalog: LCAvailableTools,
  tool: string,
  catalogKey: string,
  keyServerName: string,
): string | undefined {
  if (catalogKey !== tool) {
    return catalogKey;
  }
  const serverToolName = catalog[catalogKey]?.serverToolName;
  if (!serverToolName) {
    return undefined;
  }
  const alias = `${serverToolName}${Constants.mcp_delimiter}${keyServerName}`;
  return alias !== tool ? alias : undefined;
}

/** The options the loader reads for a tool, after aliasing them across its spellings. */
function withAliasedOptions(
  tool: string,
  aliasName: string | undefined,
  toolOptions: AgentToolOptions | undefined,
): AgentToolOptions | undefined {
  if (!toolOptions || toolOptions[tool] != null || !aliasName || toolOptions[aliasName] == null) {
    return toolOptions;
  }
  return { ...toolOptions, [tool]: toolOptions[aliasName] };
}

/**
 * Whether a turn may skip the up-front sign-in for a server and leave it to the server's
 * first tool call. That holds only when the server opts in with `oauthPrompt: on_use`, every
 * tool the agent selected from it is deferred, so the model can only reach those tools through
 * tool search and nothing in the turn needs them before it asks for one, and, when given, the
 * catalog offered in the meantime holds every one of them.
 */
export function shouldDeferMCPOAuthSignIn({
  serverName,
  serverConfig,
  tools,
  toolOptions,
  deferredToolsEnabled,
  backgroundToolsEnabled = false,
  knownServerNames,
  catalog,
}: {
  serverName: string;
  serverConfig: ParsedServerConfig;
  tools: readonly string[];
  toolOptions?: AgentToolOptions;
  deferredToolsEnabled: boolean;
  /** Whether the `run_in_background` capability lets opted-in tools run detached. */
  backgroundToolsEnabled?: boolean;
  knownServerNames?: readonly string[];
  catalog?: LCAvailableTools;
}): boolean {
  if (!deferredToolsEnabled || !canDeferOAuthSignIn(serverConfig)) {
    return false;
  }
  /** Tool keys carry the normalized server name; the loader may ask with the raw one. */
  const keyServerName = normalizeServerName(serverName);
  let selected = 0;
  for (const tool of tools) {
    if (tool.startsWith(serverPinPrefix)) {
      continue;
    }
    const [toolPart, toolServerName] = splitMCPToolKey(tool, knownServerNames);
    if (toolServerName !== serverName && toolServerName !== keyServerName) {
      continue;
    }
    if (isMCPAllPlaceholder(tool)) {
      return false;
    }
    const catalogKey = catalog && catalogKeyFor(catalog, tool, toolPart, keyServerName);
    if (catalog && !catalogKey) {
      return false;
    }
    const aliasName =
      catalog && catalogKey ? optionsAliasFor(catalog, tool, catalogKey, keyServerName) : undefined;
    const options = withAliasedOptions(tool, aliasName, toolOptions);
    /** A background call runs detached and could not pause for the sign-in it would trigger. */
    if (
      options?.[tool]?.defer_loading !== true ||
      (backgroundToolsEnabled &&
        resolveToolOption(tool, 'run_in_background', options)?.value === true)
    ) {
      return false;
    }
    selected++;
  }
  return selected > 0;
}

export interface MCPOAuthDeferral {
  /**
   * For a caller that already holds the user's own catalog: queues the turn-start sign-in
   * through `prompt` unless the server defers it and that catalog holds every selected tool.
   */
  promptUnlessDeferred: (
    serverName: string,
    serverConfig: ParsedServerConfig,
    catalog: LCAvailableTools,
    prompt: () => Promise<unknown>,
  ) => Promise<void>;
  /**
   * Defers a qualifying server that is waiting on sign-in, offering the tool catalog its
   * operator declared and withdrawing the turn-start prompt. Null keeps that prompt.
   */
  deferSignIn: (serverName: string, serverConfig: ParsedServerConfig) => LCAvailableTools | null;
  /**
   * The tools a reconnect attempt yields. While a sign-in this turn may defer is pending, the
   * prompt is withdrawn and the attempt's own tools, or the declared catalog when it found
   * none, are offered instead.
   */
  resolveReconnectTools: (
    serverName: string,
    serverConfig: ParsedServerConfig,
    tools: LCAvailableTools | null | undefined,
  ) => LCAvailableTools | null;
  /** Whether the server's sign-in is already settled this turn: prompted for, or deferred. */
  hasSignInDecision: (serverName: string) => boolean;
}

/** Tracks, for one turn's tool loading, which servers leave sign-in to the first tool call. */
export function createMCPOAuthDeferral({
  tools,
  toolOptions,
  deferredToolsEnabled,
  backgroundToolsEnabled,
  knownServerNames,
  pendingOAuthServers,
  pendingOAuthStarts,
  rememberAvailableTools,
}: {
  tools: readonly string[];
  toolOptions?: AgentToolOptions;
  deferredToolsEnabled: boolean;
  backgroundToolsEnabled?: boolean;
  knownServerNames?: readonly string[];
  /** Servers whose turn-start sign-in prompt is queued. */
  pendingOAuthServers: Pick<Set<string>, 'has' | 'delete'>;
  /** Queued turn-start sign-in prompts, by server. */
  pendingOAuthStarts: Pick<Map<string, unknown>, 'delete'>;
  rememberAvailableTools: (serverName: string, availableTools: LCAvailableTools) => void;
}): MCPOAuthDeferral {
  const deferred = new Set<string>();
  const qualifies = (
    serverName: string,
    serverConfig: ParsedServerConfig,
    catalog: LCAvailableTools,
  ): boolean =>
    shouldDeferMCPOAuthSignIn({
      serverName,
      serverConfig,
      tools,
      toolOptions,
      deferredToolsEnabled,
      backgroundToolsEnabled,
      knownServerNames,
      catalog,
    });
  /** Leaves the server's sign-in to its first tool call, withdrawing any turn-start prompt. */
  const withdrawPrompt = (serverName: string, catalog: LCAvailableTools): LCAvailableTools => {
    deferred.add(serverName);
    pendingOAuthServers.delete(serverName);
    pendingOAuthStarts.delete(serverName);
    rememberAvailableTools(serverName, catalog);
    return catalog;
  };
  const deferSignIn = (
    serverName: string,
    serverConfig: ParsedServerConfig,
  ): LCAvailableTools | null => {
    if (!serverConfig.oauthToolCatalog?.length) {
      return null;
    }
    const catalog = formatMCPServerTools(serverName, serverConfig.oauthToolCatalog);
    if (!qualifies(serverName, serverConfig, catalog)) {
      return null;
    }
    return withdrawPrompt(serverName, catalog);
  };
  return {
    promptUnlessDeferred: async (serverName, serverConfig, catalog, prompt) => {
      if (qualifies(serverName, serverConfig, catalog)) {
        deferred.add(serverName);
        return;
      }
      await prompt();
    },
    deferSignIn,
    resolveReconnectTools: (serverName, serverConfig, availableTools) => {
      if (!pendingOAuthServers.has(serverName)) {
        return availableTools || null;
      }
      if (availableTools == null || Object.keys(availableTools).length === 0) {
        return deferSignIn(serverName, serverConfig);
      }
      /** Discovery without a token can still list the tools; the call will need the sign-in. */
      return qualifies(serverName, serverConfig, availableTools)
        ? withdrawPrompt(serverName, availableTools)
        : availableTools;
    },
    hasSignInDecision: (serverName) =>
      pendingOAuthServers.has(serverName) || deferred.has(serverName),
  };
}
