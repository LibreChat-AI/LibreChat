import fs from 'fs';
import os from 'os';
import path from 'path';
import type { PluginMcpContext } from './mcp';
import { expandPluginVariables, readMcpConfig } from './mcp';
import { PLUGIN_MCP_SCHEMA_ID } from './constants';

let root: string;
let dataDirectory: string;
let context: PluginMcpContext;

beforeEach(async () => {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lc-plugin-mcp-'));
  root = await fs.promises.realpath(
    await fs.promises
      .mkdir(path.join(base, 'root'), { recursive: true })
      .then(() => path.join(base, 'root')),
  );
  dataDirectory = await fs.promises.realpath(
    await fs.promises
      .mkdir(path.join(base, 'data'), { recursive: true })
      .then(() => path.join(base, 'data')),
  );
  context = { realRoot: root, dataDirectory, declaredVersion: '1.0.0' };
});

afterEach(async () => {
  await fs.promises.rm(path.dirname(root), { recursive: true, force: true });
});

function document(servers: Record<string, unknown>): Record<string, unknown> {
  return { $schema: PLUGIN_MCP_SCHEMA_ID, mcpServers: servers };
}

describe('expandPluginVariables', () => {
  it('replaces every exact occurrence in one pass', () => {
    expect(expandPluginVariables('${PLUGIN_ROOT}/a:${PLUGIN_DATA}/b', '/r', '/d')).toBe(
      '/r/a:/d/b',
    );
  });

  it('does not rescan text introduced by a replacement', () => {
    expect(expandPluginVariables('${PLUGIN_ROOT}', '${PLUGIN_DATA}', '/d')).toBe('${PLUGIN_DATA}');
  });

  it('leaves unrecognized placeholder-like text literal', () => {
    expect(expandPluginVariables('${HOME}/${PLUGIN_ROOTX}', '/r', '/d')).toBe(
      '${HOME}/${PLUGIN_ROOTX}',
    );
  });

  it('treats replacement values containing $ as literal text', () => {
    expect(expandPluginVariables('${PLUGIN_ROOT}/x', '/a$&b', '/d')).toBe('/a$&b/x');
  });
});

describe('readMcpConfig document rules', () => {
  it('accepts an empty mcpServers object', async () => {
    const result = await readMcpConfig(document({}), context);
    expect(result.servers).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
  });

  it('disables MCP when a foreign top-level field is present', async () => {
    const result = await readMcpConfig({ ...document({}), extra: true }, context);
    expect(result.diagnostics[0].code).toBe('mcp_invalid');
  });

  it('disables MCP for an unsupported schema identifier', async () => {
    const result = await readMcpConfig(
      { $schema: 'https://agent-plugins.org/schemas/2.0.0/mcp.schema.json', mcpServers: {} },
      context,
    );
    expect(result.diagnostics[0].code).toBe('mcp_invalid');
  });

  it('reports a version mismatch against plugin.json', async () => {
    const result = await readMcpConfig(document({}), { ...context, declaredVersion: '1.1.0' });
    expect(result.diagnostics[0].code).toBe('mcp_version_mismatch');
    expect(result.servers).toHaveLength(0);
  });

  it('skips only the invalid entry and keeps the rest', async () => {
    const result = await readMcpConfig(
      document({
        good: { type: 'stdio', command: 'node' },
        bad: { type: 'carrier-pigeon', url: 'https://example.com' },
      }),
      context,
    );
    expect(result.servers.map((server) => server.name)).toEqual(['good']);
    expect(result.diagnostics[0].code).toBe('mcp_server_invalid');
  });
});

