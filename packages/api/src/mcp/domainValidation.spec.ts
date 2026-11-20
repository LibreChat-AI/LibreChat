import type { MCPOptions } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { ParsedServerConfig } from './types';
import { buildMCPDomainValidationConfig } from './domainValidation';
import { OpenIDReauthRequiredError } from '~/utils/oidc';
import { isMCPDomainAllowed } from '~/auth/domain';
import { processMCPEnv } from '~/utils/env';

/** What `openIdJwtStrategy` attaches from `req.session.openidTokens` without refreshing it. */
const staleOpenIDUser = (): Partial<IUser> =>
  ({
    id: 'user-1',
    provider: 'openid',
    openidId: 'oidc-sub-1',
    federatedTokens: {
      access_token: 'stale-access-token',
      expires_at: Math.floor(Date.now() / 1000) - 3600,
    },
  }) as Partial<IUser>;

/** `MCPOptions` is a union by transport, so a test reads these two through the union. */
const urlOf = (options: MCPOptions | ParsedServerConfig): string | undefined =>
  (options as { url?: string }).url;
const headersOf = (options: ParsedServerConfig): Record<string, string> | undefined =>
  (options as { headers?: Record<string, string> }).headers;

const yamlServer = (overrides: Record<string, unknown> = {}): ParsedServerConfig =>
  ({
    type: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    source: 'yaml',
    requiresOAuth: false,
    ...overrides,
  }) as ParsedServerConfig;

describe('buildMCPDomainValidationConfig', () => {
  it('lets a stale OpenID snapshot resolve a URL that an Authorization placeholder blocked', async () => {
    const config = yamlServer({ headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_TOKEN}}' } });
    const user = staleOpenIDUser();

    /** The trap: a header no domain decision reads fails the whole resolution. */
    expect(() => processMCPEnv({ user, options: config })).toThrow(OpenIDReauthRequiredError);

    const resolved = processMCPEnv({ user, options: buildMCPDomainValidationConfig(config) });
    expect(urlOf(resolved)).toBe('https://mcp.example.com/mcp');
    expect('headers' in resolved).toBe(false);
    await expect(isMCPDomainAllowed(resolved, ['mcp.example.com'])).resolves.toBe(true);
  });

  it.each([
    ['headers', { headers: { 'X-Auth-Token': '{{LIBRECHAT_OPENID_ACCESS_TOKEN}}' } }],
    ['oauth_headers', { oauth_headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_TOKEN}}' } }],
    ['env', { env: { UPSTREAM_TOKEN: '{{LIBRECHAT_OPENID_ACCESS_TOKEN}}' } }],
    ['args', { args: ['--token={{LIBRECHAT_OPENID_ACCESS_TOKEN}}'] }],
    ['oauth', { oauth: { client_secret: '{{LIBRECHAT_OPENID_ACCESS_TOKEN}}' } }],
    [
      'apiKey',
      {
        apiKey: {
          source: 'admin',
          key: '{{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
          authorization_type: 'bearer',
        },
      },
    ],
  ])(
    'drops a credential placeholder carried by %s, not only by Authorization',
    (_field, overrides) => {
      const config = yamlServer(overrides);
      const user = staleOpenIDUser();

      expect(() => processMCPEnv({ user, options: config })).toThrow(OpenIDReauthRequiredError);
      expect(urlOf(processMCPEnv({ user, options: buildMCPDomainValidationConfig(config) }))).toBe(
        'https://mcp.example.com/mcp',
      );
    },
  );

  it('keeps failing closed when the URL itself carries a credential placeholder', () => {
    const config = yamlServer({
      url: 'https://mcp.example.com/mcp/{{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
      headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_TOKEN}}' },
    });

    expect(() =>
      processMCPEnv({
        user: staleOpenIDUser(),
        options: buildMCPDomainValidationConfig(config),
      }),
    ).toThrow(OpenIDReauthRequiredError);
  });

  it('preserves every field resolution and the domain decision depend on, and mutates nothing', () => {
    const headers = { Authorization: 'Bearer {{LIBRECHAT_OPENID_TOKEN}}' };
    const config = yamlServer({ headers, dbId: 'server-1', source: 'user', consumeOnly: true });

    expect(buildMCPDomainValidationConfig(config)).toEqual({
      type: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      source: 'user',
      requiresOAuth: false,
      dbId: 'server-1',
      consumeOnly: true,
    });
    /** The connection path still needs the placeholder it knows how to refresh. */
    expect(headersOf(config)).toBe(headers);
  });

  it('still resolves the user placeholders a URL depends on', async () => {
    const config = yamlServer({
      url: 'https://{{LIBRECHAT_USER_ID}}.mcp.example.com/mcp',
      headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_TOKEN}}' },
    });

    const resolved = processMCPEnv({
      user: staleOpenIDUser(),
      options: buildMCPDomainValidationConfig(config),
    });

    expect(urlOf(resolved)).toBe('https://user-1.mcp.example.com/mcp');
    await expect(isMCPDomainAllowed(resolved, ['*.mcp.example.com'])).resolves.toBe(true);
    await expect(isMCPDomainAllowed(resolved, ['other.example.com'])).resolves.toBe(false);
  });
});
