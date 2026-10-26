import { Types } from 'mongoose';
import { logger, encryptV2, decryptV2, createMethods } from '@librechat/data-schemas';
import {
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  PermissionBits,
} from 'librechat-data-provider';
import type { AllMethods, MCPServerDocument, IAgent } from '@librechat/data-schemas';
import type { IServerConfigsRepositoryInterface } from '~/mcp/registry/ServerConfigsRepositoryInterface';
import type { ParsedServerConfig, AddServerResult } from '~/mcp/types';
import type { ResolvedPrincipal } from '~/types/principal';
import {
  getUserApiKeyVariable,
  preserveOmittedOAuthBindingFields,
  getChangedOAuthSecretBindingFields,
} from '~/mcp/registry/binding';
import { MCPCommittedWriteError, MCPOAuthSecretReentryRequiredError } from '~/mcp/errors';
import { requireApiKeyReentryForRebinding } from '~/mcp/registry/reentry';
import { normalizeLegacyHeaderMaps } from '~/mcp/registry/compat';
import { AccessControlService } from '~/acl/accessControlService';
import { isGeneratedUserApiKeyVariable } from '~/mcp/headers';

/**
 * Regex patterns for credential/env placeholders that should not be allowed in user-provided configs.
 * These would substitute server credentials or the CALLING user's data, creating exfiltration risks
 * when MCP servers are shared between users.
 *
 * Safe placeholders like {{MCP_API_KEY}} are allowed as they resolve from the user's own plugin auth.
 */
const DANGEROUS_CREDENTIAL_PATTERNS = [
  /\$\{[^}]+\}/g,
  /\{\{LIBRECHAT_OPENID_[^}]+\}\}/g,
  /\{\{LIBRECHAT_USER_[^}]+\}\}/g,
  /\{\{LIBRECHAT_GRAPH_[^}]+\}\}/g,
  /\{\{LIBRECHAT_BODY_[^}]+\}\}/g,
];

const BLOCKED_USER_OAUTH_ENDPOINT_PARAMS = ['audience', 'resource'] as const;

/**
 * Sanitizes headers by removing dangerous credential placeholders.
 * This prevents credential exfiltration when MCP servers are shared between users.
 *
 * @param headers - The headers object to sanitize
 * @returns Sanitized headers with dangerous placeholders removed
 */
function sanitizeCredentialPlaceholders(
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) {
    return headers;
  }

  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    let sanitizedValue = value;
    for (const pattern of DANGEROUS_CREDENTIAL_PATTERNS) {
      sanitizedValue = sanitizedValue.replace(pattern, '');
    }
    sanitized[key] = sanitizedValue;
  }
  return sanitized;
}

/**
 * Sanitizes every header map a shared config carries. `requestHeaders` is
 * included because it reaches the upstream server exactly like `headers` does:
 * left unsanitized, a user-managed config could name a privileged placeholder
 * there and have the runtime resolve it at chat time. Absent maps stay omitted
 * because BSON can serialize explicit undefined properties as null.
 */
function sanitizeConfigHeaderMaps(config: ParsedServerConfig): ParsedServerConfig {
  const { headers, requestHeaders, ...rest } = config as ParsedServerConfig & {
    headers?: Record<string, string>;
    requestHeaders?: Record<string, string>;
  };
  return {
    ...rest,
    ...(headers != null && { headers: sanitizeCredentialPlaceholders(headers) }),
    ...(requestHeaders != null && {
      requestHeaders: sanitizeCredentialPlaceholders(requestHeaders),
    }),
  } as ParsedServerConfig;
}

function stripBlockedOAuthEndpointParams(url?: string): string | undefined {
  if (!url) {
    return url;
  }

  try {
    const parsed = new URL(url);
    BLOCKED_USER_OAUTH_ENDPOINT_PARAMS.forEach((param) => parsed.searchParams.delete(param));
    return parsed.href;
  } catch {
    return url;
  }
}

function sanitizeUserManagedOAuthConfig(config: ParsedServerConfig): ParsedServerConfig {
  if (!config.oauth) {
    return config;
  }

  const {
    audience: _audience,
    forward_audience_on_refresh: _forwardAudienceOnRefresh,
    send_resource_parameter: _sendResourceParameter,
    ...oauth
  } = config.oauth;
  return {
    ...config,
    oauth: {
      ...oauth,
      ...(config.oauth.authorization_url && {
        authorization_url: stripBlockedOAuthEndpointParams(config.oauth.authorization_url),
      }),
      ...(config.oauth.token_url && {
        token_url: stripBlockedOAuthEndpointParams(config.oauth.token_url),
      }),
    },
  };
}

