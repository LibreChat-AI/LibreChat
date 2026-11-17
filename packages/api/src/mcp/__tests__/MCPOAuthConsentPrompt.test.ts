/**
 * Tests that `mcpServers.<name>.oauth.skip_offline_access_consent_prompt: true` removes the
 * `prompt=consent` the MCP SDK appends to the authorization URL when the scope includes
 * `offline_access`, on both the pre-configured and the discovered (DCR) paths.
 */

import { TokenExchangeMethodEnum } from 'librechat-data-provider';
import type { MCPOptions } from 'librechat-data-provider';
import type { OAuthTestServer } from './helpers/oauthTestServer';
import { createOAuthMCPServer } from './helpers/oauthTestServer';
import { MCPOAuthHandler } from '~/mcp/oauth';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  getTenantId: jest.fn(),
  SYSTEM_TENANT_ID: '__SYSTEM__',
  encryptV2: jest.fn(async (val: string) => `enc:${val}`),
  decryptV2: jest.fn(async (val: string) => val.replace(/^enc:/, '')),
}));

/** Bypass SSRF for local test endpoints. */
jest.mock('~/auth', () => ({
  ...jest.requireActual('~/auth'),
  createSSRFSafeUndiciConnect: jest.fn(() => undefined),
  isSSRFTarget: jest.fn(() => false),
  resolveHostnameSSRF: jest.fn(async () => false),
  isOAuthUrlAllowed: jest.fn(() => true),
}));

const SCOPE = 'openid offline_access';

async function authorize(
  server: OAuthTestServer,
  config: MCPOptions['oauth'],
): Promise<URLSearchParams> {
  const { authorizationUrl } = await MCPOAuthHandler.initiateOAuthFlow(
    'test-server',
    server.url,
    'user-1',
    {},
    config,
  );
  return new URL(authorizationUrl).searchParams;
}

describe('MCP OAuth skip_offline_access_consent_prompt', () => {
  let server: OAuthTestServer;

  beforeEach(async () => {
    server = await createOAuthMCPServer({ scopesSupported: ['openid', 'offline_access'] });
  });

  afterEach(async () => {
    await server.close();
    jest.clearAllMocks();
  });

  describe('pre-configured authorize URL', () => {
    const preconfigured = (
      overrides: Partial<NonNullable<MCPOptions['oauth']>> = {},
    ): MCPOptions['oauth'] => ({
      authorization_url: `${server.url}authorize`,
      token_url: `${server.url}token`,
      client_id: 'test-client',
      client_secret: 'test-secret',
      scope: SCOPE,
      token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
      ...overrides,
    });

    it('keeps the SDK prompt=consent by default', async () => {
      const params = await authorize(server, preconfigured());
      expect(params.getAll('prompt')).toEqual(['consent']);
    });

    it('removes prompt=consent when enabled', async () => {
      const params = await authorize(
        server,
        preconfigured({ skip_offline_access_consent_prompt: true }),
      );
      expect(params.has('prompt')).toBe(false);
      expect(params.get('scope')).toBe(SCOPE);
      expect(params.get('state')).toBeTruthy();
    });

    it('keeps other prompt values from the configured authorization_url', async () => {
      const params = await authorize(
        server,
        preconfigured({
          authorization_url: `${server.url}authorize?prompt=select_account`,
          skip_offline_access_consent_prompt: true,
        }),
      );
      expect(params.getAll('prompt')).toEqual(['select_account']);
    });
  });

  describe('discovered authorize URL', () => {
    it('keeps the SDK prompt=consent by default', async () => {
      const params = await authorize(server, { scope: SCOPE });
      expect(params.getAll('prompt')).toEqual(['consent']);
    });

    it('removes prompt=consent when enabled', async () => {
      const params = await authorize(server, {
        scope: SCOPE,
        skip_offline_access_consent_prompt: true,
      });
      expect(params.has('prompt')).toBe(false);
      expect(params.get('scope')).toBe(SCOPE);
    });
  });
});
