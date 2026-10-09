#!/usr/bin/env node

/**
 * Protected MCP resource used by the resumable OAuth Playwright regression.
 * LibreChat starts the configured OAuth flow before opening the resource when
 * no user token exists, so the test deliberately leaves authorization pending.
 */

const http = require('node:http');

const PORT = Number(process.env.E2E_MCP_OAUTH_PORT || 8767);
const HOST = '127.0.0.1';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (url.pathname === '/authorize' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Authorization intentionally remains pending for the E2E test.');
    return;
  }

  if (url.pathname === '/token' && req.method === 'POST') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'authorization_pending' }));
    return;
  }

  if (url.pathname === '/mcp') {
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