/** Unions `mcpServerNames` over the candidate agents the caller can access. */
function unionMCPServerNames(
  candidates: Array<Pick<IAgent, '_id' | 'mcpServerNames'>>,
  accessibleAgentIds: Types.ObjectId[],
): string[] {
  if (accessibleAgentIds.length === 0) {
    return [];
  }
  const accessible = new Set(accessibleAgentIds.map((id) => id.toString()));
  const serverNames = new Set<string>();
  for (const agent of candidates) {
    if (!accessible.has(agent._id.toString())) {
      continue;
    }
    for (const serverName of agent.mcpServerNames ?? []) {
      serverNames.add(serverName);
    }
  }
  return Array.from(serverNames);
}

/**
 * DB backed config storage
 * Handles CRUD Methods of dynamic mcp servers
 * Will handle Permission ACL
 */
export class ServerConfigsDB implements IServerConfigsRepositoryInterface {
  private _dbMethods: AllMethods;
  private _aclService: AccessControlService;

  constructor(mongoose: typeof import('mongoose')) {
    if (!mongoose) {
      throw new Error('ServerConfigsDB requires mongoose instance');
    }
    this._dbMethods = createMethods(mongoose);
    this._aclService = new AccessControlService(mongoose);
  }

  /**
   * Checks if user has access to an MCP server via an agent they can VIEW.
   * Starts from the agents that reference `serverName` (typically few, and an
   * index-covered lookup) and bounds the ACL query to those ids, instead of
   * materializing every accessible agent and scanning it (#14016).
   * @param serverName - The MCP server name to check
   * @param userId - The user ID (optional - if not provided, checks publicly accessible agents)
   * @returns true if user has VIEW access to at least one agent that has this MCP server
   */
  private async hasAccessViaAgent(
    serverName: string,
    userId?: string,
    role?: string,
  ): Promise<boolean> {
    const candidateIds = await this._dbMethods.getAgentIdsByMCPServerName(serverName);
    if (candidateIds.length === 0) {
      return false;
    }

    const accessibleAgentIds = userId
      ? await this._aclService.findAccessibleResources({
          userId,
          role,
          requiredPermissions: PermissionBits.VIEW,
          resourceType: ResourceType.AGENT,
          resourceIds: candidateIds,
        })
      : await this._aclService.findPubliclyAccessibleResources({
          resourceType: ResourceType.AGENT,
          requiredPermissions: PermissionBits.VIEW,
          resourceIds: candidateIds,
        });

    return accessibleAgentIds.length > 0;
  }

  /**
   * Creates a new MCP server and grants owner permissions to the user.
   * @param serverName - Placeholder name kept for repository compatibility; final serverName comes from config.title
   * @param config - Server configuration to store
   * @param userId - ID of the user creating the server (required)
   * @returns The created server result with serverName and config (including dbId)
   * @throws Error if userId is not provided
   */
  public async add(
    serverName: string,
    config: ParsedServerConfig,
    userId?: string,
    reservedServerNames?: Iterable<string>,
  ): Promise<AddServerResult> {
    logger.debug(
      `[ServerConfigsDB.add] Creating DB-backed server from config title. Placeholder: ${serverName}; userId: ${userId}`,
    );
    if (!userId) {
      throw new Error(
        '[ServerConfigsDB.add] User ID is required to create a database-stored MCP server.',
      );
    }

    const sanitizedConfig = sanitizeUserManagedOAuthConfig(sanitizeConfigHeaderMaps(config));

    /** Transformed user-provided API key config (adds customUserVars and headers) */
    const transformedConfig = this.transformUserApiKeyConfig(sanitizedConfig);
    /** Encrypted config before storing in database */
    const encryptedConfig = await this.encryptConfig(transformedConfig);
    const createdServer = await this._dbMethods.createMCPServer({
      config: encryptedConfig,
      author: userId,
      reservedServerNames,
    });
    const created = {
      serverName: createdServer.serverName,
      config: await this.mapDBServerToParsedConfig(createdServer),
    };
    try {
      await this._aclService.grantPermission({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.MCPSERVER,
        resourceId: createdServer._id,
        accessRoleId: AccessRoleIds.MCPSERVER_OWNER,
        grantedBy: userId,
      });
    } catch (error) {
      /** The server exists already, so the failure must not read as a create that never happened. */
      throw new MCPCommittedWriteError(created, error);
    }
    return created;
  }

