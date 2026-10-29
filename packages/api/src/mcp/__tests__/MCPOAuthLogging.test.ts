import { inspect } from 'util';
import { logger } from '@librechat/data-schemas';
import * as sdkAuth from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTestServer } from './helpers/oauthTestServer';
import { createOAuthMCPServer } from './helpers/oauthTestServer';
import { MCPOAuthHandler } from '~/mcp/oauth/handler';

describe('MCP OAuth initiation log boundary', () => {
  let server: OAuthTestServer;
  let logs: jest.SpyInstance[];

  beforeEach(async () => {
    logs = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(logger, level).mockImplementation(() => logger),
    );
    server = await createOAuthMCPServer({ issueRefreshTokens: true });
  });

  afterEach(async () => {
    await server?.close();
    jest.restoreAllMocks();
  });

  it.each(['dynamic', 'configured'] as const)(
    'keeps %s authorization secrets out of every logger argument while retaining flow status',
    async (clientSource) => {
      const headerSecret = 'fixture-oauth-header-secret';
      const configuredSecret = 'fixture-configured-client-secret';
      const result = await MCPOAuthHandler.initiateOAuthFlow(
        'logging-server',
        server.url,
        'logging-user',
        { 'X-Fixture-Authorization': headerSecret },
        clientSource === 'configured'
          ? {
              authorization_url: new URL('authorize', server.url).href,
              token_url: new URL('token', server.url).href,
              client_id: 'configured-client',
              client_secret: configuredSecret,
            }
          : undefined,
        undefined,
        undefined,
        [`127.0.0.1:${server.port}`],
        'logging-tenant',
      );

      const authorization = new URL(result.authorizationUrl);
      expect(authorization.searchParams.get('state')).toBe(result.flowMetadata.state);
      expect(result.flowMetadata.codeVerifier).toEqual(expect.any(String));
      expect(result.flowMetadata.clientInfo?.client_secret).toEqual(expect.any(String));
      expect(result.flowMetadata.oauthHeaders).toEqual({ 'X-Fixture-Authorization': headerSecret });
      const output = inspect(
        logs.flatMap((spy) => spy.mock.calls),
        { depth: null },
      );
      for (const secret of [
        result.authorizationUrl,
        result.flowMetadata.state,
        result.flowMetadata.codeVerifier,
        result.flowMetadata.clientInfo?.client_secret,
        authorization.searchParams.get('code_challenge'),
        headerSecret,
        configuredSecret,
      ]) {
        if (secret) expect(output.includes(secret)).toBe(false);
      }
      expect(logger.debug).toHaveBeenCalledWith('[MCPOAuth] Authorization flow ready', {
        flowId: result.flowId,
        serverName: 'logging-server',
        clientSource,
        hasClientSecret: true,
        hasResourceMetadata: true,
      });
    },
  );

  it('retains safe error type/status but not provider echoes, request data or stacks', async () => {
    const secret = 'fixture-sensitive-provider-echo';
    const error = Object.assign(new Error(`Provider rejected ${secret}`), {
      status: 400,
      codeVerifier: secret,
      authorizationUrl: `https://example.invalid/authorize?state=${secret}`,
      request: { headers: { Authorization: secret } },
    });
    jest.spyOn(sdkAuth, 'startAuthorization').mockRejectedValueOnce(error);

    await expect(
      MCPOAuthHandler.initiateOAuthFlow(
        'logging-server',
        server.url,
        'logging-user',
        {},
        undefined,
        undefined,
        undefined,
        [`127.0.0.1:${server.port}`],
      ),
    ).rejects.toBe(error);

    const output = inspect(
      logs.flatMap((spy) => spy.mock.calls),
      { depth: null },
    );
    expect(output.includes(secret)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith('[MCPOAuth] startAuthorization failed:', {
      type: 'Error',
      status: 400,
    });
    expect(logger.error).toHaveBeenCalledWith('[MCPOAuth] Failed to initiate OAuth flow', {
      error: { type: 'Error', status: 400 },
      serverName: 'logging-server',
      userId: 'logging-user',
    });
  });
});
