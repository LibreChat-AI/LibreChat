import { Keyv } from 'keyv';
import { inspect } from 'util';
import { logger } from '@librechat/data-schemas';
import * as sdkAuth from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTestServer } from './helpers/oauthTestServer';
import type { MCPOAuthTokens } from '~/mcp/oauth/types';
import { createOAuthMCPServer } from './helpers/oauthTestServer';
import { MCPOAuthHandler } from '~/mcp/oauth/handler';
import { FlowStateManager } from '~/flow/manager';

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

  it('redacts stored registration lookup outages before dynamically registering again', async () => {
    const secret = 'fixture-private-cached-registration';
    const failure = Object.assign(new Error(secret), {
      status: 503,
      request: { headers: { Authorization: secret } },
    });
    const result = await MCPOAuthHandler.initiateOAuthFlow(
      'logging-server',
      server.url,
      'logging-user',
      {},
      undefined,
      undefined,
      jest.fn(async () => {
        throw failure;
      }),
      [`127.0.0.1:${server.port}`],
    );
    expect(result.flowMetadata.clientInfo?.client_id).toEqual(expect.any(String));
    const output = inspect(
      logs.flatMap((spy) => spy.mock.calls),
      { depth: null },
    );
    expect(output.includes(secret)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      '[MCPOAuth] Failed to look up existing client registration, falling back to new registration',
      { type: 'Error', status: 503, serverName: 'logging-server', userId: 'logging-user' },
    );
  });

  it('keeps resource query credentials and exchanged tokens out of completion diagnostics', async () => {
    const secret = 'fixture-private-resource-query';
    const tokens = {
      access_token: 'fixture-private-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
    };
    const result = await MCPOAuthHandler.initiateOAuthFlow(
      'logging-server',
      server.url,
      'logging-user',
      {},
      undefined,
      undefined,
      undefined,
      [`127.0.0.1:${server.port}`],
    );
    const resource = `${server.url}?credential=${secret}`;
    const manager = new FlowStateManager<MCPOAuthTokens>(new Keyv(), { ci: true });
    await manager.initFlow(result.flowId, 'mcp_oauth', {
      ...result.flowMetadata,
      serverUrl: resource,
      resourceMetadata: { ...result.flowMetadata.resourceMetadata, resource },
    });
    const exchange = jest.spyOn(sdkAuth, 'exchangeAuthorization').mockResolvedValueOnce(tokens);
    const completed = await MCPOAuthHandler.completeOAuthFlow(
      result.flowId,
      'fixture-private-code',
      manager,
      {},
    );
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(completed.access_token).toBe(tokens.access_token);
    expect((await manager.getFlowState(result.flowId, 'mcp_oauth'))?.status).toBe('COMPLETED');
    const output = inspect(
      logs.flatMap((spy) => spy.mock.calls),
      { depth: null },
    );
    for (const value of [
      secret,
      resource,
      tokens.access_token,
      'fixture-private-code',
      result.flowMetadata.state,
      result.flowMetadata.codeVerifier,
    ]) {
      expect(output.includes(value)).toBe(false);
    }
  });

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
