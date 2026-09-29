import { logger, getTenantId } from '@librechat/data-schemas';
import { Constants, PrincipalType, type MCPOptions } from 'librechat-data-provider';
import type { TokenMethods } from '@librechat/data-schemas';
import type { FlowStateManager } from '~/flow/manager';
import type { ParsedServerConfig } from '~/mcp/types';
import type { MCPOAuthTokens } from './types';
import { getMCPAppToolsPublicationGeneration } from '~/mcp/toolsChanged';
import { getMCPOAuthLeaseId, MCPTokenStorage } from './tokens';
import { MCPOAuthHandler } from './handler';
import { isOAuthServer } from '~/mcp/utils';

export function getMCPServerGeneration(config: ParsedServerConfig): string {
  const definitionGeneration = getMCPAppToolsPublicationGeneration(config);
  if (config.dbId) {
    return `db:${config.dbId}:${definitionGeneration}`;
  }
  return `config:${definitionGeneration}`;
}

interface CleanupConfig {
  mcpSettings?: {
    allowedDomains?: string[] | null;
    allowedAddresses?: string[] | null;
  };
  mcpServers?: Record<string, MCPOptions>;
}

interface OAuthAclSubject {
  principalType: string;
  principalId?: { toString(): string } | string | null;
}

export interface MCPServerOAuthDeletionSnapshot {
  tokenUserIds: string[];
  aclEntries: OAuthAclSubject[];
}

interface PrepareDeletionParams {
  getTokenUserIds: () => Promise<Array<{ toString(): string } | string>>;
  getAclEntries: () => Promise<OAuthAclSubject[]>;
}

export async function prepareMCPServerOAuthDeletion({
  getTokenUserIds,
  getAclEntries,
}: PrepareDeletionParams): Promise<MCPServerOAuthDeletionSnapshot> {
  const [tokenUserIds, aclEntries] = await Promise.all([getTokenUserIds(), getAclEntries()]);
  return { tokenUserIds: tokenUserIds.map(String), aclEntries };
}

interface CleanupDeletedUsersParams {
  ownerUserId: string;
  serverName: string;
  serverConfig: MCPOptions;
  snapshot: MCPServerOAuthDeletionSnapshot;
  getTokenUserIds: () => Promise<Array<{ toString(): string } | string>>;
  getUserPrincipals: (userId: string) => Promise<OAuthAclSubject[]>;
  resolveAllowlists: (
    userId: string,
  ) => Promise<{ allowedDomains?: string[] | null; allowedAddresses?: string[] | null }>;
  fenceAndDisconnectUser?: (userId: string) => Promise<void>;
  uninstallOAuthMCP?: (
    userId: string,
    pluginKey: string,
    appConfig: CleanupConfig,
    serverConfig: MCPOptions,
  ) => Promise<void>;
}

const OAUTH_CLEANUP_CONCURRENCY = 10;

