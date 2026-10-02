import { logger } from '@librechat/data-schemas';
import {
  Constants,
  Tools,
  buildServerNameAliases,
  normalizeServerName,
  splitMCPToolKey,
} from 'librechat-data-provider';
import type { MCPOptions, UIResource } from 'librechat-data-provider';
import type { Artifacts, LCAvailableTools, LCFunctionTool, ParsedServerConfig } from '~/mcp/types';
import { createConcurrencyLimiter } from '~/utils/promise';
import { findShadowedServerNames } from '~/mcp/utils';

const RECOVERY_CONCURRENCY = 3;

interface AssistantMCPMessage {
  messageId?: string;
  conversationId?: string | null;
  attachments?: unknown[];
}

interface AssistantMCPArtifactHost {
  responseMessage?: AssistantMCPMessage;
  finalMessage?: AssistantMCPMessage;
  res?: {
    destroyed?: boolean;
    writableEnded?: boolean;
    write(chunk: string): unknown;
  };
}

export interface AssistantMCPToolResult {
  output: unknown;
  uiResources?: UIResource[];
}

/** Separates host-only App data from an MCP result before Assistants submits model-bound output. */
export function splitAssistantMCPToolResult(
  rawOutput: unknown,
  isMCPTool: boolean,
): AssistantMCPToolResult {
  if (!isMCPTool || !Array.isArray(rawOutput) || rawOutput.length !== 2) {
    return { output: rawOutput };
  }
  const [output, candidateArtifact] = rawOutput as [unknown, Artifacts];
  const uiResources = candidateArtifact?.[Tools.ui_resources]?.data;
  return {
    output,
    ...(Array.isArray(uiResources) && uiResources.length > 0 ? { uiResources } : {}),
  };
}

/** Persists and streams an App attachment through either Assistants runtime's message owner. */
export function appendAssistantMCPAppArtifact({
  host,
  toolCallId,
  uiResources,
}: {
  host: AssistantMCPArtifactHost;
  toolCallId: string;
  uiResources: UIResource[];
}): void {
  const message = host.responseMessage ?? host.finalMessage;
  if (
    !message ||
    typeof message.messageId !== 'string' ||
    typeof message.conversationId !== 'string'
  ) {
    return;
  }
  const attachment = {
    type: Tools.ui_resources,
    messageId: message.messageId,
    toolCallId,
    conversationId: message.conversationId,
    [Tools.ui_resources]: uiResources,
  };
  message.attachments ??= [];
  message.attachments.push(attachment);
  if (host.res && !host.res.destroyed && !host.res.writableEnded) {
    host.res.write(`event: attachment\ndata: ${JSON.stringify(attachment)}\n\n`);
  }
}

export interface AssistantMCPUser {
  id?: string;
  role?: string;
}

export type AssistantToolReference = string | { type?: string; function?: { name?: string } };

export interface AssistantToolDefinitionsParams {
  user: AssistantMCPUser | undefined;
  tools?: readonly AssistantToolReference[];
  staticTools: LCAvailableTools;
  mcpConfig: Record<string, MCPOptions>;
}

export interface AssistantToolCatalogSnapshot {
  tools: LCAvailableTools | null;
  publicationGeneration?: string;
  publicationRevision?: string;
}

export interface AssistantToolDefinitionsDeps {
  ensureConfigServers: (
    mcpConfig: Record<string, MCPOptions>,
  ) => Promise<Record<string, ParsedServerConfig>>;
  getAllServerConfigs: (
    userId: string,
    configServers: Record<string, ParsedServerConfig>,
    role?: string,
  ) => Promise<Record<string, ParsedServerConfig>>;
  getMCPServerTools: (
    userId: string,
    serverName: string,
    serverConfig: ParsedServerConfig,
  ) => Promise<LCAvailableTools | null>;
  getServerToolFunctionsSnapshot: (
    userId: string,
    serverName: string,
    serverConfig: ParsedServerConfig,
  ) => Promise<AssistantToolCatalogSnapshot>;
  recoverServerTools: (
    serverName: string,
    serverConfig: ParsedServerConfig,
  ) => Promise<LCAvailableTools | null>;
  cacheMCPServerTools: (params: {
    userId: string;
    serverName: string;
    serverTools: LCAvailableTools;
    serverConfig: ParsedServerConfig;
    publicationGeneration?: string;
    publicationRevision?: string;
  }) => Promise<void>;
}

function isMCPToolReference(tool: AssistantToolReference): tool is string {
  return typeof tool === 'string' && tool.includes(Constants.mcp_delimiter);
}

async function resolveAssistantMcpConfigs(
  userId: string,
  role: string | undefined,
  mcpConfig: Record<string, MCPOptions>,
  deps: AssistantToolDefinitionsDeps,
): Promise<Record<string, ParsedServerConfig>> {
  const configServers = await deps.ensureConfigServers(mcpConfig);
  return deps.getAllServerConfigs(userId, configServers, role);
}

