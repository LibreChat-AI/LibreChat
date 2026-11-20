import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  McpError,
  ErrorCode,
  EmptyResultSchema,
  PingRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MCPConnection } from '~/mcp/connection';

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('~/auth', () => ({
  createSSRFSafeUndiciConnect: jest.fn(() => undefined),
  isOAuthUrlAllowed: jest.fn(() => false),
  isSSRFTarget: jest.fn(() => false),
  resolveHostnameSSRF: jest.fn(async () => false),
}));

describe('MCPConnection ping responses', () => {
  let server: Server;
  let connection: MCPConnection;

  beforeEach(async () => {
    server = new Server({ name: 'ping-server', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    connection = new MCPConnection({
      serverName: 'ping-server',
      serverConfig: { type: 'streamable-http', url: 'http://localhost/mcp' },
      useSSRFProtection: false,
    });
    connection['transport'] = clientTransport;
    connection['patchTransportSend']();
    await connection.client.connect(clientTransport);
    connection.emit('connectionChange', 'connected');
  });

  afterEach(async () => {
    await connection.client.close();
    await server.close();
  });

  it('answers immediate and repeated server pings and keeps ordinary requests usable', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(
        server.request({ method: 'ping' }, EmptyResultSchema, { timeout: 500 }),
      ).resolves.toEqual({});
    }
    await expect(connection.client.listTools()).resolves.toEqual({ tools: [] });
    await expect(connection.isConnected()).resolves.toBe(true);
  });

  it('still falls back to advertised capabilities when client ping is unsupported', async () => {
    server.setRequestHandler(PingRequestSchema, async () => {
      throw new McpError(ErrorCode.MethodNotFound, 'Unsupported method: ping');
    });
    const listTools = jest.fn(async () => ({ tools: [] }));
    server.setRequestHandler(ListToolsRequestSchema, listTools);
    await expect(connection.isConnected()).resolves.toBe(true);
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it('still reports an ordinary client ping failure', async () => {
    server.setRequestHandler(PingRequestSchema, async () => {
      throw new McpError(ErrorCode.InternalError, 'Ping unavailable');
    });
    await expect(connection.isConnected()).resolves.toBe(false);
  });
});
