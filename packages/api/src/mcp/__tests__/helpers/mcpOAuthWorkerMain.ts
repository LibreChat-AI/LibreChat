/**
 * One replica of the MCP OAuth multi-process harness.
 *
 * Runs in its own process with production adapters: a real Mongo connection and the real token
 * methods (so credentials are encrypted and persisted exactly as deployed), a real Redis-backed
 * `FlowStateManager` (so refresh coordination and the persistence fence are distributed rather
 * than process-local), and the real `MCPTokenStorage` / `MCPOAuthHandler`. Only the OAuth provider
 * and the stores are test-owned.
 *
 * Secrets never leave this process: the parent receives digests and HTTP statuses, never a token.
 */

import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { createMethods, createModels, decryptV2 } from '@librechat/data-schemas';
import type { TokenMethods } from '@librechat/data-schemas';
import type {
  MCPOAuthTokens,
  OAuthClientInformation,
  OAuthStoredClientMetadata,
} from '~/mcp/oauth';
import { MCPOAuthHandler, MCPTokenStorage } from '~/mcp/oauth';
import { standardCache } from '~/cache/cacheFactory';
import { FlowStateManager } from '~/flow/manager';

interface WorkerRequest {
  id: number;
  command: string;
  payload?: Record<string, unknown>;
}

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Worker requires ${name}`);
  }
  return value;
};

const providerUrl = env('MCP_TEST_PROVIDER_URL');
const userId = env('MCP_TEST_USER_ID');
const serverName = env('MCP_TEST_SERVER_NAME');
const clientId = env('MCP_TEST_CLIENT_ID');
const flowNamespace = env('MCP_TEST_FLOW_NAMESPACE');
const coordinateRefresh = process.env.MCP_TEST_COORDINATE === 'true';
/** The provider listens on loopback, which the SSRF gate blocks unless explicitly allowed. */
const allowedAddresses = [new URL(providerUrl).host];
const identifier = `mcp:${serverName}`;

let tokenMethods: TokenMethods;
let flowManager: FlowStateManager<MCPOAuthTokens | null>;

/** Digest so the parent can compare rotation without a credential crossing the IPC channel. */
const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);

const clientInfo: OAuthClientInformation = {
  client_id: clientId,
  redirect_uris: ['http://localhost'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

const storedMetadata = (): OAuthStoredClientMetadata =>
  ({
    issuer: providerUrl.replace(/\/$/, ''),
    authorization_endpoint: new URL('authorize', providerUrl).href,
    token_endpoint: new URL('token', providerUrl).href,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    server_url: providerUrl,
    client_source: 'dynamic',
  }) as OAuthStoredClientMetadata;

async function init(): Promise<void> {
  createModels(mongoose);
  tokenMethods = createMethods(mongoose) as unknown as TokenMethods;
  await mongoose.connect(env('MCP_TEST_MONGO_URI'), { autoIndex: false });
  flowManager = new FlowStateManager<MCPOAuthTokens | null>(standardCache(flowNamespace, 60_000), {
    ttl: 60_000,
  });
}

/** Completes a real authorization-code grant against the provider. */
async function exchangeAuthorizationCode(): Promise<MCPOAuthTokens> {
  const authUrl = new URL('authorize', providerUrl);
  authUrl.searchParams.set('redirect_uri', 'http://localhost');
  authUrl.searchParams.set('state', `multiprocess-${process.pid}`);
  authUrl.searchParams.set('client_id', clientId);

  const authResponse = await fetch(authUrl, { redirect: 'manual' });
  const location = authResponse.headers.get('location');
  if (!location) {
    throw new Error(`Authorization failed with HTTP ${authResponse.status}`);
  }
  const code = new URL(location).searchParams.get('code');
  if (!code) {
    throw new Error('Authorization response carried no code');
  }

  const tokenResponse = await fetch(new URL('token', providerUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
    }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`Token exchange failed with HTTP ${tokenResponse.status}`);
  }
  const body = (await tokenResponse.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token?: string;
  };
  return {
    ...body,
    obtained_at: Date.now(),
    expires_at: Date.now() + body.expires_in * 1000,
  } as MCPOAuthTokens;
}

/** Proves a credential is accepted by the protected resource, without revealing it. */
async function probeResource(accessToken: string): Promise<number> {
  const response = await fetch(providerUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'multiprocess-harness', version: '0.0.1' },
      },
    }),
  });
  return response.status;
}

/** Token metadata is a Mongoose Map on a hydrated document and a plain object once lean. */
function readCredentialSetId(record: { metadata?: unknown } | null): string | null {
  const metadata = record?.metadata as Map<string, unknown> | Record<string, unknown> | undefined;
  if (!metadata) {
    return null;
  }
  const value =
    metadata instanceof Map
      ? metadata.get('credential_set_id')
      : (metadata as Record<string, unknown>).credential_set_id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Digest of the persisted refresh credential, so the parent can observe rotation. */
async function storedRefreshDigest(): Promise<string | null> {
  const record = await tokenMethods.findToken({
    userId,
    type: 'mcp_oauth_refresh',
    identifier: `${identifier}:refresh`,
  });
  return record ? digest(await decryptV2(record.token)) : null;
}

const commands: Record<string, (payload: Record<string, unknown>) => Promise<unknown>> = {
  /** Interactive authorization, persisted through the production storage path. */
  async authorize() {
    const tokens = await exchangeAuthorizationCode();
    const stored = await MCPTokenStorage.storeTokens({
      userId,
      serverName,
      tokens,
      createToken: tokenMethods.createToken,
      updateToken: tokenMethods.updateToken,
      deleteTokens: tokenMethods.deleteTokens,
      findToken: tokenMethods.findToken,
      clientInfo,
      metadata: storedMetadata(),
      flowManager,
    });
    return { credentialSetId: stored.credential_set_id };
  },

  /** Ages the stored access record so the next read must refresh, as elapsed time would. */
  async expireAccess() {
    await tokenMethods.updateToken({ userId, type: 'mcp_oauth', identifier }, { expiresIn: -60 });
    return { expired: true };
  },

  /** The production read path: refresh when expired, coordinating across replicas. */
  async getTokens() {
    /**
     * Confirm the credential this replica is about to read is actually expired, then tell the
     * parent. A concurrency assertion that only counts provider hits can pass vacuously when one
     * replica arrives after the winner already persisted: it would simply load a fresh token and
     * never contend. The parent waits for this signal from BOTH replicas before releasing the
     * provider, so the overlap is established rather than assumed from a fixed delay.
     */
    const accessBefore = await tokenMethods.findToken({ userId, type: 'mcp_oauth', identifier });
    const expiredAtEntry =
      accessBefore?.expiresAt != null && new Date() >= new Date(accessBefore.expiresAt);
    process.send?.({ progress: 'entered-refresh-path', expiredAtEntry });

    /**
     * `getTokens` invokes exactly one of these per call, so they report which side of the
     * coordination this replica took: the redeemer, or a peer adopting what the redeemer
     * published. Asserting the pair is what makes the test non-vacuous regardless of timing.
     */
    let role: 'refreshed' | 'adopted' | null = null;

    const tokens = await MCPTokenStorage.getTokens({
      userId,
      serverName,
      onRefreshSuccess: async () => {
        role = 'refreshed';
      },
      onTokensAdopted: async () => {
        role = 'adopted';
      },
      findToken: tokenMethods.findToken,
      createToken: tokenMethods.createToken,
      updateToken: tokenMethods.updateToken,
      deleteTokens: tokenMethods.deleteTokens,
      coordinateRefresh,
      flowManager,
      refreshTokens: async (refreshToken, metadata, signal) =>
        MCPOAuthHandler.refreshOAuthTokens(
          refreshToken,
          {
            serverName: metadata.serverName,
            serverUrl: metadata.storedServerUrl ?? providerUrl,
            clientInfo: metadata.clientInfo,
            storedTokenEndpoint: metadata.storedTokenEndpoint,
            storedAuthMethods: metadata.storedAuthMethods,
            storedServerUrl: metadata.storedServerUrl,
            clientSource: metadata.clientSource,
            resource: metadata.resource,
          },
          {},
          undefined,
          null,
          allowedAddresses,
          signal,
        ),
    });
    if (!tokens) {
      return {
        obtained: false,
        role,
        expiredAtEntry,
        resourceStatus: null,
        refreshDigest: await storedRefreshDigest(),
      };
    }
    return {
      obtained: true,
      role,
      expiredAtEntry,
      accessDigest: digest(tokens.access_token),
      credentialSetId: tokens.credential_set_id ?? null,
      /** Proves the credential is accepted by the protected resource, not merely non-null. */
      resourceStatus: await probeResource(tokens.access_token),
      refreshDigest: await storedRefreshDigest(),
    };
  },

  /** Persisted-state digests, so the parent can assert rotation and survival. */
  async readStored() {
    const [access, refresh, client] = await Promise.all([
      tokenMethods.findToken({ userId, type: 'mcp_oauth', identifier }),
      tokenMethods.findToken({
        userId,
        type: 'mcp_oauth_refresh',
        identifier: `${identifier}:refresh`,
      }),
      tokenMethods.findToken({
        userId,
        type: 'mcp_oauth_client',
        identifier: `${identifier}:client`,
      }),
    ]);
    return {
      obtained: access != null,
      accessDigest: access ? digest(await decryptV2(access.token)) : null,
      refreshDigest: refresh ? digest(await decryptV2(refresh.token)) : null,
      credentialSetId: readCredentialSetId(access) ?? readCredentialSetId(client),
      hasClient: client != null,
      role: null,
      resourceStatus: null,
    };
  },
};

process.on('message', (raw: unknown) => {
  const request = raw as WorkerRequest;
  void (async () => {
    try {
      const handler = commands[request.command];
      if (!handler) {
        throw new Error(`Unknown worker command: ${request.command}`);
      }
      const result = await handler(request.payload ?? {});
      process.send?.({ id: request.id, ok: true, result });
    } catch (error) {
      process.send?.({
        id: request.id,
        ok: false,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      });
    }
  })();
});

void init().then(
  () => process.send?.({ ready: true, pid: process.pid }),
  (error: unknown) =>
    process.send?.({
      ready: false,
      error: { message: error instanceof Error ? error.message : String(error) },
    }),
);
