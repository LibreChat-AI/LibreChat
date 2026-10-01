import { TokenExchangeMethodEnum } from 'librechat-data-provider';
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { MCPOptions } from 'librechat-data-provider';
import { MCPOAuthFlowMetadata, MCPOAuthHandler, MCPOAuthTokens } from '~/mcp/oauth';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  startAuthorization: jest.fn(),
  discoverAuthorizationServerMetadata: jest.fn(),
  discoverOAuthProtectedResourceMetadata: jest.fn(),
  registerClient: jest.fn(),
  exchangeAuthorization: jest.fn(),
  extractWWWAuthenticateParams: jest.fn(() => ({})),
}));

jest.mock('../../mcp/oauth/tokens', () => ({
  MCPTokenStorage: {
    getClientInfoAndMetadata: jest.fn(),
  },
}));

jest.mock('../../mcp/oauth/resourceHint', () => ({
  probeResourceMetadataHint: jest.fn().mockResolvedValue(null),
}));

import {
  startAuthorization,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  registerClient,
  exchangeAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { MCPTokenStorage } from '../../mcp/oauth/tokens';
import { probeResourceMetadataHint } from '../../mcp/oauth/resourceHint';
import { FlowStateManager } from '../../flow/manager';

const mockStartAuthorization = startAuthorization as jest.MockedFunction<typeof startAuthorization>;
const mockDiscoverAuthorizationServerMetadata =
  discoverAuthorizationServerMetadata as jest.MockedFunction<
    typeof discoverAuthorizationServerMetadata
  >;
const mockDiscoverOAuthProtectedResourceMetadata =
  discoverOAuthProtectedResourceMetadata as jest.MockedFunction<
    typeof discoverOAuthProtectedResourceMetadata
  >;
const mockRegisterClient = registerClient as jest.MockedFunction<typeof registerClient>;
const mockExchangeAuthorization = exchangeAuthorization as jest.MockedFunction<
  typeof exchangeAuthorization
>;
const mockGetClientInfoAndMetadata =
  MCPTokenStorage.getClientInfoAndMetadata as jest.MockedFunction<
    typeof MCPTokenStorage.getClientInfoAndMetadata
  >;
const mockProbeResourceMetadataHint = probeResourceMetadataHint as jest.MockedFunction<
  typeof probeResourceMetadataHint
>;

describe('MCPOAuthHandler - Configurable OAuth Metadata', () => {
  const mockServerName = 'test-server';
  const mockServerUrl = 'https://example.com/mcp';
  const mockUserId = 'user-123';

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DOMAIN_SERVER = 'http://localhost:3080';

    // Mock startAuthorization to return a successful response
    mockStartAuthorization.mockResolvedValue({
      authorizationUrl: new URL('https://auth.example.com/oauth/authorize?client_id=test'),
      codeVerifier: 'test-code-verifier',
    });
  });

  afterEach(() => {
    delete process.env.DOMAIN_SERVER;
  });

  describe('Flow IDs', () => {
    it('should tenant-scope OAuth flow IDs and parse the owning user', () => {
      const flowId = MCPOAuthHandler.generateFlowId('user-123', 'test-server', 'tenant/a');

      expect(flowId).toBe('tenant:tenant%2Fa:user-123:test-server');
      expect(MCPOAuthHandler.parseFlowId(flowId)).toEqual({
        tenantId: 'tenant/a',
        userId: 'user-123',
        serverName: 'test-server',
      });
    });

    it('should parse legacy unscoped OAuth flow IDs', () => {
      expect(MCPOAuthHandler.parseFlowId('user-123:test-server')).toEqual({
        userId: 'user-123',
        serverName: 'test-server',
      });
    });
  });

  describe('Pre-configured OAuth Metadata Fields', () => {
    const baseConfig: MCPOptions['oauth'] = {
      authorization_url: 'https://auth.example.com/oauth/authorize',
      token_url: 'https://auth.example.com/oauth/token',
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
    };

    it('should discover client_secret_post for a pre-registered confidential client', async () => {
      mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
        resource: mockServerUrl,
        authorization_servers: ['https://auth.example.com'],
      });
      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
        issuer: 'https://auth.example.com',
        authorization_endpoint: baseConfig.authorization_url,
        token_endpoint: baseConfig.token_url,
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
      } as AuthorizationServerMetadata);

      const result = await MCPOAuthHandler.initiateOAuthFlow(
        mockServerName,
        mockServerUrl,
        mockUserId,
        {},
        baseConfig,
      );

      expect(mockDiscoverOAuthProtectedResourceMetadata).toHaveBeenCalled();
      expect(mockDiscoverAuthorizationServerMetadata).toHaveBeenCalledWith(
        new URL('https://auth.example.com'),
        expect.objectContaining({ fetchFn: expect.any(Function) }),
      );
      expect(mockStartAuthorization).toHaveBeenCalledWith(
        mockServerUrl,
        expect.objectContaining({
          metadata: expect.objectContaining({
            token_endpoint_auth_methods_supported: ['client_secret_post'],
            code_challenge_methods_supported: ['S256'],
          }),
          clientInformation: expect.objectContaining({
            token_endpoint_auth_method: 'client_secret_post',
          }),
        }),
      );
      expect(result.authorizationUrl).toContain('resource=https%3A%2F%2Fexample.com%2Fmcp');
      expect(result.flowMetadata.resourceMetadata).toEqual(
        expect.objectContaining({ resource: mockServerUrl }),
      );
      expect(result.flowMetadata.metadata).toEqual(
        expect.objectContaining({
          token_endpoint: baseConfig.token_url,
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        }),
      );
    });

    it('should discover capabilities from the configured authorization server origin', async () => {
      mockDiscoverOAuthProtectedResourceMetadata.mockRejectedValueOnce(
        new Error('No resource metadata'),
      );
      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
        issuer: 'https://auth.example.com',
        authorization_endpoint: baseConfig.authorization_url,
        token_endpoint: baseConfig.token_url,
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        response_types_supported: ['code'],
      } as AuthorizationServerMetadata);

      await MCPOAuthHandler.initiateOAuthFlow(
        mockServerName,
        mockServerUrl,
        mockUserId,
        {},
        baseConfig,
      );

      expect(mockDiscoverAuthorizationServerMetadata).toHaveBeenCalledWith(
        new URL('https://auth.example.com'),
        expect.objectContaining({ fetchFn: expect.any(Function) }),
      );
      expect(mockStartAuthorization).toHaveBeenCalledWith(
        mockServerUrl,
        expect.objectContaining({
          clientInformation: expect.objectContaining({
            token_endpoint_auth_method: 'client_secret_post',
          }),
        }),
      );
    });

    it('should preserve resource discovery while preferring an explicit exchange method', async () => {
      mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
        resource: mockServerUrl,
        authorization_servers: ['https://auth.example.com'],
      });

      const result = await MCPOAuthHandler.initiateOAuthFlow(
        mockServerName,
        mockServerUrl,
        mockUserId,
        {},
        {
          ...baseConfig,
          token_exchange_method: TokenExchangeMethodEnum.BasicAuthHeader,
        },
      );

      expect(mockStartAuthorization).toHaveBeenCalledWith(
        mockServerUrl,
        expect.objectContaining({
          clientInformation: expect.objectContaining({
            token_endpoint_auth_method: 'client_secret_basic',
          }),
        }),
      );
      expect(mockDiscoverOAuthProtectedResourceMetadata).toHaveBeenCalled();
      expect(mockDiscoverAuthorizationServerMetadata).not.toHaveBeenCalled();
      expect(result.authorizationUrl).toContain('resource=https%3A%2F%2Fexample.com%2Fmcp');
      expect(result.flowMetadata.resourceMetadata).toEqual(
        expect.objectContaining({ resource: mockServerUrl }),
      );
    });

    it('should fall back when pre-configured metadata discovery times out', async () => {
      mockDiscoverOAuthProtectedResourceMetadata.mockImplementationOnce(
        () => new Promise(() => undefined),
      );

      await expect(
        MCPOAuthHandler.initiateOAuthFlow(
          mockServerName,
          mockServerUrl,
          mockUserId,
          {},
          baseConfig,
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          authorizationUrl: expect.stringContaining('state='),
        }),
      );
      expect(mockStartAuthorization).toHaveBeenCalledWith(
        mockServerUrl,
        expect.objectContaining({
          clientInformation: expect.objectContaining({
            token_endpoint_auth_method: 'client_secret_basic',
          }),
        }),
      );
    });

    it('should not apply metadata from a different token endpoint', async () => {
      mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
        resource: mockServerUrl,
        authorization_servers: ['https://auth.example.com'],
      });
      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
        issuer: 'https://auth.example.com',
        authorization_endpoint: baseConfig.authorization_url,
        token_endpoint: 'https://untrusted.example.com/oauth/token',
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        response_types_supported: ['code'],
      } as AuthorizationServerMetadata);

      const result = await MCPOAuthHandler.initiateOAuthFlow(
        mockServerName,
        mockServerUrl,
        mockUserId,
        {},
        baseConfig,
      );

      expect(mockStartAuthorization).toHaveBeenCalledWith(
        mockServerUrl,
        expect.objectContaining({
          metadata: expect.objectContaining({
            token_endpoint: baseConfig.token_url,
            token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          }),
          clientInformation: expect.objectContaining({
            token_endpoint_auth_method: 'client_secret_basic',
          }),
        }),
      );
      expect(result.authorizationUrl).toContain('resource=https%3A%2F%2Fexample.com%2Fmcp');
      expect(result.flowMetadata.resourceMetadata).toEqual(
        expect.objectContaining({ resource: mockServerUrl }),
      );
    });

    it('should not send custom headers during pre-configured metadata discovery', async () => {
      const discoveryRequests: Array<{ url: string; method: string; headers: Headers }> = [];
      const originalFetch = global.fetch;
      global.fetch = (async (url, init) => {
        discoveryRequests.push({
          url: url.toString(),
          method: init?.method ?? 'GET',
          headers: new Headers(init?.headers),
        });
        return new Response('{}');
      }) as typeof fetch;

      mockProbeResourceMetadataHint.mockImplementationOnce(async (url, fetchFn) => {
        await fetchFn?.(url, { method: 'HEAD' });
        await fetchFn?.(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        return { bearerChallenge: false, headAuthChallenge: false };
      });
      mockDiscoverOAuthProtectedResourceMetadata.mockImplementationOnce(async (_, __, fetchFn) => {
        await fetchFn?.('https://example.com/.well-known/oauth-protected-resource');
        return {
          resource: mockServerUrl,
          authorization_servers: ['https://auth.example.com'],
        };
      });
      mockDiscoverAuthorizationServerMetadata.mockImplementationOnce(async (_, options) => {
        await options?.fetchFn?.('https://auth.example.com/.well-known/oauth-authorization-server');
        return {
          issuer: 'https://auth.example.com',
          authorization_endpoint: baseConfig.authorization_url,
          token_endpoint: baseConfig.token_url,
          token_endpoint_auth_methods_supported: ['client_secret_post'],
          response_types_supported: ['code'],
        } as AuthorizationServerMetadata;
      });

      try {
        await MCPOAuthHandler.initiateOAuthFlow(
          mockServerName,
          mockServerUrl,
          mockUserId,
          {
            Authorization: 'Bearer admin-runtime-token',
            'X-API-Key': 'gateway-api-key-secret',
          },
          baseConfig,
          ['example.com', 'auth.example.com'],
        );
      } finally {
        global.fetch = originalFetch;
      }

      expect(discoveryRequests.map(({ url, method }) => ({ url, method }))).toEqual([
        { url: mockServerUrl, method: 'HEAD' },
        { url: mockServerUrl, method: 'POST' },
        {
          url: 'https://example.com/.well-known/oauth-protected-resource',
          method: 'GET',
        },
        {
          url: 'https://auth.example.com/.well-known/oauth-authorization-server',
          method: 'GET',
        },
      ]);
      for (const { headers } of discoveryRequests) {
        expect(headers.get('Authorization')).toBeNull();
        expect(headers.get('X-API-Key')).toBeNull();
      }
    });

    it('should use default values when OAuth metadata fields are not configured', async () => {
      await MCPOAuthHandler.initiateOAuthFlow(
        mockServerName,
        mockServerUrl,
        mockUserId,
        {},
        baseConfig,
      );

      expect(mockStartAuthorization).toHaveBeenCalledWith(
        mockServerUrl,
        expect.objectContaining({
          metadata: expect.objectContaining({
            grant_types_supported: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256', 'plain'],
          }),
        }),
      );
    });

    it('should use custom grant_types_supported when provided', async () => {
      const config = {
        ...baseConfig,
        grant_types_supported: ['authorization_code'],
      };

      await MCPOAuthHandler.initiateOAuthFlow(
        mockServerName,
        mockServerUrl,
        mockUserId,
        {},
        config,
      );

      expect(mockStartAuthorization).toHaveBeenCalledWith(
        mockServerUrl,
        expect.objectContaining({
          metadata: expect.objectContaining({
            grant_types_supported: ['authorization_code'],
          }),
        }),
      );
    });

    it('should use custom token_endpoint_auth_methods_supported when provided', async () => {
      const config = {
        ...baseConfig,
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      };

      await MCPOAuthHandler.initiateOAuthFlow(
        mockServerName,
        mockServerUrl,
        mockUserId,
        {},
        config,
      );

      expect(mockStartAuthorization).toHaveBeenCalledWith(
        mockServerUrl,
        expect.objectContaining({
          metadata: expect.objectContaining({
            token_endpoint_auth_methods_supported: ['client_secret_post'],
          }),
        }),
      );
    });

    it('should use custom response_types_supported when provided', async () => {
      const config = {
        ...baseConfig,
        response_types_supported: ['code', 'token'],
      };

      await MCPOAuthHandler.initiateOAuthFlow(
        mockServerName,
        mockServerUrl,
        mockUserId,
        {},
        config,
      );

      expect(mockStartAuthorization).toHaveBeenCalledWith(
        mockServerUrl,
        expect.objectContaining({
          metadata: expect.objectContaining({
            response_types_supported: ['code', 'token'],
          }),
        }),
      );
    });

    it('stores configured revocation metadata with the OAuth flow', async () => {
      const result = await MCPOAuthHandler.initiateOAuthFlow(
        mockServerName,
        mockServerUrl,
        mockUserId,
        {},
        {
          ...baseConfig,
          revocation_endpoint: 'https://auth.example.com/oauth/revoke',
          revocation_endpoint_auth_methods_supported: ['client_secret_post'],
        },
      );

      expect(result.flowMetadata.metadata).toEqual(
        expect.objectContaining({
          revocation_endpoint: 'https://auth.example.com/oauth/revoke',
          revocation_endpoint_auth_methods_supported: ['client_secret_post'],
        }),
      );
    });

    it('should use custom code_challenge_methods_supported when provided', async () => {
      const config = {
        ...baseConfig,
        code_challenge_methods_supported: ['S256'],
      };

      await MCPOAuthHandler.initiateOAuthFlow(
        mockServerName,
        mockServerUrl,
        mockUserId,
        {},
        config,
      );

      expect(mockStartAuthorization).toHaveBeenCalledWith(
        mockServerUrl,
        expect.objectContaining({
          metadata: expect.objectContaining({
            code_challenge_methods_supported: ['S256'],
          }),
        }),
      );
    });

    it('should use all custom OAuth metadata fields when provided together', async () => {
      const config = {
        ...baseConfig,
        grant_types_supported: ['authorization_code', 'client_credentials'],
        token_endpoint_auth_methods_supported: ['none'],
        response_types_supported: ['code', 'token', 'id_token'],
        code_challenge_methods_supported: ['S256'],
      };

      await MCPOAuthHandler.initiateOAuthFlow(
        mockServerName,
        mockServerUrl,
        mockUserId,
        {},
        config,
      );

      expect(mockStartAuthorization).toHaveBeenCalledWith(
        mockServerUrl,
        expect.objectContaining({
          metadata: expect.objectContaining({
            grant_types_supported: ['authorization_code', 'client_credentials'],
            token_endpoint_auth_methods_supported: ['none'],
            response_types_supported: ['code', 'token', 'id_token'],
            code_challenge_methods_supported: ['S256'],
          }),
        }),
      );
    });

    it('should handle empty arrays as valid custom values', async () => {
      const config = {
        ...baseConfig,
        grant_types_supported: [],
        token_endpoint_auth_methods_supported: [],
        response_types_supported: [],
        code_challenge_methods_supported: [],
      };

      await MCPOAuthHandler.initiateOAuthFlow(
        mockServerName,
        mockServerUrl,
        mockUserId,
        {},
        config,
      );

      expect(mockStartAuthorization).toHaveBeenCalledWith(
        mockServerUrl,
        expect.objectContaining({
          metadata: expect.objectContaining({
            grant_types_supported: [],
            token_endpoint_auth_methods_supported: [],
            response_types_supported: [],
            code_challenge_methods_supported: [],
          }),
        }),
      );
    });
  });

  describe('Auto-discovered predefined clients', () => {
    it('should reject configured client_secret without client_id', async () => {
      await expect(
        MCPOAuthHandler.initiateOAuthFlow(
          mockServerName,
          mockServerUrl,
          mockUserId,
          {},
          {
            client_secret: 'configured-client-secret',
          },
        ),
      ).rejects.toThrow(/client_secret requires oauth\.client_id/);

      expect(mockProbeResourceMetadataHint).not.toHaveBeenCalled();
      expect(mockDiscoverOAuthProtectedResourceMetadata).not.toHaveBeenCalled();
      expect(mockDiscoverAuthorizationServerMetadata).not.toHaveBeenCalled();
      expect(mockRegisterClient).not.toHaveBeenCalled();
      expect(mockStartAuthorization).not.toHaveBeenCalled();
    });

    it('should reject configured client_secret when OAuth endpoints are not pinned', async () => {
      await expect(
        MCPOAuthHandler.initiateOAuthFlow(
          mockServerName,
          mockServerUrl,
          mockUserId,
          {},
          {
            client_id: 'configured-client-id',
            client_secret: 'configured-client-secret',
          },
        ),
      ).rejects.toThrow(
        /client_secret requires both oauth\.authorization_url and oauth\.token_url/,
      );

      expect(mockProbeResourceMetadataHint).not.toHaveBeenCalled();
      expect(mockDiscoverOAuthProtectedResourceMetadata).not.toHaveBeenCalled();
      expect(mockDiscoverAuthorizationServerMetadata).not.toHaveBeenCalled();
      expect(mockRegisterClient).not.toHaveBeenCalled();
      expect(mockStartAuthorization).not.toHaveBeenCalled();
    });

    it('should use configured client_id without client_secret as a public auto-discovered client', async () => {
      mockDiscoverOAuthProtectedResourceMetadata.mockRejectedValueOnce(
        new Error('No resource metadata'),
      );
      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
        issuer: 'https://example.com',
        authorization_endpoint: 'https://example.com/authorize',
        token_endpoint: 'https://example.com/token',
        registration_endpoint: 'https://example.com/register',
        response_types_supported: ['code'],
      } as AuthorizationServerMetadata);

      await MCPOAuthHandler.initiateOAuthFlow(
        mockServerName,
        mockServerUrl,
        mockUserId,
        {},
        {
          client_id: 'public-client-id',
          scope: 'read write',
        },
      );

      expect(mockRegisterClient).not.toHaveBeenCalled();
      expect(mockStartAuthorization).toHaveBeenCalledWith(
        mockServerUrl,
        expect.objectContaining({
          clientInformation: expect.objectContaining({
            client_id: 'public-client-id',
            scope: 'read write',
            token_endpoint_auth_method: 'none',
          }),
        }),
      );

      const startOptions = mockStartAuthorization.mock.calls[0]?.[1];
      expect(startOptions?.clientInformation).not.toHaveProperty('client_secret');
    });

    it('should reject stored configured client_secret when refresh would auto-discover token endpoint', async () => {
      await expect(
        MCPOAuthHandler.refreshOAuthTokens(
          'refresh-token-12345',
          {
            serverName: 'test-server',
            serverUrl: 'https://example.com/mcp',
            clientInfo: {
              client_id: 'configured-client-id',
              client_secret: 'configured-client-secret',
            },
          },
          {},
          {
            client_id: 'configured-client-id',
            client_secret: 'configured-client-secret',
          },
        ),
      ).rejects.toThrow(/missing its bound token endpoint/);

      expect(mockDiscoverAuthorizationServerMetadata).not.toHaveBeenCalled();
    });
  });

  describe('refreshOAuthTokens', () => {
    const mockRefreshToken = 'refresh-token-12345';
    const originalFetch = global.fetch;
    const mockFetch = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;

    beforeEach(() => {
      jest.clearAllMocks();
      global.fetch = mockFetch;
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    describe('with stored metadata', () => {
      it('should use client_secret_post when server only supports that method', async () => {
        const metadata = {
          serverName: 'test-server',
          userId: 'user-123',
          serverUrl: 'https://auth.example.com',
          state: 'state-123',
          clientInfo: {
            client_id: 'test-client-id',
            client_secret: 'test-client-secret',
            grant_types: ['authorization_code', 'refresh_token'],
            scope: 'read write',
          },
          storedTokenEndpoint: 'https://auth.example.com/oauth/token',
          storedAuthMethods: ['client_secret_post'],
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            expires_in: 3600,
          }),
        } as Response);

        const result = await MCPOAuthHandler.refreshOAuthTokens(mockRefreshToken, metadata, {}, {});

        // Verify the call was made without Authorization header
        expect(mockFetch).toHaveBeenCalledWith(
          'https://auth.example.com/oauth/token',
          expect.objectContaining({
            method: 'POST',
            headers: expect.not.objectContaining({
              Authorization: expect.any(String),
            }),
          }),
        );

        // Verify the body contains client_id and client_secret
        const callArgs = mockFetch.mock.calls[0];
        const body = callArgs[1]?.body as URLSearchParams;
        expect(body.toString()).toContain('client_id=test-client-id');
        expect(body.toString()).toContain('client_secret=test-client-secret');

        expect(result).toEqual({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
          obtained_at: expect.any(Number),
          expires_at: expect.any(Number),
        });
      });

      it('should reuse the stored OAuth resource indicator on refresh', async () => {
        const metadata = {
          serverName: 'test-server',
          userId: 'user-123',
          serverUrl: 'https://api.example.com/mcp',
          resource: 'https://api.example.com/',
          clientInfo: {
            client_id: 'test-client-id',
            grant_types: ['authorization_code', 'refresh_token'],
          },
        };

        mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/oauth/authorize',
          token_endpoint: 'https://auth.example.com/oauth/token',
          token_endpoint_auth_methods_supported: ['none'],
          response_types_supported: ['code'],
          jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        } as AuthorizationServerMetadata);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'new-access-token',
            expires_in: 3600,
          }),
        } as Response);

        await MCPOAuthHandler.refreshOAuthTokens(mockRefreshToken, metadata, {}, {});

        const body = mockFetch.mock.calls[0][1]?.body as URLSearchParams;
        expect(body.get('resource')).toBe('https://api.example.com/');
      });

      it('should not invent an OAuth resource indicator when the original flow had none', async () => {
        const metadata = {
          serverName: 'test-server',
          userId: 'user-123',
          serverUrl: 'https://api.example.com/mcp',
          clientInfo: {
            client_id: 'test-client-id',
            grant_types: ['authorization_code', 'refresh_token'],
          },
        };

        mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/oauth/authorize',
          token_endpoint: 'https://auth.example.com/oauth/token',
          token_endpoint_auth_methods_supported: ['none'],
          response_types_supported: ['code'],
          jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        } as AuthorizationServerMetadata);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'new-access-token',
            expires_in: 3600,
          }),
        } as Response);

        await MCPOAuthHandler.refreshOAuthTokens(mockRefreshToken, metadata, {}, {});

        const body = mockFetch.mock.calls[0][1]?.body as URLSearchParams;
        expect(body.has('resource')).toBe(false);
      });

      it('should use client_secret_basic when server only supports that method', async () => {
        const metadata = {
          serverName: 'test-server',
          userId: 'user-123',
          serverUrl: 'https://auth.example.com',
          state: 'state-123',
          clientInfo: {
            client_id: 'test-client-id',
            client_secret: 'test-client-secret',
            grant_types: ['authorization_code', 'refresh_token'],
            scope: 'read write',
          },
          storedTokenEndpoint: 'https://auth.example.com/oauth/token',
          storedAuthMethods: ['client_secret_basic'],
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            expires_in: 3600,
          }),
        } as Response);

        await MCPOAuthHandler.refreshOAuthTokens(mockRefreshToken, metadata, {}, {});

        const expectedAuth = `Basic ${Buffer.from('test-client-id:test-client-secret').toString('base64')}`;
        expect(mockFetch).toHaveBeenCalledWith(
          'https://auth.example.com/oauth/token',
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
              Authorization: expectedAuth,
            }),
            body: expect.not.stringContaining('client_id='),
          }),
        );
      });

      it('should prefer client_secret_basic when both methods are supported', async () => {
        const metadata = {
          serverName: 'test-server',
          userId: 'user-123',
          serverUrl: 'https://auth.example.com',
          state: 'state-123',
          clientInfo: {
            client_id: 'test-client-id',
            client_secret: 'test-client-secret',
            grant_types: ['authorization_code', 'refresh_token'],
          },
          storedTokenEndpoint: 'https://auth.example.com/oauth/token',
          storedAuthMethods: ['client_secret_post', 'client_secret_basic'],
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            expires_in: 3600,
          }),
        } as Response);

        await MCPOAuthHandler.refreshOAuthTokens(mockRefreshToken, metadata, {}, {});

        const expectedAuth = `Basic ${Buffer.from('test-client-id:test-client-secret').toString('base64')}`;
        expect(mockFetch).toHaveBeenCalledWith(
          'https://auth.example.com/oauth/token',
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: expectedAuth,
            }),
          }),
        );
      });

      it('should default to client_secret_basic when no methods are advertised', async () => {
        const metadata = {
          serverName: 'test-server',
          userId: 'user-123',
          serverUrl: 'https://auth.example.com',
          state: 'state-123',
          clientInfo: {
            client_id: 'test-client-id',
            client_secret: 'test-client-secret',
            grant_types: ['authorization_code', 'refresh_token'],
          },
          storedTokenEndpoint: 'https://auth.example.com/oauth/token',
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            expires_in: 3600,
          }),
        } as Response);

        await MCPOAuthHandler.refreshOAuthTokens(mockRefreshToken, metadata, {}, {});

        const expectedAuth = `Basic ${Buffer.from('test-client-id:test-client-secret').toString('base64')}`;
        expect(mockFetch).toHaveBeenCalledWith(
          'https://auth.example.com/oauth/token',
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: expectedAuth,
            }),
          }),
        );
      });

      it('should include client_id in body for public clients (no secret)', async () => {
        const metadata = {
          serverName: 'test-server',
          userId: 'user-123',
          serverUrl: 'https://auth.example.com',
          state: 'state-123',
          clientInfo: {
            client_id: 'test-client-id',
            // No client_secret - public client
            grant_types: ['authorization_code', 'refresh_token'],
          },
        };

        // Mock OAuth metadata discovery
        mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/oauth/authorize',
          token_endpoint: 'https://auth.example.com/oauth/token',
          token_endpoint_auth_methods_supported: ['none'],
          response_types_supported: ['code'],
          jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        } as AuthorizationServerMetadata);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            expires_in: 3600,
          }),
        } as Response);

        await MCPOAuthHandler.refreshOAuthTokens(mockRefreshToken, metadata, {}, {});

        // Verify the call was made without Authorization header
        expect(mockFetch).toHaveBeenCalledWith(
          'https://auth.example.com/oauth/token',
          expect.objectContaining({
            method: 'POST',
            headers: expect.not.objectContaining({
              Authorization: expect.any(String),
            }),
          }),
        );

        // Verify the body contains client_id (public client)
        const callArgs = mockFetch.mock.calls[0];
        const body = callArgs[1]?.body as URLSearchParams;
        expect(body.toString()).toContain('client_id=test-client-id');
      });
    });

    describe('with pre-configured OAuth settings', () => {
      it('should use client_secret_post when configured to only support that method', async () => {
        const config = {
          token_url: 'https://auth.example.com/oauth/token',
          client_id: 'test-client-id',
          client_secret: 'test-client-secret',
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            expires_in: 3600,
          }),
        } as Response);

        await MCPOAuthHandler.refreshOAuthTokens(
          mockRefreshToken,
          { serverName: 'test-server' },
          {},
          config,
        );

        // Verify the call was made without Authorization header
        expect(mockFetch).toHaveBeenCalledWith(
          new URL('https://auth.example.com/oauth/token'),
          expect.objectContaining({
            method: 'POST',
            headers: expect.not.objectContaining({
              Authorization: expect.any(String),
            }),
          }),
        );

        // Verify the body contains client_id and client_secret
        const callArgs = mockFetch.mock.calls[0];
        const body = callArgs[1]?.body as URLSearchParams;
        expect(body.toString()).toContain('client_id=test-client-id');
        expect(body.toString()).toContain('client_secret=test-client-secret');
      });

      it('should use client_secret_basic when configured to support that method', async () => {
        const config = {
          token_url: 'https://auth.example.com/oauth/token',
          client_id: 'test-client-id',
          client_secret: 'test-client-secret',
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            expires_in: 3600,
          }),
        } as Response);

        await MCPOAuthHandler.refreshOAuthTokens(
          mockRefreshToken,
          { serverName: 'test-server' },
          {},
          config,
        );

        const expectedAuth = `Basic ${Buffer.from('test-client-id:test-client-secret').toString('base64')}`;
        expect(mockFetch).toHaveBeenCalledWith(
          new URL('https://auth.example.com/oauth/token'),
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
              Authorization: expectedAuth,
            }),
            body: expect.not.stringContaining('client_id='),
          }),
        );
      });

      it('should default to client_secret_basic when no auth methods configured', async () => {
        const config = {
          token_url: 'https://auth.example.com/oauth/token',
          client_id: 'test-client-id',
          client_secret: 'test-client-secret',
          // No token_endpoint_auth_methods_supported field
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            expires_in: 3600,
          }),
        } as Response);

        await MCPOAuthHandler.refreshOAuthTokens(
          mockRefreshToken,
          { serverName: 'test-server' },
          {},
          config,
        );

        const expectedAuth = `Basic ${Buffer.from('test-client-id:test-client-secret').toString('base64')}`;
        expect(mockFetch).toHaveBeenCalledWith(
          new URL('https://auth.example.com/oauth/token'),
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: expectedAuth,
            }),
          }),
        );
      });
    });

    it('should throw error when refresh fails', async () => {
      const metadata = {
        serverName: 'test-server',
        userId: 'user-123',
        serverUrl: 'https://auth.example.com',
        state: 'state-123',
        clientInfo: {
          client_id: 'test-client-id',
          client_secret: 'test-client-secret',
          grant_types: ['authorization_code', 'refresh_token'],
        },
        storedTokenEndpoint: 'https://auth.example.com/oauth/token',
        storedAuthMethods: ['client_secret_post'],
      };

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () =>
          '{"error":"invalid_request","error_description":"refresh_token.client_id: Field required"}',
      } as Response);

      await expect(
        MCPOAuthHandler.refreshOAuthTokens(mockRefreshToken, metadata, {}, {}),
      ).rejects.toThrow(
        'Token refresh failed: 400 Bad Request - {"error":"invalid_request","error_description":"refresh_token.client_id: Field required"}',
      );
    });

    describe('stored token endpoint binding', () => {
      it('rejects a replacement confidential client binding before discovery or fetch', async () => {
        const metadata = {
          serverName: 'test-server',
          serverUrl: 'https://attacker.example.com/mcp',
          clientInfo: {
            client_id: 'test-client-id',
            client_secret: 'test-client-secret',
          },
          storedTokenEndpoint: 'https://auth.example.com/token',
          storedAuthMethods: ['client_secret_basic'],
        };

        await expect(
          MCPOAuthHandler.refreshOAuthTokens(
            'test-refresh-token',
            metadata,
            {},
            {
              token_url: 'https://attacker.example.com/token',
              client_id: 'replacement-client-id',
              client_secret: 'replacement-client-secret',
              token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
              token_endpoint_auth_methods_supported: ['client_secret_post'],
            },
          ),
        ).rejects.toThrow('no longer matches current OAuth client configuration');

        expect(mockDiscoverAuthorizationServerMetadata).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('rejects a transition from a stored confidential client to an explicit public client', async () => {
        const metadata = {
          serverName: 'test-server',
          serverUrl: 'https://mcp.example.com',
          clientInfo: {
            client_id: 'old-client-id',
            client_secret: 'old-client-secret',
          },
          storedTokenEndpoint: 'https://auth.example.com/token',
          storedAuthMethods: ['client_secret_basic'],
        };

        await expect(
          MCPOAuthHandler.refreshOAuthTokens(
            'test-refresh-token',
            metadata,
            {},
            {
              token_url: 'https://auth.example.com/token',
              client_id: 'public-client-id',
            },
          ),
        ).rejects.toThrow('no longer matches current OAuth client configuration');

        expect(mockDiscoverAuthorizationServerMetadata).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('uses the stored endpoint and auth policy when the confidential binding still matches', async () => {
        const metadata = {
          serverName: 'test-server',
          serverUrl: 'https://mcp.example.com',
          clientInfo: {
            client_id: 'test-client-id',
            client_secret: 'test-client-secret',
            token_endpoint_auth_method: 'client_secret_basic',
          },
          storedTokenEndpoint: 'https://auth.example.com/token',
          storedAuthMethods: ['client_secret_basic'],
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'new-access-token',
            expires_in: 3600,
          }),
        } as Response);

        await MCPOAuthHandler.refreshOAuthTokens(
          'test-refresh-token',
          metadata,
          {},
          {
            token_url: 'https://auth.example.com:443/token',
            client_id: 'test-client-id',
            client_secret: 'test-client-secret',
            token_exchange_method: TokenExchangeMethodEnum.BasicAuthHeader,
            token_endpoint_auth_methods_supported: ['client_secret_post'],
          },
        );

        expect(mockDiscoverAuthorizationServerMetadata).not.toHaveBeenCalled();
        expect(mockFetch).toHaveBeenCalledWith(
          'https://auth.example.com/token',
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
              Authorization: `Basic ${Buffer.from('test-client-id:test-client-secret').toString(
                'base64',
              )}`,
            }),
          }),
        );
      });

      it('retains the discovered auth method when unchanged config has no explicit method policy', async () => {
        const metadata = {
          serverName: 'test-server',
          serverUrl: 'https://mcp.example.com',
          clientInfo: {
            client_id: 'test-client-id',
            client_secret: 'test-client-secret',
            token_endpoint_auth_method: 'client_secret_post',
          },
          storedTokenEndpoint: 'https://auth.example.com/token',
          storedAuthMethods: ['client_secret_post'],
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'new-access-token', expires_in: 3600 }),
        } as Response);

        await MCPOAuthHandler.refreshOAuthTokens(
          'test-refresh-token',
          metadata,
          {},
          {
            token_url: 'https://auth.example.com/token',
            client_id: 'test-client-id',
            client_secret: 'test-client-secret',
          },
        );

        const request = mockFetch.mock.calls[0][1];
        expect(new Headers(request?.headers).has('Authorization')).toBe(false);
        const body = request?.body as URLSearchParams;
        expect(body.get('client_id')).toBe('test-client-id');
        expect(body.get('client_secret')).toBe('test-client-secret');
      });

      it('rejects a dynamically registered client after the MCP server URL changes', async () => {
        const metadata = {
          serverName: 'test-server',
          serverUrl: 'https://attacker.example.com/mcp',
          clientInfo: {
            client_id: 'dynamically-registered-client-id',
            client_secret: 'dynamically-registered-client-secret',
            token_endpoint_auth_method: 'client_secret_post',
          },
          storedTokenEndpoint: 'https://auth.example.com/token',
          storedAuthMethods: ['client_secret_post'],
          storedServerUrl: 'https://mcp.example.com/mcp',
          clientSource: 'dynamic' as const,
        };

        await expect(
          MCPOAuthHandler.refreshOAuthTokens('test-refresh-token', metadata, {}, undefined),
        ).rejects.toThrow('no longer matches the current MCP server URL');

        expect(mockDiscoverAuthorizationServerMetadata).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('rejects an edited token endpoint for a stored public configured client', async () => {
        const metadata = {
          serverName: 'test-server',
          serverUrl: 'https://mcp.example.com/mcp',
          clientInfo: { client_id: 'public-client-id' },
          storedTokenEndpoint: 'https://auth.example.com/token',
          storedAuthMethods: ['none'],
          storedServerUrl: 'https://mcp.example.com/mcp',
          clientSource: 'configured' as const,
        };

        await expect(
          MCPOAuthHandler.refreshOAuthTokens(
            'test-refresh-token',
            metadata,
            {},
            {
              client_id: 'public-client-id',
              token_url: 'https://attacker.example.com/token',
            },
          ),
        ).rejects.toThrow('no longer matches the current configured token endpoint');

        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('keeps a configured public client pinned when discovery advertises confidential methods', async () => {
        const metadata = {
          serverName: 'test-server',
          serverUrl: 'https://mcp.example.com/mcp',
          clientInfo: {
            client_id: 'public-client-id',
            token_endpoint_auth_method: 'none',
          },
          storedTokenEndpoint: 'https://auth.example.com/token',
          storedAuthMethods: ['client_secret_basic'],
          storedServerUrl: 'https://mcp.example.com/mcp',
          clientSource: 'configured' as const,
        };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'new-access-token', expires_in: 3600 }),
        } as Response);

        await MCPOAuthHandler.refreshOAuthTokens(
          'test-refresh-token',
          metadata,
          {},
          {
            client_id: 'public-client-id',
          },
        );

        expect(mockFetch).toHaveBeenCalledWith(
          'https://auth.example.com/token',
          expect.objectContaining({ method: 'POST' }),
        );
        const body = mockFetch.mock.calls[0][1]?.body as URLSearchParams;
        expect(body.get('client_id')).toBe('public-client-id');
      });

      it('rejects stored configured credentials after the configured client is removed', async () => {
        const metadata = {
          serverName: 'test-server',
          serverUrl: 'https://mcp.example.com/mcp',
          clientInfo: {
            client_id: 'configured-client-id',
            client_secret: 'configured-client-secret',
          },
          storedTokenEndpoint: 'https://auth.example.com/token',
          storedAuthMethods: ['client_secret_basic'],
          storedServerUrl: 'https://mcp.example.com/mcp',
          clientSource: 'configured' as const,
        };

        await expect(
          MCPOAuthHandler.refreshOAuthTokens('test-refresh-token', metadata, {}, undefined),
        ).rejects.toThrow('no longer matches the current configured client');

        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('uses stored token endpoint when discovery fails (auto-discovered)', async () => {
        const metadata = {
          serverName: 'test-server',
          serverUrl: 'https://mcp.example.com',
          storedTokenEndpoint: 'https://auth.example.com/token',
        };

        mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce(undefined);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'new-access-token',
            expires_in: 3600,
          }),
        } as Response);

        const result = await MCPOAuthHandler.refreshOAuthTokens(
          'test-refresh-token',
          metadata,
          {},
          {},
        );

        const [fetchUrl] = mockFetch.mock.calls[0];
        expect(fetchUrl).toBeInstanceOf(URL);
        expect(fetchUrl.toString()).toBe('https://auth.example.com/token');
        expect(result.access_token).toBe('new-access-token');
      });

      it('fails before discovery or fetch when confidential client binding is missing', async () => {
        const metadata = {
          serverName: 'test-server',
          serverUrl: 'https://attacker.example.com/mcp',
          clientInfo: {
            client_id: 'test-client-id',
            client_secret: 'test-client-secret',
          },
        };

        await expect(
          MCPOAuthHandler.refreshOAuthTokens(
            'test-refresh-token',
            metadata,
            {},
            {
              token_url: 'https://attacker.example.com/token',
              client_id: 'replacement-client-id',
              client_secret: 'replacement-client-secret',
            },
          ),
        ).rejects.toThrow('Stored OAuth client_secret is missing its bound token endpoint');

        expect(mockDiscoverAuthorizationServerMetadata).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('still throws when discovery fails and no stored endpoint (auto-discovered)', async () => {
        const metadata = {
          serverName: 'test-server',
          serverUrl: 'https://mcp.example.com',
        };

        mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce(undefined);

        await expect(
          MCPOAuthHandler.refreshOAuthTokens('test-refresh-token', metadata, {}, {}),
        ).rejects.toThrow('No OAuth metadata discovered for token refresh');

        expect(mockFetch).not.toHaveBeenCalled();
      });
    });
  });

  describe('revokeOAuthToken', () => {
    const mockServerName = 'test-server';
    const mockToken = 'test-token-12345';

    const originalFetch = global.fetch;
    const mockFetch = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;

    beforeEach(() => {
      jest.clearAllMocks();
      global.fetch = mockFetch;
    });

    afterEach(() => {
      mockFetch.mockClear();
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    it('should successfully revoke an access token with client_secret_basic auth', async () => {
      const metadata = {
        serverUrl: 'https://auth.example.com',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        revocationEndpoint: 'https://auth.example.com/oauth/revoke',
        revocationEndpointAuthMethodsSupported: ['client_secret_basic'],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);

      await MCPOAuthHandler.revokeOAuthToken(mockServerName, mockToken, 'access', metadata);

      expect(mockFetch).toHaveBeenCalledWith(
        new URL('https://auth.example.com/oauth/revoke'),
        expect.objectContaining({
          method: 'POST',
          body: 'token=test-token-12345&token_type_hint=access_token',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from('test-client-id:test-client-secret').toString('base64')}`,
          },
        }),
      );
    });

    it('should successfully revoke a refresh token with client_secret_basic auth', async () => {
      const metadata = {
        serverUrl: 'https://auth.example.com',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        revocationEndpoint: 'https://auth.example.com/oauth/revoke',
        revocationEndpointAuthMethodsSupported: ['client_secret_basic'],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);

      await MCPOAuthHandler.revokeOAuthToken(mockServerName, mockToken, 'refresh', metadata);

      expect(mockFetch).toHaveBeenCalledWith(
        new URL('https://auth.example.com/oauth/revoke'),
        expect.objectContaining({
          method: 'POST',
          body: 'token=test-token-12345&token_type_hint=refresh_token',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from('test-client-id:test-client-secret').toString('base64')}`,
          },
        }),
      );
    });

    it('should successfully revoke an access token with client_secret_post auth', async () => {
      const metadata = {
        serverUrl: 'https://auth.example.com',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        revocationEndpoint: 'https://auth.example.com/oauth/revoke',
        revocationEndpointAuthMethodsSupported: ['client_secret_post'],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);

      await MCPOAuthHandler.revokeOAuthToken(mockServerName, mockToken, 'access', metadata);

      expect(mockFetch).toHaveBeenCalledWith(
        new URL('https://auth.example.com/oauth/revoke'),
        expect.objectContaining({
          method: 'POST',
          body: 'token=test-token-12345&token_type_hint=access_token&client_secret=test-client-secret&client_id=test-client-id',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }),
      );
    });

    it('should fallback to /revoke endpoint when revocationEndpoint is not provided', async () => {
      const metadata = {
        serverUrl: 'https://auth.example.com',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);

      await MCPOAuthHandler.revokeOAuthToken(mockServerName, mockToken, 'refresh', metadata);

      expect(mockFetch).toHaveBeenCalledWith(
        new URL('https://auth.example.com/revoke'),
        expect.any(Object),
      );
    });

    it('should default to client_secret_basic auth when revocationEndpointAuthMethodsSupported is not provided', async () => {
      const metadata = {
        serverUrl: 'https://auth.example.com',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        revocationEndpoint: 'https://auth.example.com/oauth/revoke',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);

      await MCPOAuthHandler.revokeOAuthToken(mockServerName, mockToken, 'refresh', metadata);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringMatching(/^Basic /),
          }),
        }),
      );
    });

    it('should throw an error when the revocation request fails', async () => {
      const metadata = {
        serverUrl: 'https://auth.example.com',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        revocationEndpoint: 'https://auth.example.com/oauth/revoke',
      };

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 418,
      } as Response);

      await expect(
        MCPOAuthHandler.revokeOAuthToken(mockServerName, mockToken, 'refresh', metadata),
      ).rejects.toThrow('Token revocation failed: HTTP 418');
    });

    it('should prioritize client_secret_basic over other auth methods', async () => {
      const metadata = {
        serverUrl: 'https://auth.example.com',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        revocationEndpoint: 'https://auth.example.com/oauth/revoke',
        revocationEndpointAuthMethodsSupported: [
          'client_secret_post',
          'client_secret_basic',
          'some_other_method',
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);

      await MCPOAuthHandler.revokeOAuthToken(mockServerName, mockToken, 'refresh', metadata);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringMatching(/^Basic /),
          }),
        }),
      );
    });
  });

  describe('Custom OAuth Headers', () => {
    const originalFetch = global.fetch;
    const mockFetch = jest.fn();

    beforeEach(() => {
      jest.clearAllMocks();
      global.fetch = mockFetch as unknown as typeof fetch;
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
      mockDiscoverAuthorizationServerMetadata.mockResolvedValue({
        issuer: 'http://example.com',
        authorization_endpoint: 'http://example.com/auth',
        token_endpoint: 'http://example.com/token',
        response_types_supported: ['code'],
      } as AuthorizationServerMetadata);
      mockStartAuthorization.mockResolvedValue({
        authorizationUrl: new URL('http://example.com/auth'),
        codeVerifier: 'test-verifier',
      });
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    it('passes headers to client registration', async () => {
      mockRegisterClient.mockImplementation(async (_, options) => {
        await options.fetchFn?.('http://example.com/register', {});
        return { client_id: 'test', redirect_uris: [], logo_uri: undefined, tos_uri: undefined };
      });

      await MCPOAuthHandler.initiateOAuthFlow(
        'test-server',
        'http://example.com',
        'user-123',
        { foo: 'bar' },
        {},
      );

      const headers = mockFetch.mock.calls[0][1]?.headers as Headers;
      expect(headers.get('foo')).toBe('bar');
    });

    it('passes headers to auto-discovery operations', async () => {
      mockDiscoverOAuthProtectedResourceMetadata.mockImplementation(async (_, __, fetchFn) => {
        await fetchFn?.('http://example.com/.well-known/oauth-protected-resource', {});
        return {
          resource: 'http://example.com',
          authorization_servers: ['http://auth.example.com'],
        };
      });

      await MCPOAuthHandler.initiateOAuthFlow(
        'test-server',
        'http://example.com',
        'user-123',
        { foo: 'bar' },
        {},
      );

      const allHaveHeader = mockFetch.mock.calls.every((call) => {
        const headers = call[1]?.headers as Headers;
        return headers?.get('foo') === 'bar';
      });
      expect(allHaveHeader).toBe(true);
    });

    it('passes headers to token exchange', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: 123,
          metadata: {
            serverName: 'test-server',
            codeVerifier: 'test-verifier',
            clientInfo: {},
            metadata: {},
          } as MCPOAuthFlowMetadata,
        }),
        completeFlowIfCurrent: jest.fn().mockResolvedValue('updated'),
      } as unknown as FlowStateManager<MCPOAuthTokens>;

      mockExchangeAuthorization.mockImplementation(async (_, options) => {
        await options.fetchFn?.('http://example.com/token', {});
        return { access_token: 'test-token', token_type: 'Bearer', expires_in: 3600 };
      });

      const result = await MCPOAuthHandler.completeOAuthFlow(
        'test-flow-id',
        'test-auth-code',
        mockFlowManager,
        { foo: 'bar' },
      );

      const headers = mockFetch.mock.calls[0][1]?.headers as Headers;
      expect(headers.get('foo')).toBe('bar');
      expect(result.credential_set_id).toMatch(/^[a-f0-9]{32}$/);
      expect(mockFlowManager.completeFlowIfCurrent).toHaveBeenCalledWith(
        'test-flow-id',
        'mcp_oauth',
        expect.any(Number),
        '',
        expect.objectContaining({ credential_set_id: result.credential_set_id }),
      );
    });

    it('normalizes a zero exchange lifetime before persistence', async () => {
      const flowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: 123,
          metadata: {
            serverName: 'test-server',
            codeVerifier: 'verifier',
            clientInfo: {},
            metadata: {},
          },
        }),
        completeFlowIfCurrent: jest.fn().mockResolvedValue('updated'),
      } as unknown as FlowStateManager<MCPOAuthTokens>;
      mockExchangeAuthorization.mockResolvedValue({
        access_token: 'expired-token',
        token_type: 'Bearer',
        expires_in: 0,
      });
      const persist = jest.fn(async (tokens: MCPOAuthTokens) => tokens);
      const result = await MCPOAuthHandler.completeOAuthFlow(
        'flow',
        'code',
        flowManager,
        {},
        persist,
      );
      expect(result.expires_at).toEqual(expect.any(Number));
      expect(result.expires_at).toBeLessThanOrEqual(Date.now());
      expect(persist).toHaveBeenCalledWith(
        expect.objectContaining({ expires_in: 0, expires_at: result.expires_at }),
        expect.any(Function),
      );
    });

    it('persists exchanged tokens before completing and waking the OAuth flow', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: 123,
          metadata: {
            serverName: 'test-server',
            codeVerifier: 'test-verifier',
            clientInfo: {},
            metadata: {},
          } as MCPOAuthFlowMetadata,
        }),
        completeFlowIfCurrent: jest.fn().mockResolvedValue('updated'),
      } as unknown as FlowStateManager<MCPOAuthTokens>;
      mockExchangeAuthorization.mockResolvedValue({
        access_token: 'test-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
      const persistBeforeComplete = jest.fn(async (tokens: MCPOAuthTokens) => ({
        ...tokens,
        expires_at: 123456,
      }));

      const result = await MCPOAuthHandler.completeOAuthFlow(
        'test-flow-id',
        'test-auth-code',
        mockFlowManager,
        {},
        persistBeforeComplete,
      );

      expect(result.expires_at).toBe(123456);
      expect(persistBeforeComplete.mock.invocationCallOrder[0]).toBeLessThan(
        (mockFlowManager.completeFlowIfCurrent as jest.Mock).mock.invocationCallOrder[0],
      );
      expect(mockFlowManager.completeFlowIfCurrent).toHaveBeenCalledWith(
        'test-flow-id',
        'mcp_oauth',
        expect.any(Number),
        '',
        result,
      );
    });

    it('rolls back persisted tokens when teardown cancels the flow before settlement', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: 123,
          metadata: {
            serverName: 'test-server',
            serverUrl: 'https://example.com/mcp',
            codeVerifier: 'test-verifier',
            clientInfo: {},
            metadata: {},
          } as MCPOAuthFlowMetadata,
        }),
        completeFlowIfCurrent: jest.fn().mockResolvedValue('stale'),
        failFlowIfCurrent: jest.fn().mockResolvedValue('stale'),
      } as unknown as FlowStateManager<MCPOAuthTokens>;
      mockExchangeAuthorization.mockResolvedValue({
        access_token: 'test-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
      const persistBeforeComplete = jest.fn(async (tokens: MCPOAuthTokens) => tokens);
      const rollbackPersistedTokens = jest.fn(async () => undefined);

      await expect(
        MCPOAuthHandler.completeOAuthFlow(
          'test-flow-id',
          'test-auth-code',
          mockFlowManager,
          {},
          persistBeforeComplete,
          rollbackPersistedTokens,
        ),
      ).rejects.toThrow('OAuth flow was cancelled before completion');

      expect(rollbackPersistedTokens).toHaveBeenCalledWith(
        expect.objectContaining({ access_token: 'test-token' }),
      );
      expect(mockFlowManager.completeFlowIfCurrent).toHaveBeenCalledWith(
        'test-flow-id',
        'mcp_oauth',
        123,
        '',
        expect.objectContaining({ access_token: 'test-token' }),
      );
    });

    it('lets persistence settle the flow inside its rollback boundary', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: 123,
          metadata: {
            serverName: 'test-server',
            codeVerifier: 'test-verifier',
            clientInfo: {},
            metadata: {},
          } as MCPOAuthFlowMetadata,
        }),
        completeFlowIfCurrent: jest.fn().mockResolvedValue('updated'),
      } as unknown as FlowStateManager<MCPOAuthTokens>;
      mockExchangeAuthorization.mockResolvedValue({
        access_token: 'test-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
      const persistBeforeComplete = jest.fn(
        async (
          tokens: MCPOAuthTokens,
          completePersistedFlow: (tokens: MCPOAuthTokens) => Promise<void>,
        ) => {
          const storedTokens = { ...tokens, expires_at: 123456 };
          await completePersistedFlow(storedTokens);
          return storedTokens;
        },
      );
      const rollbackPersistedTokens = jest.fn(async () => undefined);

      const result = await MCPOAuthHandler.completeOAuthFlow(
        'test-flow-id',
        'test-auth-code',
        mockFlowManager,
        {},
        persistBeforeComplete,
        rollbackPersistedTokens,
      );

      expect(result.expires_at).toBe(123456);
      expect(mockFlowManager.completeFlowIfCurrent).toHaveBeenCalledTimes(1);
      expect(rollbackPersistedTokens).not.toHaveBeenCalled();
    });

    it('rejects a replaced callback attempt before exchanging its authorization code', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: 456,
          metadata: {
            state: 'replacement-state',
            serverName: 'test-server',
            codeVerifier: 'replacement-verifier',
            clientInfo: {},
            metadata: {},
          } as MCPOAuthFlowMetadata,
        }),
        failFlowIfCurrent: jest.fn(),
      } as unknown as FlowStateManager<MCPOAuthTokens>;

      await expect(
        MCPOAuthHandler.completeOAuthFlow(
          'test-flow-id',
          'stale-auth-code',
          mockFlowManager,
          {},
          undefined,
          undefined,
          { createdAt: 123, state: 'original-state' },
        ),
      ).rejects.toThrow('OAuth flow attempt was replaced before token exchange');

      expect(mockExchangeAuthorization).not.toHaveBeenCalled();
      expect(mockFlowManager.failFlowIfCurrent).not.toHaveBeenCalled();
    });

    it('passes headers to token refresh', async () => {
      mockDiscoverAuthorizationServerMetadata.mockImplementation(async (_, options) => {
        await options?.fetchFn?.('http://example.com/.well-known/oauth-authorization-server', {});
        return {
          issuer: 'http://example.com',
          token_endpoint: 'http://example.com/token',
        } as AuthorizationServerMetadata;
      });

      await MCPOAuthHandler.refreshOAuthTokens(
        'test-refresh-token',
        {
          serverName: 'test-server',
          serverUrl: 'http://example.com',
          clientInfo: { client_id: 'test-client' },
        },
        { foo: 'bar' },
        {},
      );

      const discoveryCall = mockFetch.mock.calls.find((call) =>
        call[0].toString().includes('.well-known'),
      );
      expect(discoveryCall).toBeDefined();
      const headers = discoveryCall![1]?.headers as Headers;
      expect(headers.get('foo')).toBe('bar');
    });
  });

  describe('Fetch wrapper client_secret_basic body cleanup', () => {
    const originalFetch = global.fetch;
    const mockFetch = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;

    beforeEach(() => {
      jest.clearAllMocks();
      global.fetch = mockFetch;
    });

    afterEach(() => {
      mockFetch.mockClear();
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    it('should remove client_id and client_secret from body when using client_secret_basic via completeOAuthFlow', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: 123,
          metadata: {
            serverName: 'test-server',
            serverUrl: 'https://example.com/mcp',
            codeVerifier: 'test-verifier',
            clientInfo: {
              client_id: 'test-client-id',
              client_secret: 'test-client-secret',
              redirect_uris: ['http://localhost:3080/api/mcp/test-server/oauth/callback'],
              token_endpoint_auth_method: 'client_secret_basic',
            },
            metadata: {
              issuer: 'https://example.com',
              authorization_endpoint: 'https://example.com/authorize',
              token_endpoint: 'https://example.com/token',
              response_types_supported: ['code'],
              token_endpoint_auth_methods_supported: ['client_secret_basic'],
            },
          } as MCPOAuthFlowMetadata,
        }),
        completeFlowIfCurrent: jest.fn().mockResolvedValue('updated'),
      } as unknown as FlowStateManager<MCPOAuthTokens>;

      mockExchangeAuthorization.mockImplementation(async (_, options) => {
        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'test-auth-code',
          client_id: 'test-client-id',
          client_secret: 'test-client-secret',
        });
        await options.fetchFn?.('https://example.com/token', {
          method: 'POST',
          body,
        });
        return { access_token: 'test-token', token_type: 'Bearer', expires_in: 3600 };
      });

      await MCPOAuthHandler.completeOAuthFlow('test-flow', 'test-auth-code', mockFlowManager, {});

      const callArgs = mockFetch.mock.calls[0];
      const sentBody = callArgs[1]?.body as string;
      expect(sentBody).not.toContain('client_id=');
      expect(sentBody).not.toContain('client_secret=');

      const sentHeaders = callArgs[1]?.headers as Headers;
      expect(sentHeaders.get('Authorization')).toMatch(/^Basic /);
    });
  });

  describe('completeOAuthFlow auth method propagation', () => {
    const originalFetch = global.fetch;
    const mockFetch = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;

    beforeEach(() => {
      jest.clearAllMocks();
      global.fetch = mockFetch;
    });

    afterEach(() => {
      mockFetch.mockClear();
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    it('should use client_secret_post when clientInfo specifies that method', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: 123,
          metadata: {
            serverName: 'test-server',
            serverUrl: 'https://example.com/mcp',
            codeVerifier: 'test-verifier',
            clientInfo: {
              client_id: 'test-client-id',
              client_secret: 'test-client-secret',
              redirect_uris: ['http://localhost:3080/api/mcp/test-server/oauth/callback'],
              token_endpoint_auth_method: 'client_secret_post',
            },
            metadata: {
              issuer: 'https://example.com',
              authorization_endpoint: 'https://example.com/authorize',
              token_endpoint: 'https://example.com/token',
              response_types_supported: ['code'],
              token_endpoint_auth_methods_supported: ['client_secret_post'],
            },
          } as MCPOAuthFlowMetadata,
        }),
        completeFlowIfCurrent: jest.fn().mockResolvedValue('updated'),
      } as unknown as FlowStateManager<MCPOAuthTokens>;

      mockExchangeAuthorization.mockImplementation(async (_, options) => {
        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'test-auth-code',
        });
        await options.fetchFn?.('https://example.com/token', {
          method: 'POST',
          body,
        });
        return { access_token: 'test-token', token_type: 'Bearer', expires_in: 3600 };
      });

      await MCPOAuthHandler.completeOAuthFlow('test-flow', 'test-auth-code', mockFlowManager, {});

      const callArgs = mockFetch.mock.calls[0];
      const sentBody = callArgs[1]?.body as string;
      expect(sentBody).toContain('client_id=test-client-id');
      expect(sentBody).toContain('client_secret=test-client-secret');

      const sentHeaders = callArgs[1]?.headers as Headers;
      expect(sentHeaders.has('Authorization')).toBe(false);
    });

    it('should use none auth when clientInfo has no secret', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: 123,
          metadata: {
            serverName: 'test-server',
            serverUrl: 'https://example.com/mcp',
            codeVerifier: 'test-verifier',
            clientInfo: {
              client_id: 'test-client-id',
              redirect_uris: ['http://localhost:3080/api/mcp/test-server/oauth/callback'],
              token_endpoint_auth_method: 'none',
            },
            metadata: {
              issuer: 'https://example.com',
              authorization_endpoint: 'https://example.com/authorize',
              token_endpoint: 'https://example.com/token',
              response_types_supported: ['code'],
              token_endpoint_auth_methods_supported: ['none'],
            },
          } as MCPOAuthFlowMetadata,
        }),
        completeFlowIfCurrent: jest.fn().mockResolvedValue('updated'),
      } as unknown as FlowStateManager<MCPOAuthTokens>;

      mockExchangeAuthorization.mockImplementation(async (_, options) => {
        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'test-auth-code',
        });
        await options.fetchFn?.('https://example.com/token', {
          method: 'POST',
          body,
        });
        return { access_token: 'test-token', token_type: 'Bearer', expires_in: 3600 };
      });

      await MCPOAuthHandler.completeOAuthFlow('test-flow', 'test-auth-code', mockFlowManager, {});

      const callArgs = mockFetch.mock.calls[0];
      const sentBody = callArgs[1]?.body as string;
      expect(sentBody).toContain('client_id=test-client-id');
      expect(sentBody).not.toContain('client_secret=');

      const sentHeaders = callArgs[1]?.headers as Headers;
      expect(sentHeaders.has('Authorization')).toBe(false);
    });
  });

  describe('refreshOAuthTokens with forced token_exchange_method', () => {
    const originalFetch = global.fetch;
    const mockFetch = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;

    beforeEach(() => {
      jest.clearAllMocks();
      global.fetch = mockFetch;
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    it('should force client_secret_post even when server advertises client_secret_basic', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
        }),
      } as Response);

      await MCPOAuthHandler.refreshOAuthTokens(
        'refresh-token',
        { serverName: 'test-server' },
        {},
        {
          token_url: 'https://auth.example.com/oauth/token',
          client_id: 'test-client-id',
          client_secret: 'test-client-secret',
          token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
        },
      );

      expect(mockFetch).toHaveBeenCalledWith(
        new URL('https://auth.example.com/oauth/token'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.not.objectContaining({
            Authorization: expect.any(String),
          }),
        }),
      );

      const callArgs = mockFetch.mock.calls[0];
      const body = callArgs[1]?.body as URLSearchParams;
      expect(body.toString()).toContain('client_id=test-client-id');
      expect(body.toString()).toContain('client_secret=test-client-secret');
    });
  });

  describe('revokeOAuthToken with empty auth methods', () => {
    const originalFetch = global.fetch;
    const mockFetch = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;

    beforeEach(() => {
      jest.clearAllMocks();
      global.fetch = mockFetch;
    });

    afterEach(() => {
      mockFetch.mockClear();
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    it('should send no client credentials when revocationEndpointAuthMethodsSupported is empty', async () => {
      const metadata = {
        serverUrl: 'https://auth.example.com',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        revocationEndpoint: 'https://auth.example.com/oauth/revoke',
        revocationEndpointAuthMethodsSupported: [] as string[],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);

      await MCPOAuthHandler.revokeOAuthToken('test-server', 'test-token', 'access', metadata);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          headers: expect.not.objectContaining({
            Authorization: expect.any(String),
          }),
        }),
      );

      const callArgs = mockFetch.mock.calls[0];
      const body = callArgs[1]?.body as string;
      expect(body).not.toContain('client_id=');
      expect(body).not.toContain('client_secret=');
    });
  });

  describe('Client Registration Reuse', () => {
    const originalFetch = global.fetch;
    const mockFetch = jest.fn();

    beforeEach(() => {
      jest.clearAllMocks();
      global.fetch = mockFetch as unknown as typeof fetch;
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
      process.env.DOMAIN_SERVER = 'http://localhost:3080';
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    const mockFindToken = jest.fn();

    it('should reuse existing client registration when findToken is provided and client exists', async () => {
      const existingClientInfo = {
        client_id: 'existing-client-id',
        client_secret: 'existing-client-secret',
        redirect_uris: ['http://localhost:3080/api/mcp/test-server/oauth/callback'],
        token_endpoint_auth_method: 'client_secret_basic',
      };

      mockGetClientInfoAndMetadata.mockResolvedValueOnce({
        clientInfo: existingClientInfo,
        clientMetadata: {
          issuer: 'https://example.com',
          token_endpoint: 'https://example.com/token',
          server_url: 'https://example.com/mcp',
          client_source: 'dynamic',
          credential_set_id: 'stored-generation',
        },
      });

      // Mock resource metadata discovery to fail
      mockDiscoverOAuthProtectedResourceMetadata.mockRejectedValueOnce(
        new Error('No resource metadata'),
      );

      // Mock authorization server metadata discovery
      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
        issuer: 'https://example.com',
        authorization_endpoint: 'https://example.com/authorize',
        token_endpoint: 'https://example.com/token',
        registration_endpoint: 'https://example.com/register',
        response_types_supported: ['code'],
        jwks_uri: 'https://example.com/.well-known/jwks.json',
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      } as AuthorizationServerMetadata);

      mockStartAuthorization.mockResolvedValueOnce({
        authorizationUrl: new URL('https://example.com/authorize?client_id=existing-client-id'),
        codeVerifier: 'test-code-verifier',
      });

      const result = await MCPOAuthHandler.initiateOAuthFlow(
        'test-server',
        'https://example.com/mcp',
        'user-123',
        {},
        undefined,
        undefined,
        mockFindToken,
      );

      // Should NOT have called registerClient since we reused the existing one
      expect(mockRegisterClient).not.toHaveBeenCalled();

      // Should have used the existing client info for startAuthorization
      expect(mockStartAuthorization).toHaveBeenCalledWith(
        'https://example.com/mcp',
        expect.objectContaining({
          clientInformation: existingClientInfo,
        }),
      );

      expect(result.authorizationUrl).toBeDefined();
      expect(result.flowId).toBeDefined();
      expect(result.flowMetadata.reusedClientCredentialSetId).toBe('stored-generation');
    });

    it('should register a new client when findToken is provided but no existing registration found', async () => {
      mockGetClientInfoAndMetadata.mockResolvedValueOnce(null);

      // Mock resource metadata discovery to fail
      mockDiscoverOAuthProtectedResourceMetadata.mockRejectedValueOnce(
        new Error('No resource metadata'),
      );

      // Mock authorization server metadata discovery
      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
        issuer: 'https://example.com',
        authorization_endpoint: 'https://example.com/authorize',
        token_endpoint: 'https://example.com/token',
        registration_endpoint: 'https://example.com/register',
        response_types_supported: ['code'],
        jwks_uri: 'https://example.com/.well-known/jwks.json',
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      } as AuthorizationServerMetadata);

      mockRegisterClient.mockResolvedValueOnce({
        client_id: 'new-client-id',
        client_secret: 'new-client-secret',
        redirect_uris: ['http://localhost:3080/api/mcp/test-server/oauth/callback'],
        logo_uri: undefined,
        tos_uri: undefined,
      });

      mockStartAuthorization.mockResolvedValueOnce({
        authorizationUrl: new URL('https://example.com/authorize?client_id=new-client-id'),
        codeVerifier: 'test-code-verifier',
      });

      await MCPOAuthHandler.initiateOAuthFlow(
        'test-server',
        'https://example.com/mcp',
        'user-123',
        {},
        undefined,
        undefined,
        mockFindToken,
      );

      // Should have called registerClient since no existing registration was found
      expect(mockRegisterClient).toHaveBeenCalled();
    });

    it('should register a new client when findToken is not provided', async () => {
      // Mock resource metadata discovery to fail
      mockDiscoverOAuthProtectedResourceMetadata.mockRejectedValueOnce(
        new Error('No resource metadata'),
      );

      // Mock authorization server metadata discovery
      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
        issuer: 'https://example.com',
        authorization_endpoint: 'https://example.com/authorize',
        token_endpoint: 'https://example.com/token',
        registration_endpoint: 'https://example.com/register',
        response_types_supported: ['code'],
        jwks_uri: 'https://example.com/.well-known/jwks.json',
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      } as AuthorizationServerMetadata);

      mockRegisterClient.mockResolvedValueOnce({
        client_id: 'new-client-id',
        client_secret: 'new-client-secret',
        redirect_uris: ['http://localhost:3080/api/mcp/test-server/oauth/callback'],
        logo_uri: undefined,
        tos_uri: undefined,
      });

      mockStartAuthorization.mockResolvedValueOnce({
        authorizationUrl: new URL('https://example.com/authorize?client_id=new-client-id'),
        codeVerifier: 'test-code-verifier',
      });

      // No findToken passed
      await MCPOAuthHandler.initiateOAuthFlow(
        'test-server',
        'https://example.com/mcp',
        'user-123',
        {},
        undefined,
      );

      // Should NOT have tried to look up existing registration
      expect(mockGetClientInfoAndMetadata).not.toHaveBeenCalled();

      // Should have called registerClient
      expect(mockRegisterClient).toHaveBeenCalled();
    });

    it('should fall back to registration when getClientInfoAndMetadata throws', async () => {
      mockGetClientInfoAndMetadata.mockRejectedValueOnce(new Error('DB error'));

      // Mock resource metadata discovery to fail
      mockDiscoverOAuthProtectedResourceMetadata.mockRejectedValueOnce(
        new Error('No resource metadata'),
      );

      // Mock authorization server metadata discovery
      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
        issuer: 'https://example.com',
        authorization_endpoint: 'https://example.com/authorize',
        token_endpoint: 'https://example.com/token',
        registration_endpoint: 'https://example.com/register',
        response_types_supported: ['code'],
        jwks_uri: 'https://example.com/.well-known/jwks.json',
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      } as AuthorizationServerMetadata);

      mockRegisterClient.mockResolvedValueOnce({
        client_id: 'new-client-id',
        client_secret: 'new-client-secret',
        redirect_uris: ['http://localhost:3080/api/mcp/test-server/oauth/callback'],
        logo_uri: undefined,
        tos_uri: undefined,
      });

      mockStartAuthorization.mockResolvedValueOnce({
        authorizationUrl: new URL('https://example.com/authorize?client_id=new-client-id'),
        codeVerifier: 'test-code-verifier',
      });

      await MCPOAuthHandler.initiateOAuthFlow(
        'test-server',
        'https://example.com/mcp',
        'user-123',
        {},
        undefined,
        undefined,
        mockFindToken,
      );

      // Should have fallen back to registerClient
      expect(mockRegisterClient).toHaveBeenCalled();
    });

    it('should re-register when stored redirect_uri differs from current configuration', async () => {
      const existingClientInfo = {
        client_id: 'existing-client-id',
        client_secret: 'existing-client-secret',
        redirect_uris: ['http://old-domain.com/api/mcp/test-server/oauth/callback'],
        token_endpoint_auth_method: 'client_secret_basic',
      };

      mockGetClientInfoAndMetadata.mockResolvedValueOnce({
        clientInfo: existingClientInfo,
        clientMetadata: {},
      });

      mockDiscoverOAuthProtectedResourceMetadata.mockRejectedValueOnce(
        new Error('No resource metadata'),
      );

      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
        issuer: 'https://example.com',
        authorization_endpoint: 'https://example.com/authorize',
        token_endpoint: 'https://example.com/token',
        registration_endpoint: 'https://example.com/register',
        response_types_supported: ['code'],
        jwks_uri: 'https://example.com/.well-known/jwks.json',
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      } as AuthorizationServerMetadata);

      mockRegisterClient.mockResolvedValueOnce({
        client_id: 'new-client-id',
        client_secret: 'new-client-secret',
        redirect_uris: ['http://localhost:3080/api/mcp/test-server/oauth/callback'],
        logo_uri: undefined,
        tos_uri: undefined,
      });

      mockStartAuthorization.mockResolvedValueOnce({
        authorizationUrl: new URL('https://example.com/authorize?client_id=new-client-id'),
        codeVerifier: 'test-code-verifier',
      });

      await MCPOAuthHandler.initiateOAuthFlow(
        'test-server',
        'https://example.com/mcp',
        'user-123',
        {},
        undefined,
        undefined,
        mockFindToken,
      );

      expect(mockRegisterClient).toHaveBeenCalled();
      expect(mockStartAuthorization).toHaveBeenCalledWith(
        'https://example.com/mcp',
        expect.objectContaining({
          clientInformation: expect.objectContaining({
            client_id: 'new-client-id',
          }),
        }),
      );
    });

    it('should re-register when stored client has empty redirect_uris', async () => {
      const existingClientInfo = {
        client_id: 'empty-redirect-client',
        client_secret: 'secret',
        redirect_uris: [],
      };

      mockGetClientInfoAndMetadata.mockResolvedValueOnce({
        clientInfo: existingClientInfo,
        clientMetadata: {},
      });

      mockDiscoverOAuthProtectedResourceMetadata.mockRejectedValueOnce(
        new Error('No resource metadata'),
      );

      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
        issuer: 'https://example.com',
        authorization_endpoint: 'https://example.com/authorize',
        token_endpoint: 'https://example.com/token',
        registration_endpoint: 'https://example.com/register',
        response_types_supported: ['code'],
        jwks_uri: 'https://example.com/.well-known/jwks.json',
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      } as AuthorizationServerMetadata);

      mockRegisterClient.mockResolvedValueOnce({
        client_id: 'new-client-id',
        client_secret: 'new-client-secret',
        redirect_uris: ['http://localhost:3080/api/mcp/test-server/oauth/callback'],
        logo_uri: undefined,
        tos_uri: undefined,
      });

      mockStartAuthorization.mockResolvedValueOnce({
        authorizationUrl: new URL('https://example.com/authorize?client_id=new-client-id'),
        codeVerifier: 'test-code-verifier',
      });

      await MCPOAuthHandler.initiateOAuthFlow(
        'test-server',
        'https://example.com/mcp',
        'user-123',
        {},
        undefined,
        undefined,
        mockFindToken,
      );

      expect(mockRegisterClient).toHaveBeenCalled();
      expect(mockStartAuthorization).toHaveBeenCalledWith(
        'https://example.com/mcp',
        expect.objectContaining({
          clientInformation: expect.objectContaining({
            client_id: 'new-client-id',
          }),
        }),
      );
    });
  });

  describe('Fallback OAuth Metadata (Legacy Server Support)', () => {
    const originalFetch = global.fetch;
    const mockFetch = jest.fn();

    beforeEach(() => {
      jest.clearAllMocks();
      global.fetch = mockFetch as unknown as typeof fetch;
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    it('should use fallback metadata when discoverAuthorizationServerMetadata returns undefined', async () => {
      // Mock resource metadata discovery to fail
      mockDiscoverOAuthProtectedResourceMetadata.mockRejectedValueOnce(
        new Error('No resource metadata'),
      );

      // Mock authorization server metadata discovery to return undefined (no .well-known)
      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce(undefined);

      // Mock client registration to succeed
      mockRegisterClient.mockResolvedValueOnce({
        client_id: 'dynamic-client-id',
        client_secret: 'dynamic-client-secret',
        redirect_uris: ['http://localhost:3080/api/mcp/test-server/oauth/callback'],
        logo_uri: undefined,
        tos_uri: undefined,
      });

      // Mock startAuthorization to return a successful response
      mockStartAuthorization.mockResolvedValueOnce({
        authorizationUrl: new URL('https://mcp.example.com/authorize?client_id=dynamic-client-id'),
        codeVerifier: 'test-code-verifier',
      });

      await MCPOAuthHandler.initiateOAuthFlow(
        'test-server',
        'https://mcp.example.com',
        'user-123',
        {},
        undefined,
      );

      // Verify registerClient was called with fallback metadata
      expect(mockRegisterClient).toHaveBeenCalledWith(
        'https://mcp.example.com/',
        expect.objectContaining({
          metadata: expect.objectContaining({
            issuer: 'https://mcp.example.com/',
            authorization_endpoint: 'https://mcp.example.com/authorize',
            token_endpoint: 'https://mcp.example.com/token',
            registration_endpoint: 'https://mcp.example.com/register',
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256', 'plain'],
            token_endpoint_auth_methods_supported: [
              'client_secret_basic',
              'client_secret_post',
              'none',
            ],
          }),
        }),
      );
    });

    it('should throw when metadata discovery fails during refresh (public stored clientInfo)', async () => {
      const metadata = {
        serverName: 'test-server',
        serverUrl: 'https://mcp.example.com',
        clientInfo: {
          client_id: 'test-client-id',
        },
      };

      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce(undefined);

      await expect(
        MCPOAuthHandler.refreshOAuthTokens('test-refresh-token', metadata, {}, {}),
      ).rejects.toThrow('No OAuth metadata discovered for token refresh');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw when metadata lacks token endpoint during refresh', async () => {
      const metadata = {
        serverName: 'test-server',
        serverUrl: 'https://mcp.example.com',
        clientInfo: {
          client_id: 'test-client-id',
        },
      };

      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
        issuer: 'https://auth.example.com/',
        authorization_endpoint: 'https://auth.example.com/authorize',
        response_types_supported: ['code'],
      } as AuthorizationServerMetadata);

      await expect(
        MCPOAuthHandler.refreshOAuthTokens('test-refresh-token', metadata, {}, {}),
      ).rejects.toThrow('No token endpoint found in OAuth metadata');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw for auto-discovered refresh when metadata discovery returns undefined', async () => {
      const metadata = {
        serverName: 'test-server',
        serverUrl: 'https://mcp.example.com',
      };

      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce(undefined);

      await expect(
        MCPOAuthHandler.refreshOAuthTokens('test-refresh-token', metadata, {}, {}),
      ).rejects.toThrow('No OAuth metadata discovered for token refresh');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw for auto-discovered refresh when metadata has no token_endpoint', async () => {
      const metadata = {
        serverName: 'test-server',
        serverUrl: 'https://mcp.example.com',
      };

      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
        issuer: 'https://auth.example.com/',
        authorization_endpoint: 'https://auth.example.com/authorize',
        response_types_supported: ['code'],
      } as AuthorizationServerMetadata);

      await expect(
        MCPOAuthHandler.refreshOAuthTokens('test-refresh-token', metadata, {}, {}),
      ).rejects.toThrow('No token endpoint found in OAuth metadata');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    describe('path-based URL origin fallback', () => {
      it('retries with origin URL when path-based discovery fails (stored clientInfo path)', async () => {
        const metadata = {
          serverName: 'sentry',
          serverUrl: 'https://mcp.sentry.dev/mcp',
          clientInfo: {
            client_id: 'test-client-id',
            grant_types: ['authorization_code', 'refresh_token'],
          },
        };

        const originMetadata = {
          issuer: 'https://mcp.sentry.dev/',
          authorization_endpoint: 'https://mcp.sentry.dev/oauth/authorize',
          token_endpoint: 'https://mcp.sentry.dev/oauth/token',
          token_endpoint_auth_methods_supported: ['client_secret_post'],
          response_types_supported: ['code'],
          jwks_uri: 'https://mcp.sentry.dev/.well-known/jwks.json',
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        } as AuthorizationServerMetadata;

        // First call (path-based URL) fails, second call (origin URL) succeeds
        mockDiscoverAuthorizationServerMetadata
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(originMetadata);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            expires_in: 3600,
          }),
        } as Response);

        const result = await MCPOAuthHandler.refreshOAuthTokens(
          'test-refresh-token',
          metadata,
          {},
          {},
        );

        // Discovery attempted twice: once with path URL, once with origin URL
        expect(mockDiscoverAuthorizationServerMetadata).toHaveBeenCalledTimes(2);
        expect(mockDiscoverAuthorizationServerMetadata).toHaveBeenNthCalledWith(
          1,
          expect.any(URL),
          expect.any(Object),
        );
        expect(mockDiscoverAuthorizationServerMetadata).toHaveBeenNthCalledWith(
          2,
          expect.any(URL),
          expect.any(Object),
        );
        const firstDiscoveryUrl = mockDiscoverAuthorizationServerMetadata.mock.calls[0][0] as URL;
        const secondDiscoveryUrl = mockDiscoverAuthorizationServerMetadata.mock.calls[1][0] as URL;
        expect(firstDiscoveryUrl.href).toBe('https://mcp.sentry.dev/mcp');
        expect(secondDiscoveryUrl.href).toBe('https://mcp.sentry.dev/');

        // Token endpoint from origin discovery metadata is used (string in stored-clientInfo branch)
        expect(mockFetch).toHaveBeenCalled();
        const [fetchUrl, fetchOptions] = mockFetch.mock.calls[0];
        expect(typeof fetchUrl).toBe('string');
        expect(fetchUrl).toBe('https://mcp.sentry.dev/oauth/token');
        expect(fetchOptions).toEqual(expect.objectContaining({ method: 'POST' }));
        expect(result.access_token).toBe('new-access-token');
      });

      it('retries with origin URL when path-based discovery fails (no stored clientInfo)', async () => {
        // No clientInfo — uses the auto-discovered branch
        const metadata = {
          serverName: 'sentry',
          serverUrl: 'https://mcp.sentry.dev/mcp',
        };

        const originMetadata = {
          issuer: 'https://mcp.sentry.dev/',
          authorization_endpoint: 'https://mcp.sentry.dev/oauth/authorize',
          token_endpoint: 'https://mcp.sentry.dev/oauth/token',
          response_types_supported: ['code'],
          jwks_uri: 'https://mcp.sentry.dev/.well-known/jwks.json',
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        } as AuthorizationServerMetadata;

        // First call (path-based URL) fails, second call (origin URL) succeeds
        mockDiscoverAuthorizationServerMetadata
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(originMetadata);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            expires_in: 3600,
          }),
        } as Response);

        const result = await MCPOAuthHandler.refreshOAuthTokens(
          'test-refresh-token',
          metadata,
          {},
          {},
        );

        // Discovery attempted twice: once with path URL, once with origin URL
        expect(mockDiscoverAuthorizationServerMetadata).toHaveBeenCalledTimes(2);
        expect(mockDiscoverAuthorizationServerMetadata).toHaveBeenNthCalledWith(
          1,
          expect.any(URL),
          expect.any(Object),
        );
        expect(mockDiscoverAuthorizationServerMetadata).toHaveBeenNthCalledWith(
          2,
          expect.any(URL),
          expect.any(Object),
        );
        const firstDiscoveryUrl = mockDiscoverAuthorizationServerMetadata.mock.calls[0][0] as URL;
        const secondDiscoveryUrl = mockDiscoverAuthorizationServerMetadata.mock.calls[1][0] as URL;
        expect(firstDiscoveryUrl.href).toBe('https://mcp.sentry.dev/mcp');
        expect(secondDiscoveryUrl.href).toBe('https://mcp.sentry.dev/');

        // Token endpoint from origin discovery metadata is used (URL object in auto-discovered branch)
        expect(mockFetch).toHaveBeenCalled();
        const [fetchUrl, fetchOptions] = mockFetch.mock.calls[0];
        expect(fetchUrl).toBeInstanceOf(URL);
        expect(fetchUrl.toString()).toBe('https://mcp.sentry.dev/oauth/token');
        expect(fetchOptions).toEqual(expect.objectContaining({ method: 'POST' }));
        expect(result.access_token).toBe('new-access-token');
      });

      it('throws when both path and origin discovery return undefined', async () => {
        const metadata = {
          serverName: 'sentry',
          serverUrl: 'https://mcp.sentry.dev/mcp',
          clientInfo: {
            client_id: 'test-client-id',
            grant_types: ['authorization_code', 'refresh_token'],
          },
        };

        mockDiscoverAuthorizationServerMetadata
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(undefined);

        await expect(
          MCPOAuthHandler.refreshOAuthTokens('test-refresh-token', metadata, {}, {}),
        ).rejects.toThrow('No OAuth metadata discovered for token refresh');

        expect(mockDiscoverAuthorizationServerMetadata).toHaveBeenCalledTimes(2);
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('throws when root URL discovery returns undefined (no path retry)', async () => {
        const metadata = {
          serverName: 'test-server',
          serverUrl: 'https://auth.example.com/',
          clientInfo: {
            client_id: 'test-client-id',
          },
        };

        mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce(undefined);

        await expect(
          MCPOAuthHandler.refreshOAuthTokens('test-refresh-token', metadata, {}, {}),
        ).rejects.toThrow('No OAuth metadata discovered for token refresh');

        expect(mockDiscoverAuthorizationServerMetadata).toHaveBeenCalledTimes(1);
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('retries with origin when path-based discovery throws', async () => {
        const metadata = {
          serverName: 'sentry',
          serverUrl: 'https://mcp.sentry.dev/mcp',
          clientInfo: {
            client_id: 'test-client-id',
            grant_types: ['authorization_code', 'refresh_token'],
          },
        };

        const originMetadata = {
          issuer: 'https://mcp.sentry.dev/',
          authorization_endpoint: 'https://mcp.sentry.dev/oauth/authorize',
          token_endpoint: 'https://mcp.sentry.dev/oauth/token',
          token_endpoint_auth_methods_supported: ['client_secret_post'],
          response_types_supported: ['code'],
        } as AuthorizationServerMetadata;

        // First call throws, second call succeeds
        mockDiscoverAuthorizationServerMetadata
          .mockRejectedValueOnce(new Error('Network error'))
          .mockResolvedValueOnce(originMetadata);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            expires_in: 3600,
          }),
        } as Response);

        const result = await MCPOAuthHandler.refreshOAuthTokens(
          'test-refresh-token',
          metadata,
          {},
          {},
        );

        expect(mockDiscoverAuthorizationServerMetadata).toHaveBeenCalledTimes(2);
        const [fetchUrl] = mockFetch.mock.calls[0];
        expect(String(fetchUrl)).toBe('https://mcp.sentry.dev/oauth/token');
        expect(result.access_token).toBe('new-access-token');
      });

      it('propagates the throw when root URL discovery throws', async () => {
        const metadata = {
          serverName: 'test-server',
          serverUrl: 'https://auth.example.com/',
          clientInfo: {
            client_id: 'test-client-id',
          },
        };

        mockDiscoverAuthorizationServerMetadata.mockRejectedValueOnce(
          new Error('Discovery failed'),
        );

        await expect(
          MCPOAuthHandler.refreshOAuthTokens('test-refresh-token', metadata, {}, {}),
        ).rejects.toThrow('Discovery failed');

        expect(mockDiscoverAuthorizationServerMetadata).toHaveBeenCalledTimes(1);
      });

      it('propagates the throw when both path and origin discovery throw', async () => {
        const metadata = {
          serverName: 'sentry',
          serverUrl: 'https://mcp.sentry.dev/mcp',
          clientInfo: {
            client_id: 'test-client-id',
          },
        };

        mockDiscoverAuthorizationServerMetadata
          .mockRejectedValueOnce(new Error('Network error'))
          .mockRejectedValueOnce(new Error('Origin also failed'));

        await expect(
          MCPOAuthHandler.refreshOAuthTokens('test-refresh-token', metadata, {}, {}),
        ).rejects.toThrow('Origin also failed');

        expect(mockDiscoverAuthorizationServerMetadata).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Protected Resource Metadata validation (RFC 9728 / GHSA-gvpj-vm2f-2m23)', () => {
    const originalFetch = global.fetch;
    const mockFetch = jest.fn();

    beforeEach(() => {
      jest.clearAllMocks();
      global.fetch = mockFetch as unknown as typeof fetch;
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    it('rejects metadata whose resource points at a different origin than the configured server', async () => {
      mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
        // attacker's server pretends to be real-mcp.com so tokens minted by real-mcp's
        // auth server get sent to the attacker
        resource: 'https://real-mcp.com/mcp',
        authorization_servers: ['https://auth.real-mcp.com'],
      });

      await expect(
        MCPOAuthHandler.initiateOAuthFlow(
          'evil-server',
          'https://fake-mcp.com/mcp',
          'user-123',
          {},
          undefined,
        ),
      ).rejects.toThrow(/does not match server URL/);

      // authorization_servers from the tainted document must never be consulted
      expect(mockDiscoverAuthorizationServerMetadata).not.toHaveBeenCalled();
      expect(mockStartAuthorization).not.toHaveBeenCalled();
      expect(mockRegisterClient).not.toHaveBeenCalled();
    });

    it('rejects metadata whose resource is not a parseable URL (error-wrapping path)', async () => {
      // A malicious or broken server could return a `resource` that passes the
      // zod schema but is not a valid URL. `resourceUrlFromServerUrl` /
      // `checkResourceAllowed` call `new URL()` internally and will throw;
      // `assertResourceBoundToServer` wraps that into a descriptive error rather
      // than letting a raw `TypeError: Invalid URL` leak out.
      mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
        resource: 'not-a-url',
        authorization_servers: ['https://auth.example.com'],
      });

      await expect(
        MCPOAuthHandler.initiateOAuthFlow(
          'test-server',
          'https://example.com/mcp',
          'user-123',
          {},
          undefined,
        ),
      ).rejects.toThrow(/Unable to validate Protected Resource Metadata 'resource'/);

      expect(mockDiscoverAuthorizationServerMetadata).not.toHaveBeenCalled();
      expect(mockStartAuthorization).not.toHaveBeenCalled();
    });

    it('rejects metadata that is missing the required resource identifier', async () => {
      mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
        // RFC 9728 §2: `resource` is REQUIRED
        authorization_servers: ['https://auth.example.com'],
      } as unknown as Awaited<ReturnType<typeof discoverOAuthProtectedResourceMetadata>>);

      await expect(
        MCPOAuthHandler.initiateOAuthFlow(
          'test-server',
          'https://example.com/mcp',
          'user-123',
          {},
          undefined,
        ),
      ).rejects.toThrow(/missing the required 'resource' identifier/);

      expect(mockDiscoverAuthorizationServerMetadata).not.toHaveBeenCalled();
    });

    it('rejects metadata whose resource points at the same origin but a sibling path', async () => {
      // Same-origin path-confusion: checkResourceAllowed enforces path-prefix match, so
      // a server at /api can't claim tokens for /admin on the same origin.
      mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
        resource: 'https://example.com/admin',
        authorization_servers: ['https://auth.example.com'],
      });

      await expect(
        MCPOAuthHandler.initiateOAuthFlow(
          'test-server',
          'https://example.com/api',
          'user-123',
          {},
          undefined,
        ),
      ).rejects.toThrow(/does not match server URL/);
    });

    it('accepts metadata whose resource exactly matches the server URL', async () => {
      mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
        resource: 'https://example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
      });

      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        registration_endpoint: 'https://auth.example.com/register',
        response_types_supported: ['code'],
      } as AuthorizationServerMetadata);

      mockRegisterClient.mockResolvedValueOnce({
        client_id: 'new-client-id',
        redirect_uris: ['http://localhost:3080/api/mcp/test-server/oauth/callback'],
        logo_uri: undefined,
        tos_uri: undefined,
      });

      mockStartAuthorization.mockResolvedValueOnce({
        authorizationUrl: new URL('https://auth.example.com/authorize?client_id=new-client-id'),
        codeVerifier: 'test-code-verifier',
      });

      const result = await MCPOAuthHandler.initiateOAuthFlow(
        'test-server',
        'https://example.com/mcp',
        'user-123',
        {},
        undefined,
      );

      expect(result.authorizationUrl).toContain('resource=https%3A%2F%2Fexample.com%2Fmcp');
    });

    it('accepts metadata whose resource is an origin-level prefix of the server URL', async () => {
      // Some RFC 9728 implementations advertise the origin as `resource` for a
      // sub-path MCP server; checkResourceAllowed permits this (path-prefix match).
      mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
        resource: 'https://example.com',
        authorization_servers: ['https://auth.example.com'],
      });

      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        registration_endpoint: 'https://auth.example.com/register',
        response_types_supported: ['code'],
      } as AuthorizationServerMetadata);

      mockRegisterClient.mockResolvedValueOnce({
        client_id: 'client-id',
        redirect_uris: ['http://localhost:3080/api/mcp/test-server/oauth/callback'],
        logo_uri: undefined,
        tos_uri: undefined,
      });

      mockStartAuthorization.mockResolvedValueOnce({
        authorizationUrl: new URL('https://auth.example.com/authorize?client_id=client-id'),
        codeVerifier: 'test-code-verifier',
      });

      await expect(
        MCPOAuthHandler.initiateOAuthFlow(
          'test-server',
          'https://example.com/mcp',
          'user-123',
          {},
          undefined,
        ),
      ).resolves.toBeDefined();
    });

    it('re-validates resource binding at token exchange for flows initiated before the fix', async () => {
      // Defense-in-depth: flow state has a 10-min TTL, so a flow created under older
      // (vulnerable) code could still be in-flight at upgrade time with unvalidated
      // resourceMetadata stored. completeOAuthFlow must re-assert the binding rather
      // than blindly trusting stored state — and must still run the normal failure
      // bookkeeping so the observed flow attempt doesn't leak a stuck PENDING entry.
      const mockFailFlow = jest.fn();
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: 123,
          metadata: {
            serverName: 'evil-server',
            userId: 'user-123',
            serverUrl: 'https://fake-mcp.com/mcp',
            state: 'abc',
            codeVerifier: 'verifier',
            clientInfo: { client_id: 'cid' },
            metadata: { authorization_endpoint: 'x', token_endpoint: 'y' },
            resourceMetadata: {
              // tainted: stored during a pre-fix initiateOAuthFlow
              resource: 'https://real-mcp.com/mcp',
              authorization_servers: ['https://auth.real-mcp.com'],
            },
          } as MCPOAuthFlowMetadata,
        }),
        failFlowIfCurrent: mockFailFlow,
      } as unknown as FlowStateManager<MCPOAuthTokens>;

      await expect(
        MCPOAuthHandler.completeOAuthFlow('flow-id', 'auth-code', mockFlowManager, {}),
      ).rejects.toThrow(/does not match server URL/);

      expect(mockExchangeAuthorization).not.toHaveBeenCalled();
      expect(mockFailFlow).toHaveBeenCalledWith(
        'flow-id',
        expect.any(String),
        123,
        'abc',
        expect.any(Error),
      );
    });

    /**
     * The `authorization_code` exchange must carry the same parameters as the
     * `/authorize` request that produced the code, so the decision travels on flow
     * metadata rather than being re-read from live config. Validation is unaffected:
     * `assertResourceBoundToServer` runs on both paths before the exchange.
     */
    const exchangeFlowState = (sendResourceParameter?: boolean): FlowStateManager<MCPOAuthTokens> =>
      ({
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: 123,
          metadata: {
            serverName: 'entra-server',
            userId: 'user-123',
            serverUrl: 'https://example.com/mcp',
            state: 'abc',
            codeVerifier: 'verifier',
            clientInfo: { client_id: 'cid' },
            metadata: {
              authorization_endpoint: 'https://login.microsoftonline.test/authorize',
              token_endpoint: 'https://login.microsoftonline.test/token',
            },
            resourceMetadata: { resource: 'https://example.com/mcp' },
            ...(sendResourceParameter !== undefined && { sendResourceParameter }),
          } as MCPOAuthFlowMetadata,
        }),
        completeFlowIfCurrent: jest.fn().mockResolvedValue('updated'),
      }) as unknown as FlowStateManager<MCPOAuthTokens>;

    it('omits resource at token exchange when the flow opted out of the parameter', async () => {
      mockExchangeAuthorization.mockResolvedValue({
        access_token: 'access-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });

      await MCPOAuthHandler.completeOAuthFlow('flow-id', 'auth-code', exchangeFlowState(false), {});

      expect(mockExchangeAuthorization).toHaveBeenCalledTimes(1);
      expect(mockExchangeAuthorization.mock.calls[0][1].resource).toBeUndefined();
    });

    it('strips an inherited resource from the token endpoint at exchange when opted out', async () => {
      // The SDK builds the token request from `token_endpoint` verbatim, so a `resource`
      // left in the configured `token_url` would survive the opt-out.
      mockExchangeAuthorization.mockResolvedValue({
        access_token: 'access-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
      const flowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: 123,
          metadata: {
            serverName: 'entra-server',
            userId: 'user-123',
            serverUrl: 'https://example.com/mcp',
            state: 'abc',
            codeVerifier: 'verifier',
            clientInfo: { client_id: 'cid' },
            metadata: {
              authorization_endpoint: 'https://login.microsoftonline.test/authorize',
              token_endpoint:
                'https://login.microsoftonline.test/token?resource=https%3A%2F%2Fstale.example.test%2Fmcp&foo=bar',
            },
            resourceMetadata: { resource: 'https://example.com/mcp' },
            sendResourceParameter: false,
          } as MCPOAuthFlowMetadata,
        }),
        completeFlowIfCurrent: jest.fn().mockResolvedValue('updated'),
      } as unknown as FlowStateManager<MCPOAuthTokens>;

      await MCPOAuthHandler.completeOAuthFlow('flow-id', 'auth-code', flowManager, {});

      const exchangedTokenEndpoint = mockExchangeAuthorization.mock.calls[0][1].metadata
        ?.token_endpoint as string | undefined;
      expect(exchangedTokenEndpoint).toBeDefined();
      const tokenEndpoint = new URL(exchangedTokenEndpoint as string);
      expect(tokenEndpoint.searchParams.has('resource')).toBe(false);
      expect(tokenEndpoint.searchParams.get('foo')).toBe('bar');
      expect(mockExchangeAuthorization.mock.calls[0][1].resource).toBeUndefined();
    });

    it('sends resource at token exchange for flows initiated before the opt-out existed', async () => {
      // Mixed-version upgrade: flow state has a bounded TTL, so a flow started under
      // older code carries no flag and must keep the previous behavior.
      mockExchangeAuthorization.mockResolvedValue({
        access_token: 'access-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });

      await MCPOAuthHandler.completeOAuthFlow(
        'flow-id',
        'auth-code',
        exchangeFlowState(undefined),
        {},
      );

      expect(mockExchangeAuthorization).toHaveBeenCalledTimes(1);
      expect(mockExchangeAuthorization.mock.calls[0][1].resource?.href).toBe(
        'https://example.com/mcp',
      );
    });

    it('falls back to origin-based discovery when the well-known endpoint returns no metadata', async () => {
      // A missing/404 PRM doc is different from a spoofed one: the SDK throws, we
      // catch it, and proceed to discover the auth server from the MCP server URL.
      // This path must NOT trip the new validation.
      mockDiscoverOAuthProtectedResourceMetadata.mockRejectedValueOnce(
        new Error('Resource server does not implement OAuth 2.0 Protected Resource Metadata.'),
      );

      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
        issuer: 'https://example.com',
        authorization_endpoint: 'https://example.com/authorize',
        token_endpoint: 'https://example.com/token',
        registration_endpoint: 'https://example.com/register',
        response_types_supported: ['code'],
      } as AuthorizationServerMetadata);

      mockRegisterClient.mockResolvedValueOnce({
        client_id: 'client-id',
        redirect_uris: ['http://localhost:3080/api/mcp/test-server/oauth/callback'],
        logo_uri: undefined,
        tos_uri: undefined,
      });

      mockStartAuthorization.mockResolvedValueOnce({
        authorizationUrl: new URL('https://example.com/authorize?client_id=client-id'),
        codeVerifier: 'test-code-verifier',
      });

      const result = await MCPOAuthHandler.initiateOAuthFlow(
        'test-server',
        'https://example.com/mcp',
        'user-123',
        {},
        undefined,
      );

      expect(result.authorizationUrl).toBeDefined();
      // No PRM, so the authorization URL must not carry a `resource` parameter
      expect(result.authorizationUrl).not.toContain('resource=');
    });
  });

  describe('WWW-Authenticate resource_metadata hint (RFC 9728 §5.1 / issue #12761)', () => {
    const serverUrl = 'https://example.com/mcp';
    const hintUrl = 'https://example.com/.well-known/oauth-protected-resource';

    beforeEach(() => {
      // Default the probe to "no hint" so earlier suites that don't set it aren't affected.
      mockProbeResourceMetadataHint.mockResolvedValue(null);
    });

    it('threads the hint URL into discoverOAuthProtectedResourceMetadata when present', async () => {
      mockProbeResourceMetadataHint.mockResolvedValueOnce({
        resourceMetadataUrl: new URL(hintUrl),
        bearerChallenge: true,
        headAuthChallenge: true,
      });

      mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
        resource: serverUrl,
        authorization_servers: ['https://auth.example.com'],
      });

      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        registration_endpoint: 'https://auth.example.com/register',
        response_types_supported: ['code'],
      } as AuthorizationServerMetadata);

      mockRegisterClient.mockResolvedValueOnce({
        client_id: 'new-client-id',
        redirect_uris: ['http://localhost:3080/api/mcp/test-server/oauth/callback'],
        logo_uri: undefined,
        tos_uri: undefined,
      });

      mockStartAuthorization.mockResolvedValueOnce({
        authorizationUrl: new URL('https://auth.example.com/authorize?client_id=new-client-id'),
        codeVerifier: 'test-code-verifier',
      });

      await MCPOAuthHandler.initiateOAuthFlow('test-server', serverUrl, 'user-123', {}, undefined);

      expect(mockDiscoverOAuthProtectedResourceMetadata).toHaveBeenCalledTimes(1);
      expect(mockDiscoverOAuthProtectedResourceMetadata).toHaveBeenCalledWith(
        serverUrl,
        expect.objectContaining({ resourceMetadataUrl: new URL(hintUrl) }),
        expect.any(Function),
      );
    });

    it('passes undefined resourceMetadataUrl when no hint is available', async () => {
      mockProbeResourceMetadataHint.mockResolvedValueOnce(null);

      mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
        resource: serverUrl,
        authorization_servers: ['https://auth.example.com'],
      });

      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        registration_endpoint: 'https://auth.example.com/register',
        response_types_supported: ['code'],
      } as AuthorizationServerMetadata);

      mockRegisterClient.mockResolvedValueOnce({
        client_id: 'new-client-id',
        redirect_uris: ['http://localhost:3080/api/mcp/test-server/oauth/callback'],
        logo_uri: undefined,
        tos_uri: undefined,
      });

      mockStartAuthorization.mockResolvedValueOnce({
        authorizationUrl: new URL('https://auth.example.com/authorize?client_id=new-client-id'),
        codeVerifier: 'test-code-verifier',
      });

      await MCPOAuthHandler.initiateOAuthFlow('test-server', serverUrl, 'user-123', {}, undefined);

      expect(mockDiscoverOAuthProtectedResourceMetadata).toHaveBeenCalledWith(
        serverUrl,
        expect.objectContaining({ resourceMetadataUrl: undefined }),
        expect.any(Function),
      );
    });

    it('prefers the hint over path-aware metadata when they diverge', async () => {
      // The regression scenario from issue #12761: path-aware discovery would return
      // stale metadata pointing at a defunct authorization server. The hint URL must
      // take precedence so the SDK fetches the authoritative document instead.
      mockProbeResourceMetadataHint.mockResolvedValueOnce({
        resourceMetadataUrl: new URL(hintUrl),
        bearerChallenge: true,
        headAuthChallenge: true,
      });

      // Whatever the hint URL returns is what reaches the handler — stale path-aware
      // data never gets a chance to be used, because the SDK follows the hint instead.
      mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
        resource: serverUrl,
        authorization_servers: ['https://auth.example.com'],
      });

      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        registration_endpoint: 'https://auth.example.com/register',
        response_types_supported: ['code'],
      } as AuthorizationServerMetadata);

      mockRegisterClient.mockResolvedValueOnce({
        client_id: 'new-client-id',
        redirect_uris: ['http://localhost:3080/api/mcp/test-server/oauth/callback'],
        logo_uri: undefined,
        tos_uri: undefined,
      });

      mockStartAuthorization.mockResolvedValueOnce({
        authorizationUrl: new URL('https://auth.example.com/authorize?client_id=new-client-id'),
        codeVerifier: 'test-code-verifier',
      });

      const result = await MCPOAuthHandler.initiateOAuthFlow(
        'test-server',
        serverUrl,
        'user-123',
        {},
        undefined,
      );

      expect(result.authorizationUrl).toContain('auth.example.com');
      // Exactly one SDK call — no separate path-aware retry.
      expect(mockDiscoverOAuthProtectedResourceMetadata).toHaveBeenCalledTimes(1);
    });

    it('invokes the probe with the OAuth-aware fetch so oauthHeaders reach the server', async () => {
      // Regression guard: without the wrapper, admin-configured `oauthHeaders` (e.g. a
      // gateway API key that fronts the MCP endpoint) would be stripped from the probe,
      // causing the gateway to 401 us for the wrong reason and masking the real hint.
      mockProbeResourceMetadataHint.mockResolvedValueOnce(null);

      mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
        resource: serverUrl,
        authorization_servers: ['https://auth.example.com'],
      });

      mockDiscoverAuthorizationServerMetadata.mockResolvedValueOnce({
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        registration_endpoint: 'https://auth.example.com/register',
        response_types_supported: ['code'],
      } as AuthorizationServerMetadata);

      mockRegisterClient.mockResolvedValueOnce({
        client_id: 'new-client-id',
        redirect_uris: ['http://localhost:3080/api/mcp/test-server/oauth/callback'],
        logo_uri: undefined,
        tos_uri: undefined,
      });

      mockStartAuthorization.mockResolvedValueOnce({
        authorizationUrl: new URL('https://auth.example.com/authorize?client_id=new-client-id'),
        codeVerifier: 'test-code-verifier',
      });

      await MCPOAuthHandler.initiateOAuthFlow(
        'test-server',
        serverUrl,
        'user-123',
        { 'X-Gateway-Key': 'secret' },
        undefined,
      );

      expect(mockProbeResourceMetadataHint).toHaveBeenCalledTimes(1);
      // Second argument must be a fetchFn (the OAuth-aware wrapper), not `undefined`.
      const fetchFnArg = mockProbeResourceMetadataHint.mock.calls[0][1];
      expect(typeof fetchFnArg).toBe('function');
    });
  });
});
