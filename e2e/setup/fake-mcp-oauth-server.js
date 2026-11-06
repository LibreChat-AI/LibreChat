#!/usr/bin/env node

/**
 * Protected MCP resource used by the resumable OAuth Playwright regression.
 * LibreChat starts the configured OAuth flow before opening the resource when
 * no user token exists, so the test deliberately leaves authorization pending.
 */

const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const {
  StreamableHTTPServerTransport,
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const sessions = new Map();
const accessToken = 'e2e-approved-access-token';

const PORT = Number(process.env.E2E_MCP_OAUTH_PORT || 8767);
const HOST = '127.0.0.1';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (url.pathname === '/authorize' && req.method === 'GET') {
    if (url.searchParams.get('approve') === '1') {
      const redirect = new URL(url.searchParams.get('redirect_uri'));
      redirect.searchParams.set('code', 'e2e-approved-code');
      redirect.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { Location: redirect.toString() });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Authorization intentionally remains pending for the E2E test.');
    return;
  }

  if (url.pathname === '/token' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    if (
      body.get('code') === 'e2e-approved-code' ||
      body.get('refresh_token') === 'e2e-refresh-token'
    ) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'e2e-refresh-token',
        }),
      );
      return;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'authorization_pending' }));
    return;
  }

  if (url.pathname === '/mcp') {
    if (req.headers.authorization === `Bearer ${accessToken}`) {
      const sid = req.headers['mcp-session-id'];
      let transport = typeof sid === 'string' ? sessions.get(sid) : undefined;
      if (!transport) {
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
        const mcp = new McpServer({ name: 'e2e-oauth', version: '1.0.0' });
        mcp.registerTool(
          'echo',
          { description: 'Echo for OAuth reconnection tests.', inputSchema: {} },
          async () => ({ content: [{ type: 'text', text: 'E2E OAuth MCP ready' }] }),
        );
        await mcp.connect(transport);
      }
      await transport.handleRequest(req, res);
      if (transport.sessionId && !sessions.has(transport.sessionId)) {
        sessions.set(transport.sessionId, transport);
        transport.onclose = () => sessions.delete(transport.sessionId);
      }
      return;
    }
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer realm="e2e-oauth"',
    });
    res.end(JSON.stringify({ error: 'invalid_token' }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`[e2e] fake OAuth MCP resource listening on http://${HOST}:${PORT}/mcp`);
});
