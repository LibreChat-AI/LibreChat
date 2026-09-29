import { logger } from '@librechat/data-schemas';
import { Constants, normalizeServerName, stripServerNamePrefixes } from 'librechat-data-provider';
import type { JsonSchemaType } from '@librechat/data-schemas';
import type { MCPConnection } from '~/mcp/connection';
import type * as t from '~/mcp/types';
import {
  hasCustomUserVars,
  applyRequestHeaders,
  hasRuntimeContextPlaceholders,
  hasRuntimeUrlPlaceholders,
  toCatalogConnectionConfig,
  isUserSourced,
} from '~/mcp/utils';
import { isMCPDomainAllowed, extractMCPServerDomain } from '~/auth/domain';
import { normalizeJsonSchema, resolveJsonSchemaRefs } from '~/mcp/zod';
import { isDirectOpenIDBearerRecoveryEnabled } from '~/mcp/openid';
import { MCPConnectionFactory } from '~/mcp/MCPConnectionFactory';
import { MCPDomainNotAllowedError } from '~/mcp/errors';
import { detectOAuthRequirement } from '~/mcp/oauth';
import { isEnabled } from '~/utils';

/**
 * Inspects MCP servers to discover their metadata, capabilities, and tools.
 * Connects to servers and populates configuration with OAuth requirements,
 * server instructions, capabilities, and available tools.
 */
export class MCPServerInspector {
  private constructor(
    private readonly serverName: string,
    private readonly config: t.ParsedServerConfig,
    private connection: MCPConnection | undefined,
    private readonly useSSRFProtection: boolean = false,
    private readonly allowedDomains?: string[] | null,
    private readonly allowedAddresses?: string[] | null,
  ) {}

  /**
   * Inspects a server and returns an enriched configuration with metadata.
   * Detects OAuth requirements and fetches server capabilities.
   * @param serverName - The name of the server (used for tool function naming)
   * @param rawConfig - The raw server configuration
   * @param connection - The MCP connection
   * @param allowedDomains - Optional list of allowed domains for remote transports
   * @returns A fully processed and enriched configuration with server metadata
   */
  public static async inspect(
    serverName: string,
    rawConfig: t.MCPOptions,
    connection?: MCPConnection,
    allowedDomains?: string[] | null,
    allowedAddresses?: string[] | null,
  ): Promise<t.ParsedServerConfig> {
    // Validate domain against allowlist BEFORE attempting connection
    const isDomainAllowed = await isMCPDomainAllowed(rawConfig, allowedDomains, allowedAddresses);
    if (!isDomainAllowed) {
      const domain = extractMCPServerDomain(rawConfig);
      throw new MCPDomainNotAllowedError(domain ?? 'unknown');
    }

    const useSSRFProtection = !Array.isArray(allowedDomains) || allowedDomains.length === 0;
    const start = Date.now();
    const inspector = new MCPServerInspector(
      serverName,
      rawConfig,
      connection,
      useSSRFProtection,
      allowedDomains,
      allowedAddresses,
    );
    await inspector.inspectServer();
    inspector.config.initDuration = Date.now() - start;
    return inspector.config;
  }

  private async inspectServer(): Promise<void> {
    this.warnOnUnrestrictedRuntimeUrl();
    await this.detectOAuth();

    /** Startup inspection is catalog work with no chat request, so the chat-only
     *  headers come off before BOTH the eligibility gate and the probe. Left on,
     *  a `{{LIBRECHAT_BODY_*}}` placeholder there fails
     *  `hasRuntimeContextPlaceholders` and skips inspection altogether — the
     *  very outcome `requestHeaders` exists to avoid. */
    const catalogConfig = toCatalogConnectionConfig(this.config);
    if (
      this.config.startup !== false &&
      !this.config.requiresOAuth &&
      !hasCustomUserVars(this.config) &&
      // user-provided API key is supplied per-user at connect time; an unauthenticated
      // probe here would 401 against a bearer server and fail inspection
      this.config.apiKey?.source !== 'user' &&
      !hasRuntimeContextPlaceholders(catalogConfig) &&
      !this.config.obo
    ) {
      let tempConnection = false;
      if (!this.connection) {
        tempConnection = true;
        this.connection = await MCPConnectionFactory.create({
          serverConfig: catalogConfig,
          serverDefinition: this.config,
          serverName: this.serverName,
          dbSourced: isUserSourced(this.config),
          useSSRFProtection: this.useSSRFProtection,
          allowedDomains: this.allowedDomains,
          allowedAddresses: this.allowedAddresses,
        });
      }

      await Promise.allSettled([
        this.fetchServerInstructions(),
        this.fetchServerCapabilities(),
        this.fetchToolFunctions(),
      ]);

      if (tempConnection) await this.connection.disconnect();
    }
  }

