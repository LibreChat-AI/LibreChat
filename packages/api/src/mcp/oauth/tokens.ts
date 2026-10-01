import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { MAX_MCP_OAUTH_PERSISTENCE_WAIT_MS } from 'librechat-data-provider';
import { logger, encryptV2, decryptV2, getTenantId } from '@librechat/data-schemas';
import type {
  TokenMethods,
  IToken,
  TokenCreateData,
  TokenUpdateData,
} from '@librechat/data-schemas';
import type { OAuthTokens, OAuthClientInformation } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { MCPOAuthTokens, ExtendedOAuthTokens, OAuthStoredClientMetadata } from './types';
import type { FlowLease, FlowStateManager } from '~/flow/manager';
import { isInvalidClientMessage } from '~/mcp/utils';
import { isSystemUserId } from '~/mcp/enum';

export class ReauthenticationRequiredError extends Error {
  constructor(serverName: string, reason: 'expired' | 'missing' | 'invalid_client' | 'binding') {
    let detail: string;
    if (reason === 'invalid_client') {
      detail = 'stored client registration is no longer valid';
    } else if (reason === 'binding') {
      detail = 'stored OAuth binding metadata is missing or no longer valid';
    } else {
      detail = `access token ${reason} and no refresh token available`;
    }
    super(`Re-authentication required for "${serverName}": ${detail}`);
    this.name = 'ReauthenticationRequiredError';
  }
}

/** Durable credentials could not be read or decrypted. This is retryable infrastructure state,
 * never evidence that the user must authorize the server again. */
export class MCPTokenStorageUnavailableError extends Error {
  constructor(serverName: string, cause: unknown) {
    super(`OAuth token storage is unavailable for "${serverName}"`, { cause });
    this.name = 'MCPTokenStorageUnavailableError';
  }
}

/** The refresh credential may still be usable, but its provider could not complete this attempt. */
export class MCPTokenRefreshUnavailableError extends Error {
  constructor(serverName: string, cause: unknown) {
    super(`OAuth token refresh is temporarily unavailable for "${serverName}"`, { cause });
    this.name = 'MCPTokenRefreshUnavailableError';
  }
}

interface StoreTokensParams {
  /** Interactive writers share the persistence fence with refresh, adoption, and teardown. */
  flowManager?: Pick<FlowStateManager, 'acquireLease'>;
  persistenceWaitTimeoutMs?: number;
  userId: string;
  serverName: string;
  tokens: OAuthTokens | ExtendedOAuthTokens | MCPOAuthTokens;
  createToken: TokenMethods['createToken'];
  updateToken?: TokenMethods['updateToken'];
  deleteTokens?: TokenMethods['deleteTokens'];
  findToken?: TokenMethods['findToken'];
  clientInfo?: OAuthClientInformation;
  metadata?: Partial<OAuthStoredClientMetadata>;
  /** Existing generation that must still own every stored record before a refresh is persisted. */
  expectedCredentialSetId?: string;
  /** Internal refresh-teardown fence; interactive authorization writes omit it. */
  signal?: AbortSignal;
  /** Optional: Pass existing token state to avoid duplicate DB calls */
  existingTokens?: {
    accessToken?: IToken | null;
    refreshToken?: IToken | null;
    clientInfoToken?: IToken | null;
  };
  /** Runs after all token rows are written but while the rollback journal is still available. */
  onStoreCommitted?: (tokens: MCPOAuthTokens) => Promise<void>;
  /** Runs after preflight reads and encryption, immediately before the first token-row write. */
  onStorePreparing?: () => Promise<void>;
}

interface GetTokensParams {
  userId: string;
  serverName: string;
  findToken: TokenMethods['findToken'];
  refreshTokens?: (
    refreshToken: string,
    metadata: {
      userId: string;
      serverName: string;
      identifier: string;
      clientInfo?: OAuthClientInformation;
      storedTokenEndpoint?: string;
      storedAuthMethods?: string[];
      storedServerUrl?: string;
      clientSource?: OAuthStoredClientMetadata['client_source'];
      resource?: string;
    },
    signal?: AbortSignal,
  ) => Promise<MCPOAuthTokens>;
  createToken?: TokenMethods['createToken'];
  updateToken?: TokenMethods['updateToken'];
  /** Enables cleanup of stale client registration and refresh token on invalid_client errors during refresh. */
  deleteTokens?: TokenMethods['deleteTokens'];
  /** Waiter-specific: aborting resolves this caller's wait with `null` without cancelling the shared redemption. */
  signal?: AbortSignal;
  /**
   * Invoked inside the shared redemption after rotated tokens are persisted.
   * Runs even when the initiating waiter has already aborted its wait, so
   * cache invalidation tied to the fresh tokens cannot be skipped by a timeout.
   */
  onRefreshSuccess?: (tokens: MCPOAuthTokens) => Promise<void>;
  /** Creates the exact post-write callback after durable fence intent is safely stored. */
  onRefreshPreparing?: () => Promise<(tokens?: MCPOAuthTokens) => Promise<void>>;
  /** Separates in-flight redemptions for the same named server under different OAuth bindings. */
  singleFlightScope?: string;
  /**
   * Invoked instead of `onRefreshSuccess` when this replica adopted a credential another
   * replica rotated. Distinct because the two carry different information: after our own
   * redemption we know the generation we published, whereas an adopted credential was
   * published by a peer under a generation only the store knows, so the caller has to
   * re-read it rather than assume the one it captured before the rotation.
   */
  onTokensAdopted?: (tokens: MCPOAuthTokens) => Promise<void>;
  /**
   * The refresh record the caller already loaded, reused as the pre-flight observation baseline.
   * `getTokens` reads it to decide a refresh is needed, so passing it keeps the flight off a path
   * the repository's latency budget already counts.
   */
  existingRefreshToken?: IToken | null;
  /** Rejected credential: null means known absence; undefined means no request identity was captured. */
  rejectedCredentialSetId?: string | null;
  /** Per-server `oauthRefreshWaitTimeout`: how long to wait on another replica's redemption. */
  refreshWaitTimeoutMs?: number;
  /** Staged capability: enable only when every writer honors the persistence fence. */
  coordinateRefresh?: boolean;
  persistenceWaitTimeoutMs?: number;
  /** Shared cache-backed fence used to serialize refresh persistence with server teardown. */
  flowManager?: Pick<FlowStateManager, 'getLeaseGeneration' | 'acquireLease'>;
}

export const getMCPOAuthLeaseId = (
  userId: string,
  serverName: string,
  tenantId: string | undefined = getTenantId(),
): string => JSON.stringify([tenantId ?? '', userId, serverName]);

/**
 * Lease that serializes refresh-token redemption for one stored credential across replicas.
 *
 * Keyed by what is stored — tenant, user, server name — and deliberately *not* by the caller's
 * OAuth binding scope, even though the process-local single-flight key carries it. The refresh
 * record lives at `mcp:<serverName>:refresh`, with no binding in its identifier, and
 * `assertCredentialSetBinding` compares only `credential_set_id`, so a config change that moves the
 * binding digest without invalidating the stored credential still permits refresh. Scoping this
 * lease by that digest would then hand two replicas different locks over one stored token during a
 * rolling config change, which is the concurrency the lease exists to remove. The scope stays where
 * it decides which callers may share a returned result, not which redemptions may run at once.
 *
 * Distinct from `getMCPOAuthLeaseId`: that lease is the teardown/persistence fence taken *inside* a
 * redemption, so one shared key would make a redemption wait on a lease it already holds.
 */
export const getMCPOAuthRefreshFlightLeaseId = (
  userId: string,
  serverName: string,
  tenantId: string | undefined = getTenantId(),
): string => JSON.stringify(['refresh', tenantId ?? '', userId, serverName]);

/**
 * Reads the `exp` claim (RFC 7519 §4.1.4 / RFC 9068) from a JWT-format access
 * token, returned as epoch milliseconds. Returns null for opaque (non-JWT)
 * tokens or when no usable `exp` is present. The signature is intentionally
 * not verified — the protected resource server validates the token; here we
 * only read its self-declared expiry to avoid a lossy default.
 */
function getJwtAccessTokenExpiry(accessToken?: string): number | null {
  if (!accessToken) {
    return null;
  }
  try {
    const decoded = jwt.decode(accessToken);
    if (
      decoded != null &&
      typeof decoded !== 'string' &&
      typeof decoded.exp === 'number' &&
      Number.isFinite(decoded.exp)
    ) {
      return decoded.exp * 1000;
    }
  } catch {
    /* Not a JWT or malformed — fall through to other expiry sources. */
  }
  return null;
}

function getTokenMetadata(tokenData: IToken | null | undefined): Record<string, unknown> {
  if (tokenData?.metadata == null) {
    return {};
  }
  if (tokenData.metadata instanceof Map) {
    return Object.fromEntries(tokenData.metadata);
  }
  return { ...(tokenData.metadata as unknown as Record<string, unknown>) };
}

