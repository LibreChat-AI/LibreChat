#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod/v4';

const require = createRequire(import.meta.url);
const HOST = '127.0.0.1';
const PORT = Number(process.env.E2E_MCP_APP_PORT || '8768');
const ORIGIN = `http://${HOST}:${PORT}`;
const LINK_ORIGIN = `http://localhost:${PORT}`;
const APP_URI = 'ui://e2e/app.html';
const LINK_APP_URI = 'ui://e2e/link-app.html';
const LEGACY_URI = 'ui://e2e/legacy.html';
const LEGACY_MIMELESS_URI = 'ui://e2e/legacy-mimeless.html';
const DETAIL_URI = 'ui://e2e/details/current';
const SDK_PATH = require.resolve('@modelcontextprotocol/ext-apps/app-with-deps');
const SDK_SOURCE = fs.readFileSync(SDK_PATH, 'utf8');
const SDK_PACKAGE = JSON.parse(
  fs.readFileSync(path.resolve(path.dirname(SDK_PATH), '../../package.json'), 'utf8'),
);
const appConstructor = SDK_SOURCE.match(/\b([A-Za-z_$][\w$]*) as App\b/)?.[1];
if (!appConstructor) {
  throw new Error('Could not resolve App constructor from the installed ext-apps bundle');
}
const inlineSdkSource = SDK_SOURCE.replace(/export\{[^}]+\};?\s*$/, '').replace(
  /<\/script/gi,
  '<\\/script',
);

const events = [];

function record(method, params = {}) {
  events.push({ method, params });
}

const embeddedToolResultHtml = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Tool result document</title></head>
  <body><p data-testid="tool-result-document">tool-result-embedded-document</p></body>
</html>`;

const appHtml = `<!doctype html>
<html lang="en">
  <template data-testid="inert-head"><head><title>inert template head</title></head></template>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="mcp-app-sdk-version" content="${SDK_PACKAGE.version}" />
  <title>LibreChat MCP App fixture</title>
  <style>
    body { font: 14px system-ui, sans-serif; margin: 12px; }
    button { margin: 4px; }
    output { display: block; white-space: pre-wrap; }
  </style>
  <body>
    <main data-testid="mcp-app-fixture">
      <p data-testid="document-source">resources-read-document</p>
      <p data-testid="status">connecting</p>
      <p data-testid="input"></p>
      <p data-testid="result"></p>
      <p data-testid="result-content"></p>
      <p data-testid="events"></p>
      <p data-testid="capabilities"></p>
      <button data-testid="call-tool" type="button">Call follow-up tool</button>
      <button data-testid="read-resource" type="button">Read resource</button>
      <button data-testid="list-resources" type="button">List resources</button>
      <button data-testid="send-message" type="button">Send message</button>
      <button data-testid="open-link" type="button">Open permitted link</button>
      <output data-testid="operation"></output>
    </main>
    <script type="module">
      ${inlineSdkSource}

      const byTestId = (id) => document.querySelector('[data-testid="' + id + '"]');
      const write = (id, value) => {
        byTestId(id).textContent = typeof value === 'string' ? value : JSON.stringify(value);
      };
      const run = async (operation) => {
        try {
          write('operation', await operation());
        } catch (error) {
          write('operation', 'error:' + (error instanceof Error ? error.message : String(error)));
        }
      };
      const lifecycleEvents = [];
      const recordLifecycle = (event) => {
        lifecycleEvents.push(event);
        write('events', lifecycleEvents.join(','));
      };

      const app = new ${appConstructor}({ name: 'LibreChat E2E App', version: '1.0.0' }, {}, {
        autoResize: false,
      });
      app.ontoolinput = ({ arguments: args }) => {
        write('input', args);
        recordLifecycle('input');
      };
      app.ontoolresult = (result) => {
        write('result', result.structuredContent ?? result.content);
        write('result-content', result.content);
        recordLifecycle('result');
      };
      app.onteardown = async () => {
        document.documentElement.dataset.tornDown = 'true';
        return {};
      };

      await app.connect();
      const capabilities = app.getHostCapabilities() ?? {};
      write('capabilities', Object.keys(capabilities).sort());
      write('status', 'connected');
      await app.sendSizeChanged({ height: 260, width: 640 });

      byTestId('call-tool').disabled = !capabilities.serverTools;
      byTestId('read-resource').disabled = !capabilities.serverResources;
      byTestId('list-resources').disabled = !capabilities.serverResources;
      byTestId('send-message').disabled = !capabilities.message;
      byTestId('open-link').disabled = !capabilities.openLinks;

      byTestId('call-tool').addEventListener('click', () => run(async () => {
        const result = await app.callServerTool({
          name: 'follow_up',
          arguments: { label: 'from-view' },
        });
        return result.structuredContent;
      }));
      byTestId('read-resource').addEventListener('click', () => run(async () => {
        const result = await app.readServerResource({ uri: '${DETAIL_URI}' });
        return result.contents[0]?.text;
      }));
      byTestId('list-resources').addEventListener('click', () => run(async () => {
        const result = await app.listServerResources();
        return { uris: result.resources.map((resource) => resource.uri).sort() };
      }));
      byTestId('send-message').addEventListener('click', () => run(async () => {
        await app.sendMessage({
          role: 'user',
          content: [{ type: 'text', text: 'E2E_MCP_APP_MESSAGE:from-view' }],
        });
        return 'message-sent';
      }));
      byTestId('open-link').addEventListener('click', () => run(async () => {
        return app.openLink({ url: '${LINK_ORIGIN}/opened' });
      }));
    </script>
  </body>
