/**
 * Coverage for the `scope` parameter fallback on the OAuth refresh_token grant
 * (support case 00046259 — Salesforce).
 *
 * LibreChat sends `scope` on refresh by default because some authorization servers
 * expect it (added in the original MCP OAuth support, PR #7924). Salesforce, however,
 * rejects any `scope` on the refresh grant with HTTP 400 "scope parameter not
 * supported", which broke token refresh in production and forced re-authentication
 * (amplifying the multi-replica PKCE retry storm). RFC 6749 §6 makes `scope` optional
 * on refresh, so the handler now retries once without it — only when the server
 * rejected the request because of that parameter.
 *
 * Mirrors handler.test.ts: SDK discovery is mocked and global.fetch is stubbed
 * (the public hostname still resolves through the real SSRF gate). Request bodies are
 * snapshotted at call time because the fallback reuses (and mutates) one URLSearchParams.
 */

import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { MCPOAuthHandler } from '~/mcp/oauth';

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  startAuthorization: jest.fn(),
  discoverAuthorizationServerMetadata: jest.fn(),
  discoverOAuthProtectedResourceMetadata: jest.fn(),
  registerClient: jest.fn(),
  exchangeAuthorization: jest.fn(),
  extractWWWAuthenticateParams: jest.fn(() => ({})),
}));

import { discoverAuthorizationServerMetadata } from '@modelcontextprotocol/sdk/client/auth.js';

const mockDiscover = discoverAuthorizationServerMetadata as jest.MockedFunction<
  typeof discoverAuthorizationServerMetadata
>;

describe('MCPOAuthHandler.refreshOAuthTokens — scope parameter fallback', () => {
  const refreshToken = 'refresh-token-abc';
  const originalFetch = global.fetch;
  const mockFetch = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;

  /** Bodies captured at the moment each request is sent (the fallback mutates one URLSearchParams). */
  const sentBodies: string[] = [];
  let responseQueue: Response[] = [];

  const metadata = {
    serverName: 'salesforce',
    serverUrl: 'https://auth.example.com',
    clientInfo: {
      client_id: 'client-abc',
      scope: 'refresh_token mcp_api',
    },
  };

  const discovered = {
    issuer: 'https://auth.example.com',
    authorization_endpoint: 'https://auth.example.com/oauth/authorize',
    token_endpoint: 'https://auth.example.com/oauth/token',
    token_endpoint_auth_methods_supported: ['none'],
    response_types_supported: ['code'],
  } as AuthorizationServerMetadata;

  const scopeRejection = {
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    text: async () =>
      '{"error":"invalid_request","error_description":"scope parameter not supported"}',
  } as Response;

  const success = {
    ok: true,
    json: async () => ({
      access_token: 'fresh-access',
      refresh_token: 'fresh-refresh',
      token_type: 'Bearer',
    }),
  } as Response;

  beforeEach(() => {
    jest.clearAllMocks();
    sentBodies.length = 0;
    responseQueue = [];
    global.fetch = mockFetch;
    mockDiscover.mockResolvedValue(discovered);
    mockFetch.mockImplementation((async (_url: unknown, init?: { body?: unknown }) => {
      sentBodies.push(String(init?.body ?? ''));
      const next = responseQueue.shift();
      if (!next) {
        throw new Error('No queued response for fetch call');
      }
      return next;
    }) as unknown as typeof fetch);
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it.each([408, 429, 500, 502, 503, 504])(
    'keeps HTTP %i retryable without reading or logging misleading scope/client errors',
    async (status) => {
      const cancel = jest.fn().mockResolvedValue(undefined);
      const text = jest.fn(async () => 'invalid_client invalid_grant invalid_scope not supported');
      responseQueue = [{ status, ok: false, text, body: { cancel } } as unknown as Response];
      await expect(
        MCPOAuthHandler.refreshOAuthTokens(refreshToken, metadata, {}, {}),
      ).rejects.toMatchObject({
        name: 'MCPTokenRefreshUnavailableError',
        cause: { message: `Token refresh temporarily unavailable (HTTP ${status})` },
      });
      expect(sentBodies).toHaveLength(1);
      expect(text).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps an outage after the scope fallback retryable', async () => {
    responseQueue = [scopeRejection, new Response('{"error":"invalid_client"}', { status: 503 })];
    await expect(
      MCPOAuthHandler.refreshOAuthTokens(refreshToken, metadata, {}, {}),
    ).rejects.toMatchObject({ name: 'MCPTokenRefreshUnavailableError' });
    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[1]).not.toContain('scope=');
  });

  it('keeps an outage retryable even when cancelling its response stream fails', async () => {
    responseQueue = [
      {
        status: 503,
        body: {
          cancel: async () => {
            throw new Error('invalid_client');
          },
        },
      } as unknown as Response,
    ];
    await expect(
      MCPOAuthHandler.refreshOAuthTokens(refreshToken, metadata, {}, {}),
    ).rejects.toMatchObject({ name: 'MCPTokenRefreshUnavailableError' });
  });

  it.each(['configured', 'discovered'] as const)(
    'preserves outage status in the %s refresh path',
    async (mode) => {
      responseQueue = [new Response('{"error":"invalid_grant"}', { status: 503 })];
      await expect(
        MCPOAuthHandler.refreshOAuthTokens(
          refreshToken,
          { serverName: metadata.serverName, serverUrl: metadata.serverUrl },
          {},
          mode === 'configured'
            ? {
                token_url: discovered.token_endpoint,
                client_id: 'configured-client',
                scope: 'read',
              }
            : {},
        ),
      ).rejects.toMatchObject({ name: 'MCPTokenRefreshUnavailableError' });
      expect(sentBodies).toHaveLength(1);
    },
  );

  it('retries without scope when the server rejects the scope parameter, then succeeds', async () => {
    responseQueue = [scopeRejection, success];

    const result = await MCPOAuthHandler.refreshOAuthTokens(refreshToken, metadata, {}, {});

    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[0]).toContain('scope=');
    expect(sentBodies[1]).not.toContain('scope=');
    expect(sentBodies[1]).toContain('grant_type=refresh_token');
    expect(result.access_token).toBe('fresh-access');
  });

  it('does NOT retry and surfaces the error when the failure is unrelated to scope', async () => {
    responseQueue = [
      {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => '{"error":"invalid_grant","error_description":"expired refresh token"}',
      } as Response,
    ];

    await expect(
      MCPOAuthHandler.refreshOAuthTokens(refreshToken, metadata, {}, {}),
    ).rejects.toThrow(/invalid_grant|Token refresh failed/);
    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0]).toContain('scope=');
  });

  it('makes a single request (no scope, no retry) when no scope is configured', async () => {
    const noScope = { ...metadata, clientInfo: { client_id: 'client-abc' } };
    responseQueue = [success];

    await MCPOAuthHandler.refreshOAuthTokens(refreshToken, noScope, {}, {});

    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0]).not.toContain('scope=');
  });
});
