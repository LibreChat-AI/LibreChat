import * as http from 'http';
import { randomUUID } from 'crypto';
import type { AddressInfo, Socket } from 'net';

/** Tracks open sockets so `close()` can force-destroy keep-alive connections;
 *  a plain `server.close()` otherwise hangs until idle clients disconnect. */
function trackSockets(httpServer: http.Server): () => Promise<void> {
  const sockets = new Set<Socket>();
  httpServer.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      httpServer.close(() => resolve());
    });
}

/**
 * How the mock delivers the -32042 `UrlElicitationRequired` error, mirroring the
 * two wire shapes {@link extractUrlElicitation} must survive:
 *
 * - `http-401`: the shape AWS Bedrock AgentCore Gateway returns live — a JSON-RPC
 *   error body carried on a **non-2xx** HTTP status, so the SDK's streamable-HTTP
 *   transport never parses it as a protocol message and instead throws a
 *   `StreamableHTTPError` whose `.message` embeds the raw body.
 * - `jsonrpc-200`: the spec-pure shape — a JSON-RPC error body on HTTP **200**,
 *   which the SDK parses and surfaces as an `McpError` with `code === -32042`.
 */
export type ElicitationWireShape = 'http-401' | 'jsonrpc-200';

/**
 * JSON serialization of the error body. Gateways/serializers vary here and the
 * exact byte layout matters: an HTTP-wrapped -32042 is matched by scanning the
 * SDK error's `.message` string, so `'pretty'` (which yields `"code": -32042`
 * with a space) is a realistic shape that a naive substring match would miss.
 */
export type ElicitationBodyFormat = 'compact' | 'pretty';

export interface MockElicitationServerOptions {
  /** Fixed port to bind; when omitted an ephemeral port is chosen. */
  port?: number;
  /** Initial value of the in-memory authorization gate. Default `false`. */
  authorized?: boolean;
  /** How the -32042 is delivered. Default `'http-401'` (the AgentCore shape). */
  wireShape?: ElicitationWireShape;
  /** JSON layout of the error body. Default `'compact'`. */
  bodyFormat?: ElicitationBodyFormat;
  /**
   * When true, the NEXT `tools/call` (any tool) is answered with a -32600
   * "Session not initialized" JSON-RPC error, then the flag auto-clears — models
   * the stale-session state seen in production after a reconnection is abandoned.
   * A subsequent call (or a client that re-initializes and retries) succeeds.
   */
  sessionErrorOnce?: boolean;
}

/** The `initialize` request params exactly as they arrived on the wire — lets
 *  tests assert the protocolVersion and capabilities the real client stack sends
 *  (e.g. whether URL-mode elicitation capability actually reaches the server). */
export interface CapturedInitializeRequest {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  clientInfo?: Record<string, unknown>;
}

export interface MockElicitationServerState {
  /** Flipped to `true` by `GET /consent`; gates `get_secret`. */
  authorized: boolean;
  wireShape: ElicitationWireShape;
  bodyFormat: ElicitationBodyFormat;
  /** `tools/call` invocations received, keyed by tool name — asserts retry counts. */
  callCounts: Record<string, number>;
  /** `elicitationId` handed out on the most recent -32042. */
  lastElicitationId?: string;
  /** Raw `initialize` params from the most recent handshake. */
  initializeRequest?: CapturedInitializeRequest;
  /** When true, the next `tools/call` returns -32600 then clears (see options). */
  sessionErrorOnce: boolean;
}

