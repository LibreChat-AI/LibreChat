/**
 * Unit tests for MCPConnection.fetchTools pagination.
 *
 * MCP `tools/list` is a paginated method: the server may return a page of tools
 * plus a `nextCursor` that the client must follow to retrieve the rest. These
 * tests verify that fetchTools walks every page, passes the cursor back
 * unchanged, and is bounded against misbehaving servers (page cap + repeated
 * cursor guard) while preserving the original single-page and error behavior.
 */

import { logger } from '@librechat/data-schemas';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { MCPConnection } from '~/mcp/connection';
import { mcpConfig } from '~/mcp/mcpConfig';

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

/** Pin the page cap to a small value so the cap path is cheap to exercise. */
jest.mock('~/mcp/mcpConfig', () => ({
  mcpConfig: {
    TOOLS_LIST_MAX_PAGES: 3,
    TOOLS_LIST_MAX_TOOLS: 1000,
    TOOLS_LIST_MAX_BYTES: 5 * 1024 * 1024,
    TOOLS_LIST_TIMEOUT_MS: 30000,
    CONNECTION_CHECK_TTL: 0,
  },
}));

const mockLogger = logger as jest.Mocked<typeof logger>;

const makeTool = (name: string) => ({
  name,
  description: `${name} description`,
  inputSchema: { type: 'object' as const, properties: {} },
});

/** Build a bare MCPConnection (no real transport) with an injected, controllable client. */
function createConnectionWithListTools(
  listTools: jest.Mock,
  directBearerRecoveryEnabled = false,
): MCPConnection {
  const conn = new MCPConnection({
    serverName: 'pagination-test',
    serverConfig: { type: 'streamable-http', url: 'http://localhost/mcp' },
    useSSRFProtection: false,
    directBearerRecoveryEnabled,
  });
  conn.client.listTools = listTools;
  return conn;
}

function expectListToolsCall(
  listTools: jest.Mock,
  callNumber: number,
  params: { cursor?: string } | undefined,
): void {
  expect(listTools).toHaveBeenNthCalledWith(
    callNumber,
    params,
    expect.objectContaining({
      timeout: expect.any(Number),
      maxTotalTimeout: expect.any(Number),
    }),
  );
}