function selectReferencedServers(
  toolNames: readonly string[],
  configs: Record<string, ParsedServerConfig>,
  configuredServerNames: readonly string[] = [],
): Set<string> {
  const serverNames = [...new Set([...Object.keys(configs), ...configuredServerNames])];
  const aliases = buildServerNameAliases(serverNames);
  const knownNames = [...new Set([...serverNames, ...aliases.keys()])];
  const shadowed = findShadowedServerNames(serverNames);

  return toolNames.reduce((selected, toolName) => {
    const [, parsedServerName] = splitMCPToolKey(toolName, knownNames);
    const unavailableConfiguredServer = configuredServerNames.find(
      (serverName) =>
        !Object.prototype.hasOwnProperty.call(configs, serverName) &&
        (serverName === parsedServerName || normalizeServerName(serverName) === parsedServerName),
    );
    if (unavailableConfiguredServer) {
      throw new Error(
        `MCP server configuration unavailable for assistant server "${unavailableConfiguredServer}"`,
      );
    }
    const serverName =
      parsedServerName != null && Object.prototype.hasOwnProperty.call(configs, parsedServerName)
        ? parsedServerName
        : aliases.get(parsedServerName ?? '');
    if (serverName && !Object.prototype.hasOwnProperty.call(configs, serverName)) {
      throw new Error(`MCP server configuration unavailable for assistant server "${serverName}"`);
    }
    if (serverName && !shadowed.has(serverName)) {
      selected.add(serverName);
    }
    return selected;
  }, new Set<string>());
}

async function loadServerCatalog(
  userId: string,
  serverName: string,
  serverConfig: ParsedServerConfig,
  deps: AssistantToolDefinitionsDeps,
  recover: <T>(task: () => Promise<T>) => Promise<T>,
): Promise<LCAvailableTools> {
  const cached = await deps.getMCPServerTools(userId, serverName, serverConfig);
  if (cached != null) {
    return cached;
  }

  const snapshot = await deps.getServerToolFunctionsSnapshot(userId, serverName, serverConfig);
  if (snapshot.tools != null) {
    void deps
      .cacheMCPServerTools({
        userId,
        serverName,
        serverTools: snapshot.tools,
        serverConfig,
        publicationGeneration: snapshot.publicationGeneration,
        publicationRevision: snapshot.publicationRevision,
      })
      .catch((error) =>
        logger.error(
          `[assistant tool definitions] Failed to cache tools for ${serverName}:`,
          error,
        ),
      );
    return snapshot.tools;
  }

  const recovered = await recover(() => deps.recoverServerTools(serverName, serverConfig));
  if (recovered != null) {
    return recovered;
  }
  throw new Error(`MCP tool definitions unavailable for assistant server "${serverName}"`);
}

export interface AssistantToolDefinitionsResult {
  toolDefinitions: LCAvailableTools;
  /**
   * Every server name the principal can reach, from the same merged registry
   * read that resolved the catalogs — the legacy-key heal reuses it instead
   * of repeating the app-config and registry round trips on the write path.
   * `undefined` when the payload references no MCP tools (nothing to heal).
   */
  accessibleServerNames?: string[];
}

/** Loads the static catalog with the configuration-addressed MCP slices referenced by an assistant. */
export async function getAssistantToolDefinitions(
  params: AssistantToolDefinitionsParams,
  deps: AssistantToolDefinitionsDeps,
): Promise<AssistantToolDefinitionsResult> {
  const mcpToolNames =
    params.tools?.filter(
      (tool): tool is string =>
        isMCPToolReference(tool) && !Object.prototype.hasOwnProperty.call(params.staticTools, tool),
    ) ?? [];
  const userId = params.user?.id;
  if (mcpToolNames.length === 0 || !userId) {
    return { toolDefinitions: params.staticTools };
  }

  const configs = await resolveAssistantMcpConfigs(
    userId,
    params.user?.role,
    params.mcpConfig,
    deps,
  );
  const recover = createConcurrencyLimiter(RECOVERY_CONCURRENCY);
  const serverCatalogs = await Promise.all(
    Array.from(
      selectReferencedServers(mcpToolNames, configs, Object.keys(params.mcpConfig)),
      (serverName) => loadServerCatalog(userId, serverName, configs[serverName], deps, recover),
    ),
  );
  /** Entries keep `serverToolName` here: the assistants heal verifies legacy
   *  key rewrites against that upstream identity. The controllers sanitize
   *  through {@link toProviderToolDefinition} at the submission boundary. */
  return {
    toolDefinitions: Object.assign({}, params.staticTools, ...serverCatalogs),
    accessibleServerNames: [
      ...new Set([...Object.keys(configs), ...Object.keys(params.mcpConfig)]),
    ],
  };
}

/**
 * Assistant writers submit tool entries VERBATIM as provider tool definitions
 * (`assistantData.tools` in the v1/v2 controllers), and providers reject
 * unknown fields — the internal `serverToolName` mapping must never leave the
 * catalog. Strings and entries without the mapping pass through by reference;
 * the cached catalog keeps the mapping for the runtime call path.
 */
export function toProviderToolDefinition<T>(tool: T): T | LCFunctionTool {
  if (tool == null || typeof tool !== 'object') {
    return tool;
  }
  const entry = tool as Partial<LCFunctionTool>;
  if (entry.serverToolName == null || entry.type !== 'function' || entry['function'] == null) {
    return tool;
  }
  return { type: entry.type, ['function']: entry['function'] };
}
