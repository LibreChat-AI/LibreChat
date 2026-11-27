import fs from 'fs';
import os from 'os';
import path from 'path';
import type { PluginHookCapabilities } from '~/agents/hooks';
import { PLUGIN_MANIFEST_SCHEMA_ID, PLUGIN_MCP_SCHEMA_ID } from './constants';
import { loadPlugin } from './load';

const CAPABILITIES: PluginHookCapabilities = {
  handlerTypes: new Set(['command'] as const),
  translateMatcher: ({ matcher }) => (matcher === 'Bash' ? 'execute_code' : undefined),
};

let base: string;
let root: string;
let dataRoot: string;

function skillDocument(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} documents for the user on request.\n---\n\n# ${name}\n\nSteps to follow when the user asks.\n`;
}

async function write(relativePath: string, contents: string): Promise<void> {
  const target = path.join(root, relativePath);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, contents);
}

async function writeManifest(overrides: Record<string, unknown> = {}): Promise<void> {
  await write(
    'plugin.json',
    JSON.stringify({ $schema: PLUGIN_MANIFEST_SCHEMA_ID, name: 'demo', ...overrides }),
  );
}

function load() {
  return loadPlugin(root, { dataRoot, hookCapabilities: CAPABILITIES });
}

beforeEach(async () => {
  base = await fs.promises.realpath(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lc-plugin-load-')),
  );
  root = path.join(base, 'demo');
  dataRoot = path.join(base, 'plugin-data');
  await fs.promises.mkdir(root, { recursive: true });
  await fs.promises.mkdir(dataRoot, { recursive: true });
});

afterEach(async () => {
  await fs.promises.rm(base, { recursive: true, force: true });
});