export async function cleanupDeletedMCPServerOAuthUsers({
  ownerUserId,
  serverName,
  serverConfig,
  snapshot,
  getTokenUserIds,
  getUserPrincipals,
  resolveAllowlists,
  fenceAndDisconnectUser,
  uninstallOAuthMCP,
}: CleanupDeletedUsersParams): Promise<void> {
  const tokenUserIdsAfterDelete = (await getTokenUserIds()).map(String);
  const candidateUserIds = [
    ...new Set([ownerUserId, ...snapshot.tokenUserIds, ...tokenUserIdsAfterDelete]),
  ];
  const affectedUserIds = [ownerUserId];
  const sharedCandidates = candidateUserIds.filter((userId) => userId !== ownerUserId);
  const failures: unknown[] = [];

  for (let offset = 0; offset < sharedCandidates.length; offset += OAUTH_CLEANUP_CONCURRENCY) {
    const batch = sharedCandidates.slice(offset, offset + OAUTH_CLEANUP_CONCURRENCY);
    const results = await Promise.allSettled(batch.map(getUserPrincipals));
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status === 'rejected') {
        failures.push(result.reason);
        logger.warn(
          `[cleanupDeletedMCPServerOAuthUsers] Failed to resolve MCP principals for user ${batch[index]}:`,
          result.reason,
        );
        continue;
      }
      const hadAccess = snapshot.aclEntries.some((entry) =>
        result.value.some(
          (principal) =>
            principal.principalType === entry.principalType &&
            (principal.principalType === PrincipalType.PUBLIC ||
              principal.principalId?.toString() === entry.principalId?.toString()),
        ),
      );
      if (hadAccess) {
        affectedUserIds.push(batch[index]);
      }
    }
  }

  for (let offset = 0; offset < affectedUserIds.length; offset += OAUTH_CLEANUP_CONCURRENCY) {
    const batch = affectedUserIds.slice(offset, offset + OAUTH_CLEANUP_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (userId) => {
        const userFailures: unknown[] = [];
        try {
          await fenceAndDisconnectUser?.(userId);
        } catch (error) {
          userFailures.push(error);
        }
        try {
          const { allowedDomains, allowedAddresses } = await resolveAllowlists(userId);
          await uninstallOAuthMCP?.(
            userId,
            `${Constants.mcp_prefix}${serverName}`,
            { mcpSettings: { allowedDomains, allowedAddresses } },
            serverConfig,
          );
        } catch (error) {
          userFailures.push(error);
        }
        if (userFailures.length > 0) {
          throw new Error(`OAuth cleanup failed for user ${userId}`);
        }
      }),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        failures.push(result.reason);
        logger.warn(
          `[cleanupDeletedMCPServerOAuthUsers] OAuth cleanup failed for ${serverName}:`,
          result.reason,
        );
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`OAuth cleanup failed for ${serverName} (${failures.length} operation(s))`);
  }
}

export interface MCPOAuthCleanupDependencies {
  flowManager: FlowStateManager<MCPOAuthTokens | null>;
  oauthHandler: Pick<
    typeof MCPOAuthHandler,
    'generateFlowId' | 'generateTokenFlowId' | 'deleteFlowAndStateMapping' | 'revokeOAuthToken'
  >;
  tokenStorage: Pick<
    typeof MCPTokenStorage,
    'deleteUserTokens' | 'getClientInfoAndMetadata' | 'getTokens' | 'assertCredentialSetBinding'
  > &
    Partial<Pick<typeof MCPTokenStorage, 'beginRefreshTeardown'>>;
  findToken: TokenMethods['findToken'];
  deleteTokens: TokenMethods['deleteTokens'];
  getServerConfig: (serverName: string, userId: string) => Promise<MCPOptions | undefined>;
  isRegisteredOAuthServer: (serverName: string, userId: string) => Promise<boolean>;
}

interface ClearStateParams {
  userId: string;
  serverName: string;
  dependencies: Pick<
    MCPOAuthCleanupDependencies,
    'flowManager' | 'deleteTokens' | 'oauthHandler' | 'tokenStorage'
  >;
  skipOAuthFlows?: boolean;
  credentialSetId?: string | null;
  tokenSnapshot?: Map<string, string>;
}

const oauthTokenKeys = (serverName: string) => {
  const identifier = `mcp:${serverName}`;
  return [
    { type: 'mcp_oauth_client', identifier: `${identifier}:client` },
    { type: 'mcp_oauth', identifier },
    { type: 'mcp_oauth_refresh', identifier: `${identifier}:refresh` },
  ];
};

