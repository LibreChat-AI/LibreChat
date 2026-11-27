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
 * Exercises the `MCP_OAUTH_ON_AUTH_ERROR=true` path in isolation — the main
 * `detectOAuth.test.ts` disables it to assert on precise detection outcomes, so
 * the fallback's behavior (and its avoidance of a redundant HEAD request) lives
 * here with the config forced on.
 */
jest.mock('../mcpConfig', () => ({
  mcpConfig: {
    OAUTH_ON_AUTH_ERROR: true,
    OAUTH_DETECTION_TIMEOUT: 5000,
  },
}));

import { discoverOAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/client/auth.js';

const mockDiscoverOAuthProtectedResourceMetadata =
  discoverOAuthProtectedResourceMetadata as jest.MockedFunction<
    typeof discoverOAuthProtectedResourceMetadata
  >;

describe('detectOAuthRequirement — MCP_OAUTH_ON_AUTH_ERROR fallback', () => {
  const originalFetch = global.fetch;
  const mockFetch = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = mockFetch;
    mockDiscoverOAuthProtectedResourceMetadata.mockRejectedValue(
      new Error('No protected resource metadata'),
    );
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('honors a 401 observed by the probe without issuing a second HEAD', async () => {
    // Server responds 401 on HEAD with neither Bearer nor resource_metadata (Basic).
    // Before the authChallenge optimization, detectOAuth would fire another HEAD via
    // checkAuthErrorFallback; now it reuses the probe's observation.
    mockFetch.mockResolvedValueOnce({
      status: 401,
      headers: new Headers({ 'www-authenticate': 'Basic realm="api"' }),
    } as Response);
    // POST still probed because the HEAD carried no useful hint.
    mockFetch.mockResolvedValueOnce({
      status: 401,
      headers: new Headers({ 'www-authenticate': 'Basic realm="api"' }),
    } as Response);

    const result = await detectOAuthRequirement('https://mcp.example.com');

    expect(result).toEqual({
      requiresOAuth: true,
      method: 'no-metadata-found',
      metadata: null,
    });
    // Exactly 2 fetches — HEAD + POST from the probe. No redundant fallback HEAD.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('honors a 403 observed by the probe without issuing a second HEAD', async () => {
    mockFetch.mockResolvedValue({ status: 403, headers: new Headers() } as Response);

    const result = await detectOAuthRequirement('https://mcp.example.com');

    expect(result.requiresOAuth).toBe(true);
    expect(result.method).toBe('no-metadata-found');
    // HEAD + POST from the probe; no extra fallback HEAD.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries via HEAD when the probe threw (transient network error)', async () => {
    // Probe crashes on both HEAD and POST (network down).
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    // Fallback HEAD succeeds and returns 401 — we honor it.
    mockFetch.mockResolvedValueOnce({
      status: 401,
      headers: new Headers(),
    } as Response);

    const result = await detectOAuthRequirement('https://mcp.example.com');

    expect(result.requiresOAuth).toBe(true);
    expect(result.method).toBe('no-metadata-found');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does not fire fallback when the probe observed a clean 200', async () => {
    mockFetch.mockResolvedValue({ status: 200, headers: new Headers() } as Response);

    const result = await detectOAuthRequirement('https://mcp.example.com');

    expect(result.requiresOAuth).toBe(false);
    expect(result.method).toBe('no-metadata-found');
    // HEAD + POST from the probe, both 200 — fallback must not fire.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries via fallback HEAD when only HEAD threw (transient failure)', async () => {
    // If HEAD transiently fails (timeout/ECONNRESET) but POST responds non-auth, the
    // probe must treat HEAD status as "unknown" so the fallback still gets a chance
    // to classify 401/403 servers correctly.
    mockFetch
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce({ status: 200, headers: new Headers() } as Response);
    // Fallback HEAD finally succeeds and returns 401.
    mockFetch.mockResolvedValueOnce({
      status: 401,
      headers: new Headers(),
    } as Response);

    const result = await detectOAuthRequirement('https://mcp.example.com');

    expect(result.requiresOAuth).toBe(true);
    expect(result.method).toBe('no-metadata-found');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does not fire fallback when HEAD was 200 but POST returned 403 (WAF/CSRF)', async () => {
    // A server that isn't OAuth-protected but 403s body-less POSTs for WAF/CSRF reasons
    // must NOT be misclassified as OAuth-required. The fallback is scoped to HEAD status.
    mockFetch
      .mockResolvedValueOnce({ status: 200, headers: new Headers() } as Response)
      .mockResolvedValueOnce({ status: 403, headers: new Headers() } as Response);

    const result = await detectOAuthRequirement('https://mcp.example.com');

    expect(result.requiresOAuth).toBe(false);
    expect(result.method).toBe('no-metadata-found');
    // Only the probe ran — no extra fallback HEAD fired.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