export interface MockElicitationServer {
  /** The MCP endpoint LibreChat connects to (`http://127.0.0.1:<port>/mcp`). */
  readonly url: string;
  /** The authorization link embedded in elicitations (`.../consent`). */
  readonly consentUrl: string;
  /** Non-mutating-for-the-human helper link (`.../reset`) that sets
   *  `authorized=false` so a fresh UI round starts gated again — no process
   *  restart needed. Safe to hit in smoke checks (unlike `/consent`). */
  readonly resetUrl: string;
  readonly port: number;
  readonly state: MockElicitationServerState;
  /** Resets the authorization gate, wire shape, body format, and call counters. */
  reset(options?: {
    authorized?: boolean;
    wireShape?: ElicitationWireShape;
    bodyFormat?: ElicitationBodyFormat;
  }): void;
  close(): Promise<void>;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

const CONSENT_PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Authorization complete</title></head>
  <body style="font-family: system-ui; padding: 2rem;">
    <h1>✅ Authorization complete</h1>
    <p>You can close this tab and return to the chat, then retry the tool.</p>
  </body>
</html>`;

const RESET_PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Reset</title></head>
  <body style="font-family: system-ui; padding: 2rem;">
    <h1>🔄 Reset</h1>
    <p>The next <code>get_secret</code> call will require authorization again.</p>
  </body>
</html>`;

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Uint8Array);
  }
  return Buffer.concat(chunks).toString();
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