</html>`;

const appMeta = {
  ui: { permissions: { camera: {}, microphone: {}, geolocation: {}, clipboardWrite: {} } },
};
const linkAppMeta = { ui: { csp: { resourceDomains: [LINK_ORIGIN] } } };

const legacyHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LibreChat legacy MCP-UI fixture</title>
    <style>
      body { box-sizing: border-box; font: 14px system-ui, sans-serif; margin: 0; padding: 12px; }
      #expanded { height: 220px; }
    </style>
  </head>
  <body>
    <p data-testid="legacy-status">legacy-ready</p>
    <button data-testid="legacy-action" type="button">Run legacy action</button>
    <div data-testid="legacy-expanded" id="expanded" hidden>legacy-expanded</div>
    <script>
      const sendSize = (height) => window.parent.postMessage({
        type: 'ui-size-change',
        payload: { width: 420, height },
      }, '*');
      setTimeout(() => sendSize(120), 50);
      document.querySelector('[data-testid="legacy-action"]').addEventListener('click', () => {
        document.querySelector('#expanded').hidden = false;
        sendSize(360);
        window.parent.postMessage({
          type: 'tool',
          messageId: 'legacy-action-1',
          payload: {
            toolName: 'legacy_action',
            params: { label: 'legacy-view', proof: 'E2E_LEGACY_ACTION' },
          },
        }, '*');
      });
    </script>
  </body>
</html>`;

const legacyMimelessHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LibreChat MIME-less legacy MCP-UI fixture</title>
    <style>body { box-sizing: border-box; font: 14px system-ui, sans-serif; margin: 0; padding: 12px; }</style>
  </head>
  <body>
    <p data-testid="legacy-mimeless-status">legacy-mimeless-ready</p>
    <script>
      setTimeout(() => window.parent.postMessage({
        type: 'ui-size-change',
        payload: { width: 420, height: 140 },
      }, '*'), 50);
    </script>
  </body>
