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

export interface OAuthAclSubject {
  principalType: string;
  principalId?: { toString(): string } | string | null;
}

export interface MCPServerOAuthDeletionSnapshot {
  tokenUserIds: string[];
  aclEntries: OAuthAclSubject[];
  /** Users the view ACL names directly or through a group, whether or not they hold a token. */
  viewerUserIds?: string[];
}

interface PrepareDeletionParams {
  getTokenUserIds: () => Promise<Array<{ toString(): string } | string>>;
  getAclEntries: () => Promise<OAuthAclSubject[]>;
  getViewerUserIds?: (entries: OAuthAclSubject[]) => Promise<string[]>;
}

export async function prepareMCPServerOAuthDeletion({
  getTokenUserIds,
  getAclEntries,
  getViewerUserIds,
}: PrepareDeletionParams): Promise<MCPServerOAuthDeletionSnapshot> {
  const [tokenUserIds, { aclEntries, viewerUserIds }] = await Promise.all([
    getTokenUserIds(),
    getAclEntries().then(async (entries) => ({
      aclEntries: entries,
      viewerUserIds: getViewerUserIds ? (await getViewerUserIds(entries)).map(String) : [],
    })),
  ]);
  return { tokenUserIds: tokenUserIds.map(String), aclEntries, viewerUserIds };
}

export const MCP_OAUTH_REVOCATION_REFUSED = 'MCP_OAUTH_REVOCATION_REFUSED' as const;

/**
 * The provider did not revoke a grant. Local credentials are already gone when this is thrown,
 * so it reports an external grant that may stay valid rather than a teardown that failed.
 */
export class MCPOAuthRevocationError extends Error {
  readonly code: typeof MCP_OAUTH_REVOCATION_REFUSED = MCP_OAUTH_REVOCATION_REFUSED;
  constructor(
    readonly serverName: string,
    readonly tokenTypes: string[],
  ) {
    super(`OAuth provider did not revoke the ${tokenTypes.join(' and ')} token for ${serverName}`);
    this.name = 'MCPOAuthRevocationError';
  }
}

/** Matched by code, since hosts can load a second copy of this module. */
export function isMCPOAuthRevocationError(error: unknown): error is MCPOAuthRevocationError {
  return (
    error instanceof Error &&
    (error as Partial<MCPOAuthRevocationError>).code === MCP_OAUTH_REVOCATION_REFUSED
  );
}

/** A user whose provider grant may outlive the removed server. */
export interface MCPOAuthRevocationFailure {
  userId: string;
  tokenTypes: string[];
}

/** How a server-removal teardown treats the provider and the per-user OAuth fence. */
export interface MCPOAuthTeardownOptions {
  /**
   * Clears local state, then rejects with an `MCPOAuthRevocationError` when the provider refused a
   * revocation, so the caller learns which grants may stay valid.
   */
  strictRevocation?: boolean;
  /**
   * Receives a successful teardown's fence instead of releasing it, so the caller can keep new
   * authorizations and refreshes out until the server record is gone.
   */
  retainFence?: (fence: MCPOAuthRetainedFence) => void;
}

/** A teardown fence the caller holds past the teardown itself. */
export interface MCPOAuthRetainedFence {
  /** Extends the lease; false when it lapsed and another writer took it in the meantime. */
  renew: () => Promise<boolean>;
  release: () => Promise<void>;
}

interface CleanupDeletedUsersParams {
  ownerUserId: string;
  serverName: string;
  serverConfig?: MCPOptions;
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
    serverConfig?: MCPOptions,
    teardown?: MCPOAuthTeardownOptions,
  ) => Promise<void>;
  /**
   * Set where the server record outlives this cleanup: refused revocations are returned instead of
   * logged only, and each user's fence is held until the record is deleted. A provider cannot fail
   * the cleanup, since it could otherwise block the removal indefinitely.
   */
  strictRevocation?: boolean;
  retainFence?: MCPOAuthTeardownOptions['retainFence'];
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
  strictRevocation,
  retainFence,
}: CleanupDeletedUsersParams): Promise<MCPOAuthRevocationFailure[]> {
  const tokenUserIdsAfterDelete = (await getTokenUserIds()).map(String);
  const candidateUserIds = [
    ...new Set([ownerUserId, ...snapshot.tokenUserIds, ...tokenUserIdsAfterDelete]),
  ];
  /** Named by the view ACL itself, so they had access without a principal lookup. */
  const viewerUserIds = new Set(
    (snapshot.viewerUserIds ?? []).filter((userId) => userId !== ownerUserId),
  );
  const affectedUserIds = [ownerUserId, ...viewerUserIds];
  const sharedCandidates = candidateUserIds.filter(
    (userId) => userId !== ownerUserId && !viewerUserIds.has(userId),
  );
  const failures: unknown[] = [];
  const revocationFailures: MCPOAuthRevocationFailure[] = [];

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
            { strictRevocation, retainFence },
          );
        } catch (error) {
          if (isMCPOAuthRevocationError(error)) {
            revocationFailures.push({ userId, tokenTypes: error.tokenTypes });
          } else {
            userFailures.push(error);
          }
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
  return revocationFailures;
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
  /** Rethrows a failed token delete after flow state is cleared. */
  strict?: boolean;
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
  strict = false,
}: ClearStateParams): Promise<void> {
  let tokenDeleteError: unknown;
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
    tokenDeleteError = error;
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
  if (strict && tokenDeleteError) {
    throw new Error(`Failed to delete stored MCP OAuth tokens for ${serverName}`);
  }
}

interface UninstallParams {
  userId: string;
  pluginKey: string;
  appConfig?: CleanupConfig;
  serverConfigOverride?: MCPOptions;
  dependencies: MCPOAuthCleanupDependencies;
  teardown?: MCPOAuthTeardownOptions;
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
  const releaseFence = async () => {
    try {
      await teardownLease?.release();
    } finally {
      releaseRefreshTeardown();
    }
  };
  let fenceRetained = false;
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
    let revocationError: MCPOAuthRevocationError | undefined;
    try {
      await cleanupMCPServerOAuthWithFenceHeld(params);
    } catch (error) {
      if (!isMCPOAuthRevocationError(error)) {
        throw error;
      }
      revocationError = error;
    }
    if (leaseError) {
      throw leaseError;
    }
    const retainFence = params.teardown?.retainFence;
    if (retainFence) {
      const lease = teardownLease;
      retainFence({
        renew: async () => (lease?.renew ? lease.renew() : lease != null),
        release: releaseFence,
      });
      fenceRetained = true;
    }
    /** Local state is cleared and the fence is handed over; only the provider grant remains. */
    if (revocationError) {
      throw revocationError;
    }
  } finally {
    if (!fenceRetained) {
      await releaseFence();
    }
  }
}

async function cleanupMCPServerOAuthWithFenceHeld({
  userId,
  pluginKey,
  appConfig,
  serverConfigOverride,
  dependencies,
  teardown,
}: UninstallParams): Promise<void> {
  const strict = teardown?.strictRevocation === true;
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
      strict,
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
      strict,
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
      strict,
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
  const revocationFailures: string[] = [];
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
      revocationFailures.push(tokenType);
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
    strict,
  });
  if (strict && revocationFailures.length > 0) {
    throw new MCPOAuthRevocationError(serverName, revocationFailures);
  }
}