const WHOAMI_TOOL = {
  name: 'whoami',
  description: 'Returns a fixed identity string; never requires authorization.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const GET_SECRET_TOOL = {
  name: 'get_secret',
  description: 'Returns a secret payload; gated behind a URL elicitation until authorized.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

/**
 * Starts a standalone MCP Streamable-HTTP server that reproduces the AgentCore
 * Gateway's URL-elicitation behavior with exact control over HTTP status codes
 * (which the real SDK server does not expose). Backed by raw `node:http`.
 *
 * Endpoints:
 * - `POST /mcp` — MCP protocol: `initialize`, `notifications/initialized`,
 *   `tools/list` (`whoami`, `get_secret`), and `tools/call`. `get_secret`
 *   emits -32042 in the configured wire shape until `authorized` flips true.
 * - `GET /consent` — flips `authorized` true and returns a small HTML page, so a
 *   human clicking the elicitation URL completes the flow with zero effort.
 * - `GET /mcp` — 405 (no standalone SSE stream; an expected, error-free case for
 *   the SDK's streamable-HTTP transport).
 */
export async function startMockElicitationServer(
  options: MockElicitationServerOptions = {},
): Promise<MockElicitationServer> {
  const requestedPort = options.port ?? 0;
  const state: MockElicitationServerState = {
    authorized: options.authorized ?? false,
    wireShape: options.wireShape ?? 'http-401',
    bodyFormat: options.bodyFormat ?? 'compact',
    sessionErrorOnce: options.sessionErrorOnce ?? false,
    callCounts: {},
  };

  // Finalized once the OS assigns a port (handles `port: 0`); the request-handler
  // and error-builder closures read these bindings at call time, after listen.
  let origin = `http://127.0.0.1:${requestedPort}`;
  let consentUrl = `${origin}/consent`;

  const buildElicitationError = (id: string | number | undefined) => {
    const elicitationId = randomUUID();
    state.lastElicitationId = elicitationId;
    return {
      jsonrpc: '2.0' as const,
      id: id ?? null,
      error: {
        code: -32042,
        message: 'This request requires authorization.',
        data: {
          elicitations: [
            {
              mode: 'url',
              url: consentUrl,
              message: 'Please authorize access to the mock secret',
              elicitationId,
            },
          ],
        },
      },
    };
  };

  const handleRpc = (msg: JsonRpcMessage, res: http.ServerResponse): void => {
    const { id, method, params } = msg;

    switch (method) {
      case 'initialize':
        state.initializeRequest = {
          protocolVersion: params?.protocolVersion as string | undefined,
          capabilities: params?.capabilities as Record<string, unknown> | undefined,
          clientInfo: params?.clientInfo as Record<string, unknown> | undefined,
        };
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: id ?? null,
          // Echo the client's requested version so negotiation always succeeds
          // (whatever the client sent is, by definition, a version it supports).
          result: {
            protocolVersion: (params?.protocolVersion as string) ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'mock-elicitation-server', version: '1.0.0' },
          },
        });
        return;

      case 'notifications/initialized':
        // A notification has no id and expects no body — 202 Accepted.
        res.writeHead(202).end();
        return;

      case 'tools/list':
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: id ?? null,
          result: { tools: [WHOAMI_TOOL, GET_SECRET_TOOL] },
        });
        return;

      case 'tools/call': {
        const toolName = (params?.name as string) ?? '';
        state.callCounts[toolName] = (state.callCounts[toolName] ?? 0) + 1;

        if (state.sessionErrorOnce) {
          state.sessionErrorOnce = false;
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id: id ?? null,
            error: {
              code: -32600,
              message: 'Session not initialized. Send notifications/initialized first.',
            },
          });
          return;
        }

        if (toolName === 'whoami') {
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id: id ?? null,
            result: { content: [{ type: 'text', text: 'mock-user' }] },
          });
          return;
        }

        if (toolName === 'get_secret') {
          if (state.authorized) {
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id: id ?? null,
              result: { content: [{ type: 'text', text: 's3cr3t-payload' }] },
            });
            return;
          }
          const errorBody = buildElicitationError(id);
          const serialized =
            state.bodyFormat === 'pretty'
              ? JSON.stringify(errorBody, null, 2)
              : JSON.stringify(errorBody);
          res.writeHead(state.wireShape === 'http-401' ? 401 : 200, {
            'content-type': 'application/json',
          });
          res.end(serialized);
          return;
        }

        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: id ?? null,
          error: { code: -32602, message: `Unknown tool: ${toolName}` },
        });
        return;
      }

      default:
        if (id === undefined) {
          // Unknown notification — nothing to answer.
          res.writeHead(202).end();
          return;
        }
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
    }
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', origin);

        if (req.method === 'GET' && url.pathname === '/consent') {
          state.authorized = true;
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(CONSENT_PAGE);
          return;
        }

        if (req.method === 'GET' && url.pathname === '/reset') {
          // De-authorize so repeated UI test rounds start gated again without a
          // process restart. Unlike /consent this is safe to hit in smoke checks.
          state.authorized = false;
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(RESET_PAGE);
          return;
        }

        if (url.pathname === '/mcp') {
          if (req.method === 'POST') {
            const raw = await readRequestBody(req);
            const parsed = JSON.parse(raw) as JsonRpcMessage | JsonRpcMessage[];
            if (Array.isArray(parsed)) {
              // The SDK sends one message per request; a batch is unexpected here.
              sendJson(res, 400, {
                jsonrpc: '2.0',
                id: null,
                error: { code: -32600, message: 'Batched requests are not supported by the mock.' },
              });
              return;
            }
            handleRpc(parsed, res);
            return;
          }
          if (req.method === 'DELETE') {
            // Session termination — acknowledge so client.close() is clean.
            res.writeHead(200).end();
            return;
          }
          if (req.method === 'GET') {
            // No standalone SSE stream; the SDK treats 405 as expected/no-error.
            res.writeHead(405).end();
            return;
          }
        }

        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      } catch (error) {
        sendJson(res, 500, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        });
      }
    })();
  });

  const destroySockets = trackSockets(server);
  await new Promise<void>((resolve) => server.listen(requestedPort, '127.0.0.1', resolve));
  const boundPort = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${boundPort}`;
  consentUrl = `${origin}/consent`;

  return {
    url: `${origin}/mcp`,
    consentUrl,
    resetUrl: `${origin}/reset`,
    port: boundPort,
    state,
    reset(resetOptions) {
      state.authorized = resetOptions?.authorized ?? false;
      state.wireShape = resetOptions?.wireShape ?? state.wireShape;
      state.bodyFormat = resetOptions?.bodyFormat ?? state.bodyFormat;
      state.sessionErrorOnce = false;
      state.callCounts = {};
      state.lastElicitationId = undefined;
      // Intentionally NOT clearing initializeRequest — a fresh connect overwrites
      // it, and tests may assert on it after resetting other state.
    },
    close: () => destroySockets(),
  };
}