  /**
   *
   * @param serverName mcp server unique identifier "serverName"
   * @param config new Configuration to update
   * @param userId user id required to update DB server config
   */
  public async update(
    serverName: string,
    config: ParsedServerConfig,
    userId?: string,
  ): Promise<ParsedServerConfig> {
    if (!userId) {
      throw new Error(
        '[ServerConfigsDB.update] User ID is required to update a database-stored MCP server.',
      );
    }

    const existingServer = await this._dbMethods.findMCPServerByServerName(serverName);

    if (existingServer) {
      requireApiKeyReentryForRebinding(existingServer.config, config);
    }

    let configToSave: ParsedServerConfig = sanitizeUserManagedOAuthConfig(
      sanitizeConfigHeaderMaps(config),
    );

    const existingOAuth = existingServer?.config?.oauth;
    const existingOAuthSecret = existingOAuth?.client_secret;
    const preservesOAuthSecret =
      !config.oauth?.client_secret && !!existingOAuthSecret && !!configToSave.oauth;
    if (preservesOAuthSecret && existingServer && existingOAuth && configToSave.oauth) {
      configToSave = {
        ...configToSave,
        oauth: preserveOmittedOAuthBindingFields(existingOAuth, configToSave.oauth),
      };
      const changedFields = getChangedOAuthSecretBindingFields(existingServer.config, configToSave);
      if (changedFields.length > 0) {
        throw new MCPOAuthSecretReentryRequiredError(changedFields);
      }
    }

    /** Transformed user-provided API key config (adds customUserVars and headers) */
    configToSave = this.transformUserApiKeyConfig(configToSave, existingServer?.config);

    /** Encrypted config before storing in database */
    configToSave = await this.encryptConfig(configToSave);

    if (preservesOAuthSecret && existingOAuthSecret && configToSave.oauth) {
      configToSave = {
        ...configToSave,
        oauth: {
          ...configToSave.oauth,
          client_secret: existingOAuthSecret,
        },
      };
    }

    if (
      config.apiKey?.source === 'admin' &&
      !config.apiKey?.key &&
      existingServer?.config?.apiKey?.source === 'admin' &&
      existingServer?.config?.apiKey?.key
    ) {
      configToSave = {
        ...configToSave,
        apiKey: {
          source: configToSave.apiKey!.source,
          authorization_type: configToSave.apiKey!.authorization_type,
          custom_header: configToSave.apiKey?.custom_header,
          key: existingServer.config.apiKey.key,
        },
      };
    }

    const saved = await this._dbMethods.updateMCPServer(serverName, { config: configToSave });
    if (!saved) {
      throw new Error(`[ServerConfigsDB.update] MCP server "${serverName}" no longer exists.`);
    }
    return await this.mapDBServerToParsedConfig(saved);
  }

  /**
   * Atomic add-or-update. For DB-backed servers this delegates to update since
   * DB servers are always created via the explicit add() flow with ACL setup.
   * Config-source servers should use configCacheRepo, not dbConfigsRepo.
   */
  public async upsert(
    serverName: string,
    config: ParsedServerConfig,
    userId?: string,
  ): Promise<void> {
    if (!userId) {
      throw new Error(
        `[ServerConfigsDB.upsert] User ID is required for DB-backed MCP server upsert of "${serverName}". ` +
          'Config-source servers should use configCacheRepo, not dbConfigsRepo.',
      );
    }
    await this.update(serverName, config, userId);
  }

  /**
   * Deletes an MCP server and removes all associated ACL entries.
   * @param serverName - The serverName of the server to remove
   * @param userId - User performing the deletion (for logging)
   */
  public async remove(serverName: string, userId?: string): Promise<boolean> {
    logger.debug(`[ServerConfigsDB.remove] removing ${serverName}. UserId: ${userId}`);
    const deletedServer = await this._dbMethods.deleteMCPServer(serverName);
    if (deletedServer && deletedServer._id) {
      logger.debug(`[ServerConfigsDB.remove] removing all permissions entries of ${serverName}.`);
      try {
        await this._aclService.removeAllPermissions({
          resourceType: ResourceType.MCPSERVER,
          resourceId: deletedServer._id!,
        });
      } catch (error) {
        throw new MCPCommittedWriteError(true, error);
      }
      return true;
    }
    logger.warn(`[ServerConfigsDB.remove] server with serverName ${serverName} does not exist`);
    return false;
  }

