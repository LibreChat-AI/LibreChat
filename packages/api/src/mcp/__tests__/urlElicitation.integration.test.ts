import { randomUUID } from 'crypto';
import type { IUser } from '@librechat/data-schemas';
import type { FlowStateManager } from '~/flow/manager';
import {
  startMockElicitationServer,
  type ElicitationWireShape,
  type MockElicitationServer,
} from './helpers/mockElicitationServer';
import { MCPServersRegistry } from '../registry/MCPServersRegistry';
import { MCPConnection } from '../connection';
import { MCPManager } from '../MCPManager';

/**
 * Exercises the REAL client stack end to end against a mock AgentCore-style
 * gateway: `MCPManager.callTool` → real SDK `Client` → real
 * `StreamableHTTPClientTransport` (with LibreChat's guarded fetch) → mock HTTP
 * server. The only stubs are `getConnection` (so we can point callTool at our
 * connection) and the flow manager (so "user consent" resolves synchronously).
 *
 * This is the harness the unit tests in `elicitation.test.ts` can't be: it
 * proves the -32042 exception actually round-trips through the SDK in both wire
 * shapes and that callTool emits the elicitation, retries exactly once, and
 * returns the post-authorization result.
 */

const USER = { id: 'user-1' } as unknown as IUser;

const WIRE_SHAPES: ElicitationWireShape[] = ['http-401', 'jsonrpc-200'];

function streamableHttpConfig(url: string) {
  return { type: 'streamable-http' as const, url };
}

/** A flow manager whose `createFlow` simulates the user completing consent by
 *  hitting the mock's `/consent` link before resolving with `complete`. */
function consentingFlowManager(server: MockElicitationServer) {
  const createFlow = jest.fn(async () => {
    await fetch(server.consentUrl);
    return { action: 'complete' as const };
  });
  return { manager: { createFlow } as unknown as FlowStateManager<never>, createFlow };
}

/** A flow manager whose `createFlow` rejects — models a timeout / user cancel. */
function rejectingFlowManager(error: Error) {
  const createFlow = jest.fn(async () => {
    throw error;
  });
  return { manager: { createFlow } as unknown as FlowStateManager<never>, createFlow };
}

/** A flow manager that must never be consulted (asserts "no retry" paths). */
function unusedFlowManager() {
  const createFlow = jest.fn(async () => {
    throw new Error('createFlow should not have been called');
  });
  return { manager: { createFlow } as unknown as FlowStateManager<never>, createFlow };
}

async function connectToMock(server: MockElicitationServer): Promise<{
  manager: MCPManager;
  connection: MCPConnection;
  serverName: string;
}> {
  // Unique server name per connection so the static circuit breaker never
  // couples one test's reconnects to another's.
  const serverName = `mock-${randomUUID()}`;
  const connection = new MCPConnection({
    serverName,
    serverConfig: streamableHttpConfig(server.url),
    useSSRFProtection: false,
  });
  await connection.connect();

  const manager = new MCPManager();
  jest.spyOn(manager, 'getConnection').mockResolvedValue(connection);
  return { manager, connection, serverName };
}

function callGetSecret(
  manager: MCPManager,
  server: MockElicitationServer,
  serverName: string,
  opts: {
    flowManager: FlowStateManager<never>;
    elicitationStart?: jest.Mock;
    elicitationStreamId?: string | null;
    elicitationStepId?: string;
  },
) {
  return manager.callTool({
    user: USER,
    serverName,
    serverConfig: streamableHttpConfig(server.url),
    toolName: 'get_secret',
    provider: 'openai',
    flowManager: opts.flowManager as never,
    elicitationStart: opts.elicitationStart as never,
    elicitationStreamId: opts.elicitationStreamId,
    elicitationStepId: opts.elicitationStepId,
  });
}