export async function clearStoredMCPOAuthState({
  userId,
  serverName,
  dependencies,
  skipOAuthFlows = false,
  credentialSetId,
  tokenSnapshot,
}: ClearStateParams): Promise<void> {
  try {
    await dependencies.tokenStorage.deleteUserTokens({
      userId,
      serverName,
      deleteToken: async (filter) => {
        const snapshotToken = tokenSnapshot?.get(`${filter.type}:${filter.identifier}`);
        if (tokenSnapshot && !snapshotToken) {
          return;
        }
        await dependencies.deleteTokens({
          ...filter,
          ...(snapshotToken && { token: snapshotToken }),
          ...(!tokenSnapshot &&
            credentialSetId !== undefined && { metadataCredentialSetId: credentialSetId }),
        });
      },
    });
  } catch (error) {
    logger.warn(
      `[clearStoredMCPOAuthState] Failed to delete MCP OAuth tokens for ${serverName}:`,
      error,
    );
  }

  const tenantId = getTenantId();
  const baseFlowId = dependencies.oauthHandler.generateFlowId(userId, serverName);
  const flowDeletes = [
    [dependencies.oauthHandler.generateTokenFlowId(userId, serverName, tenantId), 'mcp_get_tokens'],
    [dependencies.oauthHandler.generateFlowId(userId, serverName, tenantId), 'mcp_get_tokens'],
    [baseFlowId, 'mcp_get_tokens'],
    ...(!skipOAuthFlows
      ? ([
          [dependencies.oauthHandler.generateFlowId(userId, serverName, tenantId), 'mcp_oauth'],
          [baseFlowId, 'mcp_oauth'],
        ] as Array<[string, string]>)
      : []),
  ] satisfies Array<[string, string]>;
  const uniqueFlowDeletes = flowDeletes.filter(
    ([flowId, type], index, deletes) =>
      deletes.findIndex(
        ([candidateId, candidateType]) => candidateId === flowId && candidateType === type,
      ) === index,
  );
  const results = await Promise.allSettled(
    uniqueFlowDeletes.map(([flowId, type]) =>
      type === 'mcp_oauth'
        ? dependencies.oauthHandler.deleteFlowAndStateMapping(flowId, dependencies.flowManager)
        : dependencies.flowManager.deleteFlow(flowId, type),
    ),
  );
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn(
        `[clearStoredMCPOAuthState] Failed to clear MCP OAuth flow state for ${serverName}:`,
        result.reason,
      );
    }
  }
}

interface UninstallParams {
  userId: string;
  pluginKey: string;
  appConfig?: CleanupConfig;
  serverConfigOverride?: MCPOptions;
  dependencies: MCPOAuthCleanupDependencies;
}

export async function cleanupMCPServerOAuth(params: UninstallParams): Promise<void> {
  const { userId, pluginKey, dependencies } = params;
  if (!pluginKey.startsWith(Constants.mcp_prefix)) {
    return;
  }
  const serverName = pluginKey.replace(Constants.mcp_prefix, '');
  const releaseRefreshTeardown =
    (await dependencies.tokenStorage.beginRefreshTeardown?.(userId, serverName)) ?? (() => {});
  let teardownLease: Awaited<ReturnType<typeof dependencies.flowManager.acquireLease>> = null;
  let leaseError: unknown;
  try {
    try {
      teardownLease = await dependencies.flowManager.acquireLease(
        getMCPOAuthLeaseId(userId, serverName),
        { advanceGeneration: true, waitMs: 60_000 },
      );
      if (!teardownLease) {
        leaseError = new Error(`Unable to acquire OAuth teardown lease for ${serverName}`);
      }
    } catch (error) {
      leaseError = error;
    }
    await cleanupMCPServerOAuthWithFenceHeld(params);
    if (leaseError) {
      throw leaseError;
    }
  } finally {
    try {
      await teardownLease?.release();
    } finally {
      releaseRefreshTeardown();
    }
  }
}