  /**
   * Retrieves a single MCP server configuration by its serverName.
   * @param serverName - The serverName of the server to retrieve
   * @param userId - the user id provide the scope of the request. If the user Id is not provided, only publicly visible servers are returned.
   * @returns The parsed server config or undefined if not found. If accessed via agent, consumeOnly will be true.
   */
  public async get(
    serverName: string,
    userId?: string,
    role?: string,
  ): Promise<ParsedServerConfig | undefined> {
    if (userId) {
      /** Each lookup is bounded to this server or the agents that reference it. Resolve the
       *  principal set once so direct and agent ACL checks can start together. */
      const [server, principalsList, candidateIds] = await Promise.all([
        this._dbMethods.findMCPServerByServerName(serverName),
        this._aclService.getUserPrincipals({ userId, role }),
        this._dbMethods.getAgentIdsByMCPServerName(serverName),
      ]);
      if (!server) return undefined;

      const [directlyAccessibleIds, accessibleAgentIds] = await Promise.all([
        this._aclService.findAccessibleResourcesForPrincipals({
          principalsList,
          resourceType: ResourceType.MCPSERVER,
          requiredPermissions: PermissionBits.VIEW,
          resourceIds: [server._id],
        }),
        this.findAccessibleAgentIds(candidateIds, userId, principalsList),
      ]);
      if (directlyAccessibleIds.some((id) => id.toString() === server._id.toString())) {
        logger.debug(
          `[ServerConfigsDB.get] getting ${serverName} for user with the UserId: ${userId}`,
        );
        return await this.mapDBServerToParsedConfig(server);
      }
      if (accessibleAgentIds.length > 0) {
        logger.debug(
          `[ServerConfigsDB.get] user ${userId} accessing ${serverName} via agent (consumeOnly)`,
        );
        return {
          ...(await this.mapDBServerToParsedConfig(server)),
          consumeOnly: true,
        };
      }
      return undefined;
    }

    const server = await this._dbMethods.findMCPServerByServerName(serverName);
    if (!server) return undefined;
    const directlyAccessibleMCPIds = (
      await this._aclService.findPubliclyAccessibleResources({
        resourceType: ResourceType.MCPSERVER,
        requiredPermissions: PermissionBits.VIEW,
      })
    ).map((id) => id.toString());
    if (directlyAccessibleMCPIds.indexOf(server._id.toString()) > -1) {
      return await this.mapDBServerToParsedConfig(server);
    }

    const hasAgentAccess = await this.hasAccessViaAgent(serverName);
    if (hasAgentAccess) {
      logger.debug(`[ServerConfigsDB.get] accessing ${serverName} via public agent (consumeOnly)`);
      return {
        ...(await this.mapDBServerToParsedConfig(server)),
        consumeOnly: true,
      };
    }

    return undefined;
  }

  /**
   * Agent-side access resolution bounded to the MCP-referencing candidate ids,
   * so the ACL query cost scales with agents that use MCP servers instead of
   * every accessible agent (#14016).
   */
  private findAccessibleAgentIds(
    candidateIds: Types.ObjectId[],
    userId?: string,
    principalsList: ResolvedPrincipal[] = [],
  ): Promise<Types.ObjectId[]> {
    if (candidateIds.length === 0) {
      return Promise.resolve([]);
    }
    if (userId) {
      return this._aclService.findAccessibleResourcesForPrincipals({
        principalsList,
        requiredPermissions: PermissionBits.VIEW,
        resourceType: ResourceType.AGENT,
        resourceIds: candidateIds,
      });
    }
    return this._aclService.findPubliclyAccessibleResources({
      resourceType: ResourceType.AGENT,
      requiredPermissions: PermissionBits.VIEW,
      resourceIds: candidateIds,
    });
  }

