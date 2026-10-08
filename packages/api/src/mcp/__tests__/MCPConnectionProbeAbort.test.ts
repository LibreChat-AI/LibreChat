/**
 * Real-SDK coverage for aborting the `isConnected` health probe.
 *
 * The probe's `client.ping()` carries only the SDK's own 60s default timeout, so a budgeted
 * discovery caller probing an unresponsive server would otherwise hold its fan-out slot for that
 * long. The caller's signal must cancel the in-flight ping — and, because the probed connection
 * can be the shared app connection, an aborted probe must report `false` without disturbing the
 * connection's state for everyone else.
 *
 * The client, transport, and server are real SDK objects; the server is made unresponsive by
 * swallowing its inbound messages after the handshake, which no mock of our own code could model.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCPConnection } from '~/mcp/connection';

jest.setTimeout(10_000);

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

describe('MCPConnection health-probe abort', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await server?.close().catch(() => undefined);
    server = undefined;
  });

  it('cancels a hung ping at the caller signal without disturbing connection state', async () => {
    server = new Server(
      { name: 'probe-abort-server', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const connection = new MCPConnection({
      serverName: 'probe-abort',
      serverConfig: { type: 'streamable-http', url: 'http://localhost/mcp' },
      useSSRFProtection: false,
    });
    await connection.client.connect(clientTransport);
    connection.emit('connectionChange', 'connected');

    /** The handshake used the real server; from here on it swallows every request, so the
     *  ping stays in flight until the signal cancels it. */
    serverTransport.onmessage = () => {};

    const start = Date.now();
    const alive = await connection.isConnected(AbortSignal.timeout(40));

    expect(alive).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
    const state = (connection as unknown as { connectionState: string }).connectionState;
    expect(state).toBe('connected');

    /** The aborted probe answered nothing, so it must not stamp the health-check TTL: with the
     *  server now genuinely gone, the next unbudgeted caller has to probe for real and see it —
     *  a TTL-cached result would report a dead shared connection as healthy for 60 seconds. */
    await server?.close();
    expect(await connection.isConnected()).toBe(false);
  });
});
