import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';
import type { MCPClientCapabilityProfile } from '~/mcp/capabilities';
import {
  getMCPConnectionPoolKey,
  getMCPUserConnectionPoolKey,
  MCP_APPS_CAPABILITY_PROFILE,
  resolveMCPClientCapabilityProfile,
  STANDARD_MCP_CAPABILITY_PROFILE,
} from '~/mcp/capabilities';
import { MCPConnection } from '~/mcp/connection';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('~/auth', () => ({
  createSSRFSafeUndiciConnect: jest.fn(() => undefined),
  isOAuthUrlAllowed: jest.fn(() => false),
  isSSRFTarget: jest.fn(() => false),
  resolveHostnameSSRF: jest.fn(async () => false),
}));

describe('MCP client capability profiles', () => {
  const clients: MCPConnection[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((connection) => connection.client.close()));
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function negotiateCapabilities(
    capabilityProfile?: MCPClientCapabilityProfile,
  ): Promise<ClientCapabilities | undefined> {
    const server = new Server(
      { name: 'capability-test-server', version: '1.0.0' },
      { capabilities: {} },
    );
    servers.push(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const connection = new MCPConnection({
      serverName: 'capability-test-server',
      serverConfig: { type: 'streamable-http', url: 'http://localhost/mcp' },
      useSSRFProtection: false,
      ...(capabilityProfile == null ? {} : { capabilityProfile }),
    });
    clients.push(connection);
    await connection.client.connect(clientTransport);

    return server.getClientCapabilities();
  }

  it.each([
    ['omitted policy', undefined, STANDARD_MCP_CAPABILITY_PROFILE],
    ['disabled policy', { enabled: false }, STANDARD_MCP_CAPABILITY_PROFILE],
    ['enabled policy', { enabled: true }, MCP_APPS_CAPABILITY_PROFILE],
  ] as const)('resolves %s to the immutable session profile', (_label, policy, expected) => {
    expect(resolveMCPClientCapabilityProfile(policy)).toBe(expected);
  });

  it('keeps every server and user profile tuple unambiguous', () => {
    expect(getMCPConnectionPoolKey('server:one', STANDARD_MCP_CAPABILITY_PROFILE)).toBe(
      JSON.stringify(['server:one', STANDARD_MCP_CAPABILITY_PROFILE]),
    );
    expect(getMCPConnectionPoolKey('server:one', MCP_APPS_CAPABILITY_PROFILE)).toBe(
      JSON.stringify(['server:one', MCP_APPS_CAPABILITY_PROFILE]),
    );
    expect(
      getMCPUserConnectionPoolKey('user:one', 'server:one', STANDARD_MCP_CAPABILITY_PROFILE),
    ).toBe(JSON.stringify(['user:one', 'server:one', STANDARD_MCP_CAPABILITY_PROFILE]));
    expect(getMCPUserConnectionPoolKey('user:one', 'server:one', MCP_APPS_CAPABILITY_PROFILE)).toBe(
      JSON.stringify(['user:one', 'server:one', MCP_APPS_CAPABILITY_PROFILE]),
    );
    expect(
      getMCPConnectionPoolKey('["server:one","apps"]', STANDARD_MCP_CAPABILITY_PROFILE),
    ).not.toBe(getMCPConnectionPoolKey('server:one', MCP_APPS_CAPABILITY_PROFILE));
  });

  it.each([
    ['omitted', undefined],
    ['standard', STANDARD_MCP_CAPABILITY_PROFILE],
  ] as const)('advertises no extensions for the %s profile', async (_label, profile) => {
    await expect(negotiateCapabilities(profile)).resolves.toEqual({});
  });

  it('advertises the MCP Apps HTML extension for the apps profile', async () => {
    await expect(negotiateCapabilities(MCP_APPS_CAPABILITY_PROFILE)).resolves.toEqual({
      extensions: {
        'io.modelcontextprotocol/ui': {
          mimeTypes: ['text/html;profile=mcp-app'],
        },
      },
    });
  });
});