  /**
   * Return all DB stored configs (scoped by user Id if provided)
   * @param userId optional user id. if not provided only publicly shared mcp configs will be returned
   * @returns record of parsed configs
   */
  public async getAll(userId?: string, role?: string): Promise<Record<string, ParsedServerConfig>> {
    const candidatesPromise = this._dbMethods.getAgentsWithMCPServerNames();
    const principalsPromise: Promise<ResolvedPrincipal[]> | undefined = userId
      ? this._aclService.getUserPrincipals({ userId, role })
      : undefined;
    const principalsResolved = principalsPromise ?? Promise.resolve([] as ResolvedPrincipal[]);

    /** Direct-server ids depend on principals only for the user path; chaining
     *  attaches a rejection handler at creation for both branches, and the
     *  direct-server fetch follows the ids immediately. */
    const directResultsPromise = (
      principalsPromise
        ? principalsPromise.then((principalsList) =>
            this._aclService.findAccessibleResourcesForPrincipals({
              principalsList,
              requiredPermissions: PermissionBits.VIEW,
              resourceType: ResourceType.MCPSERVER,
            }),
          )
        : this._aclService.findPubliclyAccessibleResources({
            resourceType: ResourceType.MCPSERVER,
            requiredPermissions: PermissionBits.VIEW,
          })
    ).then((ids) => this._dbMethods.getListMCPServersByIds({ ids }));

    /** The agent-side ACL needs only candidates and principals; chaining it
     *  from those keeps the independent direct-server path off its critical
     *  path, and the outer settlement attaches handlers to everything else. */
    const agentAccessPromise = Promise.all([candidatesPromise, principalsResolved]).then(
      ([agentCandidates, principalsList]) =>
        this.findAccessibleAgentIds(
          agentCandidates.map((agent) => agent._id),
          userId,
          principalsList,
        ),
    );

    const [agentCandidates, accessibleAgentIds, directResults] = await Promise.all([
      candidatesPromise,
      agentAccessPromise,
      directResultsPromise,
    ]);

    logger.debug(
      `[ServerConfigsDB.getAll] resolving access for ${userId ?? 'public'}; ${agentCandidates.length} agent candidate(s) reference MCP servers`,
    );

    const agentMCPServerNames = unionMCPServerNames(agentCandidates, accessibleAgentIds);

    const parsedConfigs: Record<string, ParsedServerConfig> = {};
    const directData = directResults.data || [];
    const directServerNames = new Set(directData.map((s: MCPServerDocument) => s.serverName));

    const directParsed = await Promise.all(
      directData.map((s: MCPServerDocument) => this.mapDBServerToParsedConfig(s)),
    );
    directData.forEach((s: MCPServerDocument, i: number) => {
      parsedConfigs[s.serverName] = directParsed[i];
    });

    const agentOnlyServerNames = agentMCPServerNames.filter((name) => !directServerNames.has(name));

    if (agentOnlyServerNames.length > 0) {
      const agentServers = await this._dbMethods.getListMCPServersByNames({
        names: agentOnlyServerNames,
      });

      const agentData = agentServers.data || [];
      const agentParsed = await Promise.all(
        agentData.map((s: MCPServerDocument) => this.mapDBServerToParsedConfig(s)),
      );
      agentData.forEach((s: MCPServerDocument, i: number) => {
        parsedConfigs[s.serverName] = { ...agentParsed[i], consumeOnly: true };
      });
    }

    return parsedConfigs;
  }

  /** No-op for DB storage; logs a warning if called. */
  public async reset(): Promise<void> {
    logger.warn('Attempt to reset the DB config storage');
    return;
  }

  /**
   * Maps a MongoDB server document to the ParsedServerConfig format.
   * Decrypts sensitive fields (oauth.client_secret) after retrieval.
   */
  private async mapDBServerToParsedConfig(
    serverDBDoc: MCPServerDocument,
  ): Promise<ParsedServerConfig> {
    const authorId =
      serverDBDoc.author != null
        ? (serverDBDoc.author as unknown as Types.ObjectId | string).toString()
        : undefined;
    const config: ParsedServerConfig = {
      ...serverDBDoc.config,
      dbId: (serverDBDoc._id as Types.ObjectId).toString(),
      source: 'user',
      updatedAt: serverDBDoc.updatedAt?.getTime(),
      ...(authorId ? { author: authorId } : {}),
    };
    return sanitizeUserManagedOAuthConfig(
      await this.decryptConfig(normalizeLegacyHeaderMaps(config)),
    );
  }