  /**
   * Runtime placeholders in the URL make the resolved connection target partially
   * user/request-controlled. The resolved URL is validated against the domain
   * allowlist at request time, but without one only private-range SSRF protection
   * limits where it can point.
   */
  private warnOnUnrestrictedRuntimeUrl(): void {
    if (!hasRuntimeUrlPlaceholders(this.config)) return;
    if (Array.isArray(this.allowedDomains) && this.allowedDomains.length > 0) return;

    logger.warn(
      `[MCP][${this.serverName}] Server URL contains runtime placeholders but no domain allowlist is configured; ` +
        'the resolved URL is partially user/request-controlled. Set mcpSettings.allowedDomains to restrict targets.',
    );
  }

  private async detectOAuth(): Promise<void> {
    if (isDirectOpenIDBearerRecoveryEnabled(applyRequestHeaders(this.config))) {
      this.config.requiresOAuth = false;
      this.config.oauthMetadata = null;
      return;
    }
    if (this.config.requiresOAuth != null) return;
    if (hasRuntimeUrlPlaceholders(this.config)) return;
    if (this.config.url == null || this.config.startup === false) {
      this.config.requiresOAuth = false;
      return;
    }

    // API key auth (admin- or user-provided) is API-key, not OAuth. A credential-less
    // probe of a bearer server returns the same 401 challenge as an OAuth server, so
    // detection would misclassify it; trust the configured auth method. An explicit
    // `oauth` block still wins if both are somehow set.
    if (this.config.apiKey != null && this.config.oauth == null) {
      this.config.requiresOAuth = false;
      return;
    }

    const result = await detectOAuthRequirement(
      this.config.url,
      this.allowedDomains,
      this.allowedAddresses,
    );
    this.config.requiresOAuth = result.requiresOAuth;
    this.config.oauthMetadata = result.metadata;
  }

  private async fetchServerInstructions(): Promise<void> {
    if (isEnabled(this.config.serverInstructions)) {
      this.config.resolvedInstructions = this.connection!.client.getInstructions();
    }
  }

  private async fetchServerCapabilities(): Promise<void> {
    const capabilities = this.connection!.client.getServerCapabilities();
    this.config.capabilities = JSON.stringify(capabilities);
    const tools = await this.connection!.fetchTools();
    this.config.tools = tools.map((tool) => tool.name).join(', ');
  }

  private async fetchToolFunctions(): Promise<void> {
    this.config.toolFunctions = (
      await MCPServerInspector.getToolCatalog(this.serverName, this.connection!)
    ).tools;
  }

  /**
   * Converts server tools to LibreChat-compatible tool functions format, keeping the ordering
   * reserved before the `tools/list` that produced them. App-level publishers need that
   * revision — a catalog write that cannot be ordered against concurrent replicas is dropped.
   * @param serverName - The name of the server
   * @param connection - The MCP connection
   */
  public static async getToolCatalog(
    serverName: string,
    connection: MCPConnection,
    deadlineMs?: number,
    signal?: AbortSignal,
  ): Promise<{ tools: t.LCAvailableTools; publicationRevision?: string }> {
    const snapshot = await connection.fetchOrderedToolsSnapshot(deadlineMs, signal);
    if (!snapshot.complete) {
      throw new Error(`Incomplete tools/list snapshot for MCP server ${serverName}`);
    }
    const { tools } = snapshot;

    const toolFunctions: t.LCAvailableTools = {};
    /** Model-facing key: must match the runtime instance name, which embeds
     *  the normalized server name (see `createToolInstance` in MCP.js). */
    const keyServerName = normalizeServerName(serverName);
    const keyToolNames = stripServerNamePrefixes(
      tools.map((tool) => tool.name),
      keyServerName,
    );
    tools.forEach((tool) => {
      const keyToolName = keyToolNames.get(tool.name) ?? tool.name;
      const name = `${keyToolName}${Constants.mcp_delimiter}${keyServerName}`;
      toolFunctions[name] = {
        type: 'function',
        ...(keyToolName !== tool.name && { serverToolName: tool.name }),
        ['function']: {
          name,
          description: tool.description,
          // Normalize before persisting: resolves `$ref`s and strips
          // `$`-prefixed keywords (e.g. a spec-compliant `$schema`), which
          // MongoDB rejects as field names and would otherwise crash storage
          // of this `parameters` blob during server registration.
          parameters: normalizeJsonSchema(
            resolveJsonSchemaRefs(tool.inputSchema as Record<string, unknown>),
          ) as JsonSchemaType,
        },
      };
    });

    return { tools: toolFunctions, publicationRevision: snapshot.publicationRevision };
  }
}
