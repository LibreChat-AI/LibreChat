/**
 * Real-SDK coverage for disposal landing mid-connect.
 *
 * A discovery caller that gives up on a slow `connect()` disposes immediately, so it can dispose
 * while `constructTransport()` is still pending. `dispose()` then finds no transport to close, and
 * without a post-await check the abandoned attempt goes on to connect, leaving a live session
 * nobody owns. Only transport construction is delayed here; the client, transport, and server are
 * real SDK objects, so the assertions are about a genuinely open or closed session rather than
 * about which mock was called.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListToolsRequestSchema,
  InitializeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
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

describe('MCPConnection disposal during connect', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await server?.close().catch(() => undefined);
    server = undefined;
  });

  it('does not charge a disposed initialize attempt to connection health', async () => {
    server = new Server({ name: 'cancelled-initialize', version: '1.0.0' }, { capabilities: {} });
    let started: (() => void) | undefined;
    const initializeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    server.setRequestHandler(InitializeRequestSchema, async (request) => {
      started?.();
      await gate;
      return {
        protocolVersion: request.params.protocolVersion,
        capabilities: {},
        serverInfo: { name: 'cancelled-initialize', version: '1.0.0' },
      };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const connection = new MCPConnection({
      serverName: 'cancelled-initialize',
      serverConfig: { type: 'streamable-http', url: 'http://localhost/mcp' },
      useSSRFProtection: false,
      directBearerRecoveryEnabled: true,
    });
    jest
      .spyOn(
        connection as unknown as { constructTransport: () => Promise<unknown> },
        'constructTransport',
      )
      .mockResolvedValue(clientTransport);
    const recordFailedRound = jest.spyOn(
      connection as unknown as { recordFailedRound: () => void },
      'recordFailedRound',
    );
    const connecting = connection.connectClient().catch((error: Error) => error);
    await initializeStarted;
    await connection.dispose();
    finish?.();
    await connecting;
    expect(recordFailedRound).not.toHaveBeenCalled();
    expect(await connection.isConnected()).toBe(false);
  });

  it('leaves no live session when disposal lands while the transport is being constructed', async () => {
    server = new Server(
      { name: 'dispose-race-server', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const connection = new MCPConnection({
      serverName: 'dispose-race',
      serverConfig: { type: 'streamable-http', url: 'http://localhost/mcp' },
      useSSRFProtection: false,
    });

    let serverSawClose = false;
    serverTransport.onclose = () => {
      serverSawClose = true;
    };

    /** The only stub: hold construction open so disposal can land inside this window. */
    let releaseTransport: (() => void) | undefined;
    const transportPending = new Promise<void>((resolve) => {
      releaseTransport = resolve;
    });
    jest
      .spyOn(
        connection as unknown as { constructTransport: () => Promise<unknown> },
        'constructTransport',
      )
      .mockImplementation(async () => {
        await transportPending;
        return clientTransport;
      });

    const connecting = connection.connectClient();
    await connection.dispose();
    releaseTransport?.();
    await connecting;

    /** A real `tools/list` is the honest probe: it succeeds over any session left open. */
    await expect(connection.client.listTools()).rejects.toThrow();
    expect(await connection.isConnected()).toBe(false);
    expect(serverSawClose).toBe(true);
  });
});
