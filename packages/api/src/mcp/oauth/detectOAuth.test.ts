import { discoverOAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/client/auth.js';
import { isSSRFTarget, resolveHostnameSSRF } from '~/auth';
import { detectOAuthRequirement } from './detectOAuth';

jest.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  ...jest.requireActual('@modelcontextprotocol/sdk/client/auth.js'),
  discoverOAuthProtectedResourceMetadata: jest.fn(),
}));

jest.mock('~/auth', () => ({
  createSSRFSafeUndiciConnect: jest.fn(() => ({ lookup: jest.fn() })),
  isOAuthUrlAllowed: jest.fn(() => false),
  isSSRFTarget: jest.fn(() => false),
  resolveHostnameSSRF: jest.fn(async () => false),
}));

/**
 * Disable the `MCP_OAUTH_ON_AUTH_ERROR` fallback by default so tests assert on the
 * precise detection outcome without the "any 401/403 = OAuth" safety net rewriting
 * the result. The fallback is exercised directly in its own describe block.
 */
jest.mock('../mcpConfig', () => ({
  mcpConfig: {
    OAUTH_ON_AUTH_ERROR: false,
    OAUTH_DETECTION_TIMEOUT: 5000,
  },
}));

const mockDiscoverOAuthProtectedResourceMetadata =
  discoverOAuthProtectedResourceMetadata as jest.MockedFunction<
    typeof discoverOAuthProtectedResourceMetadata
  >;
const mockIsSSRFTarget = isSSRFTarget as jest.MockedFunction<typeof isSSRFTarget>;
const mockResolveHostnameSSRF = resolveHostnameSSRF as jest.MockedFunction<
  typeof resolveHostnameSSRF
>;

