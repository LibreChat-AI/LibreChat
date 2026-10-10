import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { withToolApprovalExecution, withToolApprovalTransport } from '~/tools/approval';
import { MCPConnection } from '../connection';

/** The actual SDK recursively sends again after auth. Only external HTTP is replaced. */
test('SDK-internal OAuth recovery cannot retry tools/call under a replacement account', async () => {
  const connection = new MCPConnection({
    serverName: 'db',
    userId: 'user-a',
    serverConfig: { type: 'streamable-http', url: 'https://mcp.example.test/mcp' },
    oauthTokens: {
      access_token: 'synthetic-a',
      token_type: 'Bearer',
      credential_set_id: 'account-a',
      obtained_at: Date.now(),
    },
  });
  let tokens: OAuthTokens = {
    access_token: 'synthetic-a',
    refresh_token: 'synthetic-refresh',
    token_type: 'Bearer',
  };
  let toolAttempts = 0;
  const provider: OAuthClientProvider = {
    redirectUrl: 'https://callback.example.test',
    clientMetadata: {
      redirect_uris: ['https://callback.example.test'],
      token_endpoint_auth_method: 'none',
      logo_uri: undefined,
      tos_uri: undefined,
    },
    clientInformation: () => ({ client_id: 'test-client' }),
    tokens: async () => tokens,
    saveTokens: async (replacement) => {
      tokens = replacement;
      connection.setOAuthTokens({
        ...replacement,
        credential_set_id: 'account-b',
        obtained_at: Date.now(),
      });
    },
    redirectToAuthorization: async () => {
      throw new Error('The scripted refresh should not redirect.');
    },
    saveCodeVerifier: async () => {},
    codeVerifier: async () => 'verifier',
  };
  const fetch = jest.fn(async (input: string | URL | Request) => {
    let url: string;
    if (typeof input === 'string') url = input;
    else if (input instanceof URL) url = input.href;
    else url = input.url;
    if (url === 'https://mcp.example.test/mcp') {
      toolAttempts++;
      return new Response('', {
        status: 401,
        headers: {
          'www-authenticate': 'Bearer resource_metadata="https://mcp.example.test/metadata"',
        },
      });
    }
    if (url === 'https://mcp.example.test/metadata')
      return Response.json({
        resource: 'https://mcp.example.test/mcp',
        authorization_servers: ['https://auth.example.test'],
      });
    if (url.includes('/.well-known/'))
      return Response.json({
        issuer: 'https://auth.example.test',
        authorization_endpoint: 'https://auth.example.test/authorize',
        token_endpoint: 'https://auth.example.test/token',
        response_types_supported: ['code'],
        grant_types_supported: ['refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    if (url === 'https://auth.example.test/token')
      return Response.json({ access_token: 'synthetic-b', token_type: 'Bearer', expires_in: 3600 });
    throw new Error('Unexpected scripted HTTP endpoint');
  });
  const transport = new StreamableHTTPClientTransport(new URL('https://mcp.example.test/mcp'), {
    authProvider: provider,
    fetch,
  });
  connection['transport'] = transport;
  connection['patchTransportSend']();
  const execution = {
    validateExecution: async () => {},
    validateTransport: async (_server: string, epoch: string | null) => {
      if (epoch !== 'account-a') throw new Error('Reviewed epoch changed before send');
    },
  };
  try {
    await expect(
      withToolApprovalExecution(execution, () =>
        withToolApprovalTransport(
          {
            toolCall: { id: 'approved-call' },
            metadata: { agentId: 'agent-a' },
          },
          () =>
            transport.send({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: 'mutate', arguments: {} },
            }),
        ),
      ),
    ).rejects.toThrow('Reviewed epoch changed before send');
    expect(tokens.access_token).toBe('synthetic-b');
    expect(toolAttempts).toBe(1);
  } finally {
    await transport.close();
  }
});
