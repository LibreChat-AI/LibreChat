/**
 * Integration tests for MCPTokenStorage.storeTokens() and MCPTokenStorage.getTokens().
 *
 * Uses InMemoryTokenStore to exercise encrypt/decrypt round-trips, expiry calculation,
 * refresh callback wiring, and ReauthenticationRequiredError paths.
 */

import { Keyv } from 'keyv';
import type { TokenMethods } from '@librechat/data-schemas';
import type { MCPOAuthTokens } from '~/mcp/oauth';
import {
  MCPTokenStorage,
  MCPTokenRefreshUnavailableError,
  MCPTokenStorageUnavailableError,
  ReauthenticationRequiredError,
  getMCPOAuthLeaseId,
  getMCPOAuthRefreshFlightLeaseId,
} from '~/mcp/oauth';
import { InMemoryTokenStore } from './helpers/oauthTestServer';
import { FlowStateManager } from '~/flow/manager';

const credentialSetId = 'credential-set-a';
const storedTokenMetadata = { credential_set_id: credentialSetId };
const storedBindingMetadata = {
  ...storedTokenMetadata,
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  server_url: 'https://mcp.example.com/',
  client_source: 'dynamic',
} as const;

function createBoundToken(
  store: InMemoryTokenStore,
  data: Parameters<InMemoryTokenStore['createToken']>[0],
) {
  return store.createToken({
    ...data,
    metadata: { ...storedTokenMetadata, ...(data.metadata ?? {}) },
  });
}

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  getTenantId: jest.fn(),
  encryptV2: jest.fn(async (val: string) => `enc:${val}`),
  decryptV2: jest.fn(async (val: string) => val.replace(/^enc:/, '')),
}));

