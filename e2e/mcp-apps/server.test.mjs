import assert from 'node:assert/strict';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.env.E2E_MCP_APP_TEST_PORT || '18768');
const origin = `http://127.0.0.1:${port}`;

async function waitForReady(child) {
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`Timed out waiting for MCP App fixture:\n${output}`));
    }, 10_000);
    const poll = setInterval(() => {
      if (output.includes('MCP App fixture listening')) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve();
      }
      if (child.exitCode != null) {
        clearInterval(poll);
        clearTimeout(timeout);
        reject(new Error(`MCP App fixture exited before readiness:\n${output}`));
      }
    }, 20);
  });
}

test('official SDK fixture exposes App and legacy producers with follow-up operations', async () => {
  const child = spawn(process.execPath, ['e2e/setup/fake-mcp-app-server.mjs'], {
    cwd: root,
    env: { ...process.env, E2E_MCP_APP_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const client = new Client({ name: 'mcp-app-fixture-test', version: '1.0.0' });

  try {
    await waitForReady(child);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));

    const tools = await client.listTools();
    const showApp = tools.tools.find((tool) => tool.name === 'show_app');
    const showLinkApp = tools.tools.find((tool) => tool.name === 'show_link_app');
    const showLegacy = tools.tools.find((tool) => tool.name === 'show_legacy');
    const legacyAction = tools.tools.find((tool) => tool.name === 'legacy_action');
    const followUp = tools.tools.find((tool) => tool.name === 'follow_up');
    assert.equal(showApp?._meta?.ui?.resourceUri, 'ui://e2e/app.html');
    assert.equal(showLinkApp?._meta?.ui?.resourceUri, 'ui://e2e/link-app.html');
    assert.ok(showLegacy);
    assert.ok(legacyAction);
    assert.deepEqual(followUp?._meta?.ui?.visibility, ['app']);

    const result = await client.callTool({ name: 'show_app', arguments: { label: 'server-test' } });
    assert.deepEqual(result.structuredContent, { label: 'server-test', stage: 'initial' });
    const embedded = result.content.find((item) => item.type === 'resource');
    assert.equal(embedded?.resource.mimeType, 'text/html;profile=mcp-app');
    assert.match(embedded?.resource.text ?? '', /tool-result-embedded-document/);
    assert.doesNotMatch(embedded?.resource.text ?? '', /resources-read-document/);

    const linkResult = await client.callTool({
      name: 'show_link_app',
      arguments: { label: 'server-test' },
    });
    const linkResource = linkResult.content.find((item) => item.type === 'resource');
    assert.equal(linkResource?.resource.uri, 'ui://e2e/link-app.html');
    assert.deepEqual(linkResource?.resource._meta?.ui?.csp, {
      resourceDomains: [`http://localhost:${port}`],
    });

    const appDocument = await client.readResource({ uri: 'ui://e2e/app.html' });
    assert.match(appDocument.contents[0]?.text ?? '', /resources-read-document/);
    assert.match(
      appDocument.contents[0]?.text ?? '',
      /<meta name="mcp-app-sdk-version" content="1\.7\.5" \/>/,
    );
    assert.match(appDocument.contents[0]?.text ?? '', /name: 'LibreChat E2E App'/);
    const linkDocument = await client.readResource({ uri: 'ui://e2e/link-app.html' });
    assert.match(linkDocument.contents[0]?.text ?? '', /resources-read-document/);
    assert.deepEqual(linkDocument.contents[0]?._meta?.ui?.csp, {
      resourceDomains: [`http://localhost:${port}`],
    });

    const legacyResult = await client.callTool({
      name: 'show_legacy',
      arguments: { label: 'server-test' },
    });
    const legacy = legacyResult.content.find((item) => item.type === 'resource');
    assert.equal(legacy?.resource.uri, 'ui://e2e/legacy.html');
    assert.equal(legacy?.resource.mimeType, 'text/html');
    assert.match(legacy?.resource.text ?? '', /data-testid="legacy-action"/);

    const legacyActionResult = await client.callTool({
      name: 'legacy_action',
      arguments: { label: 'server-test' },
    });
    assert.equal(legacyActionResult.content[0]?.text, 'legacy-action:server-test');

    const listed = await client.listResources();
    assert.deepEqual(listed.resources.map((resource) => resource.uri).sort(), [
      'ui://e2e/app.html',
      'ui://e2e/details/current',
      'ui://e2e/link-app.html',
    ]);
    const detail = await client.readResource({ uri: 'ui://e2e/details/current' });
    assert.equal(detail.contents[0]?.text, 'fixture-detail:current');
    const templates = await client.listResourceTemplates();
    assert.equal(templates.resourceTemplates[0]?.uriTemplate, 'ui://e2e/details/{id}');

    const followUpResult = await client.callTool({
      name: 'follow_up',
      arguments: { label: 'server-test' },
    });
    assert.deepEqual(followUpResult.structuredContent, { followUp: 'server-test' });

    const debug = await fetch(`${origin}/__debug/events`).then((response) => response.json());
    assert.deepEqual(
      debug.events.map((event) => event.method),
      [
        'tools/call:show_app',
        'tools/call:show_link_app',
        'resources/read:show_app',
        'resources/read:show_link_app',
        'tools/call:show_legacy',
        'tools/call:legacy_action',
        'resources/read:details',
        'tools/call:follow_up',
      ],
    );
  } finally {
    await client.close().catch(() => undefined);
    child.kill('SIGTERM');
    if (child.exitCode == null) {
      await once(child, 'exit');
    }
  }
});