describe('stdio servers', () => {
  it('maps a bare command with plugin variables expanded', async () => {
    const result = await readMcpConfig(
      document({
        db: {
          type: 'stdio',
          command: 'npx',
          args: ['--config', '${PLUGIN_ROOT}/config/db.json'],
          env: { DATA_DIR: '${PLUGIN_DATA}/database' },
        },
      }),
      context,
    );
    expect(result.servers[0].options).toMatchObject({
      type: 'stdio',
      command: 'npx',
      args: ['--config', `${root}/config/db.json`],
      cwd: root,
    });
    expect(result.servers[0].options).toHaveProperty('env.DATA_DIR', `${dataDirectory}/database`);
  });

  it('supplies the reserved variables in the subprocess environment', async () => {
    const result = await readMcpConfig(
      document({ db: { type: 'stdio', command: 'node' } }),
      context,
    );
    expect(result.servers[0].options).toHaveProperty('env.PLUGIN_ROOT', root);
    expect(result.servers[0].options).toHaveProperty('env.PLUGIN_DATA', dataDirectory);
  });

  it('rejects an entry declaring a reserved environment variable', async () => {
    const result = await readMcpConfig(
      document({ db: { type: 'stdio', command: 'node', env: { PLUGIN_ROOT: '/tmp' } } }),
      context,
    );
    expect(result.servers).toHaveLength(0);
    expect(result.diagnostics[0].message).toContain('reserved');
  });

  it('resolves a plugin-relative command against the plugin root', async () => {
    await fs.promises.mkdir(path.join(root, 'bin'), { recursive: true });
    await fs.promises.writeFile(path.join(root, 'bin', 'server'), '#!/bin/sh\n');
    const result = await readMcpConfig(
      document({ local: { type: 'stdio', command: './bin/server' } }),
      context,
    );
    expect(result.servers[0].options).toHaveProperty('command', path.join(root, 'bin', 'server'));
  });

  it.each([
    ['../bin/server', 'parent-relative'],
    ['/usr/bin/server', 'absolute'],
    ['bin/server', 'bare relative path'],
    ['server --flag', 'shell string'],
  ])('rejects the command %s (%s)', async (command) => {
    const result = await readMcpConfig(document({ s: { type: 'stdio', command } }), context);
    expect(result.servers).toHaveLength(0);
    expect(result.diagnostics[0].code).toBe('mcp_server_invalid');
  });

  it('does not expand placeholders in command', async () => {
    const result = await readMcpConfig(
      document({ s: { type: 'stdio', command: '${PLUGIN_ROOT}' } }),
      context,
    );
    expect(result.servers[0].options).toHaveProperty('command', '${PLUGIN_ROOT}');
  });

  it('accepts each documented cwd form', async () => {
    await fs.promises.mkdir(path.join(root, 'work'), { recursive: true });
    await fs.promises.mkdir(path.join(dataDirectory, 'state'), { recursive: true });
    const result = await readMcpConfig(
      document({
        a: { type: 'stdio', command: 'node', cwd: './work' },
        b: { type: 'stdio', command: 'node', cwd: '${PLUGIN_ROOT}' },
        c: { type: 'stdio', command: 'node', cwd: '${PLUGIN_DATA}/state' },
      }),
      context,
    );
    expect(result.servers.map((server) => (server.options as { cwd?: string }).cwd)).toEqual([
      path.join(root, 'work'),
      root,
      path.join(dataDirectory, 'state'),
    ]);
  });

  it.each(['work', '../work', '${PLUGIN_ROOT}/../escape', '${PLUGIN_DATA}/../escape', '/abs'])(
    'rejects the cwd %s',
    async (cwd) => {
      const result = await readMcpConfig(
        document({ s: { type: 'stdio', command: 'node', cwd } }),
        context,
      );
      expect(result.servers).toHaveLength(0);
    },
  );

  it('rejects a field belonging to another variant', async () => {
    const result = await readMcpConfig(
      document({ s: { type: 'stdio', command: 'node', url: 'https://example.com' } }),
      context,
    );
    expect(result.servers).toHaveLength(0);
  });
});