describe('MCPTokenStorage', () => {
  let store: InMemoryTokenStore;

  beforeEach(() => {
    store = new InMemoryTokenStore();
    jest.clearAllMocks();
  });

  describe('hasStoredAuthorization', () => {
    const validateClientBinding = () => undefined;

    async function storeClient(
      metadata: Record<string, unknown> = storedBindingMetadata,
      clientInfo = { client_id: 'dynamic-client' },
    ) {
      await store.createToken({
        userId: 'u1',
        type: 'mcp_oauth_client',
        identifier: 'mcp:srv1:client',
        token: `enc:${JSON.stringify(clientInfo)}`,
        expiresIn: 3600,
        metadata,
      });
    }

    it('accepts a current access token bound to its stored client generation', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:access-token',
        expiresIn: 3600,
      });
      await storeClient();

      await expect(
        MCPTokenStorage.hasStoredAuthorization({
          userId: 'u1',
          serverName: 'srv1',
          findToken: store.findToken,
          validateClientBinding,
        }),
      ).resolves.toBe(true);
    });

    it('rejects legacy credentials without binding metadata', async () => {
      await store.createToken({
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:legacy-access-token',
        expiresIn: 3600,
      });
      await storeClient({});

      await expect(
        MCPTokenStorage.hasStoredAuthorization({
          userId: 'u1',
          serverName: 'srv1',
          findToken: store.findToken,
          validateClientBinding,
        }),
      ).resolves.toBe(false);
    });

    it('accepts an expired access token only when a bound refresh token remains usable', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:expired-access-token',
        expiresIn: -60,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
        token: 'enc:refresh-token',
        expiresIn: 3600,
      });
      await storeClient();

      await expect(
        MCPTokenStorage.hasStoredAuthorization({
          userId: 'u1',
          serverName: 'srv1',
          findToken: store.findToken,
          validateClientBinding,
        }),
      ).resolves.toBe(true);
    });

    it('accepts a bound refresh token after the expired access-token record is removed', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
        token: 'enc:refresh-token',
        expiresIn: 3600,
      });
      await storeClient();

      await expect(
        MCPTokenStorage.hasStoredAuthorization({
          userId: 'u1',
          serverName: 'srv1',
          findToken: store.findToken,
          validateClientBinding,
        }),
      ).resolves.toBe(true);
    });

    it('rejects a refresh-only credential from a different client generation', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
        token: 'enc:refresh-token',
        expiresIn: 3600,
      });
      await storeClient({ ...storedBindingMetadata, credential_set_id: 'different-generation' });

      await expect(
        MCPTokenStorage.hasStoredAuthorization({
          userId: 'u1',
          serverName: 'srv1',
          findToken: store.findToken,
          validateClientBinding,
        }),
      ).resolves.toBe(false);
    });

    it('rejects an expired access token without a usable refresh token', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:expired-access-token',
        expiresIn: -60,
      });
      await storeClient();

      await expect(
        MCPTokenStorage.hasStoredAuthorization({
          userId: 'u1',
          serverName: 'srv1',
          findToken: store.findToken,
          validateClientBinding,
        }),
      ).resolves.toBe(false);
    });

    it('rejects usable credentials that are bound to an older server configuration', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:access-token',
        expiresIn: 3600,
      });
      await storeClient({
        ...storedBindingMetadata,
        server_url: 'https://old-mcp.example.com/',
      });

      await expect(
        MCPTokenStorage.hasStoredAuthorization({
          userId: 'u1',
          serverName: 'srv1',
          findToken: store.findToken,
          validateClientBinding: (_clientInfo, storedMetadata) => {
            if (storedMetadata.server_url !== 'https://new-mcp.example.com/') {
              throw new Error('stored server binding changed');
            }
          },
        }),
      ).resolves.toBe(false);
    });
  });

  describe('isCurrentAccessToken', () => {
    it('rejects a flow-cached token after persistent storage has rotated it', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:new-token',
        expiresIn: 3600,
      });

      await expect(
        MCPTokenStorage.isCurrentAccessToken({
          userId: 'u1',
          serverName: 'srv1',
          accessToken: 'old-cached-token',
          credentialSetId,
          findToken: store.findToken,
        }),
      ).resolves.toBe(false);
      await expect(
        MCPTokenStorage.isCurrentAccessToken({
          userId: 'u1',
          serverName: 'srv1',
          accessToken: 'new-token',
          credentialSetId,
          findToken: store.findToken,
        }),
      ).resolves.toBe(true);
    });

    it('rejects the same token value after its credential generation changes', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:same-token',
        expiresIn: 3600,
        metadata: { credential_set_id: 'credential-set-b' },
      });

      await expect(
        MCPTokenStorage.isCurrentAccessToken({
          userId: 'u1',
          serverName: 'srv1',
          accessToken: 'same-token',
          credentialSetId,
          findToken: store.findToken,
        }),
      ).resolves.toBe(false);
    });
  });

  describe('storeTokens', () => {
    it('persists fence intent before writing the first token row', async () => {
      const onStorePreparing = jest.fn().mockResolvedValue(undefined);
      const createToken = jest.fn(store.createToken);

      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: { access_token: 'at1', token_type: 'Bearer' },
        createToken,
        onStorePreparing,
      });

      expect(onStorePreparing.mock.invocationCallOrder[0]).toBeLessThan(
        createToken.mock.invocationCallOrder[0],
      );
    });

    it('keeps the trusted flow generation when provider metadata supplies a conflicting ID', async () => {
      const result = await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: {
          access_token: 'at1',
          token_type: 'Bearer',
          obtained_at: Date.now(),
          credential_set_id: 'credential-set-from-flow',
        },
        createToken: store.createToken,
        clientInfo: { client_id: 'client-id' },
        metadata: {
          ...storedBindingMetadata,
          credential_set_id: 'credential-set-from-metadata',
        },
      });

      expect(result.credential_set_id).toBe('credential-set-from-flow');
      expect(store.getAll()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'mcp_oauth',
            metadata: expect.objectContaining({
              credential_set_id: 'credential-set-from-flow',
            }),
          }),
          expect.objectContaining({
            type: 'mcp_oauth_client',
            metadata: expect.objectContaining({
              credential_set_id: 'credential-set-from-flow',
            }),
          }),
        ]),
      );
    });

    it('does not adopt a provider metadata generation when callback tokens lack one', async () => {
      const result = await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: { access_token: 'at1', token_type: 'Bearer' },
        createToken: store.createToken,
        clientInfo: { client_id: 'client-id' },
        metadata: {
          ...storedBindingMetadata,
          credential_set_id: 'provider-controlled-generation',
        },
      });

      expect(result.credential_set_id).toEqual(expect.any(String));
      expect(result.credential_set_id).not.toBe('provider-controlled-generation');
      expect(store.getAll()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'mcp_oauth',
            metadata: expect.objectContaining({
              credential_set_id: result.credential_set_id,
            }),
          }),
          expect.objectContaining({
            type: 'mcp_oauth_client',
            metadata: expect.objectContaining({
              credential_set_id: result.credential_set_id,
            }),
          }),
        ]),
      );
    });

    it('rejects metadata that conflicts with the expected refresh generation', async () => {
      const createToken = jest.fn();

      await expect(
        MCPTokenStorage.storeTokens({
          userId: 'u1',
          serverName: 'srv1',
          tokens: { access_token: 'at1', token_type: 'Bearer' },
          createToken,
          metadata: {
            ...storedBindingMetadata,
            credential_set_id: 'different-generation',
          },
          expectedCredentialSetId: credentialSetId,
        }),
      ).rejects.toThrow(ReauthenticationRequiredError);
      expect(createToken).not.toHaveBeenCalled();
    });

    it('rejects a stale write when the generation changes after prevalidation', async () => {
      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: {
          access_token: 'generation-a-access',
          refresh_token: 'generation-a-refresh',
          token_type: 'Bearer',
          credential_set_id: credentialSetId,
        },
        createToken: store.createToken,
        updateToken: store.updateToken,
        findToken: store.findToken,
        clientInfo: { client_id: 'client-a', client_secret: 'secret-a' },
        metadata: storedBindingMetadata,
      });

      let replaced = false;
      const interleavedUpdate = jest.fn(async (...args: Parameters<typeof store.updateToken>) => {
        if (!replaced) {
          replaced = true;
          await MCPTokenStorage.storeTokens({
            userId: 'u1',
            serverName: 'srv1',
            tokens: {
              access_token: 'generation-b-access',
              refresh_token: 'generation-b-refresh',
              token_type: 'Bearer',
              credential_set_id: 'credential-set-b',
            },
            createToken: store.createToken,
            updateToken: store.updateToken,
            findToken: store.findToken,
            clientInfo: { client_id: 'client-b', client_secret: 'secret-b' },
            metadata: {
              ...storedBindingMetadata,
              credential_set_id: 'credential-set-b',
            },
          });
        }
        return await store.updateToken(...args);
      }) as typeof store.updateToken;

      await expect(
        MCPTokenStorage.storeTokens({
          userId: 'u1',
          serverName: 'srv1',
          tokens: {
            access_token: 'late-generation-a-access',
            refresh_token: 'late-generation-a-refresh',
            token_type: 'Bearer',
            credential_set_id: credentialSetId,
          },
          createToken: store.createToken,
          updateToken: interleavedUpdate,
          findToken: store.findToken,
          clientInfo: { client_id: 'client-a', client_secret: 'secret-a' },
          metadata: storedBindingMetadata,
          expectedCredentialSetId: credentialSetId,
        }),
      ).rejects.toThrow(ReauthenticationRequiredError);

      expect(interleavedUpdate).toHaveBeenCalledTimes(1);
      expect(store.getAll()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'mcp_oauth',
            token: 'enc:generation-b-access',
            metadata: expect.objectContaining({ credential_set_id: 'credential-set-b' }),
          }),
          expect.objectContaining({
            type: 'mcp_oauth_refresh',
            token: 'enc:generation-b-refresh',
            metadata: expect.objectContaining({ credential_set_id: 'credential-set-b' }),
          }),
          expect.objectContaining({
            type: 'mcp_oauth_client',
            token: expect.stringContaining('client-b'),
            metadata: expect.objectContaining({ credential_set_id: 'credential-set-b' }),
          }),
        ]),
      );
    });

    it('rolls back callback access when an interleaved refresh wins the next CAS', async () => {
      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: {
          access_token: 'generation-a-refreshed-access',
          refresh_token: 'generation-a-refresh',
          token_type: 'Bearer',
          credential_set_id: credentialSetId,
        },
        createToken: store.createToken,
        updateToken: store.updateToken,
        deleteTokens: store.deleteTokens,
        findToken: store.findToken,
        clientInfo: { client_id: 'client-a', client_secret: 'secret-a' },
        metadata: storedBindingMetadata,
      });

      let injectedRefresh = false;
      const interleavedUpdate = jest.fn(async (...args: Parameters<typeof store.updateToken>) => {
        const updated = await store.updateToken(...args);
        const [query] = args;
        if (updated && !injectedRefresh && query.type === 'mcp_oauth') {
          injectedRefresh = true;
          await store.updateToken(
            {
              userId: 'u1',
              type: 'mcp_oauth_refresh',
              identifier: 'mcp:srv1:refresh',
              token: 'enc:generation-a-refresh',
              metadataCredentialSetId: credentialSetId,
            },
            {
              token: 'enc:generation-a-rotated-refresh',
              metadata: storedTokenMetadata,
            },
          );
          await store.updateToken(
            {
              userId: 'u1',
              type: 'mcp_oauth_client',
              identifier: 'mcp:srv1:client',
              metadataCredentialSetId: credentialSetId,
            },
            {
              token: 'enc:{"client_id":"client-a-rotated","client_secret":"secret-a"}',
              metadata: storedBindingMetadata,
            },
          );
        }
        return updated;
      }) as typeof store.updateToken;

      await expect(
        MCPTokenStorage.storeTokens({
          userId: 'u1',
          serverName: 'srv1',
          tokens: {
            access_token: 'generation-b-access',
            refresh_token: 'generation-b-refresh',
            token_type: 'Bearer',
            credential_set_id: 'credential-set-b',
          },
          createToken: store.createToken,
          updateToken: interleavedUpdate,
          deleteTokens: store.deleteTokens,
          findToken: store.findToken,
          clientInfo: { client_id: 'client-b', client_secret: 'secret-b' },
          metadata: storedBindingMetadata,
        }),
      ).rejects.toThrow(ReauthenticationRequiredError);

      expect(store.getAll()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'mcp_oauth',
            token: 'enc:generation-a-refreshed-access',
            metadata: expect.objectContaining({ credential_set_id: credentialSetId }),
          }),
          expect.objectContaining({
            type: 'mcp_oauth_refresh',
            token: 'enc:generation-a-rotated-refresh',
            metadata: expect.objectContaining({ credential_set_id: credentialSetId }),
          }),
          expect.objectContaining({
            type: 'mcp_oauth_client',
            token: expect.stringContaining('client-a-rotated'),
            metadata: expect.objectContaining({ credential_set_id: credentialSetId }),
          }),
        ]),
      );
    });

    it('does not roll back over a newer writer that supersedes the callback anchor', async () => {
      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: {
          access_token: 'generation-a-access',
          refresh_token: 'generation-a-refresh',
          token_type: 'Bearer',
          credential_set_id: credentialSetId,
        },
        createToken: store.createToken,
        updateToken: store.updateToken,
        deleteTokens: store.deleteTokens,
        findToken: store.findToken,
        clientInfo: { client_id: 'client-a', client_secret: 'secret-a' },
        metadata: storedBindingMetadata,
      });

      let injectedNewerWriter = false;
      const interleavedUpdate = jest.fn(async (...args: Parameters<typeof store.updateToken>) => {
        const updated = await store.updateToken(...args);
        const [query] = args;
        if (updated && !injectedNewerWriter && query.type === 'mcp_oauth') {
          injectedNewerWriter = true;
          const generationCMetadata = { credential_set_id: 'credential-set-c' };
          await store.updateToken(
            {
              userId: 'u1',
              type: 'mcp_oauth',
              identifier: 'mcp:srv1',
              token: 'enc:generation-b-access',
              metadataCredentialSetId: 'credential-set-b',
            },
            { token: 'enc:generation-c-access', metadata: generationCMetadata },
          );
          await store.updateToken(
            {
              userId: 'u1',
              type: 'mcp_oauth_refresh',
              identifier: 'mcp:srv1:refresh',
              metadataCredentialSetId: credentialSetId,
            },
            { token: 'enc:generation-c-refresh', metadata: generationCMetadata },
          );
          await store.updateToken(
            {
              userId: 'u1',
              type: 'mcp_oauth_client',
              identifier: 'mcp:srv1:client',
              metadataCredentialSetId: credentialSetId,
            },
            {
              token: 'enc:{"client_id":"client-c","client_secret":"secret-c"}',
              metadata: { ...storedBindingMetadata, ...generationCMetadata },
            },
          );
        }
        return updated;
      }) as typeof store.updateToken;

      await expect(
        MCPTokenStorage.storeTokens({
          userId: 'u1',
          serverName: 'srv1',
          tokens: {
            access_token: 'generation-b-access',
            refresh_token: 'generation-b-refresh',
            token_type: 'Bearer',
            credential_set_id: 'credential-set-b',
          },
          createToken: store.createToken,
          updateToken: interleavedUpdate,
          deleteTokens: store.deleteTokens,
          findToken: store.findToken,
          clientInfo: { client_id: 'client-b', client_secret: 'secret-b' },
          metadata: storedBindingMetadata,
        }),
      ).rejects.toThrow(ReauthenticationRequiredError);

      expect(store.getAll()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'mcp_oauth',
            token: 'enc:generation-c-access',
            metadata: expect.objectContaining({ credential_set_id: 'credential-set-c' }),
          }),
          expect.objectContaining({
            type: 'mcp_oauth_refresh',
            token: 'enc:generation-c-refresh',
            metadata: expect.objectContaining({ credential_set_id: 'credential-set-c' }),
          }),
          expect.objectContaining({
            type: 'mcp_oauth_client',
            token: expect.stringContaining('client-c'),
            metadata: expect.objectContaining({ credential_set_id: 'credential-set-c' }),
          }),
        ]),
      );
    });

    it('fails closed without writes when access and client generations are already mixed', async () => {
      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: {
          access_token: 'generation-a-access',
          refresh_token: 'generation-a-refresh',
          token_type: 'Bearer',
          credential_set_id: credentialSetId,
        },
        createToken: store.createToken,
        updateToken: store.updateToken,
        deleteTokens: store.deleteTokens,
        findToken: store.findToken,
        clientInfo: { client_id: 'client-a', client_secret: 'secret-a' },
        metadata: storedBindingMetadata,
      });
      await store.updateToken(
        {
          userId: 'u1',
          type: 'mcp_oauth',
          identifier: 'mcp:srv1',
          token: 'enc:generation-a-access',
          metadataCredentialSetId: credentialSetId,
        },
        {
          token: 'enc:crash-left-generation-b-access',
          metadata: { credential_set_id: 'credential-set-b' },
        },
      );

      const createToken = jest.fn(store.createToken);
      const updateToken = jest.fn(store.updateToken);
      const deleteTokens = jest.fn(store.deleteTokens);

      await expect(
        MCPTokenStorage.storeTokens({
          userId: 'u1',
          serverName: 'srv1',
          tokens: {
            access_token: 'generation-c-access',
            refresh_token: 'generation-c-refresh',
            token_type: 'Bearer',
            credential_set_id: 'credential-set-c',
          },
          createToken,
          updateToken,
          deleteTokens,
          findToken: store.findToken,
          clientInfo: { client_id: 'client-c', client_secret: 'secret-c' },
          metadata: storedBindingMetadata,
        }),
      ).rejects.toThrow(ReauthenticationRequiredError);

      expect(createToken).not.toHaveBeenCalled();
      expect(updateToken).not.toHaveBeenCalled();
      expect(deleteTokens).not.toHaveBeenCalled();
      expect(store.getAll()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'mcp_oauth',
            token: 'enc:crash-left-generation-b-access',
            metadata: expect.objectContaining({ credential_set_id: 'credential-set-b' }),
          }),
          expect.objectContaining({
            type: 'mcp_oauth_refresh',
            token: 'enc:generation-a-refresh',
            metadata: expect.objectContaining({ credential_set_id: credentialSetId }),
          }),
          expect.objectContaining({
            type: 'mcp_oauth_client',
            token: expect.stringContaining('client-a'),
            metadata: expect.objectContaining({ credential_set_id: credentialSetId }),
          }),
        ]),
      );
    });

    it('deletes its own created records when a later create fails', async () => {
      const createToken = jest.fn(async (data) => {
        if (data.type === 'mcp_oauth_refresh') {
          throw new Error('refresh create failed');
        }
        return await store.createToken(data);
      }) as typeof store.createToken;
      const deleteTokens = jest.fn(store.deleteTokens);

      await expect(
        MCPTokenStorage.storeTokens({
          userId: 'u1',
          serverName: 'srv1',
          tokens: {
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            token_type: 'Bearer',
            credential_set_id: 'credential-set-new',
          },
          createToken,
          deleteTokens,
        }),
      ).rejects.toThrow('refresh create failed');

      expect(store.getAll()).toHaveLength(0);
      expect(deleteTokens).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'mcp_oauth',
          token: 'enc:new-access',
          metadataCredentialSetId: 'credential-set-new',
        }),
      );
    });

    it('should create new access token with expires_in', async () => {
      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: { access_token: 'at1', token_type: 'Bearer', expires_in: 3600 },
        createToken: store.createToken,
      });

      const saved = await store.findToken({
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
      });
      expect(saved).not.toBeNull();
      expect(saved!.token).toBe('enc:at1');
      const expiresInMs = saved!.expiresAt.getTime() - Date.now();
      expect(expiresInMs).toBeGreaterThan(3500 * 1000);
      expect(expiresInMs).toBeLessThanOrEqual(3600 * 1000);
    });

    it('should create new access token with expires_at (MCPOAuthTokens format)', async () => {
      const expiresAt = Date.now() + 7200 * 1000;
      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: {
          access_token: 'at1',
          token_type: 'Bearer',
          expires_at: expiresAt,
          obtained_at: Date.now(),
        },
        createToken: store.createToken,
      });

      const saved = await store.findToken({
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
      });
      expect(saved).not.toBeNull();
      const diff = Math.abs(saved!.expiresAt.getTime() - expiresAt);
      expect(diff).toBeLessThan(2000);
    });

    it('should default to 1-year expiry when none provided', async () => {
      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: { access_token: 'at1', token_type: 'Bearer' },
        createToken: store.createToken,
      });

      const saved = await store.findToken({
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
      });
      const oneYearMs = 365 * 24 * 60 * 60 * 1000;
      const expiresInMs = saved!.expiresAt.getTime() - Date.now();
      expect(expiresInMs).toBeGreaterThan(oneYearMs - 5000);
    });

    it('should update existing access token', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:old-token',
        expiresIn: 3600,
      });

      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: { access_token: 'new-token', token_type: 'Bearer', expires_in: 7200 },
        createToken: store.createToken,
        updateToken: store.updateToken,
        findToken: store.findToken,
      });

      const saved = await store.findToken({
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
      });
      expect(saved!.token).toBe('enc:new-token');
    });

    it('should store refresh token alongside access token', async () => {
      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: {
          access_token: 'at1',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'rt1',
        },
        createToken: store.createToken,
      });

      const refreshSaved = await store.findToken({
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
      });
      expect(refreshSaved).not.toBeNull();
      expect(refreshSaved!.token).toBe('enc:rt1');
    });

    it('should skip refresh token when not in response', async () => {
      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: { access_token: 'at1', token_type: 'Bearer', expires_in: 3600 },
        createToken: store.createToken,
      });

      const refreshSaved = await store.findToken({
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
      });
      expect(refreshSaved).toBeNull();
    });

    it('should store client info when provided', async () => {
      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: { access_token: 'at1', token_type: 'Bearer', expires_in: 3600 },
        createToken: store.createToken,
        clientInfo: { client_id: 'cid', client_secret: 'csec' },
      });

      const clientSaved = await store.findToken({
        userId: 'u1',
        type: 'mcp_oauth_client',
        identifier: 'mcp:srv1:client',
      });
      expect(clientSaved).not.toBeNull();
      expect(clientSaved!.token).toContain('enc:');
      expect(clientSaved!.token).toContain('cid');
    });

    it('should use existingTokens to skip DB lookups', async () => {
      const findSpy = jest.fn();

      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: { access_token: 'at1', token_type: 'Bearer', expires_in: 3600 },
        createToken: store.createToken,
        updateToken: store.updateToken,
        findToken: findSpy,
        existingTokens: {
          accessToken: null,
          refreshToken: null,
          clientInfoToken: null,
        },
      });

      expect(findSpy).not.toHaveBeenCalled();
    });

    it('should handle invalid NaN expiry date', async () => {
      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: {
          access_token: 'at1',
          token_type: 'Bearer',
          expires_at: NaN,
          obtained_at: Date.now(),
        },
        createToken: store.createToken,
      });

      const saved = await store.findToken({
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
      });
      expect(saved).not.toBeNull();
      const oneYearMs = 365 * 24 * 60 * 60 * 1000;
      const expiresInMs = saved!.expiresAt.getTime() - Date.now();
      expect(expiresInMs).toBeGreaterThan(oneYearMs - 5000);
    });
  });

  describe('getTokens', () => {
    beforeEach(async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_client',
        identifier: 'mcp:srv1:client',
        token: 'enc:{"client_id":"cid"}',
        expiresIn: 86400,
        metadata: storedBindingMetadata,
      });
    });

    it('should return valid non-expired tokens', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:valid-token',
        expiresIn: 3600,
      });

      const result = await MCPTokenStorage.getTokens({
        userId: 'u1',
        serverName: 'srv1',
        findToken: store.findToken,
      });

      expect(result).not.toBeNull();
      expect(result!.access_token).toBe('valid-token');
      expect(result!.token_type).toBe('Bearer');
    });

    it('reports token-store outages separately from reauthentication', async () => {
      const storageError = new Error('database unavailable');

      await expect(
        MCPTokenStorage.getTokens({
          userId: 'u1',
          serverName: 'srv1',
          findToken: jest.fn().mockRejectedValue(storageError),
        }),
      ).rejects.toMatchObject({
        name: 'MCPTokenStorageUnavailableError',
        cause: storageError,
      } satisfies Partial<MCPTokenStorageUnavailableError>);
    });

    it('rejects an access token read before a concurrent client generation replacement', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:generation-a-access',
        expiresIn: 3600,
      });
      let replaced = false;
      const interleavedFind = jest.fn(async (query) => {
        const result = await store.findToken(query);
        if (!replaced && query.type === 'mcp_oauth') {
          replaced = true;
          await createBoundToken(store, {
            userId: 'u1',
            type: 'mcp_oauth',
            identifier: 'mcp:srv1',
            token: 'enc:generation-b-access',
            expiresIn: 3600,
            metadata: { credential_set_id: 'credential-set-b' },
          });
          await createBoundToken(store, {
            userId: 'u1',
            type: 'mcp_oauth_client',
            identifier: 'mcp:srv1:client',
            token: 'enc:{"client_id":"client-b"}',
            expiresIn: 86400,
            metadata: {
              ...storedBindingMetadata,
              credential_set_id: 'credential-set-b',
            },
          });
        }
        return result;
      }) as typeof store.findToken;

      await expect(
        MCPTokenStorage.getTokens({
          userId: 'u1',
          serverName: 'srv1',
          findToken: interleavedFind,
        }),
      ).rejects.toThrow(ReauthenticationRequiredError);
    });

    it('should return tokens with refresh token when available', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:at',
        expiresIn: 3600,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
        token: 'enc:rt',
        expiresIn: 86400,
      });

      const result = await MCPTokenStorage.getTokens({
        userId: 'u1',
        serverName: 'srv1',
        findToken: store.findToken,
      });

      expect(result!.refresh_token).toBe('rt');
    });

    it('should return tokens without refresh token field when none stored', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:at',
        expiresIn: 3600,
      });

      const result = await MCPTokenStorage.getTokens({
        userId: 'u1',
        serverName: 'srv1',
        findToken: store.findToken,
      });

      expect(result!.refresh_token).toBeUndefined();
    });

    it('should throw ReauthenticationRequiredError when expired and no refresh', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:expired-token',
        expiresIn: -1,
      });

      await expect(
        MCPTokenStorage.getTokens({
          userId: 'u1',
          serverName: 'srv1',
          findToken: store.findToken,
        }),
      ).rejects.toThrow(ReauthenticationRequiredError);
    });

    it('should throw ReauthenticationRequiredError when missing and no refresh', async () => {
      await expect(
        MCPTokenStorage.getTokens({
          userId: 'u1',
          serverName: 'srv1',
          findToken: store.findToken,
        }),
      ).rejects.toThrow(ReauthenticationRequiredError);
    });

    it('should refresh expired access token when refresh token and callback are available', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:expired-token',
        expiresIn: -1,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
        token: 'enc:rt',
        expiresIn: 86400,
      });

      const refreshTokens = jest.fn().mockResolvedValue({
        access_token: 'refreshed-at',
        token_type: 'Bearer',
        expires_in: 3600,
        obtained_at: Date.now(),
        expires_at: Date.now() + 3600000,
      });

      const result = await MCPTokenStorage.getTokens({
        userId: 'u1',
        serverName: 'srv1',
        findToken: store.findToken,
        createToken: store.createToken,
        updateToken: store.updateToken,
        refreshTokens,
      });

      expect(result).not.toBeNull();
      expect(result!.access_token).toBe('refreshed-at');
      expect(refreshTokens).toHaveBeenCalledWith(
        'rt',
        expect.objectContaining({ userId: 'u1', serverName: 'srv1' }),
        expect.any(AbortSignal),
      );
    });

    it.each(['invalid_client', 'invalid_grant', 'invalid_scope', 'unauthorized_client'])(
      'preserves a typed temporary failure even when its message contains %s',
      async (serverName) => {
        await createBoundToken(store, {
          userId: 'u1',
          type: 'mcp_oauth',
          identifier: 'mcp:srv1',
          token: 'enc:expired-token',
          expiresIn: -1,
        });
        await createBoundToken(store, {
          userId: 'u1',
          type: 'mcp_oauth_refresh',
          identifier: 'mcp:srv1:refresh',
          token: 'enc:rt',
          expiresIn: 86400,
        });
        const failure = new MCPTokenRefreshUnavailableError(serverName, new Error('HTTP 503'));
        const deleteTokens = jest.fn(store.deleteTokens);
        await expect(
          MCPTokenStorage.getTokens({
            userId: 'u1',
            serverName: 'srv1',
            findToken: store.findToken,
            createToken: store.createToken,
            updateToken: store.updateToken,
            deleteTokens,
            refreshTokens: jest.fn().mockRejectedValue(failure),
          }),
        ).rejects.toBe(failure);
        expect(deleteTokens).not.toHaveBeenCalled();
        expect(
          await store.findToken({
            userId: 'u1',
            type: 'mcp_oauth_refresh',
            identifier: 'mcp:srv1:refresh',
          }),
        ).toMatchObject({ token: 'enc:rt' });
      },
    );

    it('reports transient refresh failures separately from reauthentication', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:expired-token',
        expiresIn: -1,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
        token: 'enc:rt',
        expiresIn: 86400,
      });

      const refreshTokens = jest.fn().mockRejectedValue(new Error('refresh failed'));

      await expect(
        MCPTokenStorage.getTokens({
          userId: 'u1',
          serverName: 'srv1',
          findToken: store.findToken,
          createToken: store.createToken,
          updateToken: store.updateToken,
          refreshTokens,
        }),
      ).rejects.toMatchObject({
        name: 'MCPTokenRefreshUnavailableError',
      } satisfies Partial<MCPTokenRefreshUnavailableError>);
    });

    it('should return null when no refreshTokens callback provided', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:expired-token',
        expiresIn: -1,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
        token: 'enc:rt',
        expiresIn: 86400,
      });

      const result = await MCPTokenStorage.getTokens({
        userId: 'u1',
        serverName: 'srv1',
        findToken: store.findToken,
      });

      expect(result).toBeNull();
    });

    it('should return null when no createToken callback provided', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:expired-token',
        expiresIn: -1,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
        token: 'enc:rt',
        expiresIn: 86400,
      });

      const result = await MCPTokenStorage.getTokens({
        userId: 'u1',
        serverName: 'srv1',
        findToken: store.findToken,
        refreshTokens: jest.fn(),
      });

      expect(result).toBeNull();
    });

    it('should pass client info to refreshTokens metadata', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:expired-token',
        expiresIn: -1,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
        token: 'enc:rt',
        expiresIn: 86400,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_client',
        identifier: 'mcp:srv1:client',
        token: 'enc:{"client_id":"cid","client_secret":"csec"}',
        expiresIn: 86400,
        metadata: storedBindingMetadata,
      });

      const refreshTokens = jest.fn().mockResolvedValue({
        access_token: 'new-at',
        token_type: 'Bearer',
        expires_in: 3600,
      });

      await MCPTokenStorage.getTokens({
        userId: 'u1',
        serverName: 'srv1',
        findToken: store.findToken,
        createToken: store.createToken,
        updateToken: store.updateToken,
        refreshTokens,
      });

      expect(refreshTokens).toHaveBeenCalledWith(
        'rt',
        expect.objectContaining({
          clientInfo: expect.objectContaining({ client_id: 'cid' }),
        }),
        expect.any(AbortSignal),
      );
    });

    it.each([
      'unauthorized_client',
      'unsupported_grant_type',
      'invalid_request',
      'invalid_scope',
      'invalid_target',
      'access_denied',
    ])('handles permanent endpoint rejection %s', async (code) => {
      const { logger } = await import('@librechat/data-schemas');

      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:expired-token',
        expiresIn: -1,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
        token: 'enc:rt',
        expiresIn: 86400,
      });

      const refreshTokens = jest.fn().mockRejectedValue(new Error(code));

      const result = await MCPTokenStorage.getTokens({
        userId: 'u1',
        serverName: 'srv1',
        findToken: store.findToken,
        createToken: store.createToken,
        refreshTokens,
      });

      expect(result).toBeNull();
      if (code === 'unauthorized_client') {
        expect(logger.info).toHaveBeenCalledWith(
          expect.stringContaining('does not support refresh tokens'),
        );
      }
    });

    it('should delete client registration and refresh token on invalid_client when deleteTokens provided', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:expired-token',
        expiresIn: -1,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
        token: 'enc:rt',
        expiresIn: 86400,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_client',
        identifier: 'mcp:srv1:client',
        token: 'enc:{"client_id":"cid"}',
        expiresIn: 86400,
        metadata: storedBindingMetadata,
      });

      const refreshTokens = jest.fn().mockRejectedValue(new Error('invalid_client'));

      await expect(
        MCPTokenStorage.getTokens({
          userId: 'u1',
          serverName: 'srv1',
          findToken: store.findToken,
          createToken: store.createToken,
          deleteTokens: store.deleteTokens,
          refreshTokens,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          name: 'ReauthenticationRequiredError',
          message: expect.stringContaining('stored client registration is no longer valid'),
        }),
      );

      const clientReg = await store.findToken({
        userId: 'u1',
        type: 'mcp_oauth_client',
        identifier: 'mcp:srv1:client',
      });
      expect(clientReg).toBeNull();

      const refreshToken = await store.findToken({
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
      });
      expect(refreshToken).toBeNull();
    });

    it('should return null and log warning on invalid_client when deleteTokens not provided', async () => {
      const { logger } = await import('@librechat/data-schemas');

      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:expired-token',
        expiresIn: -1,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
        token: 'enc:rt',
        expiresIn: 86400,
      });

      const refreshTokens = jest.fn().mockRejectedValue(new Error('invalid_client'));

      const result = await MCPTokenStorage.getTokens({
        userId: 'u1',
        serverName: 'srv1',
        findToken: store.findToken,
        createToken: store.createToken,
        refreshTokens,
      });

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('deleteTokens not available'),
      );
    });

    it('should handle client_not_found and other vendor-specific rejection patterns', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:expired-token',
        expiresIn: -1,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
        token: 'enc:rt',
        expiresIn: 86400,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_client',
        identifier: 'mcp:srv1:client',
        token: 'enc:{"client_id":"cid"}',
        expiresIn: 86400,
        metadata: storedBindingMetadata,
      });

      const refreshTokens = jest.fn().mockRejectedValue(new Error('client not found'));

      await expect(
        MCPTokenStorage.getTokens({
          userId: 'u1',
          serverName: 'srv1',
          findToken: store.findToken,
          createToken: store.createToken,
          deleteTokens: store.deleteTokens,
          refreshTokens,
        }),
      ).rejects.toThrow(ReauthenticationRequiredError);

      expect(
        await store.findToken({
          userId: 'u1',
          type: 'mcp_oauth_client',
          identifier: 'mcp:srv1:client',
        }),
      ).toBeNull();
      expect(
        await store.findToken({
          userId: 'u1',
          type: 'mcp_oauth_refresh',
          identifier: 'mcp:srv1:refresh',
        }),
      ).toBeNull();
    });

    it('should handle case-insensitive error messages for client rejection', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:expired-token',
        expiresIn: -1,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
        token: 'enc:rt',
        expiresIn: 86400,
      });

      const refreshTokens = jest.fn().mockRejectedValue(new Error('INVALID_CLIENT'));

      await expect(
        MCPTokenStorage.getTokens({
          userId: 'u1',
          serverName: 'srv1',
          findToken: store.findToken,
          createToken: store.createToken,
          deleteTokens: store.deleteTokens,
          refreshTokens,
        }),
      ).rejects.toThrow(ReauthenticationRequiredError);
    });

    it('should still throw ReauthenticationRequiredError when deleteClientRegistration fails', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:expired-token',
        expiresIn: -1,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
        token: 'enc:rt',
        expiresIn: 86400,
      });

      const refreshTokens = jest.fn().mockRejectedValue(new Error('invalid_client'));
      const failingDeleteTokens = jest.fn().mockRejectedValue(new Error('DB connection lost'));

      await expect(
        MCPTokenStorage.getTokens({
          userId: 'u1',
          serverName: 'srv1',
          findToken: store.findToken,
          createToken: store.createToken,
          deleteTokens: failingDeleteTokens,
          refreshTokens,
        }),
      ).rejects.toThrow(ReauthenticationRequiredError);
    });
  });

  describe('forceRefreshTokens', () => {
    beforeEach(async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_client',
        identifier: 'mcp:srv1:client',
        token: 'enc:{"client_id":"cid"}',
        expiresIn: 86400,
        metadata: storedBindingMetadata,
      });
    });

    it('fails closed before invoking refresh for legacy client metadata', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
        token: 'enc:rt',
        expiresIn: 86400,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_client',
        identifier: 'mcp:srv1:client',
        token: 'enc:{"client_id":"legacy-client"}',
        expiresIn: 86400,
      });
      const refreshTokens = jest.fn();

      await expect(
        MCPTokenStorage.forceRefreshTokens({
          userId: 'u1',
          serverName: 'srv1',
          findToken: store.findToken,
          createToken: store.createToken,
          refreshTokens,
        }),
      ).rejects.toThrow(ReauthenticationRequiredError);

      expect(refreshTokens).not.toHaveBeenCalled();
    });

    it('does not send a refresh token read before a concurrent client generation replacement', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
        token: 'enc:generation-a-refresh',
        expiresIn: 86400,
      });
      let replaced = false;
      const interleavedFind = jest.fn(async (query) => {
        const result = await store.findToken(query);
        if (!replaced && query.type === 'mcp_oauth_refresh') {
          replaced = true;
          await createBoundToken(store, {
            userId: 'u1',
            type: 'mcp_oauth_client',
            identifier: 'mcp:srv1:client',
            token: 'enc:{"client_id":"client-b","client_secret":"secret-b"}',
            expiresIn: 86400,
            metadata: {
              ...storedBindingMetadata,
              credential_set_id: 'credential-set-b',
            },
          });
        }
        return result;
      }) as typeof store.findToken;
      const refreshTokens = jest.fn();

      await expect(
        MCPTokenStorage.forceRefreshTokens({
          userId: 'u1',
          serverName: 'srv1',
          findToken: interleavedFind,
          createToken: store.createToken,
          refreshTokens,
        }),
      ).rejects.toThrow(ReauthenticationRequiredError);

      expect(refreshTokens).not.toHaveBeenCalled();
    });

    it('does not persist a late refresh after interactive authorization replaces its generation', async () => {
      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: {
          access_token: 'generation-a-access',
          refresh_token: 'generation-a-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
          credential_set_id: credentialSetId,
        },
        createToken: store.createToken,
        updateToken: store.updateToken,
        findToken: store.findToken,
        clientInfo: { client_id: 'client-a', client_secret: 'secret-a' },
        metadata: storedBindingMetadata,
      });

      let markRefreshStarted!: () => void;
      const refreshStarted = new Promise<void>((resolve) => {
        markRefreshStarted = resolve;
      });
      let finishRefresh!: (tokens: MCPOAuthTokens) => void;
      const refreshResponse = new Promise<MCPOAuthTokens>((resolve) => {
        finishRefresh = resolve;
      });
      const refreshTokens = jest.fn(async () => {
        markRefreshStarted();
        return await refreshResponse;
      });
      const staleCreateToken = jest.fn(store.createToken);
      const staleUpdateToken = jest.fn(store.updateToken);

      const staleRefresh = MCPTokenStorage.forceRefreshTokens({
        userId: 'u1',
        serverName: 'srv1',
        findToken: store.findToken,
        createToken: staleCreateToken,
        updateToken: staleUpdateToken,
        refreshTokens,
      });
      let staleRefreshError: unknown;
      const observedStaleRefresh = staleRefresh.catch((error) => {
        staleRefreshError = error;
      });
      await refreshStarted;

      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: {
          access_token: 'generation-b-access',
          refresh_token: 'generation-b-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
          credential_set_id: 'credential-set-b',
        },
        createToken: store.createToken,
        updateToken: store.updateToken,
        findToken: store.findToken,
        clientInfo: { client_id: 'client-b', client_secret: 'secret-b' },
        metadata: {
          ...storedBindingMetadata,
          credential_set_id: 'credential-set-b',
        },
      });

      finishRefresh({
        access_token: 'late-generation-a-access',
        refresh_token: 'late-generation-a-refresh',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      });
      await observedStaleRefresh;
      expect(staleRefreshError).toBeInstanceOf(ReauthenticationRequiredError);

      expect(staleCreateToken).not.toHaveBeenCalled();
      expect(staleUpdateToken).not.toHaveBeenCalled();
      const storedRecords = store.getAll().filter((record) => record.userId === 'u1');
      expect(storedRecords).toHaveLength(3);
      expect(storedRecords).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'mcp_oauth',
            token: 'enc:generation-b-access',
            metadata: expect.objectContaining({ credential_set_id: 'credential-set-b' }),
          }),
          expect.objectContaining({
            type: 'mcp_oauth_refresh',
            token: 'enc:generation-b-refresh',
            metadata: expect.objectContaining({ credential_set_id: 'credential-set-b' }),
          }),
          expect.objectContaining({
            type: 'mcp_oauth_client',
            token: expect.stringContaining('client-b'),
            metadata: expect.objectContaining({ credential_set_id: 'credential-set-b' }),
          }),
        ]),
      );
      await expect(
        MCPTokenStorage.getTokens({
          userId: 'u1',
          serverName: 'srv1',
          findToken: store.findToken,
        }),
      ).resolves.toMatchObject({
        access_token: 'generation-b-access',
        refresh_token: 'generation-b-refresh',
        credential_set_id: 'credential-set-b',
      });
    });

    it('does not delete a newer generation when a late refresh rejects the old client', async () => {
      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: {
          access_token: 'generation-a-access',
          refresh_token: 'generation-a-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
          credential_set_id: credentialSetId,
        },
        createToken: store.createToken,
        updateToken: store.updateToken,
        findToken: store.findToken,
        clientInfo: { client_id: 'client-a', client_secret: 'secret-a' },
        metadata: storedBindingMetadata,
      });

      let markRefreshStarted!: () => void;
      const refreshStarted = new Promise<void>((resolve) => {
        markRefreshStarted = resolve;
      });
      let rejectRefresh!: (error: Error) => void;
      const refreshResponse = new Promise<MCPOAuthTokens>((_resolve, reject) => {
        rejectRefresh = reject;
      });
      const refreshTokens = jest.fn(async () => {
        markRefreshStarted();
        return await refreshResponse;
      });
      const deleteTokens = jest.fn(store.deleteTokens);
      const staleRefresh = MCPTokenStorage.forceRefreshTokens({
        userId: 'u1',
        serverName: 'srv1',
        findToken: store.findToken,
        createToken: store.createToken,
        updateToken: store.updateToken,
        deleteTokens,
        refreshTokens,
      });
      let staleRefreshError: unknown;
      const observedStaleRefresh = staleRefresh.catch((error) => {
        staleRefreshError = error;
      });
      await refreshStarted;

      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: {
          access_token: 'generation-b-access',
          refresh_token: 'generation-b-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
          credential_set_id: 'credential-set-b',
        },
        createToken: store.createToken,
        updateToken: store.updateToken,
        findToken: store.findToken,
        clientInfo: { client_id: 'client-b', client_secret: 'secret-b' },
        metadata: {
          ...storedBindingMetadata,
          credential_set_id: 'credential-set-b',
        },
      });

      rejectRefresh(new Error('invalid_client'));
      await observedStaleRefresh;
      expect(staleRefreshError).toBeInstanceOf(ReauthenticationRequiredError);

      expect(deleteTokens).toHaveBeenCalledTimes(2);
      expect(deleteTokens).toHaveBeenCalledWith(
        expect.objectContaining({ metadataCredentialSetId: credentialSetId }),
      );
      await expect(
        MCPTokenStorage.getTokens({
          userId: 'u1',
          serverName: 'srv1',
          findToken: store.findToken,
        }),
      ).resolves.toMatchObject({
        access_token: 'generation-b-access',
        refresh_token: 'generation-b-refresh',
        credential_set_id: 'credential-set-b',
      });
      expect(store.getAll().filter((record) => record.userId === 'u1')).toHaveLength(3);
    });

    it('should refresh and store tokens even when access token is not locally expired', async () => {
      // Access token still has time on the clock (1 hour), but the server has
      // invalidated it (we simulate a mid-session 401 by calling forceRefreshTokens
      // directly). The local `expires_at` must be ignored — the 401 is the signal.
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:stale-access-token',
        expiresIn: 3600,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
        token: 'enc:rt',
        expiresIn: 86400,
      });

      const refreshTokens = jest.fn().mockResolvedValue({
        access_token: 'new-access-token',
        refresh_token: 'new-rt',
        token_type: 'Bearer',
        expires_in: 3600,
        obtained_at: Date.now(),
      });

      const result = await MCPTokenStorage.forceRefreshTokens({
        userId: 'u1',
        serverName: 'srv1',
        findToken: store.findToken,
        createToken: store.createToken,
        updateToken: store.updateToken,
        deleteTokens: store.deleteTokens,
        refreshTokens,
      });

      expect(result).not.toBeNull();
      expect(result!.access_token).toBe('new-access-token');
      expect(result!.credential_set_id).toEqual(expect.any(String));
      expect(result!.credential_set_id).not.toBe(credentialSetId);
      expect(refreshTokens).toHaveBeenCalledWith(
        'rt',
        expect.objectContaining({
          userId: 'u1',
          serverName: 'srv1',
          identifier: 'mcp:srv1',
        }),
        expect.any(AbortSignal),
      );

      // The new access token is persisted, replacing the stale one.
      const saved = await store.findToken({
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
      });
      expect(saved!.token).toBe('enc:new-access-token');
      expect(store.getAll()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'mcp_oauth',
            metadata: expect.objectContaining({
              credential_set_id: result!.credential_set_id,
            }),
          }),
          expect.objectContaining({
            type: 'mcp_oauth_refresh',
            metadata: expect.objectContaining({
              credential_set_id: result!.credential_set_id,
            }),
          }),
          expect.objectContaining({
            type: 'mcp_oauth_client',
            metadata: expect.objectContaining({
              credential_set_id: result!.credential_set_id,
            }),
          }),
        ]),
      );
    });

    it('should return null when no refresh token is stored', async () => {
      // Access token exists locally, but no refresh token. Silent refresh is
      // not possible — the caller must fall back to interactive OAuth.
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:srv1',
        token: 'enc:any',
        expiresIn: 3600,
      });

      const refreshTokens = jest.fn();

      const result = await MCPTokenStorage.forceRefreshTokens({
        userId: 'u1',
        serverName: 'srv1',
        findToken: store.findToken,
        createToken: store.createToken,
        refreshTokens,
      });

      expect(result).toBeNull();
      expect(refreshTokens).not.toHaveBeenCalled();
    });

    it('should throw a retryable error when refresh callback fails transiently', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
        token: 'enc:rt',
        expiresIn: 86400,
      });

      const refreshTokens = jest.fn().mockRejectedValue(new Error('network blew up'));

      await expect(
        MCPTokenStorage.forceRefreshTokens({
          userId: 'u1',
          serverName: 'srv1',
          findToken: store.findToken,
          createToken: store.createToken,
          refreshTokens,
        }),
      ).rejects.toMatchObject({
        name: 'MCPTokenRefreshUnavailableError',
      } satisfies Partial<MCPTokenRefreshUnavailableError>);
    });

    it('should throw ReauthenticationRequiredError when refresh fails with invalid_client', async () => {
      // Mirrors the contract that getTokens has on stale client registration —
      // forceRefreshTokens cleans up the stale state and signals re-auth.
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
        token: 'enc:rt',
        expiresIn: 86400,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_client',
        identifier: 'mcp:srv1:client',
        token: 'enc:{"client_id":"cid"}',
        expiresIn: 86400,
        metadata: storedBindingMetadata,
      });

      const refreshTokens = jest.fn().mockRejectedValue(new Error('invalid_client'));

      await expect(
        MCPTokenStorage.forceRefreshTokens({
          userId: 'u1',
          serverName: 'srv1',
          findToken: store.findToken,
          createToken: store.createToken,
          deleteTokens: store.deleteTokens,
          refreshTokens,
        }),
      ).rejects.toThrow(ReauthenticationRequiredError);

      expect(
        await store.findToken({
          userId: 'u1',
          type: 'mcp_oauth_refresh',
          identifier: 'mcp:srv1:refresh',
        }),
      ).toBeNull();
    });
  });

  describe('forceRefreshTokens concurrent coalescing (single-flight)', () => {
    /** Seeds one coherent expired OAuth credential generation for `serverName`. */
    const seedRefreshableTokens = async (serverName = 'srv1', refreshToken = 'rt-1') => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: `mcp:${serverName}`,
        token: 'enc:expired-access-token',
        expiresIn: -1,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: `mcp:${serverName}:refresh`,
        token: `enc:${refreshToken}`,
        expiresIn: 86400,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_client',
        identifier: `mcp:${serverName}:client`,
        token: 'enc:{"client_id":"cid","client_secret":"secret"}',
        expiresIn: 86400,
        metadata: storedBindingMetadata,
      });
    };

    const rotatedTokens = (generation: number): MCPOAuthTokens => ({
      access_token: `at-${generation}`,
      refresh_token: `rt-${generation}`,
      token_type: 'Bearer',
      expires_in: 3600,
      obtained_at: Date.now(),
    });

    const refreshParams = (refreshTokens: GetTokensRefresh, serverName = 'srv1') => ({
      coordinateRefresh: true,
      userId: 'u1',
      serverName,
      findToken: store.findToken,
      createToken: store.createToken,
      updateToken: store.updateToken,
      deleteTokens: store.deleteTokens,
      refreshTokens,
    });

    type GetTokensRefresh = NonNullable<
      Parameters<typeof MCPTokenStorage.forceRefreshTokens>[0]['refreshTokens']
    >;

    /** Flushes the task queue until `predicate` holds (bounded to avoid hangs). */
    const waitFor = async (predicate: () => boolean) => {
      for (let i = 0; i < 50 && !predicate(); i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(predicate()).toBe(true);
    };

    it('coalesces concurrent refresh calls into a single token-endpoint redemption', async () => {
      // Unique server names per test keep single-flight keys isolated, so a
      // failed test can't leave an unsettled in-flight entry that later tests join.
      await seedRefreshableTokens('coalesce-srv');

      let resolveRefresh!: (tokens: MCPOAuthTokens) => void;
      const refreshTokens = jest.fn(
        () =>
          new Promise<MCPOAuthTokens>((resolve) => {
            resolveRefresh = resolve;
          }),
      );

      const params = refreshParams(refreshTokens, 'coalesce-srv');
      const first = MCPTokenStorage.forceRefreshTokens(params);
      const second = MCPTokenStorage.forceRefreshTokens(params);
      const third = MCPTokenStorage.forceRefreshTokens(params);

      await waitFor(() => refreshTokens.mock.calls.length > 0);
      resolveRefresh(rotatedTokens(2));

      const results = await Promise.all([first, second, third]);

      expect(refreshTokens).toHaveBeenCalledTimes(1);
      for (const result of results) {
        expect(result!.access_token).toBe('at-2');
      }

      const storedRefresh = await store.findToken({
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:coalesce-srv:refresh',
      });
      expect(storedRefresh!.token).toBe('enc:rt-2');
    });

    it('rechecks single-flight ownership after the asynchronous generation read', async () => {
      await seedRefreshableTokens('generation-yield-srv');
      const refreshTokens = jest.fn().mockResolvedValue(rotatedTokens(2));
      const flowManager = {
        getLeaseGeneration: jest.fn(async () => {
          await new Promise((resolve) => setImmediate(resolve));
          return 0;
        }),
        acquireLease: jest.fn().mockResolvedValue({
          generation: 0,
          release: jest.fn().mockResolvedValue(undefined),
        }),
      };
      const params = {
        ...refreshParams(refreshTokens, 'generation-yield-srv'),
        flowManager: flowManager as never,
      };

      const [first, second] = await Promise.all([
        MCPTokenStorage.forceRefreshTokens(params),
        MCPTokenStorage.forceRefreshTokens(params),
      ]);

      expect(refreshTokens).toHaveBeenCalledTimes(1);
      expect(first).toMatchObject({ access_token: 'at-2' });
      expect(second).toMatchObject({ access_token: 'at-2' });
    });

    it('aborts and joins an in-flight refresh before teardown continues', async () => {
      await seedRefreshableTokens('teardown-srv');
      const refreshTokens = jest.fn(
        (_token, _metadata, signal) =>
          new Promise<MCPOAuthTokens>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('teardown fence')), {
              once: true,
            });
          }),
      );

      const refresh = MCPTokenStorage.forceRefreshTokens(
        refreshParams(refreshTokens, 'teardown-srv'),
      );
      await waitFor(() => refreshTokens.mock.calls.length > 0);
      const release = await MCPTokenStorage.beginRefreshTeardown('u1', 'teardown-srv');

      await expect(refresh).resolves.toBeNull();
      await expect(
        MCPTokenStorage.forceRefreshTokens(refreshParams(refreshTokens, 'teardown-srv')),
      ).resolves.toBeNull();
      release();
      expect(
        await store.findToken({
          userId: 'u1',
          type: 'mcp_oauth_refresh',
          identifier: 'mcp:teardown-srv:refresh',
        }),
      ).toMatchObject({ token: 'enc:rt-1' });
    });

    it('discards a remote refresh response after teardown advances the durable generation', async () => {
      await seedRefreshableTokens('remote-teardown-srv');
      const refreshTokens = jest.fn().mockResolvedValue(rotatedTokens(2));
      const flowManager = {
        getLeaseGeneration: jest.fn().mockResolvedValue(7),
        /** The refresh flight is free; the persistence fence is what teardown holds. */
        acquireLease: jest.fn(
          async (_leaseId: string, options?: { expectedGeneration?: number }) =>
            options?.expectedGeneration === undefined
              ? { generation: 0, release: jest.fn().mockResolvedValue(undefined) }
              : null,
        ),
      };

      await expect(
        MCPTokenStorage.forceRefreshTokens({
          ...refreshParams(refreshTokens, 'remote-teardown-srv'),
          flowManager: flowManager as never,
        }),
      ).resolves.toBeNull();

      expect(flowManager.acquireLease).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ expectedGeneration: 7 }),
      );
      expect(
        await store.findToken({
          userId: 'u1',
          type: 'mcp_oauth_refresh',
          identifier: 'mcp:remote-teardown-srv:refresh',
        }),
      ).toMatchObject({ token: 'enc:rt-1' });
    });

    it('returns committed refresh tokens when distributed lease release fails', async () => {
      await seedRefreshableTokens('release-failure-srv');
      const refreshTokens = jest.fn().mockResolvedValue(rotatedTokens(2));
      const flowManager = {
        getLeaseGeneration: jest.fn().mockResolvedValue(3),
        acquireLease: jest.fn().mockResolvedValue({
          generation: 3,
          release: jest.fn().mockRejectedValue(new Error('redis unavailable')),
        }),
      };

      await expect(
        MCPTokenStorage.forceRefreshTokens({
          ...refreshParams(refreshTokens, 'release-failure-srv'),
          flowManager: flowManager as never,
        }),
      ).resolves.toMatchObject({ access_token: 'at-2' });

      expect(
        await store.findToken({
          userId: 'u1',
          type: 'mcp_oauth_refresh',
          identifier: 'mcp:release-failure-srv:refresh',
        }),
      ).toMatchObject({ token: 'enc:rt-2' });
    });

    /**
     * The process-local `inflightRefreshes` map coalesces one Node process; these cover the
     * cross-replica flight that keeps two pods from redeeming the same refresh token.
     */
    describe('cross-replica refresh flight', () => {
      /** Simulates the peer replica's completed redemption landing in shared storage. */
      const peerRotates = async (serverName: string, generation: number) => {
        await createBoundToken(store, {
          userId: 'u1',
          type: 'mcp_oauth',
          identifier: `mcp:${serverName}`,
          token: `enc:at-${generation}`,
          expiresIn: 3600,
        });
        await createBoundToken(store, {
          userId: 'u1',
          type: 'mcp_oauth_refresh',
          identifier: `mcp:${serverName}:refresh`,
          token: `enc:rt-${generation}`,
          expiresIn: 86400,
        });
      };

      /** Answers the persistence fence, and the flight only once `freeFlight` is true. */
      const flightManager = (isFlightFree: () => Promise<boolean>) => ({
        getLeaseGeneration: jest.fn().mockResolvedValue(0),
        acquireLease: jest.fn(
          async (_leaseId: string, options?: { expectedGeneration?: number }) => {
            if (options?.expectedGeneration !== undefined) {
              return { generation: 0, release: jest.fn().mockResolvedValue(undefined) };
            }
            return (await isFlightFree())
              ? { generation: 0, release: jest.fn().mockResolvedValue(undefined) }
              : null;
          },
        ),
      });

      it('serializes independent refresh owners with real shared leases and adopts the winner', async () => {
        const serverName = 'real-flight';
        await seedRefreshableTokens(serverName);
        const keyv = new Keyv({ serialize: JSON.stringify, deserialize: JSON.parse });
        const firstManager = new FlowStateManager(keyv, { ttl: 30000, ci: true });
        const secondManager = new FlowStateManager(keyv, { ttl: 30000, ci: true });
        let resolveProvider!: (tokens: MCPOAuthTokens) => void;
        const provider = jest.fn(
          () =>
            new Promise<MCPOAuthTokens>((resolve) => {
              resolveProvider = resolve;
            }),
        );
        const first = MCPTokenStorage.forceRefreshTokens({
          ...refreshParams(provider, serverName),
          singleFlightScope: 'pod-a',
          flowManager: firstManager,
        });
        await waitFor(() => provider.mock.calls.length === 1);
        const acquire = jest.spyOn(secondManager, 'acquireLease');
        const second = MCPTokenStorage.forceRefreshTokens({
          ...refreshParams(provider, serverName),
          singleFlightScope: 'pod-b',
          flowManager: secondManager,
        });
        await waitFor(() => acquire.mock.calls.length > 0);
        resolveProvider(rotatedTokens(2));
        const results = await Promise.all([first, second]);
        expect(results[0]).toMatchObject({ access_token: 'at-2' });
        expect(results[1]).toMatchObject({ access_token: 'at-2' });
        expect(provider).toHaveBeenCalledTimes(1);
      });

      it.each([undefined, false])(
        'keeps the legacy refresh path until rollout is enabled (%s)',
        async (coordinateRefresh) => {
          const serverName = 'rollout-disabled';
          await seedRefreshableTokens(serverName);
          const flowManager = flightManager(async () => true);
          const refreshTokens = jest.fn().mockResolvedValue(rotatedTokens(2));
          await expect(
            MCPTokenStorage.forceRefreshTokens({
              ...refreshParams(refreshTokens, serverName),
              flowManager,
              coordinateRefresh,
            }),
          ).resolves.toMatchObject({ access_token: 'at-2' });
          expect(flowManager.acquireLease.mock.calls.map(([id]) => id)).not.toContain(
            getMCPOAuthRefreshFlightLeaseId('u1', serverName),
          );
          expect(refreshTokens).toHaveBeenCalledTimes(1);
        },
      );

      it('coalesces different request identities while coordination is disabled', async () => {
        const serverName = 'legacy-local-coalescing';
        await seedRefreshableTokens(serverName);
        let finish!: (tokens: MCPOAuthTokens) => void;
        const refreshTokens = jest.fn(
          () =>
            new Promise<MCPOAuthTokens>((resolve) => {
              finish = resolve;
            }),
        );
        const params = {
          ...refreshParams(refreshTokens, serverName),
          coordinateRefresh: false,
          flowManager: flightManager(async () => true),
        };
        const first = MCPTokenStorage.forceRefreshTokens(params);
        await waitFor(() => refreshTokens.mock.calls.length === 1);
        const second = MCPTokenStorage.forceRefreshTokens({
          ...params,
          rejectedCredentialSetId: credentialSetId,
        });
        const unauthenticated = MCPTokenStorage.forceRefreshTokens({
          ...params,
          rejectedCredentialSetId: null,
        });
        finish(rotatedTokens(2));
        const results = await Promise.all([first, second, unauthenticated]);
        expect(results.map((tokens) => tokens?.access_token)).toEqual(['at-2', 'at-2', 'at-2']);
        expect(refreshTokens).toHaveBeenCalledTimes(1);
      });

      it('holds a flight distinct from the teardown lease and releases it after redeeming', async () => {
        await seedRefreshableTokens('flight-srv');
        const refreshTokens = jest.fn().mockResolvedValue(rotatedTokens(2));
        const release = jest.fn().mockResolvedValue(undefined);
        const flowManager = {
          getLeaseGeneration: jest.fn().mockResolvedValue(0),
          acquireLease: jest.fn().mockResolvedValue({ generation: 0, release }),
        };

        await expect(
          MCPTokenStorage.forceRefreshTokens({
            ...refreshParams(refreshTokens, 'flight-srv'),
            flowManager: flowManager as never,
          }),
        ).resolves.toMatchObject({ access_token: 'at-2' });

        const flightLeaseId = getMCPOAuthRefreshFlightLeaseId('u1', 'flight-srv');
        expect(flightLeaseId).not.toBe(getMCPOAuthLeaseId('u1', 'flight-srv'));
        expect(flowManager.acquireLease).toHaveBeenCalledWith(
          flightLeaseId,
          expect.objectContaining({ waitMs: 0 }),
        );
        expect(refreshTokens).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalled();
      });

      it('adopts the tokens another replica rotated while the flight was held', async () => {
        await seedRefreshableTokens('adopt-srv');
        const refreshTokens = jest.fn().mockResolvedValue(rotatedTokens(9));
        const onRefreshSuccess = jest.fn().mockResolvedValue(undefined);
        const onTokensAdopted = jest.fn().mockResolvedValue(undefined);
        let attempts = 0;
        const flowManager = flightManager(async () => {
          attempts += 1;
          if (attempts === 1) {
            return false;
          }
          /** The peer completed its redemption and rotated the credential. */
          await peerRotates('adopt-srv', 3);
          return true;
        });

        await expect(
          MCPTokenStorage.forceRefreshTokens({
            ...refreshParams(refreshTokens, 'adopt-srv'),
            flowManager: flowManager as never,
            onRefreshSuccess,
            onTokensAdopted,
          }),
        ).resolves.toMatchObject({ access_token: 'at-3', refresh_token: 'rt-3' });

        expect(refreshTokens).not.toHaveBeenCalled();
        /**
         * The adopted credential was published by the peer under a generation only the store
         * knows, so the caller is told it adopted rather than refreshed: the refresh callback
         * would leave this replica's captured generation pointing before the peer's rotation.
         */
        expect(onTokensAdopted).toHaveBeenCalledWith(
          expect.objectContaining({ access_token: 'at-3' }),
        );
        expect(onRefreshSuccess).not.toHaveBeenCalled();
      });

      it('holds the flight through adoption publication and releases it when the callback fails', async () => {
        const serverName = 'adoption-publication';
        await seedRefreshableTokens(serverName);
        const keyv = new Keyv({ serialize: JSON.stringify, deserialize: JSON.parse });
        const flowManager = new FlowStateManager(keyv, { ttl: 30000, ci: true });
        const leaseId = getMCPOAuthRefreshFlightLeaseId('u1', serverName);
        const acquire = flowManager.acquireLease.bind(flowManager);
        jest.spyOn(flowManager, 'acquireLease').mockImplementation(async (id, options) => {
          if (id === leaseId) await peerRotates(serverName, 3);
          return acquire(id, options);
        });
        const onTokensAdopted = jest.fn(async () => {
          expect(await acquire(leaseId, { waitMs: 0 })).toBeNull();
          expect(await acquire(getMCPOAuthLeaseId('u1', serverName), { waitMs: 0 })).toBeNull();
          throw new Error('publication storage unavailable');
        });
        const refreshTokens = jest.fn();
        await expect(
          MCPTokenStorage.forceRefreshTokens({
            ...refreshParams(refreshTokens, serverName),
            flowManager,
            onTokensAdopted,
          }),
        ).rejects.toBeInstanceOf(MCPTokenRefreshUnavailableError);
        expect(onTokensAdopted).toHaveBeenCalledTimes(1);
        expect(refreshTokens).not.toHaveBeenCalled();
        const successor = await acquire(leaseId, { waitMs: 0 });
        expect(successor).not.toBeNull();
        await successor?.release();
        const persistenceSuccessor = await acquire(getMCPOAuthLeaseId('u1', serverName), {
          waitMs: 0,
        });
        expect(persistenceSuccessor).not.toBeNull();
        await persistenceSuccessor?.release();
      });

      it('defers adoption when a callback supersedes it before the persistence fence is acquired', async () => {
        const serverName = 'callback-before-adoption-fence';
        await seedRefreshableTokens(serverName);
        await peerRotates(serverName, 3);
        const flowManager = new FlowStateManager(new Keyv(), { ttl: 30000, ci: true });
        const acquire = flowManager.acquireLease.bind(flowManager);
        jest.spyOn(flowManager, 'acquireLease').mockImplementation(async (id, options) => {
          if (id === getMCPOAuthLeaseId('u1', serverName)) await peerRotates(serverName, 4);
          return acquire(id, options);
        });
        const onTokensAdopted = jest.fn();
        const refreshTokens = jest.fn();
        await expect(
          MCPTokenStorage.forceRefreshTokens({
            ...refreshParams(refreshTokens, serverName),
            flowManager,
            rejectedCredentialSetId: 'before-peer-generation',
            onTokensAdopted,
          }),
        ).rejects.toBeInstanceOf(MCPTokenStorageUnavailableError);
        expect(onTokensAdopted).not.toHaveBeenCalled();
        expect(refreshTokens).not.toHaveBeenCalled();
      });

      it.each([60000, 1e9])(
        'fences callback publication with a bounded persistence wait (%s)',
        async (waitMs) => {
          const serverName = 'callback-adoption-fence';
          await seedRefreshableTokens(serverName);
          await peerRotates(serverName, 3);
          const flowManager = new FlowStateManager(new Keyv(), { ttl: 30000, ci: true });
          let finishAdoption!: () => void;
          const publication = new Promise<void>((resolve) => {
            finishAdoption = resolve;
          });
          const onTokensAdopted = jest.fn(async () => publication);
          const adopted = MCPTokenStorage.forceRefreshTokens({
            ...refreshParams(jest.fn(), serverName),
            flowManager,
            rejectedCredentialSetId: 'before-peer-generation',
            onTokensAdopted,
          });
          await waitFor(() => onTokensAdopted.mock.calls.length === 1);
          const onStoreCommitted = jest.fn();
          const acquireSpy = jest.spyOn(flowManager, 'acquireLease');
          const callback = MCPTokenStorage.storeTokens({
            ...refreshParams(jest.fn(), serverName),
            flowManager,
            persistenceWaitTimeoutMs: waitMs,
            tokens: rotatedTokens(4),
            clientInfo: { client_id: 'cid', client_secret: 'secret' },
            metadata: storedBindingMetadata,
            onStoreCommitted,
          });
          try {
            await new Promise((resolve) => setTimeout(resolve, 25));
            expect(onStoreCommitted).not.toHaveBeenCalled();
            expect(acquireSpy).toHaveBeenCalledWith(getMCPOAuthLeaseId('u1', serverName), {
              waitMs: Math.min(waitMs, 840000),
            });
            expect(
              await MCPTokenStorage.isCurrentAccessToken({
                userId: 'u1',
                serverName,
                findToken: store.findToken,
                accessToken: 'at-3',
                credentialSetId,
              }),
            ).toBe(true);
          } finally {
            finishAdoption();
            await Promise.allSettled([adopted, callback]);
          }
          await expect(adopted).resolves.toMatchObject({ access_token: 'at-3' });
          await expect(callback).resolves.toMatchObject({ access_token: 'at-4' });
          expect(onStoreCommitted).toHaveBeenCalledTimes(1);
        },
      );

      it('still redeems when the credential is unchanged after waiting for the flight', async () => {
        await seedRefreshableTokens('unchanged-srv');
        const refreshTokens = jest.fn().mockResolvedValue(rotatedTokens(4));
        let attempts = 0;
        const flowManager = flightManager(async () => ++attempts > 1);

        await expect(
          MCPTokenStorage.forceRefreshTokens({
            ...refreshParams(refreshTokens, 'unchanged-srv'),
            flowManager: flowManager as never,
          }),
        ).resolves.toMatchObject({ access_token: 'at-4' });

        expect(refreshTokens).toHaveBeenCalledTimes(1);
      });

      it('defers without redeeming when the lease store cannot answer', async () => {
        await seedRefreshableTokens('lease-down-srv');
        const refreshTokens = jest.fn().mockResolvedValue(rotatedTokens(5));
        const flowManager = {
          getLeaseGeneration: jest.fn().mockResolvedValue(0),
          acquireLease: jest.fn(
            async (_leaseId: string, options?: { expectedGeneration?: number }) => {
              if (options?.expectedGeneration !== undefined) {
                return { generation: 0, release: jest.fn().mockResolvedValue(undefined) };
              }
              throw new Error('redis unavailable');
            },
          ),
        };

        await expect(
          MCPTokenStorage.forceRefreshTokens({
            ...refreshParams(refreshTokens, 'lease-down-srv'),
            flowManager: flowManager as never,
          }),
        ).rejects.toBeInstanceOf(MCPTokenRefreshUnavailableError);

        expect(refreshTokens).not.toHaveBeenCalled();
      });

      it('fails as retryable, never redeeming, when the holder keeps the flight', async () => {
        await seedRefreshableTokens('wedged-srv');
        const refreshTokens = jest.fn().mockResolvedValue(rotatedTokens(2));
        const flowManager = flightManager(async () => false);

        await expect(
          MCPTokenStorage.forceRefreshTokens({
            ...refreshParams(refreshTokens, 'wedged-srv'),
            flowManager: flowManager as never,
            refreshWaitTimeoutMs: 400,
          }),
        ).rejects.toBeInstanceOf(MCPTokenRefreshUnavailableError);

        /** The point of the fence: no redemption raced the holder, and the credential survives. */
        expect(refreshTokens).not.toHaveBeenCalled();
        expect(
          await store.findToken({
            userId: 'u1',
            type: 'mcp_oauth_refresh',
            identifier: 'mcp:wedged-srv:refresh',
          }),
        ).toMatchObject({ token: 'enc:rt-1' });
      });

      it('releases the flight and defers when the under-lease read fails', async () => {
        await seedRefreshableTokens('adopt-fail-srv');
        const refreshTokens = jest.fn().mockResolvedValue(rotatedTokens(6));
        const release = jest.fn().mockResolvedValue(undefined);
        let refreshReads = 0;
        const findToken = (async (filter: { type?: string }) => {
          /** The observed read succeeds; the read taken after acquiring the flight fails. */
          if (filter.type === 'mcp_oauth_refresh' && ++refreshReads === 2) {
            throw new Error('token storage unavailable');
          }
          return store.findToken(filter as never);
        }) as typeof store.findToken;
        let attempts = 0;
        const flowManager = {
          getLeaseGeneration: jest.fn().mockResolvedValue(0),
          acquireLease: jest.fn(async (_id: string, options?: { expectedGeneration?: number }) =>
            options?.expectedGeneration !== undefined || ++attempts > 1
              ? { generation: 0, release }
              : null,
          ),
        };

        await expect(
          MCPTokenStorage.forceRefreshTokens({
            ...refreshParams(refreshTokens, 'adopt-fail-srv'),
            findToken,
            flowManager: flowManager as never,
          }),
        ).rejects.toBeInstanceOf(MCPTokenRefreshUnavailableError);

        /** A failed read must never consume a possibly rotated credential. */
        expect(refreshTokens).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalled();
      });

      it('serializes two OAuth binding scopes onto one stored credential', async () => {
        await seedRefreshableTokens('rolling-srv');
        const refreshTokens = jest.fn().mockResolvedValue(rotatedTokens(2));
        const flightIds = new Set<string>();
        const flowManager = {
          getLeaseGeneration: jest.fn().mockResolvedValue(0),
          acquireLease: jest.fn(async (id: string, options?: { expectedGeneration?: number }) => {
            if (options?.expectedGeneration === undefined) {
              flightIds.add(id);
            }
            return { generation: 0, release: jest.fn().mockResolvedValue(undefined) };
          }),
        };
        const refresh = (singleFlightScope: string) =>
          MCPTokenStorage.forceRefreshTokens({
            ...refreshParams(refreshTokens, 'rolling-srv'),
            singleFlightScope,
            flowManager: flowManager as never,
          });

        await Promise.all([refresh('binding-a'), refresh('binding-b')]);

        /**
         * Two process-local slots, so both redeem, but one distributed flight: a rolling config
         * change moves the binding digest without moving the stored credential, and keying the
         * flight by that digest would let the two versions redeem the same token concurrently.
         */
        expect(refreshTokens).toHaveBeenCalledTimes(2);
        expect(flightIds.size).toBe(1);
      });

      it('holds the flight past the window that aborts a stalled redemption', async () => {
        await seedRefreshableTokens('margin-srv');
        const refreshTokens = jest.fn().mockResolvedValue(rotatedTokens(2));
        const leaseWindows: number[] = [];
        const flowManager = {
          getLeaseGeneration: jest.fn().mockResolvedValue(0),
          acquireLease: jest.fn(async (_id: string, options?: { leaseMs?: number }) => {
            if (options?.leaseMs != null) {
              leaseWindows.push(options.leaseMs);
            }
            return { generation: 0, release: jest.fn().mockResolvedValue(undefined) };
          }),
        };

        await MCPTokenStorage.forceRefreshTokens({
          ...refreshParams(refreshTokens, 'margin-srv'),
          flowManager: flowManager as never,
        });

        /**
         * Aborting a stalled redemption does not prove the token endpoint declined the request, so
         * the flight has to outlive the abort rather than expire alongside it.
         */
        expect(leaseWindows.length).toBeGreaterThan(0);
        expect(Math.min(...leaseWindows)).toBeGreaterThan(
          MCPTokenStorage.INFLIGHT_REFRESH_STALE_MS,
        );
      });

      it('adopts a rotation that lands while the first flight attempt is failing', async () => {
        await seedRefreshableTokens('snapshot-srv');
        const refreshTokens = jest.fn().mockResolvedValue(rotatedTokens(9));
        let attempts = 0;
        const flowManager = {
          getLeaseGeneration: jest.fn().mockResolvedValue(0),
          acquireLease: jest.fn(async (_id: string, options?: { expectedGeneration?: number }) => {
            if (options?.expectedGeneration !== undefined) {
              return { generation: 0, release: jest.fn().mockResolvedValue(undefined) };
            }
            attempts += 1;
            if (attempts === 1) {
              /** The holder stores and releases in the gap after this attempt fails. */
              await peerRotates('snapshot-srv', 4);
              return null;
            }
            return { generation: 0, release: jest.fn().mockResolvedValue(undefined) };
          }),
        };

        await expect(
          MCPTokenStorage.forceRefreshTokens({
            ...refreshParams(refreshTokens, 'snapshot-srv'),
            flowManager: flowManager as never,
          }),
        ).resolves.toMatchObject({ access_token: 'at-4' });

        /**
         * Snapshotting after the failed attempt would have captured the rotated credential as the
         * baseline, found it unchanged, and redeemed the token the holder had just been issued.
         */
        expect(refreshTokens).not.toHaveBeenCalled();
      });

      it('adopts a rotation that landed before its first acquisition attempt', async () => {
        await seedRefreshableTokens('first-acquire-srv');
        const refreshTokens = jest.fn().mockResolvedValue(rotatedTokens(9));
        const flowManager = {
          getLeaseGeneration: jest.fn().mockResolvedValue(0),
          acquireLease: jest.fn(async (_id: string, options?: { expectedGeneration?: number }) => {
            if (options?.expectedGeneration === undefined) {
              /** The peer rotated and released before this replica ever contended. */
              await peerRotates('first-acquire-srv', 4);
            }
            return { generation: 0, release: jest.fn().mockResolvedValue(undefined) };
          }),
        };

        await expect(
          MCPTokenStorage.forceRefreshTokens({
            ...refreshParams(refreshTokens, 'first-acquire-srv'),
            flowManager: flowManager as never,
          }),
        ).resolves.toMatchObject({ access_token: 'at-4' });

        /**
         * An acquisition that succeeds first try says nothing about which credential is stored: it
         * proves only that no peer holds the flight now, not that none held it a moment ago.
         */
        expect(refreshTokens).not.toHaveBeenCalled();
      });

      it('keeps the fence when the pre-flight observation read fails', async () => {
        await seedRefreshableTokens('observe-fail-srv');
        const refreshTokens = jest.fn().mockResolvedValue(rotatedTokens(2));
        let refreshReads = 0;
        const findToken = (async (filter: { type?: string }) => {
          if (filter.type === 'mcp_oauth_refresh' && ++refreshReads === 1) {
            throw new Error('token storage unavailable');
          }
          return store.findToken(filter as never);
        }) as typeof store.findToken;
        const flightIds: string[] = [];
        const flowManager = {
          getLeaseGeneration: jest.fn().mockResolvedValue(0),
          acquireLease: jest.fn(async (id: string, options?: { expectedGeneration?: number }) => {
            if (options?.expectedGeneration === undefined) {
              flightIds.push(id);
            }
            return { generation: 0, release: jest.fn().mockResolvedValue(undefined) };
          }),
        };

        await expect(
          MCPTokenStorage.forceRefreshTokens({
            ...refreshParams(refreshTokens, 'observe-fail-srv'),
            findToken,
            flowManager: flowManager as never,
          }),
        ).resolves.toMatchObject({ access_token: 'at-2' });

        /**
         * Losing the observation costs adoption and nothing else. Redeeming without the flight
         * because a read failed is the concurrency the flight exists to remove, so only the lease
         * store failing may reach the unfenced fallback.
         */
        expect(flightIds).toHaveLength(1);
        expect(refreshTokens).toHaveBeenCalledTimes(1);
      });

      it.each([false, true])(
        'adopts a rotation between access and refresh reads (missing access: %s)',
        async (missingAccess) => {
          const serverName = `split-probe-${missingAccess}`;
          await seedRefreshableTokens(serverName);
          if (missingAccess) {
            await store.deleteTokens({
              userId: 'u1',
              type: 'mcp_oauth',
              identifier: `mcp:${serverName}`,
            });
          }
          let rotated = false;
          const findToken: typeof store.findToken = async (filter) => {
            const record = await store.findToken(filter);
            if (filter.type === 'mcp_oauth' && !rotated) {
              rotated = true;
              await MCPTokenStorage.storeTokens({
                ...refreshParams(jest.fn(), serverName),
                tokens: rotatedTokens(3),
                clientInfo: { client_id: 'cid', client_secret: 'secret' },
                metadata: storedBindingMetadata,
                expectedCredentialSetId: credentialSetId,
              });
            }
            return record;
          };
          const refreshTokens = jest.fn().mockResolvedValue(rotatedTokens(9));
          await expect(
            MCPTokenStorage.getTokens({
              ...refreshParams(refreshTokens, serverName),
              findToken,
              flowManager: flightManager(async () => true),
            }),
          ).resolves.toMatchObject({ access_token: 'at-3', refresh_token: 'rt-3' });
          expect(refreshTokens).not.toHaveBeenCalled();
        },
      );

      it('refreshes normally when an expired access row was removed', async () => {
        const serverName = 'expired-access-row';
        await seedRefreshableTokens(serverName);
        await store.deleteTokens({
          userId: 'u1',
          type: 'mcp_oauth',
          identifier: `mcp:${serverName}`,
        });
        const refreshTokens = jest.fn().mockResolvedValue(rotatedTokens(2));
        await expect(
          MCPTokenStorage.getTokens({
            ...refreshParams(refreshTokens, serverName),
            flowManager: flightManager(async () => true),
          }),
        ).resolves.toMatchObject({ access_token: 'at-2' });
        expect(refreshTokens).toHaveBeenCalledTimes(1);
      });

      it('defers a failed client metadata read before provider redemption', async () => {
        const serverName = 'client-read-failure';
        await seedRefreshableTokens(serverName);
        const refreshTokens = jest.fn();
        const findToken: typeof store.findToken = async (filter) => {
          if (filter.type === 'mcp_oauth_client') throw new Error('database unavailable');
          return store.findToken(filter);
        };
        await expect(
          MCPTokenStorage.forceRefreshTokens({
            ...refreshParams(refreshTokens, serverName),
            findToken,
            flowManager: flightManager(async () => true),
          }),
        ).rejects.toBeInstanceOf(MCPTokenRefreshUnavailableError);
        expect(refreshTokens).not.toHaveBeenCalled();
      });

      it.each([
        [false, false, credentialSetId],
        [true, false, credentialSetId],
        [false, true, credentialSetId],
        [true, true, credentialSetId],
        [false, false, null],
        [true, true, null],
      ] as const)(
        'adopts a newer rejected credential (contended: %s, failed snapshot: %s, rejected: %s)',
        async (contended, failedSnapshot, rejected) => {
          const serverName = `already-stored-${contended}`;
          await seedRefreshableTokens(serverName);
          await MCPTokenStorage.storeTokens({
            ...refreshParams(jest.fn(), serverName),
            tokens: rotatedTokens(3),
            clientInfo: { client_id: 'cid', client_secret: 'secret' },
            metadata: storedBindingMetadata,
            expectedCredentialSetId: credentialSetId,
          });
          const findToken = jest.fn(store.findToken);
          if (failedSnapshot) {
            findToken.mockRejectedValueOnce(new Error('transient snapshot failure'));
          }
          let attempts = 0;
          const flowManager = flightManager(async () => !contended || ++attempts > 1);
          const refreshTokens = jest.fn();
          await expect(
            MCPTokenStorage.forceRefreshTokens({
              ...refreshParams(refreshTokens, serverName),
              flowManager,
              rejectedCredentialSetId: rejected as string | null,
              findToken,
            }),
          ).resolves.toMatchObject({ access_token: 'at-3', refresh_token: 'rt-3' });
          expect(refreshTokens).not.toHaveBeenCalled();
        },
      );

      it.each([false, true])(
        'separates known absence from another caller identity (unknown: %s)',
        async (unknown) => {
          const serverName = 'different-rejected-generations';
          await seedRefreshableTokens(serverName);
          const current = await MCPTokenStorage.storeTokens({
            ...refreshParams(jest.fn(), serverName),
            tokens: rotatedTokens(3),
            clientInfo: { client_id: 'cid', client_secret: 'secret' },
            metadata: storedBindingMetadata,
            expectedCredentialSetId: credentialSetId,
          });
          const flowManager = new FlowStateManager(
            new Keyv({ serialize: JSON.stringify, deserialize: JSON.parse }),
            { ttl: 30000, ci: true },
          );
          let finishAdoption!: () => void;
          const onTokensAdopted = jest.fn(
            () =>
              new Promise<void>((resolve) => {
                finishAdoption = resolve;
              }),
          );
          const refreshTokens = jest.fn().mockResolvedValue(rotatedTokens(4));
          const params = { ...refreshParams(refreshTokens, serverName), flowManager };
          const adopter = MCPTokenStorage.forceRefreshTokens({
            ...params,
            rejectedCredentialSetId: null,
            onTokensAdopted,
          });
          await waitFor(() => onTokensAdopted.mock.calls.length === 1);
          const rejectedCurrent = MCPTokenStorage.forceRefreshTokens({
            ...params,
            rejectedCredentialSetId: unknown ? undefined : current.credential_set_id,
          });
          finishAdoption();
          await expect(adopter).resolves.toMatchObject({ access_token: 'at-3' });
          await expect(rejectedCurrent).resolves.toMatchObject({ access_token: 'at-4' });
          expect(refreshTokens).toHaveBeenCalledTimes(1);
        },
      );

      it('reuses the refresh record getTokens already loaded', async () => {
        await seedRefreshableTokens('reuse-srv');
        const refreshTokens = jest.fn().mockResolvedValue(rotatedTokens(2));
        let refreshReads = 0;
        const findToken = (async (filter: { type?: string }) => {
          if (filter.type === 'mcp_oauth_refresh') {
            refreshReads += 1;
          }
          return store.findToken(filter as never);
        }) as typeof store.findToken;
        const flowManager = flightManager(async () => true);

        await expect(
          MCPTokenStorage.getTokens({
            ...refreshParams(refreshTokens, 'reuse-srv'),
            findToken,
            flowManager: flowManager as never,
          }),
        ).resolves.toMatchObject({ access_token: 'at-2' });

        /**
         * Two reads: the probe `getTokens` takes to decide a refresh is needed, reused as the
         * flight's observation baseline, and one under the flight that both proves rotation and
         * supplies the credential redeemed. This path is on the latency budget CI measures, so a
         * third read of the same record is a regression rather than a detail.
         */
        expect(refreshReads).toBe(2);
      });

      it('clamps a configured wait into the window the stale abort allows', () => {
        const resolve = (configured?: number) =>
          (
            MCPTokenStorage as unknown as {
              resolveRefreshFlightWaitMs: (value?: number) => number;
            }
          ).resolveRefreshFlightWaitMs(configured);

        expect(resolve()).toBe(MCPTokenStorage.DEFAULT_REFRESH_FLIGHT_WAIT_MS);
        expect(resolve(0)).toBe(MCPTokenStorage.DEFAULT_REFRESH_FLIGHT_WAIT_MS);
        expect(resolve(2_000)).toBe(2_000);
        /** Above the ceiling the stale abort, not the operator's wait, would decide the outcome. */
        expect(resolve(10 * MCPTokenStorage.INFLIGHT_REFRESH_STALE_MS)).toBe(
          MCPTokenStorage.MAX_REFRESH_FLIGHT_WAIT_MS,
        );
        expect(MCPTokenStorage.MAX_REFRESH_FLIGHT_WAIT_MS).toBe(
          MCPTokenStorage.INFLIGHT_REFRESH_STALE_MS / 2,
        );
      });
    });

    it('does not fence a colon-prefixed sibling server', async () => {
      await seedRefreshableTokens('foo:bar');
      let resolveRefresh!: (tokens: MCPOAuthTokens) => void;
      let refreshSignal: AbortSignal | undefined;
      const refreshTokens = jest.fn(
        (_token, _metadata, signal) =>
          new Promise<MCPOAuthTokens>((resolve) => {
            refreshSignal = signal;
            resolveRefresh = resolve;
          }),
      );

      const siblingRefresh = MCPTokenStorage.forceRefreshTokens(
        refreshParams(refreshTokens, 'foo:bar'),
      );
      await waitFor(() => refreshTokens.mock.calls.length > 0);
      const release = await MCPTokenStorage.beginRefreshTeardown('u1', 'foo');

      expect(refreshSignal?.aborted).toBe(false);
      resolveRefresh(rotatedTokens(2));
      await expect(siblingRefresh).resolves.toMatchObject({ access_token: 'at-2' });
      release();
    });

    it('getTokens joins an in-flight refresh instead of replaying the consumed refresh token', async () => {
      // Mirrors issue #14583: a silent refresh (401-triggered) is mid-redemption
      // when an expired-token read fires its own refresh. Without single-flight,
      // the second caller replays rt-1 and RFC 9700 servers revoke the grant family.
      await seedRefreshableTokens('join-srv');

      let resolveRefresh!: (tokens: MCPOAuthTokens) => void;
      const refreshTokens = jest.fn(
        (_refreshToken: string) =>
          new Promise<MCPOAuthTokens>((resolve) => {
            resolveRefresh = resolve;
          }),
      );

      let refreshReads = 0;
      const findToken = (async (filter: { type?: string }) => {
        if (filter.type === 'mcp_oauth_refresh') {
          refreshReads++;
        }
        return store.findToken(filter as Parameters<InMemoryTokenStore['findToken']>[0]);
      }) as TokenMethods['findToken'];

      const silentRefresh = MCPTokenStorage.forceRefreshTokens({
        ...refreshParams(refreshTokens, 'join-srv'),
        findToken,
      });
      await waitFor(() => refreshTokens.mock.calls.length === 1);

      const expiredRead = MCPTokenStorage.getTokens({
        ...refreshParams(refreshTokens, 'join-srv'),
        findToken,
      });
      /** getTokens probes the refresh token (2nd refresh-identifier read) and then
       *  synchronously joins the in-flight redemption; flush until the probe lands. */
      await waitFor(() => refreshReads >= 2);
      await new Promise((resolve) => setImmediate(resolve));

      resolveRefresh(rotatedTokens(2));
      const [silentResult, readResult] = await Promise.all([silentRefresh, expiredRead]);

      expect(refreshTokens).toHaveBeenCalledTimes(1);
      expect(refreshTokens.mock.calls[0][0]).toBe('rt-1');
      expect(silentResult!.access_token).toBe('at-2');
      expect(readResult!.access_token).toBe('at-2');
    });

    it('redeems the refresh token as stored at redemption time, not the pre-read snapshot', async () => {
      // Simulates a refresh completing between getTokens' probe and the
      // redemption (e.g. another replica rotated rt-1 → rt-2). The redemption
      // must use the freshest stored token, never the probe snapshot.
      await seedRefreshableTokens('snapshot-srv', 'rt-1');

      let probeSeen = false;
      const findToken = (async (filter: { type?: string }) => {
        const result = await store.findToken(
          filter as Parameters<InMemoryTokenStore['findToken']>[0],
        );
        if (filter.type === 'mcp_oauth_refresh' && !probeSeen) {
          probeSeen = true;
          await store.updateToken(
            { userId: 'u1', type: 'mcp_oauth_refresh', identifier: 'mcp:snapshot-srv:refresh' },
            { token: 'enc:rt-2' },
          );
        }
        return result;
      }) as TokenMethods['findToken'];

      const refreshTokens = jest.fn().mockResolvedValue(rotatedTokens(3));

      const result = await MCPTokenStorage.getTokens({
        ...refreshParams(refreshTokens, 'snapshot-srv'),
        findToken,
      });

      expect(refreshTokens).toHaveBeenCalledTimes(1);
      expect(refreshTokens.mock.calls[0][0]).toBe('rt-2');
      expect(result!.access_token).toBe('at-3');
    });

    it('re-reads an access token installed after the missing-token probe', async () => {
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:late-access-srv:refresh',
        token: 'enc:rt-1',
        expiresIn: 86400,
      });
      await createBoundToken(store, {
        userId: 'u1',
        type: 'mcp_oauth_client',
        identifier: 'mcp:late-access-srv:client',
        token: 'enc:{"client_id":"cid","client_secret":"secret"}',
        expiresIn: 86400,
        metadata: storedBindingMetadata,
      });

      let accessProbeSeen = false;
      const findToken = (async (filter: { type?: string }) => {
        if (filter.type !== 'mcp_oauth' || accessProbeSeen) {
          return store.findToken(filter as Parameters<InMemoryTokenStore['findToken']>[0]);
        }

        accessProbeSeen = true;
        const generationB = { credential_set_id: 'credential-set-b' };
        await store.createToken({
          userId: 'u1',
          type: 'mcp_oauth',
          identifier: 'mcp:late-access-srv',
          token: 'enc:interactive-access',
          expiresIn: -1,
          metadata: generationB,
        });
        await store.updateToken(
          {
            userId: 'u1',
            type: 'mcp_oauth_refresh',
            identifier: 'mcp:late-access-srv:refresh',
            metadataCredentialSetId: credentialSetId,
          },
          { token: 'enc:interactive-refresh', metadata: generationB },
        );
        await store.updateToken(
          {
            userId: 'u1',
            type: 'mcp_oauth_client',
            identifier: 'mcp:late-access-srv:client',
            metadataCredentialSetId: credentialSetId,
          },
          {
            token: 'enc:{"client_id":"cid","client_secret":"secret"}',
            metadata: { ...storedBindingMetadata, ...generationB },
          },
        );
        return null;
      }) as TokenMethods['findToken'];
      const createToken = jest.fn(store.createToken);
      const refreshTokens = jest.fn().mockResolvedValue(rotatedTokens(3));

      const result = await MCPTokenStorage.getTokens({
        ...refreshParams(refreshTokens, 'late-access-srv'),
        findToken,
        createToken,
      });

      expect(result).toMatchObject({ access_token: 'at-3' });
      expect(refreshTokens).toHaveBeenCalledWith(
        'interactive-refresh',
        expect.any(Object),
        expect.any(AbortSignal),
      );
      expect(createToken).not.toHaveBeenCalled();
      expect(store.getAll().filter((token) => token.type === 'mcp_oauth')).toHaveLength(1);
    });

    it('does not cache results: a refresh after settlement triggers a fresh redemption', async () => {
      await seedRefreshableTokens('sequential-srv');

      const refreshTokens = jest
        .fn()
        .mockResolvedValueOnce(rotatedTokens(2))
        .mockResolvedValueOnce(rotatedTokens(3));

      const params = refreshParams(refreshTokens, 'sequential-srv');
      const first = await MCPTokenStorage.forceRefreshTokens(params);
      expect(first!.access_token).toBe('at-2');

      const second = await MCPTokenStorage.forceRefreshTokens(params);
      expect(second!.access_token).toBe('at-3');

      expect(refreshTokens).toHaveBeenCalledTimes(2);
      expect(refreshTokens.mock.calls[1][0]).toBe('rt-2');
    });

    it('does not coalesce refreshes for different servers', async () => {
      await seedRefreshableTokens('multi-a');
      await seedRefreshableTokens('multi-b');

      let resolveFirst!: (tokens: MCPOAuthTokens) => void;
      let resolveSecond!: (tokens: MCPOAuthTokens) => void;
      const refreshFirst = jest.fn(
        () =>
          new Promise<MCPOAuthTokens>((resolve) => {
            resolveFirst = resolve;
          }),
      );
      const refreshSecond = jest.fn(
        () =>
          new Promise<MCPOAuthTokens>((resolve) => {
            resolveSecond = resolve;
          }),
      );

      const first = MCPTokenStorage.forceRefreshTokens(refreshParams(refreshFirst, 'multi-a'));
      const second = MCPTokenStorage.forceRefreshTokens(refreshParams(refreshSecond, 'multi-b'));

      await waitFor(
        () => refreshFirst.mock.calls.length === 1 && refreshSecond.mock.calls.length === 1,
      );
      resolveFirst(rotatedTokens(2));
      resolveSecond(rotatedTokens(5));

      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult!.access_token).toBe('at-2');
      expect(secondResult!.access_token).toBe('at-5');
    });

    it('does not coalesce refreshes across different OAuth binding scopes', async () => {
      await seedRefreshableTokens('scoped-srv');

      const resolutions: Array<(tokens: MCPOAuthTokens) => void> = [];
      const refreshTokens = jest.fn(
        () =>
          new Promise<MCPOAuthTokens>((resolve) => {
            resolutions.push(resolve);
          }),
      );
      const params = refreshParams(refreshTokens, 'scoped-srv');
      const first = MCPTokenStorage.forceRefreshTokens({
        ...params,
        singleFlightScope: 'binding-a',
      });
      const second = MCPTokenStorage.forceRefreshTokens({
        ...params,
        singleFlightScope: 'binding-b',
      });

      await waitFor(() => refreshTokens.mock.calls.length === 2);
      resolutions[0](rotatedTokens(2));
      await expect(first).resolves.toMatchObject({ access_token: 'at-2' });
      resolutions[1](rotatedTokens(3));
      await expect(second).rejects.toThrow(ReauthenticationRequiredError);
      expect(refreshTokens).toHaveBeenCalledTimes(2);
    });

    it('propagates refresh failure to all joined callers and releases the single-flight slot', async () => {
      await seedRefreshableTokens('fail-srv');

      let rejectRefresh!: (error: Error) => void;
      const refreshTokens = jest.fn(
        () =>
          new Promise<MCPOAuthTokens>((_, reject) => {
            rejectRefresh = reject;
          }),
      );

      const params = refreshParams(refreshTokens, 'fail-srv');
      const first = MCPTokenStorage.forceRefreshTokens(params);
      const second = MCPTokenStorage.forceRefreshTokens(params);

      await waitFor(() => refreshTokens.mock.calls.length === 1);
      rejectRefresh(new Error('network blew up'));

      await expect(first).rejects.toThrow(MCPTokenRefreshUnavailableError);
      await expect(second).rejects.toThrow(MCPTokenRefreshUnavailableError);

      refreshTokens.mockResolvedValueOnce(rotatedTokens(2));
      const third = await MCPTokenStorage.forceRefreshTokens(params);
      expect(third!.access_token).toBe('at-2');
      expect(refreshTokens).toHaveBeenCalledTimes(2);
    });

    it('aborts a stalled redemption and frees the slot only after it settles', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      try {
        await seedRefreshableTokens('stall-srv');

        const refreshTokens = jest
          .fn()
          .mockImplementationOnce(
            (_refreshToken: string, _metadata: unknown, signal: AbortSignal) =>
              new Promise<MCPOAuthTokens>((_, reject) => {
                signal.addEventListener('abort', () => reject(new Error('aborted')), {
                  once: true,
                });
              }),
          )
          .mockResolvedValueOnce(rotatedTokens(2));

        const params = refreshParams(refreshTokens, 'stall-srv');
        const stalled = MCPTokenStorage.forceRefreshTokens(params);
        await waitFor(() => refreshTokens.mock.calls.length === 1);

        jest.advanceTimersByTime(MCPTokenStorage.INFLIGHT_REFRESH_STALE_MS + 1);
        /** The stale abort settles the stalled execution, which frees the slot. */
        await expect(stalled).rejects.toThrow(MCPTokenRefreshUnavailableError);

        const fresh = await MCPTokenStorage.forceRefreshTokens(params);
        expect(fresh!.access_token).toBe('at-2');
        expect(refreshTokens).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('never reaches the token endpoint when a stalled execution wakes after abort', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      try {
        await seedRefreshableTokens('wake-srv');

        let releaseRead!: () => void;
        const readGate = new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        let refreshReadStarted = false;
        const findToken = (async (filter: { type?: string }) => {
          if (filter.type === 'mcp_oauth_refresh') {
            refreshReadStarted = true;
            await readGate;
          }
          return store.findToken(filter as Parameters<InMemoryTokenStore['findToken']>[0]);
        }) as TokenMethods['findToken'];

        const refreshTokens = jest.fn();
        const stalled = MCPTokenStorage.forceRefreshTokens({
          ...refreshParams(refreshTokens, 'wake-srv'),
          findToken,
        });
        await waitFor(() => refreshReadStarted);

        jest.advanceTimersByTime(MCPTokenStorage.INFLIGHT_REFRESH_STALE_MS + 1);
        releaseRead();

        await expect(stalled).rejects.toThrow(MCPTokenRefreshUnavailableError);
        expect(refreshTokens).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('runs onRefreshSuccess on the shared redemption even after the initiating waiter aborted', async () => {
      await seedRefreshableTokens('hook-srv');

      let resolveRefresh!: (tokens: MCPOAuthTokens) => void;
      const refreshTokens = jest.fn(
        () =>
          new Promise<MCPOAuthTokens>((resolve) => {
            resolveRefresh = resolve;
          }),
      );
      const onRefreshSuccess = jest.fn().mockResolvedValue(undefined);

      const controller = new AbortController();
      const initiator = MCPTokenStorage.forceRefreshTokens({
        ...refreshParams(refreshTokens, 'hook-srv'),
        signal: controller.signal,
        onRefreshSuccess,
      });
      await waitFor(() => refreshTokens.mock.calls.length === 1);

      controller.abort();
      await expect(initiator).resolves.toBeNull();
      expect(onRefreshSuccess).not.toHaveBeenCalled();

      resolveRefresh(rotatedTokens(2));
      await waitFor(() => onRefreshSuccess.mock.calls.length === 1);
      expect(onRefreshSuccess).toHaveBeenCalledWith(
        expect.objectContaining({
          access_token: 'at-2',
          credential_set_id: expect.any(String),
        }),
      );
      const callbackTokens = onRefreshSuccess.mock.calls[0][0];
      const storedAccess = store
        .getAll()
        .find((token) => token.type === 'mcp_oauth' && token.identifier === 'mcp:hook-srv');
      const storedCredentialSetId =
        storedAccess!.metadata instanceof Map
          ? storedAccess!.metadata.get('credential_set_id')
          : storedAccess!.metadata?.credential_set_id;
      expect(callbackTokens.credential_set_id).toBe(storedCredentialSetId);
      expect(callbackTokens.credential_set_id).not.toBe(credentialSetId);
    });

    it('prepares a durable fence before persisting refreshed token rows', async () => {
      await seedRefreshableTokens('prepared-srv');
      const events: string[] = [];
      const updateToken: TokenMethods['updateToken'] = async (...args) => {
        events.push('write');
        return store.updateToken(...args);
      };
      const onRefreshPreparing = jest.fn(async () => {
        events.push('prepare');
        return async () => {
          events.push('publish');
        };
      });

      await MCPTokenStorage.forceRefreshTokens({
        ...refreshParams(jest.fn().mockResolvedValue(rotatedTokens(2)), 'prepared-srv'),
        updateToken,
        onRefreshPreparing,
      });

      expect(events[0]).toBe('prepare');
      expect(events[events.length - 1]).toBe('publish');
      expect(events).toContain('write');
      expect(onRefreshPreparing).toHaveBeenCalledTimes(1);
    });

    it('removes refreshed credentials when their authorization fence cannot be published', async () => {
      await seedRefreshableTokens('unfenced-srv');
      const onRefreshSuccess = jest.fn().mockRejectedValue(new Error('generation unavailable'));

      await expect(
        MCPTokenStorage.forceRefreshTokens({
          ...refreshParams(jest.fn().mockResolvedValue(rotatedTokens(2)), 'unfenced-srv'),
          onRefreshSuccess,
        }),
      ).rejects.toThrow(MCPTokenRefreshUnavailableError);

      expect(onRefreshSuccess).toHaveBeenCalledTimes(1);
      const rejectedCredentialSetId = onRefreshSuccess.mock.calls[0][0].credential_set_id;
      expect(
        store.getAll().some((token) => {
          const storedId =
            token.metadata instanceof Map
              ? token.metadata.get('credential_set_id')
              : token.metadata?.credential_set_id;
          return storedId === rejectedCredentialSetId;
        }),
      ).toBe(false);
      expect(
        store.getAll().some((token) => {
          const storedId =
            token.metadata instanceof Map
              ? token.metadata.get('credential_set_id')
              : token.metadata?.credential_set_id;
          return token.type === 'mcp_oauth' && storedId === credentialSetId;
        }),
      ).toBe(true);
    });

    it("an initiator's abort resolves only its own wait, not the shared redemption", async () => {
      await seedRefreshableTokens('abort-srv');

      let resolveRefresh!: (tokens: MCPOAuthTokens) => void;
      const refreshTokens = jest.fn(
        () =>
          new Promise<MCPOAuthTokens>((resolve) => {
            resolveRefresh = resolve;
          }),
      );

      const params = refreshParams(refreshTokens, 'abort-srv');
      const controller = new AbortController();
      const initiator = MCPTokenStorage.forceRefreshTokens({
        ...params,
        signal: controller.signal,
      });
      await waitFor(() => refreshTokens.mock.calls.length === 1);
      const joiner = MCPTokenStorage.forceRefreshTokens(params);

      controller.abort();
      await expect(initiator).resolves.toBeNull();

      resolveRefresh(rotatedTokens(2));
      const joined = await joiner;
      expect(joined!.access_token).toBe('at-2');
      expect(refreshTokens).toHaveBeenCalledTimes(1);
    });

    it("a joiner's abort resolves only its own wait, not the shared redemption", async () => {
      await seedRefreshableTokens('joiner-abort-srv');

      let resolveRefresh!: (tokens: MCPOAuthTokens) => void;
      const refreshTokens = jest.fn(
        () =>
          new Promise<MCPOAuthTokens>((resolve) => {
            resolveRefresh = resolve;
          }),
      );

      const params = refreshParams(refreshTokens, 'joiner-abort-srv');
      const initiator = MCPTokenStorage.forceRefreshTokens(params);
      await waitFor(() => refreshTokens.mock.calls.length === 1);

      const controller = new AbortController();
      const joiner = MCPTokenStorage.forceRefreshTokens({
        ...params,
        signal: controller.signal,
      });

      controller.abort();
      await expect(joiner).resolves.toBeNull();

      resolveRefresh(rotatedTokens(2));
      const initiated = await initiator;
      expect(initiated!.access_token).toBe('at-2');
      expect(refreshTokens).toHaveBeenCalledTimes(1);
    });

    it('propagates ReauthenticationRequiredError to concurrent callers', async () => {
      await seedRefreshableTokens('reauth-srv');

      let rejectRefresh!: (error: Error) => void;
      const refreshTokens = jest.fn(
        () =>
          new Promise<MCPOAuthTokens>((_, reject) => {
            rejectRefresh = reject;
          }),
      );

      const params = {
        ...refreshParams(refreshTokens, 'reauth-srv'),
        deleteTokens: store.deleteTokens,
      };
      const first = MCPTokenStorage.forceRefreshTokens(params);
      const second = MCPTokenStorage.forceRefreshTokens(params);

      await waitFor(() => refreshTokens.mock.calls.length === 1);
      rejectRefresh(new Error('invalid_client'));

      await expect(first).rejects.toThrow(ReauthenticationRequiredError);
      await expect(second).rejects.toThrow(ReauthenticationRequiredError);
    });
  });

  describe('storeTokens + getTokens round-trip', () => {
    it('should store and retrieve tokens with full encrypt/decrypt cycle', async () => {
      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: {
          access_token: 'my-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'my-refresh-token',
        },
        createToken: store.createToken,
        clientInfo: { client_id: 'cid', client_secret: 'sec' },
      });

      const result = await MCPTokenStorage.getTokens({
        userId: 'u1',
        serverName: 'srv1',
        findToken: store.findToken,
      });

      expect(result!.access_token).toBe('my-access-token');
      expect(result!.refresh_token).toBe('my-refresh-token');
      expect(result!.token_type).toBe('Bearer');
      expect(result!.obtained_at).toBeDefined();
      expect(result!.expires_at).toBeDefined();
      expect(result!.credential_set_id).toEqual(expect.any(String));
    });

    it('keeps a new access token usable while omitting a stale refresh generation', async () => {
      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: {
          access_token: 'old-access',
          refresh_token: 'old-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
          credential_set_id: credentialSetId,
        },
        createToken: store.createToken,
        clientInfo: { client_id: 'old-client', client_secret: 'old-secret' },
        metadata: storedBindingMetadata,
      });

      const { credential_set_id: _oldCredentialSetId, ...newBindingMetadata } =
        storedBindingMetadata;
      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: { access_token: 'new-access', token_type: 'Bearer', expires_in: 3600 },
        createToken: store.createToken,
        updateToken: store.updateToken,
        findToken: store.findToken,
        clientInfo: { client_id: 'new-client', client_secret: 'new-secret' },
        metadata: newBindingMetadata,
      });

      const result = await MCPTokenStorage.getTokens({
        userId: 'u1',
        serverName: 'srv1',
        findToken: store.findToken,
      });
      const refreshRecord = await store.findToken({
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
      });

      expect(result).toMatchObject({ access_token: 'new-access' });
      expect(result!.refresh_token).toBeUndefined();
      expect(result!.credential_set_id).not.toBe(credentialSetId);
      expect(refreshRecord?.metadata).toMatchObject({ credential_set_id: credentialSetId });
    });

    it('removes the stale refresh generation after an interactive callback commits', async () => {
      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: {
          access_token: 'old-access',
          refresh_token: 'old-refresh',
          token_type: 'Bearer',
          credential_set_id: credentialSetId,
        },
        createToken: store.createToken,
        clientInfo: { client_id: 'old-client', client_secret: 'old-secret' },
        metadata: storedBindingMetadata,
      });
      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: {
          access_token: 'intermediate-access',
          token_type: 'Bearer',
          credential_set_id: 'credential-set-b',
        },
        createToken: store.createToken,
        updateToken: store.updateToken,
        findToken: store.findToken,
        clientInfo: { client_id: 'intermediate-client', client_secret: 'intermediate-secret' },
        metadata: storedBindingMetadata,
      });
      const deleteTokens = jest.fn(store.deleteTokens);

      const result = await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'srv1',
        tokens: {
          access_token: 'new-access',
          token_type: 'Bearer',
          credential_set_id: 'credential-set-c',
        },
        createToken: store.createToken,
        updateToken: store.updateToken,
        deleteTokens,
        findToken: store.findToken,
        clientInfo: { client_id: 'new-client', client_secret: 'new-secret' },
        metadata: storedBindingMetadata,
      });

      expect(deleteTokens).toHaveBeenCalledWith({
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:srv1:refresh',
        token: 'enc:old-refresh',
        metadataCredentialSetId: credentialSetId,
      });
      await expect(
        store.findToken({
          userId: 'u1',
          type: 'mcp_oauth_refresh',
          identifier: 'mcp:srv1:refresh',
        }),
      ).resolves.toBeNull();
      await expect(
        MCPTokenStorage.getTokens({
          userId: 'u1',
          serverName: 'srv1',
          findToken: store.findToken,
        }),
      ).resolves.toMatchObject({
        access_token: 'new-access',
        credential_set_id: result.credential_set_id,
      });
    });
  });
});