</html>`;

function registerFixtureApp(server, { toolName, uri, meta, resultText }) {
  registerAppTool(
    server,
    toolName,
    {
      description: 'Shows the deterministic LibreChat MCP App integration fixture.',
      inputSchema: { label: z.string() },
      _meta: { ui: { resourceUri: uri, visibility: ['model', 'app'] } },
    },
    async ({ label }) => {
      record(`tools/call:${toolName}`, { label });
      return {
        content: [
          { type: 'text', text: `${resultText}: ${label}` },
          {
            type: 'resource',
            resource: {
              uri,
              mimeType: RESOURCE_MIME_TYPE,
              text: embeddedToolResultHtml,
              _meta: meta,
            },
          },
        ],
        structuredContent: { label, stage: 'initial' },
      };
    },
  );

  registerAppResource(server, `LibreChat E2E App (${toolName})`, uri, { _meta: meta }, async () => {
    record(`resources/read:${toolName}`);
    return {
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: appHtml, _meta: meta }],
    };
  });
}

function createMcpServer() {
  const server = new McpServer({ name: 'e2e-app', version: '1.0.0' });

  registerFixtureApp(server, {
    toolName: 'show_app',
    uri: APP_URI,
    meta: appMeta,
    resultText: 'E2E MCP App result',
  });
  registerFixtureApp(server, {
    toolName: 'show_link_app',
    uri: LINK_APP_URI,
    meta: linkAppMeta,
    resultText: 'E2E MCP link App result',
  });

  server.registerTool(
    'show_legacy',
    {
      description: 'Shows the deterministic legacy inline HTML compatibility fixture.',
      inputSchema: { label: z.string() },
    },
    async ({ label }) => {
      record('tools/call:show_legacy', { label });
      return {
        content: [
          { type: 'text', text: `E2E legacy MCP-UI result: ${label}` },
          {
            type: 'resource',
            resource: {
              uri: LEGACY_URI,
              mimeType: 'text/html',
              text: legacyHtml,
            },
          },
        ],
      };
    },
  );

  server.registerTool(
    'show_legacy_mimeless',
    {
      description: 'Shows a legacy inline HTML resource whose optional MIME is omitted.',
      inputSchema: { label: z.string() },
    },
    async ({ label }) => {
      record('tools/call:show_legacy_mimeless', { label });
      return {
        content: [
          { type: 'text', text: `E2E MIME-less legacy MCP-UI result: ${label}` },
          {
            type: 'resource',
            resource: {
              uri: LEGACY_MIMELESS_URI,
              text: legacyMimelessHtml,
            },
          },
        ],
      };
    },
  );

  server.registerTool(
    'legacy_action',
    {
      description: 'Records a benign action from the legacy inline HTML fixture.',
      inputSchema: { label: z.string() },
    },
    async ({ label }) => {
      record('tools/call:legacy_action', { label });
      return {
        content: [{ type: 'text', text: `legacy-action:${label}` }],
      };
    },
  );

  registerAppTool(
    server,
    'follow_up',
    {
      description: 'Returns a deterministic result to the fixture View.',
      inputSchema: { label: z.string() },
      _meta: { ui: { visibility: ['app'] } },
    },
    async ({ label }) => {
      record('tools/call:follow_up', { label });
      return {
        content: [{ type: 'text', text: `follow-up:${label}` }],
        structuredContent: { followUp: label },
      };
    },
  );

  server.registerResource('Fixture details', DETAIL_URI, { mimeType: 'text/plain' }, async () => {
    record('resources/read:details');
    return {
      contents: [{ uri: DETAIL_URI, mimeType: 'text/plain', text: 'fixture-detail:current' }],
    };
  });

  server.registerResource(
    'Fixture detail template',
    new ResourceTemplate('ui://e2e/details/{id}', { list: undefined }),
    { mimeType: 'text/plain' },
    async (uri, { id }) => ({
      contents: [{ uri: uri.href, mimeType: 'text/plain', text: `fixture-detail:${id}` }],
    }),
  );

  return server;
}

const sessions = new Map();

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', ORIGIN);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/opened') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Permitted MCP App link</title><p>policy-permitted-open</p>');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/__debug/events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/__debug/reset') {
    events.length = 0;
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname !== '/mcp') {
    res.writeHead(404);
    res.end();
    return;
  }

  const sessionId = req.headers['mcp-session-id'];
  let transport = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
  if (!transport) {
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    await createMcpServer().connect(transport);
  }

  await transport.handleRequest(req, res);
  if (transport.sessionId && !sessions.has(transport.sessionId)) {
    sessions.set(transport.sessionId, transport);
    transport.onclose = () => sessions.delete(transport.sessionId);
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[e2e] MCP App fixture listening on ${ORIGIN}/mcp`);
});