describe('provenance and name safety', () => {
  it('marks every emitted server as plugin-sourced', async () => {
    const result = await readMcpConfig(
      document({
        local: { type: 'stdio', command: 'node' },
        remote: { type: 'streamable-http', url: 'https://example.com/mcp' },
      }),
      context,
    );
    expect(result.servers.map((server) => server.options.source)).toEqual(['plugin', 'plugin']);
  });

  it('rejects a package that tries to declare its own provenance', async () => {
    const result = await readMcpConfig(
      document({ s: { type: 'stdio', command: 'node', source: 'yaml' } }),
      context,
    );
    expect(result.servers).toHaveLength(0);
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects the reserved name %s',
    async (name) => {
      const result = await readMcpConfig(
        document({ [name]: { type: 'stdio', command: 'node' } }),
        context,
      );
      expect(result.servers).toHaveLength(0);
      expect(result.diagnostics[0].message).toContain('reserved');
    },
  );

  it('rejects a name that would change under tool-name normalization', async () => {
    const result = await readMcpConfig(
      document({ 'sales api': { type: 'stdio', command: 'node' } }),
      context,
    );
    expect(result.servers).toHaveLength(0);
    expect(result.diagnostics[0].message).toContain('sales_api');
  });

  it('keeps normalization-stable names', async () => {
    const result = await readMcpConfig(
      document({ 'sales-api.v2': { type: 'stdio', command: 'node' } }),
      context,
    );
    expect(result.servers.map((server) => server.name)).toEqual(['sales-api.v2']);
  });
});

describe('remote servers', () => {
  it('maps streamable-http and sse entries', async () => {
    const result = await readMcpConfig(
      document({
        api: {
          type: 'streamable-http',
          url: 'https://deploy.example.com/mcp',
          headers: { 'X-Tenant': 'public' },
        },
        legacy: { type: 'sse', url: 'https://legacy.example.com/sse' },
      }),
      context,
    );
    expect(result.servers[0].options).toEqual({
      source: 'plugin',
      type: 'streamable-http',
      url: 'https://deploy.example.com/mcp',
      headers: { 'X-Tenant': 'public' },
    });
    expect(result.servers[1].options).toEqual({
      source: 'plugin',
      type: 'sse',
      url: 'https://legacy.example.com/sse',
    });
  });

  it('allows http only on loopback hosts', async () => {
    const result = await readMcpConfig(
      document({
        local: { type: 'streamable-http', url: 'http://localhost:3000/mcp' },
        loop4: { type: 'streamable-http', url: 'http://127.0.0.1:3000/mcp' },
        loop6: { type: 'streamable-http', url: 'http://[::1]:3000/mcp' },
        remote: { type: 'streamable-http', url: 'http://example.com/mcp' },
      }),
      context,
    );
    expect(result.servers.map((server) => server.name)).toEqual(['local', 'loop4', 'loop6']);
    expect(result.diagnostics[0].message).toContain('https');
  });

  it.each([
    ['https://user:pw@example.com/mcp', 'user information'],
    ['https://example.com/mcp#frag', 'fragment'],
    ['/relative/mcp', 'relative'],
    ['ws://example.com/mcp', 'websocket scheme'],
  ])('rejects the url %s (%s)', async (url) => {
    const result = await readMcpConfig(document({ s: { type: 'streamable-http', url } }), context);
    expect(result.servers).toHaveLength(0);
  });

  it('rejects headers repeated under different casing', async () => {
    const result = await readMcpConfig(
      document({
        s: {
          type: 'streamable-http',
          url: 'https://example.com/mcp',
          headers: { 'X-Tenant': 'a', 'x-tenant': 'b' },
        },
      }),
      context,
    );
    expect(result.servers).toHaveLength(0);
    expect(result.diagnostics[0].message).toContain('casing');
  });

  it.each<[Record<string, string>, string]>([
    [{ 'Bad Header': 'v' }, 'invalid name'],
    [{ 'X-Tenant': 'line\nbreak' }, 'invalid value'],
  ])('rejects malformed headers (%s)', async (headers) => {
    const result = await readMcpConfig(
      document({ s: { type: 'streamable-http', url: 'https://example.com/mcp', headers } }),
      context,
    );
    expect(result.servers).toHaveLength(0);
  });

  it('does not expand placeholders in url or headers', async () => {
    const result = await readMcpConfig(
      document({
        s: {
          type: 'streamable-http',
          url: 'https://example.com/${PLUGIN_ROOT}',
          headers: { 'X-Path': '${PLUGIN_DATA}' },
        },
      }),
      context,
    );
    expect(result.servers[0].options).toMatchObject({
      url: 'https://example.com/${PLUGIN_ROOT}',
      headers: { 'X-Path': '${PLUGIN_DATA}' },
    });
  });
});
