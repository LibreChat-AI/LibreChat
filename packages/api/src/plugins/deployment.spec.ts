import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  PLUGIN_MCP_SCHEMA_ID,
  PLUGIN_MANIFEST_SCHEMA_ID,
  DEPLOYMENT_PLUGINS_DIR_ENV,
} from './constants';
import { loadPluginsFromDirectory, resolveDeploymentPluginDirectory } from './deployment';

let base: string;
let pluginsDir: string;

function skillDocument(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} documents for the user on request.\n---\n\n# ${name}\n\nSteps to follow.\n`;
}

async function writePlugin(
  directoryName: string,
  files: Record<string, string>,
  manifest: Record<string, unknown> | null = {},
): Promise<void> {
  const root = path.join(pluginsDir, directoryName);
  await fs.promises.mkdir(root, { recursive: true });
  if (manifest !== null) {
    files['plugin.json'] = JSON.stringify({
      $schema: PLUGIN_MANIFEST_SCHEMA_ID,
      name: directoryName,
      ...manifest,
    });
  }
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, contents);
  }
}

function mcpDocument(servers: Record<string, unknown>): string {
  return JSON.stringify({ $schema: PLUGIN_MCP_SCHEMA_ID, mcpServers: servers });
}

function load() {
  return loadPluginsFromDirectory(pluginsDir, { projectRoot: base, env: {} });
}

beforeEach(async () => {
  base = await fs.promises.realpath(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lc-plugin-deploy-')),
  );
  pluginsDir = path.join(base, 'plugin');
  await fs.promises.mkdir(pluginsDir, { recursive: true });
});

afterEach(async () => {
  await fs.promises.rm(base, { recursive: true, force: true });
});

describe('resolveDeploymentPluginDirectory', () => {
  it('defaults to plugin/ under the project root', () => {
    const resolved = resolveDeploymentPluginDirectory({ projectRoot: '/srv/app', env: {} });
    expect(resolved).toEqual({ directory: '/srv/app/plugin', explicitlyConfigured: false });
  });

  it('honors an absolute configured directory', () => {
    const resolved = resolveDeploymentPluginDirectory({
      projectRoot: '/srv/app',
      env: { [DEPLOYMENT_PLUGINS_DIR_ENV]: '/mnt/plugins' },
    });
    expect(resolved).toEqual({ directory: '/mnt/plugins', explicitlyConfigured: true });
  });
});

