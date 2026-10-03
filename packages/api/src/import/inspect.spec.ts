import { buildFixtureExport, cleanupFixtureExport } from './__data__/fixture';
import { inspectExport } from './inspect';

describe('inspectExport', () => {
  afterEach(() => {
    cleanupFixtureExport();
  });

  it('summarizes conversations, assets, and state without writing', async () => {
    const filepath = await buildFixtureExport();
    const { summary } = await inspectExport(filepath);

    expect(summary.source).toBe('chatgpt');
    expect(summary.manifestVersion).toBe(1);
    expect(summary.shards).toBe(2);
    expect(summary.conversations).toBe(2);
    expect(summary.assets).toBe(4);
    expect(summary.assetBytes).toBe(16);
    expect(summary.archived).toBe(1);
    expect(summary.starred).toBe(1);
  });

  it('still works when the manifest is missing', async () => {
    const filepath = await buildFixtureExport({ omitManifest: true });
    const { summary } = await inspectExport(filepath);

    expect(summary.manifestVersion).toBeNull();
    expect(summary.source).toBe('chatgpt-legacy');
    expect(summary.conversations).toBe(2);
  });

  it('rejects a shard with non-array JSON', async () => {
    const JSZip = (await import('jszip')).default;
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');

    const zip = new JSZip();
    zip.file('conversations-000.json', JSON.stringify({ conversations: [] }));
    zip.file(
      'export_manifest.json',
      JSON.stringify({
        version: 1,
        manifest_file: 'export_manifest.json',
        logical_files: {
          'conversations.json': {
            files: ['conversations-000.json'],
            sharded: true,
          },
        },
      }),
    );
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-nonarr-'));
    const filepath = path.join(dir, 'non-array-shard.zip');
    fs.writeFileSync(filepath, buffer);

    await expect(inspectExport(filepath)).rejects.toThrow(/Unsupported import type/);
  });

  it('counts intact shards after a malformed shard and leaves recovery to the import run', async () => {
    const JSZip = (await import('jszip')).default;
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');

    const valid = {
      conversation_id: 'valid-1',
      title: 'Valid',
      create_time: 1700000000,
      update_time: 1700000100,
      mapping: {},
    };
    const zip = new JSZip();
    zip.file('conversations-000.json', JSON.stringify([valid, null]));
    zip.file('conversations-001.json', '{malformed');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-recoverable-inspect-'));
    const filepath = path.join(dir, 'recoverable.zip');
    fs.writeFileSync(filepath, buffer);

    const inspected = await inspectExport(filepath);

    expect(inspected.format).toBe('chatgpt');
    expect(inspected.summary.conversations).toBe(1);
    expect(inspected.summary.shards).toBe(1);
  });

  it('rejects an archive with no recognizable conversations', async () => {
    const JSZip = (await import('jszip')).default;
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');

    const zip = new JSZip();
    zip.file('readme.txt', 'nothing here');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-empty-'));
    const filepath = path.join(dir, 'empty.zip');
    fs.writeFileSync(filepath, buffer);

    await expect(inspectExport(filepath)).rejects.toThrow(/Unsupported import type/);
  });

  it('rejects a shard whose conversations match no known export shape', async () => {
    const JSZip = (await import('jszip')).default;
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');

    const zip = new JSZip();
    zip.file(
      'conversations-000.json',
      JSON.stringify([{ uuid: 'c1', history: [{ role: 'user', content: 'hi' }] }]),
    );
    zip.file(
      'export_manifest.json',
      JSON.stringify({
        version: 1,
        manifest_file: 'export_manifest.json',
        logical_files: {
          'conversations.json': { files: ['conversations-000.json'], sharded: true },
        },
      }),
    );
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-claude-shaped-'));
    const filepath = path.join(dir, 'claude-shaped.zip');
    fs.writeFileSync(filepath, buffer);

    await expect(inspectExport(filepath)).rejects.toThrow(/Unsupported import type/);
  });

  it('inspects a bare (non-zip) ChatGPT .json upload identically to a zip', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-bare-inspect-'));
    const filepath = path.join(dir, 'bare-export.json');
    fs.writeFileSync(
      filepath,
      JSON.stringify([
        {
          conversation_id: 'bare-1',
          title: 'Bare',
          create_time: 1700000000,
          update_time: 1700000100,
          default_model_slug: 'gpt-4o',
          is_archived: false,
          is_starred: false,
          pinned_time: null,
          mapping: {},
        },
      ]),
    );

    const { summary } = await inspectExport(filepath);

    expect(summary.source).toBe('chatgpt-legacy');
    expect(summary.conversations).toBe(1);
    expect(summary.shards).toBe(1);
  });
});