async function cleanupMCPServerOAuthWithFenceHeld({
  userId,
  pluginKey,
  appConfig,
  serverConfigOverride,
  dependencies,
}: UninstallParams): Promise<void> {
  const serverName = pluginKey.replace(Constants.mcp_prefix, '');
  /** Snapshot exact encrypted values before cancelling the flow. Later cleanup can then remove
   * this authorization without matching credentials written by a replacement attempt. */
  const tokenKeys = oauthTokenKeys(serverName);
  const clientTokenKey = tokenKeys[0];
  type TokenRecord = Awaited<ReturnType<TokenMethods['findToken']>>;
  const getCredentialSetId = (record: TokenRecord): string | undefined => {
    if (!record) {
      return undefined;
    }
    const metadata =
      record.metadata instanceof Map
        ? Object.fromEntries(record.metadata)
        : (record.metadata ?? {});
    return typeof metadata.credential_set_id === 'string' ? metadata.credential_set_id : undefined;
  };
  let tokenRecords = new Map<string, TokenRecord>();
  let snapshotSupportsRevocation = false;
  /** The client record is the credential-set commit marker. Bookending the remaining reads with
   * it prevents teardown from combining records on opposite sides of a concurrent callback. */
  for (let attempt = 0; attempt < 3; attempt++) {
    const clientBefore = await dependencies.findToken({ userId, ...clientTokenKey });
    const remainingRecords = await Promise.all(
      tokenKeys
        .slice(1)
        .map(async (key) => [key, await dependencies.findToken({ userId, ...key })] as const),
    );
    const clientAfter = await dependencies.findToken({ userId, ...clientTokenKey });
    const candidate = new Map<string, TokenRecord>([
      [`${clientTokenKey.type}:${clientTokenKey.identifier}`, clientAfter],
      ...remainingRecords.map(
        ([key, record]) => [`${key.type}:${key.identifier}`, record] as const,
      ),
    ]);
    const presentRecords = [...candidate.values()].filter(
      (record): record is NonNullable<TokenRecord> => record != null,
    );
    const generations = presentRecords
      .map(getCredentialSetId)
      .filter((generation): generation is string => generation != null);
    const clientUnchanged =
      clientBefore?.token === clientAfter?.token &&
      getCredentialSetId(clientBefore) === getCredentialSetId(clientAfter);
    const generationCoherent = new Set(generations).size <= 1;
    if (clientUnchanged && generationCoherent) {
      tokenRecords = candidate;
      snapshotSupportsRevocation =
        presentRecords.length > 0 && generations.length === presentRecords.length;
      break;
    }
  }
  if (tokenRecords.size === 0) {
    throw new Error(`Unable to obtain a coherent OAuth credential snapshot for ${serverName}`);
  }
  const tokenSnapshot = new Map<string, string>();
  const tokenGenerationSnapshot = new Map<string, string>();
  for (const [key, record] of tokenRecords) {
    if (!record?.token) {
      continue;
    }
    tokenSnapshot.set(key, record.token);
    const metadata =
      record.metadata instanceof Map
        ? Object.fromEntries(record.metadata)
        : (record.metadata ?? {});
    if (typeof metadata.credential_set_id === 'string') {
      tokenGenerationSnapshot.set(key, metadata.credential_set_id);
    }
  }
  const findSnapshottedToken: TokenMethods['findToken'] = async (query) => {
    if (!query.type || !query.identifier) {
      return null;
    }
    return tokenRecords.get(`${query.type}:${query.identifier}`) ?? null;
  };
  const serverConfig =
    serverConfigOverride ??
    (await dependencies.getServerConfig(serverName, userId)) ??
    appConfig?.mcpServers?.[serverName];
  const oauthServer = serverConfigOverride
    ? isOAuthServer(serverConfigOverride)
    : await dependencies.isRegisteredOAuthServer(serverName, userId);
  let clientTokenData = null;
  let tokens = null;
  if (oauthServer && serverConfig) {
    try {
      clientTokenData = await dependencies.tokenStorage.getClientInfoAndMetadata({
        userId,
        serverName,
        findToken: findSnapshottedToken,
      });
      const clientKey = `mcp_oauth_client:mcp:${serverName}:client`;
      if (
        !snapshotSupportsRevocation ||
        clientTokenData?.clientMetadata.credential_set_id !== tokenGenerationSnapshot.get(clientKey)
      ) {
        clientTokenData = null;
      }
    } catch (error) {
      logger.warn(
        `[maybeUninstallOAuthMCP] Unable to load OAuth client metadata for ${serverName}; clearing local MCP OAuth state only.`,
        error,
      );
    }
    if (clientTokenData) {
      try {
        tokens = await dependencies.tokenStorage.getTokens({
          userId,
          serverName,
          findToken: findSnapshottedToken,
        });
        if (tokens) {
          dependencies.tokenStorage.assertCredentialSetBinding(
            serverName,
            tokens.credential_set_id,
            clientTokenData.clientMetadata,
          );
        }
      } catch (error) {
        tokens = null;
        logger.warn(
          `[maybeUninstallOAuthMCP] Unable to load OAuth tokens for ${serverName}; clearing local token state.`,
          error,
        );
      }
    }
  }
  const flowIds = [
    dependencies.oauthHandler.generateFlowId(userId, serverName, getTenantId()),
    dependencies.oauthHandler.generateFlowId(userId, serverName),
  ];
  const flowResults = await Promise.allSettled(
    [...new Set(flowIds)].map((flowId) =>
      dependencies.oauthHandler.deleteFlowAndStateMapping(flowId, dependencies.flowManager),
    ),
  );
  for (const result of flowResults) {
    if (result.status === 'rejected') {
      logger.warn(
        `[clearStoredMCPOAuthState] Failed to clear MCP OAuth flow state for ${serverName}:`,
        result.reason,
      );
    }
  }

  if (!oauthServer || !serverConfig) {
    await clearStoredMCPOAuthState({
      userId,
      serverName,
      dependencies,
      skipOAuthFlows: true,
      tokenSnapshot,
    });
    return;
  }

  if (!clientTokenData) {
    await clearStoredMCPOAuthState({
      userId,
      serverName,
      dependencies,
      skipOAuthFlows: true,
      tokenSnapshot,
    });
    return;
  }

  const { clientInfo, clientMetadata } = clientTokenData;
  const credentialSetId = clientMetadata.credential_set_id;
  const storedServerUrl = clientMetadata.server_url;
  const storedClientSource = clientMetadata.client_source;
  if (
    typeof storedServerUrl !== 'string' ||
    typeof clientMetadata.token_endpoint !== 'string' ||
    typeof clientMetadata.revocation_endpoint !== 'string' ||
    typeof credentialSetId !== 'string' ||
    (storedClientSource !== 'configured' && storedClientSource !== 'dynamic')
  ) {
    logger.warn(
      `[maybeUninstallOAuthMCP] Stored binding is incomplete for ${serverName}; clearing local state.`,
    );
    await clearStoredMCPOAuthState({
      userId,
      serverName,
      dependencies,
      skipOAuthFlows: true,
      credentialSetId: typeof credentialSetId === 'string' ? credentialSetId : null,
      tokenSnapshot,
    });
    return;
  }

  const revocationMetadata = {
    serverUrl: storedServerUrl,
    clientId: clientInfo.client_id,
    clientSecret: clientInfo.client_secret ?? '',
    revocationEndpoint: clientMetadata.revocation_endpoint,
    revocationEndpointAuthMethodsSupported: Array.isArray(
      clientMetadata.revocation_endpoint_auth_methods_supported,
    )
      ? clientMetadata.revocation_endpoint_auth_methods_supported.filter(
          (method): method is string => typeof method === 'string',
        )
      : undefined,
  };
  const oauthHeaders = serverConfig.oauth_headers ?? {};
  const allowedDomains = appConfig?.mcpSettings?.allowedDomains;
  const allowedAddresses = appConfig?.mcpSettings?.allowedAddresses;
  for (const [tokenType, token] of [
    ['access', tokens?.access_token],
    ['refresh', tokens?.refresh_token],
  ] as const) {
    if (!token) {
      continue;
    }
    try {
      await dependencies.oauthHandler.revokeOAuthToken(
        serverName,
        token,
        tokenType,
        revocationMetadata,
        oauthHeaders,
        allowedDomains,
        allowedAddresses,
      );
    } catch (error) {
      logger.error(`[maybeUninstallOAuthMCP] Error revoking ${tokenType} token:`, error);
    }
  }

  await clearStoredMCPOAuthState({
    userId,
    serverName,
    dependencies,
    skipOAuthFlows: true,
    credentialSetId,
    tokenSnapshot,
  });
}