describe('URL elicitation (-32042) integration', () => {
  let server: MockElicitationServer;
  let connection: MCPConnection | undefined;

  beforeAll(async () => {
    server = await startMockElicitationServer();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    // callTool calls MCPServersRegistry.getInstance() unconditionally; only the
    // app-connection ownership check is reached (providedConfig + no OAuth), and
    // these configs are user-scoped, so a minimal stub keeps the singleton-init
    // requirement out of the test.
    jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue({
      isAppServerConfig: jest.fn().mockResolvedValue(false),
    } as unknown as MCPServersRegistry);
  });

  afterEach(async () => {
    if (connection) {
      await connection.disconnect();
      connection = undefined;
    }
  });

  it('declares protocolVersion 2025-11-25 and URL-mode elicitation on the initialize wire', async () => {
    server.reset({ authorized: false, wireShape: 'http-401' });
    const built = await connectToMock(server);
    connection = built.connection;

    const init = server.state.initializeRequest;
    // Ground truth of what the real client stack put on the wire.
    expect(init).toBeDefined();
    // URL-mode elicitation passthrough is gated on version 2025-11-25 + capability.
    expect(init?.protocolVersion).toBe('2025-11-25');
    // The capability object must survive to the wire (not stripped by the SDK) and
    // declare URL mode — `elicitation.url` present is how the SDK signals url support.
    const elicitation = init?.capabilities?.elicitation as
      | { form?: unknown; url?: unknown }
      | undefined;
    expect(elicitation).toBeDefined();
    expect(elicitation?.url).toBeDefined();
    // This build declares only URL-mode elicitation; form mode must NOT be advertised.
    expect(elicitation?.form).toBeUndefined();
  });

  it('sanity: a non-gated tool (whoami) succeeds without any elicitation', async () => {
    server.reset({ authorized: false, wireShape: 'http-401' });
    const built = await connectToMock(server);
    connection = built.connection;
    const elicitationStart = jest.fn(async () => undefined);
    const { manager: flowManager, createFlow } = unusedFlowManager();

    const result = await built.manager.callTool({
      user: USER,
      serverName: built.serverName,
      serverConfig: streamableHttpConfig(server.url),
      toolName: 'whoami',
      provider: 'openai',
      flowManager: flowManager as never,
      elicitationStart: elicitationStart as never,
    });

    expect(JSON.stringify(result)).toContain('mock-user');
    expect(elicitationStart).not.toHaveBeenCalled();
    expect(createFlow).not.toHaveBeenCalled();
    expect(server.state.callCounts['whoami']).toBe(1);
  });

  it('refuses URL elicitation on an app-level shared connection (no cross-user auth bleed)', async () => {
    server.reset({ authorized: false, wireShape: 'http-401' });
    const built = await connectToMock(server);
    connection = built.connection;

    // Resolved connection === the app-level shared one, so the guard refuses.
    (
      built.manager as unknown as { appConnections: { get: (s: string) => Promise<unknown> } }
    ).appConnections = { get: jest.fn(async () => built.connection) };

    const elicitationStart = jest.fn(async () => undefined);
    const { manager: flowManager, createFlow } = unusedFlowManager();

    await expect(
      callGetSecret(built.manager, server, built.serverName, { flowManager, elicitationStart }),
    ).rejects.toThrow(/app level|user-scoped/i);

    // The guard fires before any elicitation/flow machinery, and there is no retry.
    expect(elicitationStart).not.toHaveBeenCalled();
    expect(createFlow).not.toHaveBeenCalled();
    expect(server.state.callCounts['get_secret']).toBe(1);
  });

  it('threads elicitationStreamId/elicitationStepId into the mcp_elicit flow metadata', async () => {
    server.reset({ authorized: false, wireShape: 'http-401' });
    const built = await connectToMock(server);
    connection = built.connection;

    const elicitationStart = jest.fn(async () => undefined);
    const { manager: flowManager, createFlow } = consentingFlowManager(server);

    await callGetSecret(built.manager, server, built.serverName, {
      flowManager,
      elicitationStart,
      elicitationStreamId: 'stream-123',
      elicitationStepId: 'step-abc',
    });

    expect(createFlow).toHaveBeenCalledTimes(1);
    const [, flowType, metadata] = createFlow.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
      AbortSignal?,
    ];
    expect(flowType).toBe('mcp_elicit');
    expect(metadata).toEqual(
      expect.objectContaining({ streamId: 'stream-123', stepId: 'step-abc' }),
    );
  });

  it('defaults the mcp_elicit flow metadata streamId to null when not supplied', async () => {
    server.reset({ authorized: false, wireShape: 'http-401' });
    const built = await connectToMock(server);
    connection = built.connection;

    const elicitationStart = jest.fn(async () => undefined);
    const { manager: flowManager, createFlow } = consentingFlowManager(server);

    await callGetSecret(built.manager, server, built.serverName, {
      flowManager,
      elicitationStart,
    });

    expect(createFlow).toHaveBeenCalledTimes(1);
    const [, , metadata] = createFlow.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
      AbortSignal?,
    ];
    expect(metadata).toEqual(expect.objectContaining({ streamId: null }));
  });

  describe.each(WIRE_SHAPES)('wire shape: %s', (wireShape) => {
    it('emits the elicitation, retries exactly once, and returns the authorized result', async () => {
      server.reset({ authorized: false, wireShape });
      const built = await connectToMock(server);
      connection = built.connection;

      const elicitationStart = jest.fn(async () => undefined);
      const { manager: flowManager, createFlow } = consentingFlowManager(server);

      const result = await callGetSecret(built.manager, server, built.serverName, {
        flowManager,
        elicitationStart,
      });

      // The authorization link + message reached the UI layer exactly once.
      expect(elicitationStart).toHaveBeenCalledTimes(1);
      expect(elicitationStart).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'url',
          url: server.consentUrl,
          message: expect.stringContaining('authorize'),
        }),
      );
      expect(createFlow).toHaveBeenCalledTimes(1);

      // Exactly one retry after consent — the initial call plus the retry.
      expect(server.state.callCounts['get_secret']).toBe(2);
      expect(JSON.stringify(result)).toContain('s3cr3t-payload');
    });

    it('propagates the error and does NOT retry when consent fails', async () => {
      server.reset({ authorized: false, wireShape });
      const built = await connectToMock(server);
      connection = built.connection;

      const elicitationStart = jest.fn(async () => undefined);
      const { manager: flowManager, createFlow } = rejectingFlowManager(
        new Error('user cancelled'),
      );

      await expect(
        callGetSecret(built.manager, server, built.serverName, { flowManager, elicitationStart }),
      ).rejects.toThrow(/authorize/i);

      expect(elicitationStart).toHaveBeenCalledTimes(1);
      expect(createFlow).toHaveBeenCalledTimes(1);
      // Initial call only — the failed consent must not trigger a retry.
      expect(server.state.callCounts['get_secret']).toBe(1);
    });

    it('rethrows the original error with no elicitation when elicitationStart is absent', async () => {
      server.reset({ authorized: false, wireShape });
      const built = await connectToMock(server);
      connection = built.connection;

      const { manager: flowManager, createFlow } = unusedFlowManager();

      await expect(
        callGetSecret(built.manager, server, built.serverName, { flowManager }),
      ).rejects.toThrow();

      // No elicitation machinery ran; the raw tool error surfaced directly.
      expect(createFlow).not.toHaveBeenCalled();
      expect(server.state.callCounts['get_secret']).toBe(1);
    });
  });

  // The HTTP-wrapped shape is matched by scanning the SDK error's `.message`
  // string, so the exact JSON byte layout matters. A gateway that pretty-prints
  // (or otherwise inserts whitespace) yields `"code": -32042` with a space —
  // extraction must still recognize it, otherwise callTool rethrows and the UI
  // shows a generic gateway error even though authorization was available.
  it('extracts a whitespaced HTTP-wrapped -32042 body (gateway serializer variance)', async () => {
    server.reset({ authorized: false, wireShape: 'http-401', bodyFormat: 'pretty' });
    const built = await connectToMock(server);
    connection = built.connection;

    const elicitationStart = jest.fn(async () => undefined);
    const { manager: flowManager, createFlow } = consentingFlowManager(server);

    const result = await callGetSecret(built.manager, server, built.serverName, {
      flowManager,
      elicitationStart,
    });

    expect(elicitationStart).toHaveBeenCalledTimes(1);
    expect(createFlow).toHaveBeenCalledTimes(1);
    expect(server.state.callCounts['get_secret']).toBe(2);
    expect(JSON.stringify(result)).toContain('s3cr3t-payload');
  });

  // Regression for the spurious-reconnect bug: the -32042 arrives HTTP-wrapped
  // (StreamableHTTPError.code === 401), which the transport error handler would
  // otherwise mistake for an OAuth/connection failure and reconnect on — racing
  // the in-band retry and, in prod, leaving a stale session (-32600). The live
  // session must be left untouched.
  it('does NOT emit oauthError or reconnect on a -32042 (request-scoped, session stays live)', async () => {
    server.reset({ authorized: false, wireShape: 'http-401' });
    const built = await connectToMock(server);
    connection = built.connection;

    const connectionStates: string[] = [];
    built.connection.on('connectionChange', (state) => connectionStates.push(state));
    let oauthErrors = 0;
    built.connection.on('oauthError', () => {
      oauthErrors += 1;
    });

    const elicitationStart = jest.fn(async () => undefined);
    const { manager: flowManager } = consentingFlowManager(server);

    const result = await callGetSecret(built.manager, server, built.serverName, {
      flowManager,
      elicitationStart,
    });

    expect(JSON.stringify(result)).toContain('s3cr3t-payload');
    // The elicitation error must not be classified as an OAuth/transport failure.
    expect(oauthErrors).toBe(0);
    expect(connectionStates).not.toContain('error');
  });

  // Documents current -32600 handling (Datadog's observed production failure): a
  // "Session not initialized" error on tools/call is NOT auto-recovered by
  // callTool — no re-initialize, no retry — it surfaces to the caller. (Mirrored
  // in MCPManager.callTool: only -32042 is caught for retry; every other error is
  // rethrown, packages/api/src/mcp/MCPManager.ts:607-666.)
  it('surfaces a -32600 session error with no auto-reinitialize/retry', async () => {
    server.reset({ authorized: true });
    server.state.sessionErrorOnce = true;
    const built = await connectToMock(server);
    connection = built.connection;

    const elicitationStart = jest.fn(async () => undefined);
    const { manager: flowManager } = unusedFlowManager();

    await expect(
      callGetSecret(built.manager, server, built.serverName, { flowManager, elicitationStart }),
    ).rejects.toThrow();

    // Exactly one attempt — callTool did not re-initialize and retry the session.
    expect(server.state.callCounts['get_secret']).toBe(1);
    expect(elicitationStart).not.toHaveBeenCalled();
  });

  // GET /reset re-gates the mock (authorized=false) so a human can run repeated
  // UI rounds without restarting the process — and, unlike /consent, it is safe
  // to hit in smoke checks (it never grants access).
  it('GET /reset sets authorized=false for a fresh round', async () => {
    server.reset({ authorized: true });
    expect(server.state.authorized).toBe(true);

    const res = await fetch(server.resetUrl);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Reset');
    expect(server.state.authorized).toBe(false);
  });
});