describe('loadPluginsFromDirectory', () => {
  it('returns an empty registry when the directory is absent and unconfigured', async () => {
    const registry = await loadPluginsFromDirectory(path.join(base, 'missing'), { env: {} });
    expect(registry.list()).toHaveLength(0);
  });

  it('throws when an explicitly configured directory is absent', async () => {
    await expect(
      loadPluginsFromDirectory(path.join(base, 'missing'), {
        env: {},
        explicitlyConfigured: true,
      }),
    ).rejects.toThrow(/could not be read/);
  });

  it('loads each immediate child directory as one plugin', async () => {
    await writePlugin('alpha', { 'skills/alpha-skill/SKILL.md': skillDocument('alpha-skill') });
    await writePlugin('beta', {
      'mcp.json': mcpDocument({ beta: { type: 'streamable-http', url: 'https://b.example/mcp' } }),
    });

    const registry = await load();
    expect(registry.list().map((plugin) => plugin.manifest.name)).toEqual(['alpha', 'beta']);
    expect(registry.skills().map((skill) => skill.name)).toEqual(['alpha-skill']);
    expect(Object.keys(registry.mcpServers())).toEqual(['beta']);
  });

  it('creates a persistent data directory per plugin', async () => {
    await writePlugin('alpha', {});
    const registry = await load();
    const dataDirectory = registry.list()[0].dataDirectory;
    expect(dataDirectory).toBe(path.join(base, 'data/plugins', 'alpha'));
    expect((await fs.promises.stat(dataDirectory)).isDirectory()).toBe(true);
  });

  it('skips a rejected plugin and keeps the rest', async () => {
    await writePlugin('broken', { 'plugin.json': '{ not json' }, null);
    await writePlugin('good', { 'skills/good-skill/SKILL.md': skillDocument('good-skill') });

    const registry = await load();
    expect(registry.list().map((plugin) => plugin.manifest.name)).toEqual(['good']);
    expect(registry.diagnostics().map((issue) => issue.code)).toContain('manifest_invalid_json');
  });

  it('ignores loose files beside the plugin directories', async () => {
    await fs.promises.writeFile(path.join(pluginsDir, 'README.md'), 'not a plugin');
    await writePlugin('alpha', {});
    const registry = await load();
    expect(registry.list()).toHaveLength(1);
  });

  it('isolates a plugin whose data directory cannot be created', async () => {
    const dataRoot = path.join(base, 'data/plugins');
    await fs.promises.mkdir(dataRoot, { recursive: true });
    await fs.promises.writeFile(path.join(dataRoot, 'alpha'), 'occupied by a file');
    await writePlugin('alpha', {});
    await writePlugin('beta', { 'skills/beta-skill/SKILL.md': skillDocument('beta-skill') });

    const registry = await load();
    expect(registry.list().map((plugin) => plugin.manifest.name)).toEqual(['beta']);
    expect(registry.skills().map((skill) => skill.name)).toEqual(['beta-skill']);
    expect(registry.diagnostics().map((issue) => issue.code)).toContain(
      'data_directory_unavailable',
    );
  });

  it('identifies a rejected plugin by its directory', async () => {
    await writePlugin('broken-one', { 'plugin.json': '{ not json' }, null);
    await writePlugin('broken-two', { 'plugin.json': '{ also not json' }, null);

    const registry = await load();
    const locations = registry.diagnostics().map((issue) => issue.location);
    expect(locations).toContain(path.join(pluginsDir, 'broken-one') + '/plugin.json');
    expect(locations).toContain(path.join(pluginsDir, 'broken-two') + '/plugin.json');
  });

  describe('name conflicts', () => {
    it('refuses a second plugin claiming the same manifest name', async () => {
      await writePlugin('first', {}, { name: 'shared-name' });
      await writePlugin('second', {}, { name: 'shared-name' });

      const registry = await load();
      expect(registry.list()).toHaveLength(1);
      expect(registry.diagnostics().map((issue) => issue.code)).toContain('manifest_name_conflict');
    });

    it('does not let a refused duplicate contribute components', async () => {
      await writePlugin(
        'first',
        { 'skills/from-first/SKILL.md': skillDocument('from-first') },
        { name: 'shared-name' },
      );
      await writePlugin(
        'second',
        { 'skills/from-second/SKILL.md': skillDocument('from-second') },
        { name: 'shared-name' },
      );

      const registry = await load();
      expect(registry.skills().map((skill) => skill.name)).toEqual(['from-first']);
    });

    it('keeps the first skill and reports the duplicate', async () => {
      await writePlugin('alpha', { 'skills/shared/SKILL.md': skillDocument('shared') });
      await writePlugin('beta', { 'skills/shared/SKILL.md': skillDocument('shared') });

      const registry = await load();
      expect(registry.skills()).toHaveLength(1);
      expect(registry.diagnostics().map((issue) => issue.message)).toContainEqual(
        expect.stringContaining('already provided by another plugin'),
      );
    });

    it('keeps the first MCP server and reports the duplicate', async () => {
      const server = { github: { type: 'streamable-http', url: 'https://a.example/mcp' } };
      await writePlugin('alpha', { 'mcp.json': mcpDocument(server) });
      await writePlugin('beta', { 'mcp.json': mcpDocument(server) });

      const registry = await load();
      expect(Object.keys(registry.mcpServers())).toEqual(['github']);
      expect(registry.diagnostics().map((issue) => issue.code)).toContain('mcp_server_invalid');
    });
  });
});