describe('loadPlugin', () => {
  it('loads a manifest-only plugin without reporting missing components', async () => {
    await writeManifest();
    const result = await load();
    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') {
      return;
    }
    expect(result.plugin.skills).toHaveLength(0);
    expect(result.plugin.mcpServers).toHaveLength(0);
    expect(result.plugin.diagnostics).toHaveLength(0);
  });

  it('creates the persistent plugin data directory', async () => {
    await writeManifest();
    const result = await load();
    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') {
      return;
    }
    expect(result.plugin.dataDirectory).toBe(path.join(dataRoot, 'demo'));
    expect((await fs.promises.stat(result.plugin.dataDirectory)).isDirectory()).toBe(true);
  });

  it('loads skills, MCP servers, and extension hooks together', async () => {
    await writeManifest({ version: '1.2.0' });
    await write('skills/summarize/SKILL.md', skillDocument('summarize'));
    await write('skills/summarize/references/checklist.md', '- check\n');
    await write(
      'mcp.json',
      JSON.stringify({
        $schema: PLUGIN_MCP_SCHEMA_ID,
        mcpServers: { api: { type: 'streamable-http', url: 'https://example.com/mcp' } },
      }),
    );
    await write(
      'ai.librechat/hooks/hooks.json',
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] }] },
      }),
    );

    const result = await load();
    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') {
      return;
    }
    expect(result.plugin.skills.map((skill) => skill.name)).toEqual(['summarize']);
    expect(result.plugin.skills[0].sourceMetadata.plugin).toBe('demo');
    expect(result.plugin.mcpServers.map((server) => server.name)).toEqual(['api']);
    expect(result.plugin.hooks?.plan.summary).toMatchObject({ declared: 1, ready: 1 });
  });

  it('gives plugin skills ids distinct from deployment skills of the same name', async () => {
    await writeManifest();
    await write('skills/summarize/SKILL.md', skillDocument('summarize'));
    const first = await load();

    root = path.join(base, 'other');
    await fs.promises.mkdir(root, { recursive: true });
    await writeManifest({ name: 'other' });
    await write('skills/summarize/SKILL.md', skillDocument('summarize'));
    const second = await load();

    expect(first.status === 'loaded' && second.status === 'loaded').toBe(true);
    if (first.status !== 'loaded' || second.status !== 'loaded') {
      return;
    }
    expect(first.plugin.skills[0]._id.toString()).not.toBe(second.plugin.skills[0]._id.toString());
  });

  describe('component isolation', () => {
    it('skips an invalid skill and keeps the valid one', async () => {
      await writeManifest();
      await write('skills/good/SKILL.md', skillDocument('good'));
      await write('skills/broken/SKILL.md', '---\nname: \n---\n');
      const result = await load();
      expect(result.status).toBe('loaded');
      if (result.status !== 'loaded') {
        return;
      }
      expect(result.plugin.skills.map((skill) => skill.name)).toEqual(['good']);
      expect(result.plugin.diagnostics.map((issue) => issue.code)).toContain('skill_invalid');
    });

    it('does not search deeper than the immediate children of skills/', async () => {
      await writeManifest();
      await write('skills/group/nested/SKILL.md', skillDocument('nested'));
      const result = await load();
      expect(result.status === 'loaded' && result.plugin.skills).toHaveLength(0);
    });

    it('treats a non-directory skills location as an invalid component type', async () => {
      await writeManifest();
      await write('skills', 'not a directory');
      const result = await load();
      expect(result.status).toBe('loaded');
      if (result.status !== 'loaded') {
        return;
      }
      expect(result.plugin.diagnostics.map((issue) => issue.code)).toContain(
        'component_location_invalid',
      );
    });

    it('disables MCP but keeps skills when mcp.json is malformed', async () => {
      await writeManifest();
      await write('skills/summarize/SKILL.md', skillDocument('summarize'));
      await write('mcp.json', '{ not json');
      const result = await load();
      expect(result.status).toBe('loaded');
      if (result.status !== 'loaded') {
        return;
      }
      expect(result.plugin.skills).toHaveLength(1);
      expect(result.plugin.mcpServers).toHaveLength(0);
      expect(result.plugin.diagnostics.map((issue) => issue.code)).toContain('mcp_invalid_json');
    });

    it('reports declared hooks as unexecuted when the host registers no capabilities', async () => {
      await writeManifest();
      await write(
        'ai.librechat/hooks/hooks.json',
        JSON.stringify({
          hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo' }] }] },
        }),
      );
      const result = await loadPlugin(root, { dataRoot });
      expect(result.status).toBe('loaded');
      if (result.status !== 'loaded') {
        return;
      }
      expect(result.plugin.hooks).toBeUndefined();
      expect(result.plugin.diagnostics.map((issue) => issue.code)).toContain('hooks_unsupported');
    });

    it('stays silent about hooks when a plugin declares none', async () => {
      await writeManifest();
      const result = await loadPlugin(root, { dataRoot });
      expect(result.status === 'loaded' && result.plugin.diagnostics).toHaveLength(0);
    });

    it('reports a matcher the host cannot translate instead of running it', async () => {
      await writeManifest();
      await write(
        'ai.librechat/hooks/hooks.json',
        JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: 'Unknown', hooks: [{ type: 'command', command: 'echo' }] }],
          },
        }),
      );
      const result = await load();
      expect(result.status).toBe('loaded');
      if (result.status !== 'loaded') {
        return;
      }
      expect(result.plugin.hooks?.plan.summary).toMatchObject({ declared: 1, ready: 0 });
      expect(result.plugin.diagnostics.map((issue) => issue.code)).toContain('hooks_unsupported');
    });

    it('keeps other components when the hooks document is malformed', async () => {
      await writeManifest();
      await write('skills/summarize/SKILL.md', skillDocument('summarize'));
      await write('ai.librechat/hooks/hooks.json', JSON.stringify({ hooks: { PreToolUse: 'no' } }));
      const result = await load();
      expect(result.status).toBe('loaded');
      if (result.status !== 'loaded') {
        return;
      }
      expect(result.plugin.skills).toHaveLength(1);
      expect(result.plugin.hooks).toBeUndefined();
      expect(result.plugin.diagnostics.map((issue) => issue.code)).toContain('hooks_invalid');
    });
  });

  describe('rejection', () => {
    it('rejects a plugin with no manifest', async () => {
      const result = await load();
      expect(result.status).toBe('rejected');
      expect(result.status === 'rejected' && result.diagnostics[0].code).toBe('manifest_missing');
    });

    it('rejects a plugin whose manifest is not valid JSON', async () => {
      await write('plugin.json', '{ nope');
      const result = await load();
      expect(result.status === 'rejected' && result.diagnostics[0].code).toBe(
        'manifest_invalid_json',
      );
    });

    it('does not load components when the manifest is rejected', async () => {
      await write('plugin.json', JSON.stringify({ $schema: PLUGIN_MANIFEST_SCHEMA_ID }));
      await write('skills/summarize/SKILL.md', skillDocument('summarize'));
      const result = await load();
      expect(result.status).toBe('rejected');
    });
  });

  describe('path containment', () => {
    it('skips a skill whose SKILL.md is a symlink escaping the plugin root', async () => {
      await writeManifest();
      const outside = path.join(base, 'outside');
      await fs.promises.mkdir(outside, { recursive: true });
      await fs.promises.writeFile(path.join(outside, 'SKILL.md'), skillDocument('escaped'));
      await fs.promises.mkdir(path.join(root, 'skills', 'escaped'), { recursive: true });
      await fs.promises.symlink(
        path.join(outside, 'SKILL.md'),
        path.join(root, 'skills', 'escaped', 'SKILL.md'),
      );

      const result = await load();
      expect(result.status).toBe('loaded');
      if (result.status !== 'loaded') {
        return;
      }
      expect(result.plugin.skills).toHaveLength(0);
      expect(result.plugin.diagnostics.map((issue) => issue.code)).toContain('path_escape');
    });

    it('accepts a symlink that resolves within the plugin root', async () => {
      await writeManifest();
      await write('shared/SKILL.md', skillDocument('shared'));
      await fs.promises.mkdir(path.join(root, 'skills', 'shared'), { recursive: true });
      await fs.promises.symlink(
        path.join(root, 'shared', 'SKILL.md'),
        path.join(root, 'skills', 'shared', 'SKILL.md'),
      );

      const result = await load();
      expect(result.status === 'loaded' && result.plugin.skills.map((s) => s.name)).toEqual([
        'shared',
      ]);
    });
  });
});