  /**
   * Transforms user-provided API key config by auto-generating customUserVars and headers.
   * This is a config transformation, not encryption.
   * @param config - The server config to transform
   * @returns The transformed config with customUserVars and headers set up
   */
  private transformUserApiKeyConfig(
    config: ParsedServerConfig,
    existingConfig?: ParsedServerConfig,
  ): ParsedServerConfig {
    if (!config.apiKey || config.apiKey.source !== 'user') {
      return config;
    }

    const result = { ...config };
    const headerName =
      result.apiKey!.authorization_type === 'custom'
        ? result.apiKey!.custom_header || 'X-Api-Key'
        : 'Authorization';

    const variable = getUserApiKeyVariable(config, existingConfig);
    const placeholder = `{{${variable}}}`;
    let headerValue: string;
    if (result.apiKey!.authorization_type === 'basic') {
      headerValue = `Basic ${placeholder}`;
    } else if (result.apiKey!.authorization_type === 'bearer') {
      headerValue = `Bearer ${placeholder}`;
    } else {
      headerValue = placeholder;
    }

    const customUserVars: NonNullable<ParsedServerConfig['customUserVars']> = {
      ...result.customUserVars,
    };
    for (const name of Object.keys(customUserVars)) {
      if (isGeneratedUserApiKeyVariable(name)) {
        delete customUserVars[name];
      }
    }
    result.customUserVars = {
      ...customUserVars,
      [variable]: {
        title: 'API Key',
        description: 'Your API key for this MCP server',
      },
    };

    /** Cast to access headers property (not available on Stdio type) */
    const resultWithHeaders = result as ParsedServerConfig & {
      headers?: Record<string, string>;
    };
    resultWithHeaders.headers = {
      ...resultWithHeaders.headers,
      [headerName]: headerValue,
    };

    // Remove key field since it's user-provided (destructure to omit, not set to undefined)

    const { key: _removed, ...apiKeyWithoutKey } = result.apiKey!;
    result.apiKey = apiKeyWithoutKey;

    return result;
  }

  /**
   * Encrypts sensitive fields in config before database storage.
   * Encrypts oauth.client_secret and apiKey.key (when source === 'admin').
   * Throws on failure to prevent storing plaintext secrets.
   */
  private async encryptConfig(config: ParsedServerConfig): Promise<ParsedServerConfig> {
    let result = { ...config };

    if (result.apiKey?.source === 'admin' && result.apiKey.key) {
      try {
        result.apiKey = {
          ...result.apiKey,
          key: await encryptV2(result.apiKey.key),
        };
      } catch (error) {
        logger.error('[ServerConfigsDB.encryptConfig] Failed to encrypt apiKey.key', error);
        throw new Error('Failed to encrypt MCP server configuration');
      }
    }

    if (result.oauth?.client_secret) {
      try {
        result = {
          ...result,
          oauth: {
            ...result.oauth,
            client_secret: await encryptV2(result.oauth.client_secret),
          },
        };
      } catch (error) {
        logger.error('[ServerConfigsDB.encryptConfig] Failed to encrypt client_secret', error);
        throw new Error('Failed to encrypt MCP server configuration');
      }
    }

    return result;
  }

  /**
   * Decrypts sensitive fields in config after database retrieval.
   * Decrypts oauth.client_secret and apiKey.key (when source === 'admin').
   * Returns config without secret on failure (graceful degradation).
   */
  private async decryptConfig(config: ParsedServerConfig): Promise<ParsedServerConfig> {
    let result = { ...config };

    if (result.apiKey?.source === 'admin' && result.apiKey.key) {
      try {
        result.apiKey = {
          ...result.apiKey,
          key: await decryptV2(result.apiKey.key),
        };
      } catch (error) {
        logger.warn(
          '[ServerConfigsDB.decryptConfig] Failed to decrypt apiKey.key, returning config without key',
          error,
        );

        const { key: _removedKey, ...apiKeyWithoutKey } = result.apiKey;
        result.apiKey = apiKeyWithoutKey;
      }
    }

    if (result.oauth?.client_secret) {
      const oauthConfig = result.oauth as { client_secret: string } & typeof result.oauth;
      try {
        result = {
          ...result,
          oauth: {
            ...oauthConfig,
            client_secret: await decryptV2(oauthConfig.client_secret),
          },
        };
      } catch (error) {
        logger.warn(
          '[ServerConfigsDB.decryptConfig] Failed to decrypt client_secret, returning config without secret',
          error,
        );

        const { client_secret: _removed, ...oauthWithoutSecret } = oauthConfig;
        result = {
          ...result,
          oauth: oauthWithoutSecret,
        };
      }
    }

    return result;
  }
}