describe('MCPConnection.fetchTools pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mcpConfig.TOOLS_LIST_MAX_TOOLS = 1000;
    mcpConfig.TOOLS_LIST_MAX_BYTES = 5 * 1024 * 1024;
    mcpConfig.TOOLS_LIST_TIMEOUT_MS = 30000;
  });

  it('does not queue tool-list retries when the server has no tools capability', async () => {
    const listTools = jest.fn();
    const conn = createConnectionWithListTools(listTools);
    jest.spyOn(conn.client, 'getServerCapabilities').mockReturnValue({ resources: {} });

    await conn.refreshToolList();

    expect(listTools).not.toHaveBeenCalled();
  });

  it('returns the tools from a single page and makes one request when there is no nextCursor', async () => {
    const listTools = jest.fn().mockResolvedValue({ tools: [makeTool('a'), makeTool('b')] });
    const conn = createConnectionWithListTools(listTools);

    const tools = await conn.fetchTools();

    expect(tools.map((t) => t.name)).toEqual(['a', 'b']);
    expect(listTools).toHaveBeenCalledTimes(1);
    expectListToolsCall(listTools, 1, undefined);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('returns the notification snapshot when a request snapshot races list_changed', async () => {
    let releaseStale: ((value: { tools: ReturnType<typeof makeTool>[] }) => void) | undefined;
    const stale = new Promise<{ tools: ReturnType<typeof makeTool>[] }>((resolve) => {
      releaseStale = resolve;
    });
    const listTools = jest
      .fn()
      .mockReturnValueOnce(stale)
      .mockResolvedValueOnce({ tools: [makeTool('current')] });
    const conn = createConnectionWithListTools(listTools);
    Reflect.set(conn, 'connectionState', 'connected');
    jest.spyOn(conn.client, 'getServerCapabilities').mockReturnValue({
      tools: { listChanged: true },
    });

    const requested = conn.fetchOrderedToolsSnapshot();
    await Promise.resolve();
    const notified = conn.refreshToolList();
    await notified;
    releaseStale?.({ tools: [makeTool('stale')] });

    await expect(requested).resolves.toEqual({
      tools: [makeTool('current')],
      complete: true,
    });
  });

  it.each([
    { notificationFirst: true, interruption: 'none' },
    { notificationFirst: false, interruption: 'none' },
    { notificationFirst: true, interruption: 'abort' },
    { notificationFirst: true, interruption: 'disconnect' },
  ])(
    'orders auth rejection with notificationFirst=$notificationFirst, interruption=$interruption',
    async ({ notificationFirst, interruption }) => {
      let releaseStale!: (value: { tools: ReturnType<typeof makeTool>[] }) => void;
      let rejectRefresh!: (error: Error) => void;
      const stale = new Promise<{ tools: ReturnType<typeof makeTool>[] }>((resolve) => {
        releaseStale = resolve;
      });
      const refresh = new Promise<never>((_, reject) => {
        rejectRefresh = reject;
      });
      const listTools = jest.fn().mockReturnValueOnce(stale).mockReturnValueOnce(refresh);
      const conn = createConnectionWithListTools(listTools, true);
      Reflect.set(conn, 'connectionState', 'connected');
      jest.spyOn(conn.client, 'getServerCapabilities').mockReturnValue({ tools: {} });
      const authenticationError = Object.assign(new Error('Unauthorized'), { status: 401 });

      const controller = new AbortController();
      const requested = conn.fetchOrderedToolsSnapshot(undefined, controller.signal);
      await Promise.resolve();
      const notified = conn.refreshToolList();
      if (notificationFirst) {
        rejectRefresh(authenticationError);
        await notified;
        if (interruption === 'abort') {
          controller.abort();
        } else if (interruption === 'disconnect') {
          await conn.disconnect();
        }
        releaseStale({ tools: [makeTool('stale')] });
      } else {
        releaseStale({ tools: [makeTool('stale')] });
        await Promise.resolve();
        rejectRefresh(authenticationError);
        await notified;
      }

      if (interruption === 'none') {
        await expect(requested).resolves.toEqual(
          expect.objectContaining({ complete: false, authenticationError }),
        );
      } else {
        await expect(requested).resolves.toEqual({ tools: [], complete: false });
      }
      expect(listTools).toHaveBeenCalledTimes(2);
      await conn.disconnect();
    },
  );

  it('follows nextCursor across pages, concatenating every tool and passing the cursor back', async () => {
    const listTools = jest.fn(async (params?: { cursor?: string }) => {
      switch (params?.cursor) {
        case undefined:
          return { tools: [makeTool('a'), makeTool('b')], nextCursor: 'c1' };
        case 'c1':
          return { tools: [makeTool('c'), makeTool('d')], nextCursor: 'c2' };
        case 'c2':
          return { tools: [makeTool('e')] };
        default:
          throw new Error(`unexpected cursor: ${params?.cursor}`);
      }
    });
    const conn = createConnectionWithListTools(listTools);

    const tools = await conn.fetchTools();

    expect(tools.map((t) => t.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(listTools).toHaveBeenCalledTimes(3);
    expectListToolsCall(listTools, 1, undefined);
    expectListToolsCall(listTools, 2, { cursor: 'c1' });
    expectListToolsCall(listTools, 3, { cursor: 'c2' });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('stops at the page cap and warns when a server keeps returning new cursors', async () => {
    let page = 0;
    const listTools = jest.fn(async () => {
      page += 1;
      return { tools: [makeTool(`t${page}`)], nextCursor: `cursor-${page}` };
    });
    const conn = createConnectionWithListTools(listTools);

    const tools = await conn.fetchTools();

    // mcpConfig.TOOLS_LIST_MAX_PAGES is mocked to 3.
    expect(listTools).toHaveBeenCalledTimes(3);
    expect(tools.map((t) => t.name)).toEqual(['t1', 't2', 't3']);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('pagination limit'));
  });

  it('stops at the aggregate tool-count budget and warns', async () => {
    mcpConfig.TOOLS_LIST_MAX_TOOLS = 3;
    const listTools = jest.fn(async (params?: { cursor?: string }) => {
      if (params?.cursor == null) {
        return { tools: [makeTool('a'), makeTool('b')], nextCursor: 'c1' };
      }
      return { tools: [makeTool('c'), makeTool('d')], nextCursor: 'c2' };
    });
    const conn = createConnectionWithListTools(listTools);

    const tools = await conn.fetchTools();

    expect(tools.map((t) => t.name)).toEqual(['a', 'b', 'c']);
    expect(listTools).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('tool count budget'));
  });

  it('does not request another page when the tool-count budget is exactly full', async () => {
    mcpConfig.TOOLS_LIST_MAX_TOOLS = 2;
    const listTools = jest.fn(async (params?: { cursor?: string }) => {
      if (params?.cursor == null) {
        return { tools: [makeTool('a'), makeTool('b')], nextCursor: 'c1' };
      }
      return { tools: [makeTool('c')] };
    });
    const conn = createConnectionWithListTools(listTools);

    const tools = await conn.fetchTools();

    expect(tools.map((t) => t.name)).toEqual(['a', 'b']);
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('tool count budget'));
  });

  it('stops at the aggregate byte budget and warns', async () => {
    mcpConfig.TOOLS_LIST_MAX_BYTES = 170;
    const listTools = jest.fn(async () => ({
      tools: [makeTool('a'), makeTool('b')],
      nextCursor: 'c1',
    }));
    const conn = createConnectionWithListTools(listTools);

    const tools = await conn.fetchTools();

    expect(tools.map((t) => t.name)).toEqual(['a']);
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('size budget'));
  });

  it('marks a time-truncated snapshot incomplete before requesting another page', async () => {
    mcpConfig.TOOLS_LIST_TIMEOUT_MS = 1;
    const listTools = jest.fn(async () => ({ tools: [makeTool('a')], nextCursor: 'c1' }));
    const conn = createConnectionWithListTools(listTools);
    const dateNow = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1001);

    const snapshot = await conn.fetchToolsSnapshot();

    expect(snapshot.tools.map((t) => t.name)).toEqual(['a']);
    expect(snapshot.complete).toBe(false);
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('time budget'));
    dateNow.mockRestore();
  });

  it('passes the elapsed-time budget to the SDK request timeout', async () => {
    mcpConfig.TOOLS_LIST_TIMEOUT_MS = 25;
    const listTools = jest.fn(
      async (
        _params?: { cursor?: string },
        _options?: { timeout: number; maxTotalTimeout: number },
      ) => {
        throw new Error('Request timed out');
      },
    );
    const conn = createConnectionWithListTools(listTools);

    const tools = await conn.fetchTools();

    expect(tools).toEqual([]);
    expect(listTools).toHaveBeenCalledTimes(1);
    const options = listTools.mock.calls[0][1]!;
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(25);
    expect(options.maxTotalTimeout).toBe(options.timeout);
    expect(mockLogger.error).toHaveBeenCalledWith('[MCP] Failed to fetch tools');
    expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain('Request timed out');
  });

  it('caps the request timeout by a caller deadline shorter than the global budget', async () => {
    mcpConfig.TOOLS_LIST_TIMEOUT_MS = 30000;
    const listTools = jest.fn().mockResolvedValue({ tools: [makeTool('a')] });
    const conn = createConnectionWithListTools(listTools);

    const snapshot = await conn.fetchToolsSnapshot(Date.now() + 40);

    expect(snapshot.complete).toBe(true);
    const options = listTools.mock.calls[0][1]!;
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(40);
  });

  it('keeps the global budget when the caller deadline is further out', async () => {
    mcpConfig.TOOLS_LIST_TIMEOUT_MS = 25;
    const listTools = jest.fn().mockResolvedValue({ tools: [makeTool('a')] });
    const conn = createConnectionWithListTools(listTools);

    await conn.fetchToolsSnapshot(Date.now() + 10_000);

    const options = listTools.mock.calls[0][1]!;
    expect(options.timeout).toBeLessThanOrEqual(25);
  });

  it('stops paginating and reports incomplete when the caller deadline expires mid-walk', async () => {
    mcpConfig.TOOLS_LIST_TIMEOUT_MS = 30000;
    const listTools = jest.fn(async () => ({ tools: [makeTool('a')], nextCursor: 'c1' }));
    const conn = createConnectionWithListTools(listTools);
    const deadline = Date.now() + 20;
    const dateNow = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(deadline - 20)
      .mockReturnValueOnce(deadline - 20)
      .mockReturnValueOnce(deadline - 20)
      .mockReturnValue(deadline + 1);

    const snapshot = await conn.fetchToolsSnapshot(deadline);

    expect(snapshot.tools.map((t) => t.name)).toEqual(['a']);
    expect(snapshot.complete).toBe(false);
    expect(listTools).toHaveBeenCalledTimes(1);
    dateNow.mockRestore();
  });

  it('returns an incomplete empty snapshot without a request or a reservation when the deadline has passed', async () => {
    const listTools = jest.fn();
    const conn = createConnectionWithListTools(listTools);
    const reserve = jest.spyOn(conn, 'reserveToolsPublicationRevision');

    const snapshot = await conn.fetchToolsSnapshot(Date.now() - 1);

    expect(snapshot.tools).toEqual([]);
    expect(snapshot.complete).toBe(false);
    expect(listTools).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('detaches a completed SDK page request from its caller signal', async () => {
    const listTools = jest.fn().mockResolvedValue({ tools: [makeTool('a')] });
    const conn = createConnectionWithListTools(listTools);
    const controller = new AbortController();

    await conn.fetchToolsSnapshot(Date.now() + 5000, controller.signal);

    const options = listTools.mock.calls[0][1]!;
    expect(options.signal === controller.signal).toBe(false);
    expect(options.signal?.aborted).toBe(false);
    controller.abort();
    expect(options.signal?.aborted).toBe(false);
  });

  it('makes no request and no reservation when the signal is already aborted', async () => {
    const listTools = jest.fn();
    const conn = createConnectionWithListTools(listTools);
    const reserve = jest.spyOn(conn, 'reserveToolsPublicationRevision');
    const controller = new AbortController();
    controller.abort();

    const snapshot = await conn.fetchToolsSnapshot(undefined, controller.signal);

    expect(snapshot.complete).toBe(false);
    expect(listTools).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('stops waiting on an in-flight refresh that outlasts the caller deadline', async () => {
    mcpConfig.TOOLS_LIST_TIMEOUT_MS = 30000;
    const conn = createConnectionWithListTools(jest.fn());
    const mutable = conn as unknown as {
      toolListChangeGeneration: number;
      toolListRefreshPromise: Promise<unknown> | null;
    };
    /** A `list_changed` lands mid-fetch, so the ordered read must wait on a refresh... */
    const listTools = jest.fn(async () => {
      mutable.toolListChangeGeneration = 1;
      return { tools: [makeTool('a')] };
    });
    conn.client.listTools = listTools;
    /** ...and that refresh never settles, standing in for one on the connection's own budget. */
    mutable.toolListRefreshPromise = new Promise<void>(() => {});
    jest.spyOn(conn.client, 'getServerCapabilities').mockReturnValue({ tools: {} });

    const start = Date.now();
    const snapshot = await conn.fetchOrderedToolsSnapshot(Date.now() + 30);

    expect(snapshot.complete).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('stops waiting on an in-flight refresh when the caller signal aborts, without a deadline', async () => {
    mcpConfig.TOOLS_LIST_TIMEOUT_MS = 30000;
    const conn = createConnectionWithListTools(jest.fn());
    const mutable = conn as unknown as {
      toolListChangeGeneration: number;
      toolListRefreshPromise: Promise<unknown> | null;
    };
    const listTools = jest.fn(async () => {
      mutable.toolListChangeGeneration = 1;
      return { tools: [makeTool('a')] };
    });
    conn.client.listTools = listTools;
    mutable.toolListRefreshPromise = new Promise<void>(() => {});
    jest.spyOn(conn.client, 'getServerCapabilities').mockReturnValue({ tools: {} });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const start = Date.now();
    const snapshot = await conn.fetchOrderedToolsSnapshot(undefined, controller.signal);

    expect(snapshot.complete).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('stops and warns when the server repeats a cursor instead of looping forever', async () => {
    const listTools = jest.fn().mockResolvedValue({ tools: [makeTool('x')], nextCursor: 'same' });
    const conn = createConnectionWithListTools(listTools);

    const snapshot = await conn.fetchToolsSnapshot();

    expect(listTools).toHaveBeenCalledTimes(2);
    // The second page's tools are collected before the repeated cursor is detected, hence two copies.
    expect(snapshot.tools.map((tool) => tool.name)).toEqual(['x', 'x']);
    expect(snapshot.complete).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('repeated tools/list cursor'),
    );
  });

  it('continues paginating across an empty intermediate page', async () => {
    const listTools = jest.fn(async (params?: { cursor?: string }) => {
      if (params?.cursor == null) {
        return { tools: [], nextCursor: 'c1' };
      }
      return { tools: [makeTool('a')] };
    });
    const conn = createConnectionWithListTools(listTools);

    const tools = await conn.fetchTools();

    expect(tools.map((t) => t.name)).toEqual(['a']);
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it('treats an empty-string nextCursor as a valid cursor, not end-of-list', async () => {
    const listTools = jest.fn(async (params?: { cursor?: string }) => {
      if (params?.cursor == null) {
        return { tools: [makeTool('a')], nextCursor: '' };
      }
      return { tools: [makeTool('b')] };
    });
    const conn = createConnectionWithListTools(listTools);

    const tools = await conn.fetchTools();

    expect(tools.map((t) => t.name)).toEqual(['a', 'b']);
    expect(listTools).toHaveBeenCalledTimes(2);
    expectListToolsCall(listTools, 2, { cursor: '' });
  });

  it('returns the pages already fetched when a later page fails, without throwing', async () => {
    const listTools = jest.fn(async (params?: { cursor?: string }) => {
      if (params?.cursor == null) {
        return { tools: [makeTool('a'), makeTool('b')], nextCursor: 'c1' };
      }
      throw new Error('page 2 boom');
    });
    const conn = createConnectionWithListTools(listTools);

    const tools = await conn.fetchTools();

    expect(tools.map((t) => t.name)).toEqual(['a', 'b']);
    expect(listTools).toHaveBeenCalledTimes(2);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch tools'));
  });

  it('returns an empty array when the first page request rejects', async () => {
    const listTools = jest.fn().mockRejectedValue(new Error('boom'));
    const conn = createConnectionWithListTools(listTools);

    const tools = await conn.fetchTools();

    expect(tools).toEqual([]);
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch tools'));
  });

  it('preserves an authentication rejection without scheduling a health retry', async () => {
    const authError = Object.assign(new Error('unauthorized'), { status: 401 });
    const listTools = jest.fn().mockRejectedValue(authError);
    const conn = createConnectionWithListTools(listTools, true);
    Reflect.set(conn, 'connectionState', 'connected');
    jest.spyOn(conn.client, 'getServerCapabilities').mockReturnValue({ tools: {} });

    const snapshot = await conn.refreshToolList();

    expect(snapshot?.authenticationError).toBe(authError);
    expect(Reflect.get(conn, 'toolListRefreshFailures')).toBe(0);
    expect(Reflect.get(conn, 'toolListRefreshRetryTimer')).toBeNull();
    expect(Reflect.get(conn, 'toolListRefreshSuspended')).toBe(true);
    await Promise.resolve();
    expect(listTools).toHaveBeenCalledTimes(1);

    const ownerSnapshot = await conn.refreshToolList();
    expect(ownerSnapshot?.authenticationError).toBe(authError);
    expect(listTools).toHaveBeenCalledTimes(1);

    conn.emit('connectionChange', 'disconnected');
    expect(await conn.refreshToolList()).toBeUndefined();
    listTools.mockResolvedValue({ tools: [makeTool('recovered')] });
    conn.emit('connectionChange', 'connected');
    const recoveredSnapshot = await conn.refreshToolList();
    expect(recoveredSnapshot?.complete).toBe(true);
    expect(recoveredSnapshot?.authenticationError).toBeUndefined();
  });

  it('cancels an owned catalog read without retrying it in the background', async () => {
    const controller = new AbortController();
    const listTools = jest.fn(
      (_params, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        }),
    );
    const conn = createConnectionWithListTools(listTools, true);
    Reflect.set(conn, 'connectionState', 'connected');
    jest.spyOn(conn.client, 'getServerCapabilities').mockReturnValue({ tools: {} });
    const read = conn.refreshToolList(controller.signal);
    const outcome = read.catch((error: Error) => error);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('request stopped'));
    await expect(outcome).resolves.toMatchObject({ message: 'request stopped' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(Reflect.get(conn, 'toolListRefreshRetryTimer')).toBeNull();
  });

  it('does not treat a JSON-RPC catalog error mentioning auth as transport rejection', async () => {
    const conn = createConnectionWithListTools(
      jest
        .fn()
        .mockRejectedValue(
          new McpError(ErrorCode.InternalError, 'downstream HTTP 401 invalid_token'),
        ),
      true,
    );
    expect((await conn.fetchToolsSnapshot()).authenticationError).toBeUndefined();
  });

  it('keeps ordinary authentication modes eligible for tool-list retry', async () => {
    const authError = Object.assign(new Error('unauthorized'), { status: 401 });
    const listTools = jest.fn().mockRejectedValue(authError);
    const conn = createConnectionWithListTools(listTools);
    Reflect.set(conn, 'connectionState', 'connected');
    jest.spyOn(conn.client, 'getServerCapabilities').mockReturnValue({ tools: {} });

    await conn.refreshToolList();

    expect(Reflect.get(conn, 'toolListRefreshSuspended')).toBe(false);
    expect(Reflect.get(conn, 'toolListRefreshFailures')).toBe(1);
    const retryTimer = Reflect.get(conn, 'toolListRefreshRetryTimer') as NodeJS.Timeout;
    expect(retryTimer).toBeDefined();
    clearTimeout(retryTimer);
  });

  it('does not classify an ordinary tools/list failure as authentication rejection', async () => {
    const conn = createConnectionWithListTools(jest.fn().mockRejectedValue(new Error('boom')));

    const snapshot = await conn.fetchToolsSnapshot();

    expect(snapshot.authenticationError).toBeUndefined();
  });

  it('scopes authentication rejection to the exact concurrent snapshot that observed it', async () => {
    const authError = Object.assign(new Error('unauthorized'), { status: 401 });
    let rejectFirst: ((error: unknown) => void) | undefined;
    const firstPage = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const listTools = jest
      .fn()
      .mockReturnValueOnce(firstPage)
      .mockResolvedValueOnce({ tools: [makeTool('healthy')] });
    const conn = createConnectionWithListTools(listTools);

    const rejected = conn.fetchToolsSnapshot();
    await Promise.resolve();
    const healthy = conn.fetchToolsSnapshot();
    rejectFirst?.(authError);

    await expect(healthy).resolves.toMatchObject({ complete: true });
    await expect(rejected).resolves.toMatchObject({
      complete: false,
      authenticationError: authError,
    });
    expect((await healthy).authenticationError).toBeUndefined();
  });
});

describe('MCPConnection.usesOAuth', () => {
  it.each([
    [{ type: 'streamable-http', url: 'https://example.com/mcp', requiresOAuth: true }, true],
    [{ type: 'streamable-http', url: 'https://example.com/mcp', oauth: {} }, true],
    [{ type: 'streamable-http', url: 'https://example.com/mcp', requiresOAuth: false }, false],
  ] as const)('reports OAuth from the resolved connection config', (serverConfig, expected) => {
    const connection = new MCPConnection({
      serverName: 'oauth-status-test',
      serverConfig,
      useSSRFProtection: false,
    });

    expect(connection.usesOAuth()).toBe(expected);
  });
});