function getCredentialSetId(tokenData: IToken | null | undefined): string | undefined {
  const value = getTokenMetadata(tokenData).credential_set_id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function cloneTokenMetadata(tokenData: IToken): Record<string, unknown> | Map<string, unknown> {
  if (tokenData.metadata instanceof Map) {
    return new Map(tokenData.metadata);
  }
  if (tokenData.metadata) {
    return { ...(tokenData.metadata as unknown as Record<string, unknown>) };
  }
  return {};
}

/** Outcome of trying to take the cross-replica refresh flight (`beginRefreshFlight`). */
interface MCPRefreshFlight {
  /** Held flight; the caller redeems under it and releases it once the redemption settles. */
  lease: FlowLease | null;
  /** Tokens a peer rotated while this replica waited, adopted instead of redeeming again. */
  adoptedTokens?: MCPOAuthTokens;
  /**
   * The refresh record read under the flight, handed to the redemption so one read serves both
   * rotation detection and the credential submitted. Absent when no flight manager is supplied.
   */
  leasedRefreshToken?: IToken | null;
  /** Teardown or the stale timer fired during the wait; the caller resolves null. */
  aborted?: boolean;
}

export class MCPTokenStorage {
  /**
   * Process-local in-flight refresh-token redemptions, keyed by
   * `tenantId:userId:serverName:bindingScope`. Every code path that redeems a refresh token
   * (expired-token refresh via `getTokens`, silent refresh on 401, reconnect
   * retries) converges on `forceRefreshTokens`, so coalescing here guarantees
   * at most one wire call to the token endpoint per user/server at a time.
   * RFC 9700 servers treat a replayed (already-consumed) refresh token as
   * theft and revoke the entire grant family, so concurrent redemptions are
   * not merely wasteful — they destroy the freshly issued tokens. Only
   * in-flight promises are held (no result caching): each new refresh request
   * after settlement triggers a fresh redemption.
   *
   * This map coalesces one process. Replicas are serialized by the cross-replica
   * refresh flight in `beginRefreshFlight`, because a `Map` in pod A says nothing
   * about what pod B is redeeming.
   */
  private static inflightRefreshes = new Map<string, Promise<MCPOAuthTokens | null>>();
  private static inflightRefreshControllers = new Map<string, AbortController>();
  private static inflightRefreshOwners = new Map<string, string>();
  private static refreshTeardownCounts = new Map<string, number>();

  /**
   * How long an in-flight redemption may run before it is aborted. Generous
   * relative to a healthy refresh round trip (well under a minute) so the
   * abort only fires for genuinely wedged executions. The single-flight slot
   * is freed when the aborted execution settles — never while it might still
   * reach the token endpoint with the old refresh token.
   */
  static readonly INFLIGHT_REFRESH_STALE_MS = 60_000;

  /**
   * How long the cross-replica refresh flight is held: deliberately longer than the stale window
   * above, rather than equal to it.
   *
   * Aborting a redemption stops this process from waiting on the response. It does not prove the
   * token endpoint has not already consumed the refresh token, because the request may have been
   * processed with its response lost, and a stalled event loop can delay the abort past its own
   * deadline. A replica that took the flight the instant the abort fired could therefore redeem a
   * credential the provider had already rotated, which is the replay this fence exists to prevent.
   * The margin covers that settlement instead of assuming it.
   *
   * A live replica releases the flight as soon as its redemption settles, so the margin is paid
   * only by one that died holding it, and paid as retryable failures rather than a revoked grant.
   * Expiry remains the only recovery from a dead holder, which is why there is no renewal
   * heartbeat: nothing has to keep running for the flight to be reclaimed.
   */
  private static readonly REFRESH_FLIGHT_LEASE_MS: number =
    MCPTokenStorage.INFLIGHT_REFRESH_STALE_MS * 2;

  /**
   * How long a replica waits on a flight another replica holds before failing the attempt as
   * retryable. Not a safety bound: the waiter never redeems unfenced, so this only trades latency
   * against how long a caller blocks. A contended wait normally ends within a second, when the
   * holder's rotation lands and is adopted; this governs the holder that died.
   */
  static readonly DEFAULT_REFRESH_FLIGHT_WAIT_MS = 15_000;

  /**
   * Ceiling for a configured wait: half the stale window, because the wait runs *inside* the
   * redemption whose stale timer aborts it, and the other half is what remains to redeem once the
   * flight is acquired. A larger value would hand the outcome to that abort instead of the wait.
   */
  static readonly MAX_REFRESH_FLIGHT_WAIT_MS: number =
    MCPTokenStorage.INFLIGHT_REFRESH_STALE_MS / 2;

  /** Interval between checks for a peer's rotation landing, or for its flight coming free. */
  private static readonly REFRESH_FLIGHT_POLL_MS = 250;

  /** Clamps a server's `oauthRefreshWaitTimeout` into the window the stale abort allows. */
  private static resolveRefreshFlightWaitMs(configured?: number): number {
    if (configured == null || !Number.isFinite(configured) || configured <= 0) {
      return this.DEFAULT_REFRESH_FLIGHT_WAIT_MS;
    }
    return Math.min(configured, this.MAX_REFRESH_FLIGHT_WAIT_MS);
  }

  private static resolvePersistenceWaitMs(configured?: number): number {
    if (configured == null || !Number.isFinite(configured) || configured <= 0) return 15_000;
    return Math.min(configured, MAX_MCP_OAUTH_PERSISTENCE_WAIT_MS);
  }

  static getLogPrefix(userId: string, serverName: string): string {
    return isSystemUserId(userId)
      ? `[MCP][${serverName}]`
      : `[MCP][User: ${userId}][${serverName}]`;
  }

  private static getRefreshOwnerKey(
    userId: string,
    serverName: string,
    tenantId: string | undefined = getTenantId(),
  ): string {
    return JSON.stringify([tenantId ?? '', userId, serverName]);
  }

  static isRefreshTeardownActive(
    userId: string,
    serverName: string,
    tenantId: string | undefined = getTenantId(),
  ): boolean {
    return this.refreshTeardownCounts.has(this.getRefreshOwnerKey(userId, serverName, tenantId));
  }

  /** Holds a per-user/server gate, then aborts and joins every process-local refresh that entered
   * before it. The returned release keeps successor refreshes out until teardown finishes. */
  static async beginRefreshTeardown(userId: string, serverName: string): Promise<() => void> {
    const ownerKey = this.getRefreshOwnerKey(userId, serverName);
    this.refreshTeardownCounts.set(ownerKey, (this.refreshTeardownCounts.get(ownerKey) ?? 0) + 1);
    const refreshes: Promise<MCPOAuthTokens | null>[] = [];
    for (const [key, refresh] of this.inflightRefreshes) {
      if (this.inflightRefreshOwners.get(key) !== ownerKey) {
        continue;
      }
      this.inflightRefreshControllers.get(key)?.abort();
      refreshes.push(refresh);
    }
    await Promise.allSettled(refreshes);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const remaining = (this.refreshTeardownCounts.get(ownerKey) ?? 1) - 1;
      if (remaining > 0) {
        this.refreshTeardownCounts.set(ownerKey, remaining);
      } else {
        this.refreshTeardownCounts.delete(ownerKey);
      }
    };
  }

  /** Returns whether storage contains a currently usable, generation-bound authorization. */
  static async hasStoredAuthorization({
    userId,
    serverName,
    findToken,
    validateClientBinding,
  }: {
    userId: string;
    serverName: string;
    findToken: TokenMethods['findToken'];
    validateClientBinding: (
      clientInfo: OAuthClientInformation,
      storedMetadata: Partial<OAuthStoredClientMetadata>,
    ) => void;
  }): Promise<boolean> {
    const identifier = `mcp:${serverName}`;
    try {
      const [accessTokenData, clientInfoData] = await Promise.all([
        findToken({ userId, type: 'mcp_oauth', identifier }),
        findToken({ userId, type: 'mcp_oauth_client', identifier: `${identifier}:client` }),
      ]);
      const clientCredentialSetId = getCredentialSetId(clientInfoData);
      const accessCredentialSetId = getCredentialSetId(accessTokenData);
      let hasUsableAuthorization = false;
      if (accessTokenData) {
        if (!accessCredentialSetId || clientCredentialSetId !== accessCredentialSetId) {
          return false;
        }
        if (!accessTokenData.expiresAt || accessTokenData.expiresAt > new Date()) {
          hasUsableAuthorization = true;
        }
      }

      if (!hasUsableAuthorization) {
        const refreshTokenData = await findToken({
          userId,
          type: 'mcp_oauth_refresh',
          identifier: `${identifier}:refresh`,
        });
        const refreshCredentialSetId = getCredentialSetId(refreshTokenData);
        hasUsableAuthorization =
          !!refreshCredentialSetId &&
          refreshCredentialSetId === clientCredentialSetId &&
          (!accessCredentialSetId || refreshCredentialSetId === accessCredentialSetId) &&
          (!refreshTokenData?.expiresAt || refreshTokenData.expiresAt > new Date());
      }

      if (!hasUsableAuthorization || !clientInfoData?.token) {
        return false;
      }

      const clientInfo = JSON.parse(
        await decryptV2(clientInfoData.token),
      ) as OAuthClientInformation;
      try {
        validateClientBinding(clientInfo, getTokenMetadata(clientInfoData));
      } catch (error) {
        logger.debug(
          `${this.getLogPrefix(userId, serverName)} Stored authorization no longer matches the configured OAuth binding`,
          { error },
        );
        return false;
      }
      return true;
    } catch (error) {
      logger.warn(
        `${this.getLogPrefix(userId, serverName)} Failed to inspect stored authorization`,
        {
          error,
        },
      );
      return false;
    }
  }

  /**
   * Confirms a flow-cached access token is still the token in persistent storage. This prevents
   * an old `mcp_get_tokens` result from being paired with newer client-binding metadata.
   */
  static async isCurrentAccessToken({
    userId,
    serverName,
    accessToken,
    credentialSetId,
    findToken,
  }: {
    userId: string;
    serverName: string;
    accessToken: string;
    credentialSetId: string | undefined;
    findToken: TokenMethods['findToken'];
  }): Promise<boolean> {
    try {
      const tokenData = await findToken({
        userId,
        type: 'mcp_oauth',
        identifier: `mcp:${serverName}`,
      });
      if (!tokenData || (tokenData.expiresAt && new Date() >= tokenData.expiresAt)) {
        return false;
      }
      return (
        credentialSetId != null &&
        getCredentialSetId(tokenData) === credentialSetId &&
        (await decryptV2(tokenData.token)) === accessToken
      );
    } catch (error) {
      logger.warn(`${this.getLogPrefix(userId, serverName)} Failed to verify cached access token`, {
        error,
      });
      return false;
    }
  }

  /** Fails closed when separately stored OAuth records are not from the same authorization. */
  static assertCredentialSetBinding(
    serverName: string,
    tokenCredentialSetId: string | undefined,
    clientMetadata: Partial<OAuthStoredClientMetadata> | Record<string, unknown> | undefined,
  ): void {
    const clientCredentialSetId = clientMetadata?.credential_set_id;
    if (
      !tokenCredentialSetId ||
      typeof clientCredentialSetId !== 'string' ||
      clientCredentialSetId.length === 0 ||
      tokenCredentialSetId !== clientCredentialSetId
    ) {
      throw new ReauthenticationRequiredError(serverName, 'binding');
    }
  }

  /**
   * Stores OAuth tokens for an MCP server
   *
   * @param params.existingTokens - Optional: Pass existing token state to avoid duplicate DB calls.
   * This is useful when refreshing tokens, as getTokens() already has the token state.
   */
  static async storeTokens(params: StoreTokensParams): Promise<MCPOAuthTokens> {
    const lease = params.flowManager
      ? await params.flowManager.acquireLease(
          getMCPOAuthLeaseId(params.userId, params.serverName),
          { waitMs: this.resolvePersistenceWaitMs(params.persistenceWaitTimeoutMs) },
        )
      : undefined;
    if (params.flowManager && !lease) {
      throw new MCPTokenStorageUnavailableError(
        params.serverName,
        new Error('OAuth persistence fence unavailable'),
      );
    }
    try {
      return await this.storeTokensUnderLease(params);
    } finally {
      if (lease)
        await this.releaseRefreshFlight(lease, this.getLogPrefix(params.userId, params.serverName));
    }
  }

  private static async storeTokensUnderLease({
    userId,
    serverName,
    tokens,
    createToken,
    updateToken,
    deleteTokens,
    findToken,
    clientInfo,
    existingTokens,
    metadata,
    expectedCredentialSetId,
    signal,
    onStoreCommitted,
    onStorePreparing,
  }: StoreTokensParams): Promise<MCPOAuthTokens> {
    const logPrefix = this.getLogPrefix(userId, serverName);
    const rollbackWrites: Array<() => Promise<void>> = [];

    try {
      const identifier = `mcp:${serverName}`;
      const tokenCredentialSetId = (tokens as Partial<MCPOAuthTokens>).credential_set_id;
      const metadataCredentialSetId = metadata?.credential_set_id;
      const validTokenCredentialSetId =
        typeof tokenCredentialSetId === 'string' && tokenCredentialSetId.length > 0
          ? tokenCredentialSetId
          : undefined;
      const validMetadataCredentialSetId =
        typeof metadataCredentialSetId === 'string' && metadataCredentialSetId.length > 0
          ? metadataCredentialSetId
          : undefined;
      let credentialSetId: string;
      if (expectedCredentialSetId) {
        if (
          (validTokenCredentialSetId && validTokenCredentialSetId !== expectedCredentialSetId) ||
          (validMetadataCredentialSetId && validMetadataCredentialSetId !== expectedCredentialSetId)
        ) {
          throw new ReauthenticationRequiredError(serverName, 'binding');
        }
        /** Every successful refresh becomes a distinct credential generation. */
        credentialSetId = randomUUID();
      } else {
        /**
         * Only the token exchange result carries an internally generated flow ID. OAuth
         * metadata is provider-controlled (and the schema permits extensions), so it must
         * never select the credential generation for an interactive/non-refresh write.
         */
        credentialSetId = validTokenCredentialSetId ?? randomUUID();
      }
      const tokenMetadata = { credential_set_id: credentialSetId };

      /**
       * Snapshot every record before the first write. Conditional updates below use these
       * encrypted values and generation IDs as an optimistic lock, so a refresh response from
       * generation A cannot overwrite a newer interactive authorization B.
       */
      let existingAccessToken: IToken | null | undefined;
      let existingRefreshToken: IToken | null | undefined;
      let existingClientInfo: IToken | null | undefined;
      if (findToken && updateToken) {
        const accessLookup =
          existingTokens?.accessToken !== undefined
            ? Promise.resolve(existingTokens.accessToken)
            : findToken({ userId, type: 'mcp_oauth', identifier });
        const refreshLookup =
          existingTokens?.refreshToken !== undefined
            ? Promise.resolve(existingTokens.refreshToken)
            : findToken({
                userId,
                type: 'mcp_oauth_refresh',
                identifier: `${identifier}:refresh`,
              });
        const clientLookup =
          existingTokens?.clientInfoToken !== undefined
            ? Promise.resolve(existingTokens.clientInfoToken)
            : findToken({
                userId,
                type: 'mcp_oauth_client',
                identifier: `${identifier}:client`,
              });

        [existingAccessToken, existingRefreshToken, existingClientInfo] = await Promise.all([
          accessLookup,
          refreshLookup,
          clientLookup,
        ]);
      }

      if (expectedCredentialSetId) {
        if (!existingRefreshToken || !existingClientInfo) {
          throw new ReauthenticationRequiredError(serverName, 'binding');
        }
        for (const currentRecord of [
          existingAccessToken,
          existingRefreshToken,
          existingClientInfo,
        ]) {
          if (currentRecord && getCredentialSetId(currentRecord) !== expectedCredentialSetId) {
            throw new ReauthenticationRequiredError(serverName, 'binding');
          }
        }
      } else if (
        existingAccessToken &&
        existingClientInfo &&
        getCredentialSetId(existingAccessToken) !== getCredentialSetId(existingClientInfo)
      ) {
        /**
         * A fresh authorization may replace a coherent generation, but it must not build on a
         * crash-left mixed anchor. Allowing that would let three concurrent writers chain their
         * access-token CAS operations and make a later rollback resurrect a failed generation.
         */
        throw new ReauthenticationRequiredError(serverName, 'binding');
      }

      const updateIfCurrent = async (
        existingToken: IToken,
        type: string,
        recordIdentifier: string,
        tokenData: TokenUpdateData,
      ): Promise<void> => {
        const existingCredentialSetId = getCredentialSetId(existingToken);
        const updated = await updateToken!(
          {
            userId,
            type,
            identifier: recordIdentifier,
            token: existingToken.token,
            metadataCredentialSetId: existingCredentialSetId ?? null,
          },
          tokenData,
        );
        if (!updated) {
          throw new ReauthenticationRequiredError(serverName, 'binding');
        }
        const postWriteToken = tokenData.token ?? existingToken.token;
        const previousMetadata = cloneTokenMetadata(existingToken);
        rollbackWrites.push(async () => {
          const restored = await updateToken!(
            {
              userId,
              type,
              identifier: recordIdentifier,
              token: postWriteToken,
              metadataCredentialSetId: credentialSetId,
            },
            {
              token: existingToken.token,
              expiresAt: existingToken.expiresAt,
              metadata: previousMetadata,
            },
          );
          if (!restored) {
            logger.warn(
              `${logPrefix} Skipped OAuth rollback for ${type}; the record was superseded`,
            );
          }
        });
      };

      const createWithRollback = async (
        type: string,
        recordIdentifier: string,
        tokenData: TokenCreateData,
      ): Promise<void> => {
        await createToken(tokenData);
        if (!deleteTokens) {
          return;
        }
        rollbackWrites.push(async () => {
          const result = await deleteTokens({
            userId,
            type,
            identifier: recordIdentifier,
            token: tokenData.token,
            metadataCredentialSetId: credentialSetId,
          });
          if (result.deletedCount === 0) {
            logger.warn(
              `${logPrefix} Skipped OAuth create rollback for ${type}; the record was superseded`,
            );
          }
        });
      };

      interface PlannedTokenWrite {
        type: string;
        identifier: string;
        existingToken?: IToken | null;
        createData?: TokenCreateData;
        updateData: TokenUpdateData;
        description: string;
      }

      const plannedWrites: PlannedTokenWrite[] = [];

      // Encrypt and store access token
      const encryptedAccessToken = await encryptV2(tokens.access_token);

      logger.debug(
        `${logPrefix} Token expires_in: ${'expires_in' in tokens ? tokens.expires_in : 'N/A'}, expires_at: ${'expires_at' in tokens ? tokens.expires_at : 'N/A'}`,
      );

      const defaultTTL = 365 * 24 * 60 * 60;

      let accessTokenExpiry: Date;
      let expiresInSeconds: number;
      // Zero is a stated lifetime, not an omitted one. Only unknown/invalid lifetimes
      // use the default; never turn an elapsed known lifetime into a year of validity.
      if (
        'expires_at' in tokens &&
        typeof tokens.expires_at === 'number' &&
        Number.isFinite(tokens.expires_at)
      ) {
        /** MCPOAuthTokens format - already has calculated expiry */
        logger.debug(`${logPrefix} Using expires_at: ${tokens.expires_at}`);
        accessTokenExpiry = new Date(tokens.expires_at);
        expiresInSeconds = Math.floor((accessTokenExpiry.getTime() - Date.now()) / 1000);
      } else if (typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in)) {
        /** Standard OAuthTokens format - use expires_in directly to avoid lossy Date round-trip */
        logger.debug(`${logPrefix} Using expires_in: ${tokens.expires_in}`);
        expiresInSeconds = tokens.expires_in;
        accessTokenExpiry = new Date(Date.now() + tokens.expires_in * 1000);
      } else {
        /**
         * RFC 6749 §5.1 makes `expires_in` only RECOMMENDED, so some providers
         * (e.g. Salesforce) omit it. When the access token is a JWT (RFC 9068),
         * its `exp` claim is the authoritative lifetime — prefer it over the
         * 365-day default so the token is refreshed on time rather than being
         * treated as valid for a year and never refreshed.
         */
        const jwtExpiryMs = getJwtAccessTokenExpiry(tokens.access_token);
        if (jwtExpiryMs != null && jwtExpiryMs > Date.now()) {
          logger.debug(`${logPrefix} Using JWT exp claim: ${new Date(jwtExpiryMs).toISOString()}`);
          accessTokenExpiry = new Date(jwtExpiryMs);
          expiresInSeconds = Math.floor((jwtExpiryMs - Date.now()) / 1000);
        } else {
          logger.debug(`${logPrefix} No expiry provided, using default`);
          expiresInSeconds = defaultTTL;
          accessTokenExpiry = new Date(Date.now() + defaultTTL * 1000);
        }
      }

      if (isNaN(accessTokenExpiry.getTime())) {
        logger.error(`${logPrefix} Invalid expiry date calculated, using default`);
        accessTokenExpiry = new Date(Date.now() + defaultTTL * 1000);
        expiresInSeconds = defaultTTL;
      }

      logger.debug(`${logPrefix} Calculated expiry date: ${accessTokenExpiry.toISOString()}`);

      if (expiresInSeconds <= 0) {
        logger.info(
          `${logPrefix} Stored access token is already expired (expires_at: ${accessTokenExpiry.toISOString()}); the next read refreshes it`,
        );
      }

      const accessTokenData = {
        userId,
        type: 'mcp_oauth',
        identifier,
        token: encryptedAccessToken,
        expiresIn: expiresInSeconds,
        metadata: tokenMetadata,
      };

      plannedWrites.push({
        type: 'mcp_oauth',
        identifier,
        existingToken: existingAccessToken,
        createData: accessTokenData,
        updateData: accessTokenData,
        description: 'access token',
      });

      // Store refresh token if available
      if (tokens.refresh_token) {
        logger.debug(
          `${logPrefix} New refresh token received from OAuth server, will store/update`,
        );
        const encryptedRefreshToken = await encryptV2(tokens.refresh_token);
        const extendedTokens = tokens as ExtendedOAuthTokens;
        const refreshTokenExpiry = extendedTokens.refresh_token_expires_in
          ? new Date(Date.now() + extendedTokens.refresh_token_expires_in * 1000)
          : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // Default to 1 year

        /** Calculated expiresIn for refresh token */
        const refreshExpiresIn = Math.floor((refreshTokenExpiry.getTime() - Date.now()) / 1000);

        const refreshTokenData = {
          userId,
          type: 'mcp_oauth_refresh',
          identifier: `${identifier}:refresh`,
          token: encryptedRefreshToken,
          expiresIn: refreshExpiresIn > 0 ? refreshExpiresIn : 365 * 24 * 60 * 60,
          metadata: tokenMetadata,
        };

        plannedWrites.push({
          type: 'mcp_oauth_refresh',
          identifier: `${identifier}:refresh`,
          existingToken: existingRefreshToken,
          createData: refreshTokenData,
          updateData: refreshTokenData,
          description: 'refresh token',
        });
      } else {
        logger.debug(
          `${logPrefix} No refresh token in response - OAuth server did not rotate refresh token (this is normal for some providers)`,
        );
        if (expectedCredentialSetId && existingRefreshToken && updateToken) {
          plannedWrites.push({
            type: 'mcp_oauth_refresh',
            identifier: `${identifier}:refresh`,
            existingToken: existingRefreshToken,
            updateData: { metadata: tokenMetadata },
            description: 'refresh token binding',
          });
        }
      }

      /** Store client information if provided */
      if (clientInfo) {
        logger.debug(`${logPrefix} Storing client info:`, {
          client_id: clientInfo.client_id,
          has_client_secret: !!clientInfo.client_secret,
        });
        const encryptedClientInfo = await encryptV2(JSON.stringify(clientInfo));

        const clientInfoData = {
          userId,
          type: 'mcp_oauth_client',
          identifier: `${identifier}:client`,
          token: encryptedClientInfo,
          expiresIn: 365 * 24 * 60 * 60,
          metadata: { ...metadata, credential_set_id: credentialSetId },
        };

        plannedWrites.push({
          type: 'mcp_oauth_client',
          identifier: `${identifier}:client`,
          existingToken: existingClientInfo,
          createData: clientInfoData,
          updateData: clientInfoData,
          description: 'client info',
        });
      }

      /**
       * Claim an existing access record first (then refresh/client as fallbacks). Once the
       * anchor moves to the target generation, a competing writer can only continue from the
       * exact record versions it observed. Remaining writes are journaled so a later failure
       * restores the exact snapshot without clobbering a still-newer writer. The preflight gate
       * above rejects mixed access/client snapshots before they can extend this CAS chain.
       */
      const anchorIndex = plannedWrites.findIndex((write) => write.existingToken != null);
      const orderedWrites =
        anchorIndex > 0
          ? [
              plannedWrites[anchorIndex],
              ...plannedWrites.slice(0, anchorIndex),
              ...plannedWrites.slice(anchorIndex + 1),
            ]
          : plannedWrites;

      await onStorePreparing?.();

      for (const write of orderedWrites) {
        if (signal?.aborted) {
          throw new Error('Token storage aborted by OAuth teardown');
        }
        if (findToken && updateToken && write.existingToken) {
          await updateIfCurrent(
            write.existingToken,
            write.type,
            write.identifier,
            write.updateData,
          );
          logger.debug(`${logPrefix} Updated existing ${write.description}`);
        } else if (write.createData) {
          await createWithRollback(write.type, write.identifier, write.createData);
          logger.debug(`${logPrefix} Created ${write.description}`);
        } else {
          throw new ReauthenticationRequiredError(serverName, 'binding');
        }
      }

      const storedTokens: MCPOAuthTokens = {
        ...tokens,
        credential_set_id: credentialSetId,
        obtained_at:
          'obtained_at' in tokens && typeof tokens.obtained_at === 'number'
            ? tokens.obtained_at
            : Date.now(),
        expires_at: accessTokenExpiry.getTime(),
      };
      /**
       * An interactive response without a refresh token must never bind an older refresh
       * secret to the new client. Remove that stale record after the committed writes. This
       * cleanup is best-effort and fully scoped; reads already omit it if a crash or transient
       * database error leaves it behind.
       */
      if (
        !expectedCredentialSetId &&
        !tokens.refresh_token &&
        existingRefreshToken &&
        getCredentialSetId(existingRefreshToken) !== credentialSetId &&
        deleteTokens
      ) {
        try {
          const result = await deleteTokens({
            userId,
            type: 'mcp_oauth_refresh',
            identifier: `${identifier}:refresh`,
            token: existingRefreshToken.token,
            metadataCredentialSetId: getCredentialSetId(existingRefreshToken) ?? null,
          });
          if (result.deletedCount === 0) {
            logger.debug(`${logPrefix} Stale refresh token was already superseded`);
          }
        } catch (cleanupError) {
          logger.warn(`${logPrefix} Failed to remove stale refresh token after OAuth callback`, {
            error: cleanupError,
          });
        }
      }

      await onStoreCommitted?.(storedTokens);

      logger.debug(`${logPrefix} Stored OAuth tokens`, {
        client_id: clientInfo?.client_id,
        has_refresh_token: !!tokens.refresh_token,
        expires_at: 'expires_at' in tokens ? tokens.expires_at : 'N/A',
      });
      return storedTokens;
    } catch (error) {
      for (const rollback of rollbackWrites.reverse()) {
        try {
          await rollback();
        } catch (rollbackError) {
          logger.warn(`${logPrefix} Failed to roll back a partial OAuth credential write`, {
            error: rollbackError,
          });
        }
      }
      logger.error(`${logPrefix} Failed to store tokens`, error);
      throw error;
    }
  }

  /**
   * Forces a refresh of OAuth tokens using the stored refresh token, regardless
   * of whether the access token appears locally expired. Use this when the
   * server has signaled token invalidity (e.g. a 401 mid-session) — the 401 is
   * the authoritative signal, not the local `expires_at`.
   *
   * Single-flighted per `(tenantId, userId, serverName, bindingScope)`: concurrent callers
   * (tool-call 401s, pings, reconnect retries, expired-token reads) share one
   * redemption and receive the same rotated result instead of each replaying
   * the refresh token at the token endpoint.
   *
   * Returns the new tokens, or `null` when refresh is not possible (no refresh
   * token stored, no refresh callback, etc.). Throws `ReauthenticationRequiredError`
   * when the refresh server response indicates the client registration is stale.
   */
  static async forceRefreshTokens(
    params: GetTokensParams & {
      existingAccessToken?: IToken | null;
    },
  ): Promise<MCPOAuthTokens | null> {
    const {
      userId,
      serverName,
      refreshTokens,
      createToken,
      signal,
      singleFlightScope,
      flowManager,
    } = params;
    const logPrefix = this.getLogPrefix(userId, serverName);

    const ownerKey = this.getRefreshOwnerKey(userId, serverName);
    if (this.refreshTeardownCounts.has(ownerKey)) {
      logger.debug(`${logPrefix} Skipping token refresh during OAuth teardown`);
      return null;
    }
    const refreshKey = JSON.stringify([
      getTenantId() ?? '',
      userId,
      serverName,
      singleFlightScope ?? '',
      ...(params.coordinateRefresh === true
        ? [
            params.rejectedCredentialSetId === undefined
              ? ['unknown']
              : ['known', params.rejectedCredentialSetId],
          ]
        : []),
    ]);
    const inflight = this.inflightRefreshes.get(refreshKey);
    if (inflight) {
      logger.debug(`${logPrefix} Joining in-flight token refresh`);
      return this.raceWithAbort(inflight, signal);
    }

    if (!refreshTokens) {
      logger.warn(`${logPrefix} Cannot refresh tokens: no \`refreshTokens\` callback provided`);
      return null;
    }

    if (!createToken) {
      logger.warn(`${logPrefix} Cannot refresh tokens: no \`createToken\` function provided`);
      return null;
    }

    const leaseId = getMCPOAuthLeaseId(userId, serverName);
    /**
     * The shared redemption is owner-neutral: no caller's `AbortSignal` is
     * threaded into the execution, so an impatient waiter (e.g. the silent
     * refresh path's short timeout) cannot cancel the wire call for everyone
     * who joined. Cancellation is waiter-specific via `raceWithAbort`; the
     * execution itself is bounded by the internal stale-abort controller below.
     */
    const executionController = new AbortController();
    const staleTimerRef: { current?: NodeJS.Timeout } = {};
    /** Reserve the local single-flight slot before the asynchronous distributed-fence read. */
    const refreshPromise = (async () => {
      const leaseGeneration = flowManager
        ? await flowManager.getLeaseGeneration(leaseId)
        : undefined;
      if (leaseGeneration === null) {
        logger.debug(`${logPrefix} Skipping token refresh while OAuth teardown owns the lease`);
        return null;
      }
      if (this.refreshTeardownCounts.has(ownerKey)) {
        logger.debug(`${logPrefix} Skipping token refresh during OAuth teardown`);
        return null;
      }
      /** Serialize with the redemptions other replicas may be running for this credential. */
      let flight: MCPRefreshFlight | null = null;
      if (flowManager && params.coordinateRefresh === true) {
        try {
          flight = await this.beginRefreshFlight({
            userId,
            serverName,
            findToken: params.findToken,
            flowManager,
            existingRefreshToken: params.existingRefreshToken,
            existingAccessToken: params.existingAccessToken,
            rejectedCredentialSetId: params.rejectedCredentialSetId,
            waitMs: this.resolveRefreshFlightWaitMs(params.refreshWaitTimeoutMs),
            signal: executionController.signal,
            logPrefix,
          });
        } catch (flightError) {
          if (flightError instanceof MCPTokenRefreshUnavailableError) {
            throw flightError;
          }
          throw new MCPTokenRefreshUnavailableError(serverName, flightError);
        }
      }
      if (flight?.aborted) {
        logger.debug(`${logPrefix} Token refresh aborted while waiting for another replica`);
        return null;
      }
      try {
        if (flight?.adoptedTokens) {
          const adoptionLease = await flowManager!.acquireLease(leaseId, {
            waitMs: this.resolvePersistenceWaitMs(params.persistenceWaitTimeoutMs),
          });
          if (!adoptionLease) {
            throw new MCPTokenStorageUnavailableError(
              serverName,
              new Error('OAuth adoption fence unavailable'),
            );
          }
          try {
            if (
              !(await this.isCurrentAccessToken({
                userId,
                serverName,
                findToken: params.findToken,
                accessToken: flight.adoptedTokens.access_token,
                credentialSetId: flight.adoptedTokens.credential_set_id,
              }))
            ) {
              throw new MCPTokenStorageUnavailableError(
                serverName,
                new Error('Adopted credential was superseded'),
              );
            }
            logger.info(`${logPrefix} Adopted tokens rotated by another replica`);
            /**
             * The peer's redemption did the persisting, so only this replica's view needs
             * updating: its cached `mcp_get_tokens` result still holds the tokens it was
             * about to replace. `onRefreshPreparing`'s publication fence is deliberately
             * skipped — that fence exists to order writes this replica makes.
             */
            if (params.onTokensAdopted) {
              await params.onTokensAdopted(flight.adoptedTokens);
            } else {
              await params.onRefreshSuccess?.(flight.adoptedTokens);
            }
            return flight.adoptedTokens;
          } finally {
            await this.releaseRefreshFlight(adoptionLease, logPrefix);
          }
        }
        return await this.executeTokenRefresh({
          ...params,
          refreshTokens,
          createToken,
          leasedRefreshToken: flight?.leasedRefreshToken,
          signal: executionController.signal,
          leaseId,
          leaseGeneration,
        });
      } finally {
        if (flight?.lease) {
          await this.releaseRefreshFlight(flight.lease, logPrefix);
        }
      }
    })()
      .catch((error: unknown) => {
        if (
          error instanceof ReauthenticationRequiredError ||
          error instanceof MCPTokenRefreshUnavailableError ||
          error instanceof MCPTokenStorageUnavailableError
        ) {
          throw error;
        }
        throw new MCPTokenRefreshUnavailableError(serverName, error);
      })
      .finally(() => {
        if (staleTimerRef.current) {
          clearTimeout(staleTimerRef.current);
        }
        if (this.inflightRefreshes.get(refreshKey) === refreshPromise) {
          this.inflightRefreshes.delete(refreshKey);
          this.inflightRefreshControllers.delete(refreshKey);
          this.inflightRefreshOwners.delete(refreshKey);
        }
      });
    /**
     * Safety valve for wedged executions: after the stale window the execution
     * is aborted so it can never reach the token endpoint with a refresh token
     * that a successor is about to redeem. The slot itself is freed only by the
     * `.finally` above, that is, once the aborted execution has actually
     * settled. Deleting the entry while the redemption might still consume the
     * stored refresh token would re-open the concurrent-replay window this
     * single-flight exists to close.
     *
     * If the abort lands after the endpoint already processed the request
     * (response lost in transit), the rotated tokens are unrecoverable and the
     * stored refresh token is deliberately left in place rather than deleted.
     * A later redemption then either succeeds (request never actually
     * processed, or the server grants rotation leeway) or trips reuse
     * detection on a family whose fresh tokens were never received and whose
     * access token was already expired or rejected. That failure ends in the
     * same re-authentication the proactive deletion would force on every
     * stall, while deletion would also foreclose the silent recovery paths.
     */
    staleTimerRef.current = setTimeout(() => {
      if (this.inflightRefreshes.get(refreshKey) === refreshPromise) {
        logger.warn(
          `${logPrefix} Aborting stalled in-flight token refresh after ${MCPTokenStorage.INFLIGHT_REFRESH_STALE_MS}ms`,
        );
        executionController.abort();
      }
    }, MCPTokenStorage.INFLIGHT_REFRESH_STALE_MS);
    staleTimerRef.current.unref?.();
    this.inflightRefreshes.set(refreshKey, refreshPromise);
    this.inflightRefreshControllers.set(refreshKey, executionController);
    this.inflightRefreshOwners.set(refreshKey, ownerKey);
    return this.raceWithAbort(refreshPromise, signal);
  }

  /**
   * Serializes refresh-token redemption for one credential across replicas.
   *
   * `inflightRefreshes` coalesces callers inside a single Node process. Behind a load
   * balancer without session affinity, one user's concurrent requests (a second browser
   * tab mounting the app, a tool-call fan-out, a 401 on two pods) land on different
   * replicas, each reads the same not-yet-rotated refresh token from storage and redeems
   * it. RFC 9700 §4.13.2 servers treat the second redemption of a rotated token as replay
   * and revoke the whole grant family, including the tokens the first redeemer just
   * received — the user is then asked to authorize the server again.
   *
   * The flight is the cross-replica lease the OAuth teardown fence already uses
   * (`FlowStateManager.acquireLease`: a Redis Lua compare-and-set when `USE_REDIS` is
   * configured, process-static otherwise), so single-replica deployments and deployments
   * without Redis behave exactly as before.
   *
   * Returns the held lease, or the tokens a peer rotated while this replica waited — the
   * cross-replica equivalent of "Joining in-flight token refresh". Redeeming again after
   * the wait would be correct but pointless: it burns a second rotation on a credential
   * that was just replaced.
   */
  private static async beginRefreshFlight({
    userId,
    serverName,
    findToken,
    flowManager,
    existingRefreshToken,
    existingAccessToken,
    rejectedCredentialSetId,
    waitMs,
    signal,
    logPrefix,
  }: {
    userId: string;
    serverName: string;
    findToken: GetTokensParams['findToken'];
    flowManager: NonNullable<GetTokensParams['flowManager']>;
    existingRefreshToken?: IToken | null;
    existingAccessToken?: IToken | null;
    rejectedCredentialSetId?: string | null;
    waitMs: number;
    /** Internal stale-abort signal owned by `forceRefreshTokens`, also fired by teardown. */
    signal: AbortSignal;
    logPrefix: string;
  }): Promise<MCPRefreshFlight> {
    const flightLeaseId = getMCPOAuthRefreshFlightLeaseId(userId, serverName);
    const leaseMs = MCPTokenStorage.REFRESH_FLIGHT_LEASE_MS;

    /**
     * Baseline for recognizing a peer's rotation: the stored credential changing under us, rather
     * than timestamps another pod's clock wrote. Taken before the first acquisition attempt, since
     * a holder that stores and releases during that attempt would otherwise be observed
     * post-rotation and its fresh credential redeemed a second time.
     *
     * `getTokens` already read this record to decide a refresh was needed, so the common path pays
     * nothing for the baseline. When no record is supplied and the read fails, the baseline is
     * simply absent: that costs the adoption optimization and nothing else, and it must not skip
     * the flight, because proceeding unfenced over a storage error is how two replicas come to
     * redeem one credential. Lease-store failures also defer the attempt.
     */
    let observedRefreshToken = existingRefreshToken ?? null;
    if (!observedRefreshToken) {
      try {
        observedRefreshToken = await this.readRefreshTokenRecord({
          userId,
          serverName,
          findToken,
        });
      } catch (snapshotError) {
        logger.debug(`${logPrefix} Could not observe the credential before the refresh flight`, {
          error: snapshotError,
        });
      }
    }

    /**
     * Polled rather than delegated to `acquireLease`'s own wait, for two reasons: OAuth teardown
     * aborts in-flight redemptions and then awaits them, so it must not sit blocked on a peer's
     * lease; and every acquisition has to be followed by a rotation check, including the first,
     * because a peer can rotate and release before this replica's first attempt.
     */
    const waitUntil = Date.now() + waitMs;
    let announcedWait = false;
    while (!signal.aborted) {
      const lease = await flowManager.acquireLease(flightLeaseId, { leaseMs, waitMs: 0 });
      if (lease) {
        return await this.resolveAcquiredFlight({
          userId,
          serverName,
          findToken,
          lease,
          observedRefreshToken,
          existingAccessToken,
          rejectedCredentialSetId,
          logPrefix,
        });
      }
      if (Date.now() >= waitUntil) {
        /**
         * The holder outlived the wait. Redeeming now would race a redemption that may still reach
         * the token endpoint, so the attempt fails as retryable instead of unfenced: `getTokens`
         * callers defer connection recovery on this error, the stored credential is left intact,
         * and a later attempt acquires the flight once the holder's own stale abort releases it.
         */
        throw new MCPTokenRefreshUnavailableError(
          serverName,
          new Error(`Another replica held the OAuth refresh flight for longer than ${waitMs}ms`),
        );
      }
      if (!announcedWait) {
        announcedWait = true;
        logger.debug(`${logPrefix} Waiting for a token refresh held by another replica`);
      }
      await new Promise((resolve) => setTimeout(resolve, MCPTokenStorage.REFRESH_FLIGHT_POLL_MS));
    }
    return { lease: null, aborted: true };
  }

  /**
   * Decides what a held flight is for, and the only place that decision is made.
   *
   * Acquiring the flight is the sole proof that no peer is mid-redemption, so it is also the moment
   * a peer's completed rotation becomes safe to read. That applies to the first acquisition exactly
   * as much as to one that followed a wait: a peer can rotate, store and release before this replica
   * ever contends, and an acquisition that looks uncontended says nothing about which credential is
   * stored now.
   *
   * The record read here serves both purposes: it is the evidence of rotation and, when nothing
   * rotated, the credential the redemption submits. Reading it once under the flight is what keeps
   * the fence off the serial-read budget the auth and startup paths are measured against.
   */
  private static async resolveAcquiredFlight({
    userId,
    serverName,
    findToken,
    lease,
    observedRefreshToken,
    existingAccessToken,
    rejectedCredentialSetId,
    logPrefix,
  }: {
    userId: string;
    serverName: string;
    findToken: GetTokensParams['findToken'];
    lease: FlowLease;
    observedRefreshToken: IToken | null;
    existingAccessToken?: IToken | null;
    rejectedCredentialSetId?: string | null;
    logPrefix: string;
  }): Promise<MCPRefreshFlight> {
    let leasedRefreshToken: IToken | null;
    try {
      leasedRefreshToken = await this.readRefreshTokenRecord({ userId, serverName, findToken });
    } catch (readError) {
      await this.releaseRefreshFlight(lease, logPrefix);
      throw new MCPTokenRefreshUnavailableError(serverName, readError);
    }

    let adoptedTokens: MCPOAuthTokens | null;
    try {
      adoptedTokens = await this.adoptRotatedTokens({
        userId,
        serverName,
        findToken,
        observedRefreshToken,
        existingAccessToken,
        rejectedCredentialSetId,
        leasedRefreshToken,
      });
    } catch (adoptionError) {
      await this.releaseRefreshFlight(lease, logPrefix);
      throw new MCPTokenRefreshUnavailableError(serverName, adoptionError);
    }
    if (!adoptedTokens) {
      return { lease, leasedRefreshToken };
    }
    return { lease, adoptedTokens };
  }

  /** Releases a flight lease without letting a release failure mask the caller's outcome. */
  private static async releaseRefreshFlight(lease: FlowLease, logPrefix: string): Promise<void> {
    try {
      await lease.release();
    } catch (releaseError) {
      logger.warn(`${logPrefix} Failed to release the OAuth refresh flight`, {
        error: releaseError,
      });
    }
  }

  private static readRefreshTokenRecord({
    userId,
    serverName,
    findToken,
  }: {
    userId: string;
    serverName: string;
    findToken: GetTokensParams['findToken'];
  }): Promise<IToken | null> {
    return findToken({
      userId,
      type: 'mcp_oauth_refresh',
      identifier: `mcp:${serverName}:refresh`,
    });
  }

  /**
   * Returns the tokens another replica stored before this one took the refresh flight, or null
   * when nothing usable was rotated. The stored refresh record changing between the two reads it
   * is given is the evidence of a completed peer redemption: `storeTokens` rewrites the access and
   * refresh records together, so a different ciphertext or credential set means the pair
   * on disk is no longer the one this caller read.
   *
   * An unchanged record is not adopted even when the access token still looks valid,
   * because `forceRefreshTokens` is also the 401 path: there the resource server — not
   * `expiresAt` — is the authority, and returning the token it just rejected would loop.
   */
  private static async adoptRotatedTokens({
    userId,
    serverName,
    findToken,
    observedRefreshToken,
    existingAccessToken,
    rejectedCredentialSetId,
    leasedRefreshToken,
  }: {
    userId: string;
    serverName: string;
    findToken: GetTokensParams['findToken'];
    /** The credential as this replica saw it before contending for the flight. */
    observedRefreshToken: IToken | null;
    existingAccessToken?: IToken | null;
    rejectedCredentialSetId?: string | null;
    /** The credential as stored once the flight was held. */
    leasedRefreshToken: IToken | null;
  }): Promise<MCPOAuthTokens | null> {
    if (!leasedRefreshToken || (!observedRefreshToken && rejectedCredentialSetId === undefined)) {
      return null;
    }
    const rotated =
      (rejectedCredentialSetId !== undefined &&
        rejectedCredentialSetId !== getCredentialSetId(leasedRefreshToken)) ||
      (observedRefreshToken != null &&
        (leasedRefreshToken.token !== observedRefreshToken.token ||
          getCredentialSetId(leasedRefreshToken) !== getCredentialSetId(observedRefreshToken))) ||
      (existingAccessToken != null &&
        getCredentialSetId(leasedRefreshToken) !== getCredentialSetId(existingAccessToken));
    if (!rotated && existingAccessToken !== null) {
      return null;
    }

    const accessTokenData = await findToken({
      userId,
      type: 'mcp_oauth',
      identifier: `mcp:${serverName}`,
    });
    if (
      !rotated &&
      (!accessTokenData || (accessTokenData.expiresAt && new Date() >= accessTokenData.expiresAt))
    ) {
      return null;
    }
    if (
      !accessTokenData ||
      getCredentialSetId(accessTokenData) !== getCredentialSetId(leasedRefreshToken)
    ) {
      throw new MCPTokenRefreshUnavailableError(
        serverName,
        new Error('Peer credential is not coherent'),
      );
    }
    if (accessTokenData.expiresAt && new Date() >= accessTokenData.expiresAt) {
      throw new MCPTokenRefreshUnavailableError(
        serverName,
        new Error('Peer credential already expired'),
      );
    }
    return await this.readStoredTokens({ userId, serverName, findToken, accessTokenData });
  }

  /**
   * Wraps the shared redemption promise for a single waiter: if the waiter's
   * `signal` aborts first, that waiter receives `null` (matching the prior
   * abort contract) while the shared execution continues for other callers.
   */
  private static raceWithAbort(
    promise: Promise<MCPOAuthTokens | null>,
    signal?: AbortSignal,
  ): Promise<MCPOAuthTokens | null> {
    if (!signal) {
      return promise;
    }
    if (signal.aborted) {
      return Promise.resolve(null);
    }
    return new Promise<MCPOAuthTokens | null>((resolve, reject) => {
      const onAbort = () => resolve(null);
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  /**
   * Runs a single refresh-token redemption under the `inflightRefreshes`
   * single-flight lock. The refresh token is read from storage at execution
   * time — never from a caller-provided snapshot — so a redemption that starts
   * after another refresh completed uses the rotated token instead of
   * replaying the consumed one (which RFC 9700 reuse detection punishes by
   * revoking the whole grant family).
   */
  private static async executeTokenRefresh({
    userId,
    serverName,
    findToken,
    createToken,
    updateToken,
    deleteTokens,
    refreshTokens,
    existingAccessToken,
    leasedRefreshToken,
    onRefreshSuccess,
    onRefreshPreparing,
    signal,
    flowManager,
    leaseId,
    leaseGeneration,
  }: GetTokensParams & {
    existingAccessToken?: IToken | null;
    /**
     * The refresh record already read under the flight this redemption holds. Reused rather than
     * re-read, because a read taken under the flight is exactly what this redemption needs. Never
     * `existingRefreshToken`, which predates the flight and may name a consumed credential.
     */
    leasedRefreshToken?: IToken | null;
    refreshTokens: NonNullable<GetTokensParams['refreshTokens']>;
    createToken: NonNullable<GetTokensParams['createToken']>;
    /** Internal stale-abort signal owned by `forceRefreshTokens` — never a caller's. */
    signal: AbortSignal;
    leaseId: string;
    leaseGeneration?: number;
  }): Promise<MCPOAuthTokens | null> {
    const logPrefix = this.getLogPrefix(userId, serverName);
    const identifier = `mcp:${serverName}`;

    const refreshTokenData =
      leasedRefreshToken ??
      (await findToken({
        userId,
        type: 'mcp_oauth_refresh',
        identifier: `${identifier}:refresh`,
      }));

    if (!refreshTokenData) {
      logger.debug(`${logPrefix} No refresh token in storage`);
      return null;
    }

    const refreshCredentialSetId = getCredentialSetId(refreshTokenData);
    try {
      logger.info(`${logPrefix} Attempting to refresh token`);

      let clientInfo;
      let clientInfoData;
      let storedClientMetadata: Partial<OAuthStoredClientMetadata> | undefined;
      let storedTokenEndpoint: string | undefined;
      let storedAuthMethods: string[] | undefined;
      let storedServerUrl: string | undefined;
      let clientSource: OAuthStoredClientMetadata['client_source'] | undefined;
      let resource: string | undefined;
      try {
        clientInfoData = await findToken({
          userId,
          type: 'mcp_oauth_client',
          identifier: `${identifier}:client`,
        });
        if (clientInfoData) {
          const decryptedClientInfo = await decryptV2(clientInfoData.token);
          clientInfo = JSON.parse(decryptedClientInfo);
          logger.debug(`${logPrefix} Retrieved client info:`, {
            client_id: clientInfo.client_id,
            has_client_secret: !!clientInfo.client_secret,
          });

          if (clientInfoData.metadata) {
            const raw = getTokenMetadata(clientInfoData);
            storedClientMetadata = raw as Partial<OAuthStoredClientMetadata>;
            if (typeof raw.token_endpoint === 'string') {
              storedTokenEndpoint = raw.token_endpoint;
            }
            if (Array.isArray(raw.token_endpoint_auth_methods_supported)) {
              storedAuthMethods = raw.token_endpoint_auth_methods_supported as string[];
            }
            if (typeof raw.server_url === 'string') {
              storedServerUrl = raw.server_url;
            }
            if (raw.client_source === 'configured' || raw.client_source === 'dynamic') {
              clientSource = raw.client_source;
            }
            if (typeof raw.resource === 'string') {
              resource = raw.resource;
            }
          }
        }
      } catch (error) {
        throw new MCPTokenStorageUnavailableError(serverName, error);
      }

      if (
        !clientInfo?.client_id ||
        !storedTokenEndpoint ||
        !storedServerUrl ||
        !clientSource ||
        !refreshCredentialSetId
      ) {
        throw new ReauthenticationRequiredError(serverName, 'binding');
      }
      this.assertCredentialSetBinding(serverName, refreshCredentialSetId, storedClientMetadata);
      if (
        existingAccessToken &&
        getCredentialSetId(existingAccessToken) !== refreshCredentialSetId
      ) {
        throw new MCPTokenRefreshUnavailableError(
          serverName,
          new Error('OAuth credential changed before redemption'),
        );
      }
      const decryptedRefreshToken = await decryptV2(refreshTokenData.token);

      const metadata = {
        userId,
        serverName,
        identifier,
        clientInfo,
        storedTokenEndpoint,
        storedAuthMethods,
        storedServerUrl,
        clientSource,
        resource,
      };

      /**
       * A stalled execution may wake here after the stale-abort fired and a
       * successor already redeemed (and rotated) the refresh token — reaching
       * the endpoint with the old token would trip RFC 9700 reuse detection.
       */
      if (signal.aborted) {
        throw new Error('Token refresh aborted before reaching the token endpoint');
      }

      let newTokens: MCPOAuthTokens;
      try {
        newTokens = await refreshTokens(decryptedRefreshToken, metadata, signal);
      } catch (error) {
        if (error instanceof MCPTokenRefreshUnavailableError) {
          throw error;
        }
        // These endpoint responses reject the refresh request permanently; a new grant can recover.
        // Classify only provider failures here, never a similarly worded persistence failure.
        const message = error instanceof Error ? error.message : String(error);
        if (
          /\b(unsupported_grant_type|invalid_request|invalid_scope|invalid_target|access_denied)\b/i.test(
            message,
          )
        ) {
          return null;
        }
        throw error;
      }

      logger.debug(`${logPrefix} Refresh completed`, {
        has_new_access_token: !!newTokens.access_token,
        has_new_refresh_token: !!newTokens.refresh_token,
        refresh_token_will_be_rotated: !!newTokens.refresh_token,
        expires_at: newTokens.expires_at,
      });

      if (signal.aborted) {
        throw new Error('Token refresh aborted before storing refreshed credentials');
      }

      let persistenceLease: FlowLease | null = null;
      if (flowManager && leaseGeneration !== undefined) {
        persistenceLease = await flowManager.acquireLease(leaseId, {
          expectedGeneration: leaseGeneration,
        });
        if (!persistenceLease) {
          logger.debug(`${logPrefix} Discarding refresh response superseded by OAuth teardown`);
          return null;
        }
      }

      // Store the refreshed tokens (handles both create and update)
      // Pass existing token state to avoid duplicate DB calls
      let storedTokens: MCPOAuthTokens;
      try {
        let preparedRefreshCommit: ((tokens?: MCPOAuthTokens) => Promise<void>) | undefined;
        storedTokens = await this.storeTokensUnderLease({
          userId,
          serverName,
          tokens: newTokens,
          createToken,
          updateToken,
          deleteTokens,
          findToken,
          clientInfo,
          existingTokens: {
            accessToken: existingAccessToken ?? undefined,
            refreshToken: refreshTokenData,
            clientInfoToken: clientInfoData,
          },
          metadata: storedClientMetadata,
          expectedCredentialSetId: refreshCredentialSetId,
          signal,
          onStorePreparing:
            onRefreshPreparing == null
              ? undefined
              : async () => {
                  preparedRefreshCommit = await onRefreshPreparing();
                },
          onStoreCommitted: async (tokens) => {
            if (preparedRefreshCommit != null) {
              await preparedRefreshCommit(tokens);
            } else {
              await onRefreshSuccess?.(tokens);
            }
          },
        });
      } finally {
        try {
          await persistenceLease?.release();
        } catch (releaseError) {
          logger.warn(`${logPrefix} Failed to release OAuth refresh persistence lease`, {
            error: releaseError,
          });
        }
      }

      logger.info(`${logPrefix} Successfully refreshed and stored OAuth tokens`);
      return storedTokens;
    } catch (refreshError) {
      logger.error(`${logPrefix} Failed to refresh tokens`, refreshError);
      if (
        refreshError instanceof ReauthenticationRequiredError ||
        refreshError instanceof MCPTokenRefreshUnavailableError
      ) {
        throw refreshError;
      }
      if (
        signal.aborted &&
        this.refreshTeardownCounts.has(this.getRefreshOwnerKey(userId, serverName))
      ) {
        return null;
      }
      // Check if it's an unauthorized_client error (refresh not supported)
      const errorMessage =
        refreshError instanceof Error ? refreshError.message : String(refreshError);
      const normalizedErrorMessage = errorMessage.toLowerCase();
      if (normalizedErrorMessage.includes('unauthorized_client')) {
        logger.info(
          `${logPrefix} Server does not support refresh tokens for this client. New authentication required.`,
        );
        return null;
      }
      if (normalizedErrorMessage.includes('invalid_grant')) {
        logger.info(`${logPrefix} Refresh grant is no longer valid. New authentication required.`);
        return null;
      }
      if (isInvalidClientMessage(errorMessage)) {
        if (deleteTokens) {
          logger.info(
            `${logPrefix} Client registration rejected during token refresh, attempting to clear stale registration and refresh token`,
          );
          const publishPreparedCleanup = await onRefreshPreparing?.();
          const results = await Promise.allSettled([
            MCPTokenStorage.deleteClientRegistration({
              userId,
              serverName,
              deleteTokens,
              credentialSetId: refreshCredentialSetId,
            }),
            deleteTokens({
              userId,
              type: 'mcp_oauth_refresh',
              identifier: `${identifier}:refresh`,
              ...(refreshCredentialSetId && {
                metadataCredentialSetId: refreshCredentialSetId,
              }),
            }),
          ]);
          for (const r of results) {
            if (r.status === 'rejected') {
              logger.warn(`${logPrefix} Failed to clear stale token data`, r.reason);
            }
          }
          await publishPreparedCleanup?.();
          throw new ReauthenticationRequiredError(serverName, 'invalid_client');
        }
        logger.warn(
          `${logPrefix} Client registration rejected during token refresh but deleteTokens not available — stale registration cannot be cleared`,
        );
        return null;
      }
      throw new MCPTokenRefreshUnavailableError(serverName, refreshError);
    }
  }

  /**
   * Retrieves OAuth tokens for an MCP server
   */
  static async getTokens({
    userId,
    serverName,
    findToken,
    createToken,
    updateToken,
    deleteTokens,
    refreshTokens,
    singleFlightScope,
    refreshWaitTimeoutMs,
    coordinateRefresh,
    persistenceWaitTimeoutMs,
    flowManager,
    onRefreshSuccess,
    onRefreshPreparing,
    onTokensAdopted,
  }: GetTokensParams): Promise<MCPOAuthTokens | null> {
    const logPrefix = this.getLogPrefix(userId, serverName);

    try {
      const identifier = `mcp:${serverName}`;

      // Get access token
      const accessTokenData = await findToken({
        userId,
        type: 'mcp_oauth',
        identifier,
      });

      /** Check if access token is missing or expired */
      const isMissing = !accessTokenData;
      const isExpired = accessTokenData?.expiresAt && new Date() >= accessTokenData.expiresAt;

      if (isMissing || isExpired) {
        logger.info(`${logPrefix} Access token ${isMissing ? 'missing' : 'expired'}`);

        /** Probe for a refresh token first so we can throw `ReauthenticationRequiredError`
         *  when none exists, matching the prior contract. The probe result is passed on as the
         *  cross-replica flight's observation baseline, which saves a read on this latency-counted
         *  path, and never as the credential to redeem — the redemption reads storage again under
         *  the flight, so it cannot replay a refresh token a concurrent refresh already consumed. */
        const refreshTokenData = await findToken({
          userId,
          type: 'mcp_oauth_refresh',
          identifier: `${identifier}:refresh`,
        });

        if (!refreshTokenData) {
          const reason = isMissing ? 'missing' : 'expired';
          logger.info(
            `${logPrefix} Access token ${reason} and no refresh token available — re-authentication required`,
          );
          throw new ReauthenticationRequiredError(serverName, reason);
        }

        return await this.forceRefreshTokens({
          userId,
          serverName,
          findToken,
          createToken,
          updateToken,
          deleteTokens,
          refreshTokens,
          singleFlightScope,
          refreshWaitTimeoutMs,
          coordinateRefresh,
          persistenceWaitTimeoutMs,
          flowManager,
          onRefreshSuccess,
          onRefreshPreparing,
          onTokensAdopted,
          existingAccessToken: accessTokenData,
          existingRefreshToken: refreshTokenData,
        });
      }

      // If we reach here, access token should exist and be valid
      if (!accessTokenData) {
        return null;
      }

      const tokens = await this.readStoredTokens({
        userId,
        serverName,
        findToken,
        accessTokenData,
      });

      logger.debug(`${logPrefix} Loaded existing OAuth tokens from storage`);
      return tokens;
    } catch (error) {
      if (
        error instanceof ReauthenticationRequiredError ||
        error instanceof MCPTokenRefreshUnavailableError
      ) {
        throw error;
      }
      logger.error(`${logPrefix} Failed to retrieve tokens`, error);
      throw new MCPTokenStorageUnavailableError(serverName, error);
    }
  }

  /**
   * Rebuilds the token pair from storage around an access-token record the caller already
   * read. Expiry is the caller's business: `getTokens` checks it before reading, and the
   * adoption path checks it against the record a peer just wrote.
   *
   * Throws `ReauthenticationRequiredError('binding')` when the access record carries no
   * credential set or its client metadata no longer agrees with it.
   */
  private static async readStoredTokens({
    userId,
    serverName,
    findToken,
    accessTokenData,
  }: {
    userId: string;
    serverName: string;
    findToken: GetTokensParams['findToken'];
    accessTokenData: IToken;
  }): Promise<MCPOAuthTokens> {
    const logPrefix = this.getLogPrefix(userId, serverName);
    const identifier = `mcp:${serverName}`;

    const credentialSetId = getCredentialSetId(accessTokenData);
    if (!credentialSetId) {
      throw new ReauthenticationRequiredError(serverName, 'binding');
    }

    const decryptedAccessToken = await decryptV2(accessTokenData.token);

    /** Get refresh token if available */
    const refreshTokenData = await findToken({
      userId,
      type: 'mcp_oauth_refresh',
      identifier: `${identifier}:refresh`,
    });

    const clientInfoData = await findToken({
      userId,
      type: 'mcp_oauth_client',
      identifier: `${identifier}:client`,
    });
    this.assertCredentialSetBinding(serverName, credentialSetId, getTokenMetadata(clientInfoData));

    const tokens: MCPOAuthTokens = {
      access_token: decryptedAccessToken,
      token_type: 'Bearer',
      credential_set_id: credentialSetId,
      obtained_at: accessTokenData.createdAt.getTime(),
      expires_at: accessTokenData.expiresAt?.getTime(),
    };

    if (refreshTokenData && getCredentialSetId(refreshTokenData) === credentialSetId) {
      tokens.refresh_token = await decryptV2(refreshTokenData.token);
    } else if (refreshTokenData) {
      logger.warn(`${logPrefix} Ignoring refresh token from a different OAuth credential set`);
    }

    return tokens;
  }

  static async getClientInfoAndMetadata({
    userId,
    serverName,
    findToken,
  }: {
    userId: string;
    serverName: string;
    findToken: TokenMethods['findToken'];
  }): Promise<{
    clientInfo: OAuthClientInformation;
    clientMetadata: Record<string, unknown>;
  } | null> {
    const identifier = `mcp:${serverName}`;

    const clientInfoData: IToken | null = await findToken({
      userId,
      type: 'mcp_oauth_client',
      identifier: `${identifier}:client`,
    });
    if (clientInfoData == null) {
      return null;
    }

    const tokenData = await decryptV2(clientInfoData.token);
    const clientInfo = JSON.parse(tokenData);

    const clientMetadata = getTokenMetadata(clientInfoData);

    return {
      clientInfo,
      clientMetadata,
    };
  }

  /** Deletes only the stored client registration for a specific user and server */
  static async deleteClientRegistration({
    userId,
    serverName,
    deleteTokens,
    credentialSetId,
  }: {
    userId: string;
    serverName: string;
    deleteTokens: TokenMethods['deleteTokens'];
    credentialSetId?: string;
  }): Promise<void> {
    const identifier = `mcp:${serverName}`;
    await deleteTokens({
      userId,
      type: 'mcp_oauth_client',
      identifier: `${identifier}:client`,
      ...(credentialSetId && { metadataCredentialSetId: credentialSetId }),
    });
    const logPrefix = this.getLogPrefix(userId, serverName);
    logger.debug(`${logPrefix} Cleared stored client registration`);
  }

  /**
   * Deletes all OAuth-related tokens for a specific user and server
   */
  static async deleteUserTokens({
    userId,
    serverName,
    deleteToken,
  }: {
    userId: string;
    serverName: string;
    deleteToken: (filter: { userId: string; type: string; identifier: string }) => Promise<void>;
  }): Promise<void> {
    const identifier = `mcp:${serverName}`;

    // delete client info token
    await deleteToken({
      userId,
      type: 'mcp_oauth_client',
      identifier: `${identifier}:client`,
    });

    // delete access token
    await deleteToken({
      userId,
      type: 'mcp_oauth',
      identifier,
    });

    // delete refresh token
    await deleteToken({
      userId,
      type: 'mcp_oauth_refresh',
      identifier: `${identifier}:refresh`,
    });
  }
}