describe('detectOAuthRequirement', () => {
  const originalFetch = global.fetch;
  const mockFetch = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = mockFetch;
    // Default: path-aware / hint discovery returns no metadata unless a test overrides.
    mockDiscoverOAuthProtectedResourceMetadata.mockRejectedValue(
      new Error('No protected resource metadata'),
    );
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('POST fallback when HEAD fails', () => {
    it('tries POST when HEAD returns 405 Method Not Allowed', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 405,
        headers: new Headers(),
      } as Response);

      mockFetch.mockResolvedValueOnce({
        status: 401,
        headers: new Headers({ 'www-authenticate': 'Bearer' }),
      } as Response);

      const result = await detectOAuthRequirement('https://mcp.example.com');

      expect(result.requiresOAuth).toBe(true);
      expect(result.method).toBe('401-challenge-metadata');
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'HEAD' }));
      expect(mockFetch.mock.calls[1][1]).toEqual(
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      );
    });

    it('tries POST when HEAD returns non-401 status', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
      } as Response);

      mockFetch.mockResolvedValueOnce({
        status: 401,
        headers: new Headers({ 'www-authenticate': 'Bearer' }),
      } as Response);

      const result = await detectOAuthRequirement('https://mcp.example.com');

      expect(result.requiresOAuth).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('short-circuits POST when HEAD already delivers the resource_metadata hint', async () => {
      // Only `resource_metadata` on HEAD is strong enough to skip POST — Bearer-only
      // still lets POST run in case the server surfaces its hint only on POST.
      const hintUrl = 'https://example.com/.well-known/oauth-protected-resource';
      mockFetch.mockResolvedValueOnce({
        status: 401,
        headers: new Headers({
          'www-authenticate': `Bearer resource_metadata="${hintUrl}"`,
        }),
      } as Response);

      mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
        resource: 'https://mcp.example.com',
        authorization_servers: ['https://auth.example.com'],
      });

      const result = await detectOAuthRequirement('https://mcp.example.com');

      expect(result.requiresOAuth).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('probes POST even when HEAD returns Bearer without a hint', async () => {
      mockFetch
        .mockResolvedValueOnce({
          status: 401,
          headers: new Headers({ 'www-authenticate': 'Bearer' }),
        } as Response)
        .mockResolvedValueOnce({
          status: 401,
          headers: new Headers({ 'www-authenticate': 'Bearer' }),
        } as Response);

      const result = await detectOAuthRequirement('https://mcp.example.com');

      expect(result.requiresOAuth).toBe(true);
      expect(result.method).toBe('401-challenge-metadata');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('Bearer detection without resource_metadata URL', () => {
    it('detects OAuth when 401 has WWW-Authenticate: Bearer (case insensitive)', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 401,
        headers: new Headers({ 'www-authenticate': 'bearer' }),
      } as Response);

      const result = await detectOAuthRequirement('https://mcp.example.com');

      expect(result.requiresOAuth).toBe(true);
      expect(result.method).toBe('401-challenge-metadata');
      expect(result.metadata).toBeNull();
    });

    it('detects OAuth when 401 has WWW-Authenticate: BEARER (uppercase)', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 401,
        headers: new Headers({ 'www-authenticate': 'BEARER' }),
      } as Response);

      const result = await detectOAuthRequirement('https://mcp.example.com');

      expect(result.requiresOAuth).toBe(true);
      expect(result.method).toBe('401-challenge-metadata');
    });

    it('detects OAuth when Bearer is part of a larger header value', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 401,
        headers: new Headers({ 'www-authenticate': 'Bearer realm="api"' }),
      } as Response);

      const result = await detectOAuthRequirement('https://mcp.example.com');

      expect(result.requiresOAuth).toBe(true);
    });

    it('does not detect OAuth when 401 has no WWW-Authenticate header', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 401,
        headers: new Headers(),
      } as Response);
      mockFetch.mockResolvedValueOnce({
        status: 401,
        headers: new Headers(),
      } as Response);

      const result = await detectOAuthRequirement('https://mcp.example.com');

      expect(result.requiresOAuth).toBe(false);
      expect(result.method).toBe('no-metadata-found');
    });

    it('does not detect OAuth when 401 has non-Bearer auth scheme', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 401,
        headers: new Headers({ 'www-authenticate': 'Basic realm="api"' }),
      } as Response);
      mockFetch.mockResolvedValueOnce({
        status: 401,
        headers: new Headers({ 'www-authenticate': 'Basic realm="api"' }),
      } as Response);

      const result = await detectOAuthRequirement('https://mcp.example.com');

      expect(result.requiresOAuth).toBe(false);
    });
  });

  describe('resource_metadata URL in WWW-Authenticate', () => {
    it('passes the WWW-Authenticate hint URL to the SDK and returns its metadata', async () => {
      const metadataUrl = 'https://auth.example.com/.well-known/oauth-protected-resource';

      mockFetch.mockResolvedValueOnce({
        status: 401,
        headers: new Headers({
          'www-authenticate': `Bearer resource_metadata="${metadataUrl}"`,
        }),
      } as Response);

      mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
        resource: 'https://mcp.example.com',
        authorization_servers: ['https://auth.example.com'],
      });

      const result = await detectOAuthRequirement('https://mcp.example.com');

      expect(result.requiresOAuth).toBe(true);
      expect(result.method).toBe('401-challenge-metadata');
      expect(result.metadata).toMatchObject({
        authorization_servers: ['https://auth.example.com'],
      });

      // The SDK must be called with the hint so that it fetches the authoritative URL
      // instead of the path-aware `/.well-known/oauth-protected-resource/<path>` variant.
      expect(mockDiscoverOAuthProtectedResourceMetadata).toHaveBeenCalledWith(
        'https://mcp.example.com',
        expect.objectContaining({ resourceMetadataUrl: new URL(metadataUrl) }),
        expect.any(Function),
      );
    });

    it('falls back to Bearer-only detection when hinted metadata fetch fails', async () => {
      const metadataUrl = 'https://auth.example.com/.well-known/oauth-protected-resource';

      mockFetch.mockResolvedValueOnce({
        status: 401,
        headers: new Headers({
          'www-authenticate': `Bearer resource_metadata="${metadataUrl}"`,
        }),
      } as Response);

      // Hinted discovery throws (e.g. 404 at the hinted URL).
      mockDiscoverOAuthProtectedResourceMetadata.mockRejectedValueOnce(
        new Error('Resource server does not implement OAuth 2.0 Protected Resource Metadata.'),
      );

      const result = await detectOAuthRequirement('https://mcp.example.com');

      expect(result.requiresOAuth).toBe(true);
      expect(result.method).toBe('401-challenge-metadata');
      expect(result.metadata).toBeNull();
    });

    it('prefers the 401 hint even when path-aware metadata exists (RFC 9728 §5.1)', async () => {
      // This is the bug from issue #12761: when a 401 WWW-Authenticate header advertises
      // a `resource_metadata` URL, that URL must win over any path-aware metadata.
      const metadataUrl = 'https://mcp.example.com/.well-known/oauth-protected-resource';

      mockFetch.mockResolvedValueOnce({
        status: 401,
        headers: new Headers({
          'www-authenticate': `Bearer resource_metadata="${metadataUrl}"`,
        }),
      } as Response);

      mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://auth.example.com/'],
      });

      const result = await detectOAuthRequirement('https://mcp.example.com/mcp');

      expect(result.metadata).toMatchObject({
        authorization_servers: ['https://auth.example.com/'],
      });
      expect(mockDiscoverOAuthProtectedResourceMetadata).toHaveBeenCalledTimes(1);
      expect(mockDiscoverOAuthProtectedResourceMetadata).toHaveBeenCalledWith(
        'https://mcp.example.com/mcp',
        expect.objectContaining({ resourceMetadataUrl: new URL(metadataUrl) }),
        expect.any(Function),
      );
    });
  });

  describe('SSRF hardening of the resource_metadata hint', () => {
    // A malicious MCP server can advertise a `resource_metadata=` URL that points at a
    // private IP, loopback, or cloud metadata service. Blindly handing that URL to the
    // SDK would let the server weaponize detection as an SSRF vector, so we validate it
    // first and silently fall back to path-aware discovery on rejection.

    it('drops a hint URL whose hostname matches an SSRF target list entry', async () => {
      const maliciousHint = 'http://169.254.169.254/latest/meta-data/';
      mockFetch.mockResolvedValueOnce({
        status: 401,
        headers: new Headers({
          'www-authenticate': `Bearer resource_metadata="${maliciousHint}"`,
        }),
      } as Response);

      mockIsSSRFTarget.mockImplementation((hostname: string) => hostname === '169.254.169.254');

      mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
        resource: 'https://mcp.example.com',
        authorization_servers: ['https://auth.example.com'],
      });

      const result = await detectOAuthRequirement('https://mcp.example.com');

      expect(mockDiscoverOAuthProtectedResourceMetadata).toHaveBeenCalledWith(
        'https://mcp.example.com',
        expect.objectContaining({ resourceMetadataUrl: undefined }),
        expect.any(Function),
      );
      expect(result.requiresOAuth).toBe(true);
      expect(result.method).toBe('protected-resource-metadata');
    });

    it('drops a hint URL whose hostname resolves to a private address', async () => {
      const maliciousHint = 'https://internal.local/.well-known/oauth-protected-resource';
      mockFetch.mockResolvedValueOnce({
        status: 401,
        headers: new Headers({
          'www-authenticate': `Bearer resource_metadata="${maliciousHint}"`,
        }),
      } as Response);

      mockResolveHostnameSSRF.mockImplementation(
        async (hostname: string) => hostname === 'internal.local',
      );

      mockDiscoverOAuthProtectedResourceMetadata.mockRejectedValueOnce(
        new Error('Resource server does not implement OAuth 2.0 Protected Resource Metadata.'),
      );

      const result = await detectOAuthRequirement('https://mcp.example.com');

      // Hint dropped → SDK called with undefined → path-aware falls through → Bearer-only.
      expect(mockDiscoverOAuthProtectedResourceMetadata).toHaveBeenCalledWith(
        'https://mcp.example.com',
        expect.objectContaining({ resourceMetadataUrl: undefined }),
        expect.any(Function),
      );
      expect(result.requiresOAuth).toBe(true);
      expect(result.method).toBe('401-challenge-metadata');
      expect(result.metadata).toBeNull();
    });
  });

  describe('path-aware discovery without a hint', () => {
    it('uses path-aware discovery when the server returns no 401 challenge', async () => {
      // HEAD and POST both return 200 — no challenge, but the server may still advertise
      // `.well-known/oauth-protected-resource` (uncommon but spec-allowed).
      mockFetch.mockResolvedValue({
        status: 200,
        headers: new Headers(),
      } as Response);

      mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
        resource: 'https://mcp.example.com',
        authorization_servers: ['https://auth.example.com'],
      });

      const result = await detectOAuthRequirement('https://mcp.example.com');

      expect(result.requiresOAuth).toBe(true);
      expect(result.method).toBe('protected-resource-metadata');
      expect(mockDiscoverOAuthProtectedResourceMetadata).toHaveBeenCalledWith(
        'https://mcp.example.com',
        expect.objectContaining({ resourceMetadataUrl: undefined }),
        expect.any(Function),
      );
    });
  });

  describe('StackOverflow-like server behavior', () => {
    it('detects OAuth for servers that return 405 for HEAD and 401+Bearer for POST', async () => {
      mockFetch
        .mockResolvedValueOnce({
          status: 405,
          headers: new Headers(),
        } as Response)
        .mockResolvedValueOnce({
          status: 401,
          headers: new Headers({ 'www-authenticate': 'Bearer' }),
        } as Response);

      const result = await detectOAuthRequirement('https://mcp.stackoverflow.com');

      expect(result.requiresOAuth).toBe(true);
      expect(result.method).toBe('401-challenge-metadata');
      expect(result.metadata).toBeNull();
    });
  });

  describe('error handling', () => {
    it('returns no OAuth required when all checks fail', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await detectOAuthRequirement('https://unreachable.example.com');

      expect(result.requiresOAuth).toBe(false);
      expect(result.method).toBe('no-metadata-found');
    });

    it('handles timeout gracefully', async () => {
      mockFetch.mockImplementation(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 100)),
      );

      const result = await detectOAuthRequirement('https://slow.example.com');

      expect(result.requiresOAuth).toBe(false);
    });
  });
});
