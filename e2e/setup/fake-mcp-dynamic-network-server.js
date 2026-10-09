#!/usr/bin/env node

const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const {
  StreamableHTTPServerTransport,
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { watchDynamicTool } = require('./dynamic-mcp-tools');

const PORT = Number.parseInt(process.env.E2E_MCP_DYNAMIC_PORT || '8766', 10);
const HOST = '127.0.0.1';

function createMcpServer(name, transportLabel) {
  const server = new McpServer({ name, version: '1.0.0' });
  server.registerTool(
    'transport_probe',
    {
      description: `Confirms that the real ${transportLabel} MCP transport is connected.`,
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text', text: `${transportLabel} connected` }] }),
  );
  const stopWatching = watchDynamicTool(server);
  return { server, stopWatching };
}

/** @type {Map<string, { transport: InstanceType<typeof StreamableHTTPServerTransport>, server: InstanceType<typeof McpServer>, stopWatching: () => void }>} */
const streamableSessions = new Map();
/** @type {Map<string, { transport: InstanceType<typeof SSEServerTransport>, server: InstanceType<typeof McpServer>, stopWatching: () => void }>} */
const sseSessions = new Map();

async function handleStreamableRequest(req, res) {
  const sessionId = req.headers['mcp-session-id'];
  let session = typeof sessionId === 'string' ? streamableSessions.get(sessionId) : undefined;

  if (!session) {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    const mcp = createMcpServer('e2e-streamable', 'Streamable HTTP');
    session = { transport, ...mcp };
    await mcp.server.connect(transport);
  }

  await session.transport.handleRequest(req, res);

  const connectedSessionId = session.transport.sessionId;
  if (connectedSessionId && !streamableSessions.has(connectedSessionId)) {
    streamableSessions.set(connectedSessionId, session);
    session.transport.onclose = () => {
      streamableSessions.delete(connectedSessionId);
      session.stopWatching();
    };
  }
}

async function handleSSEConnect(res) {
  const transport = new SSEServerTransport('/messages', res);
  const mcp = createMcpServer('e2e-sse', 'SSE');
  const session = { transport, ...mcp };
  sseSessions.set(transport.sessionId, session);
  transport.onclose = () => {
    sseSessions.delete(transport.sessionId);
    session.stopWatching();
  };
  await mcp.server.connect(transport);
}

const httpServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (url.pathname === '/mcp') {
      await handleStreamableRequest(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/sse') {
      await handleSSEConnect(res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId') || '';
      const session = sseSessions.get(sessionId);
      if (!session) {
        res.writeHead(404);
        res.end();
        return;
      }
      await session.transport.handlePostMessage(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  } catch (error) {
    console.error('[fake-mcp-dynamic-network-server] request failed', error);
    if (!res.headersSent) {
      res.writeHead(500);
    }
    res.end();
  }
});

async function shutdown() {
  const sessions = [...streamableSessions.values(), ...sseSessions.values()];
  streamableSessions.clear();
  sseSessions.clear();
  await Promise.all(
    sessions.map(async ({ server, stopWatching }) => {
      stopWatching();
      await server.close().catch(() => undefined);
    }),
  );
  httpServer.close(() => process.exit(0));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

httpServer.listen(PORT, HOST, () => {
  console.log(`[e2e] dynamic MCP server listening on http://${HOST}:${PORT}`);
});
