import { buildClaudeFixtureExport, cleanupClaudeFixtureExport } from './claude';
import { resolveLayout, detectExportFormat } from '~/import/manifest';
import { openArchive } from '~/import/archive';

describe('buildClaudeFixtureExport', () => {
  afterEach(() => {
    cleanupClaudeFixtureExport();
  });

  it('produces a zip whose conversations.json is the only shard', async () => {
    const filepath = await buildClaudeFixtureExport();
    const archive = await openArchive(filepath);

    const layout = resolveLayout(archive.entries, null);
    expect(layout.conversationShards).toEqual(['conversations.json']);
    expect(layout.assetEntries).toHaveLength(0);

    /** The out-of-scope entries a real export ships alongside the
     * conversations, present so detection has to ignore them. */
    const names = archive.entries.map((entry) => entry.name).sort();
    expect(names).toEqual([
      'conversations.json',
      'design_chats/d-1.json',
      'memories.json',
      'projects/p-1.json',
      'users.json',
    ]);

    const parsed: unknown = JSON.parse((await archive.read('conversations.json')).toString('utf8'));
    expect(Array.isArray(parsed)).toBe(true);
    expect(detectExportFormat(parsed as unknown[])).toBe('claude');

    archive.close();
  });

  it('bare mode writes the conversations array as a single json upload', async () => {
    const filepath = await buildClaudeFixtureExport({ bare: true });
    const archive = await openArchive(filepath);

    expect(archive.entries.map((entry) => entry.name)).toEqual(['conversations.json']);
    expect(resolveLayout(archive.entries, null).conversationShards).toEqual(['conversations.json']);

    archive.close();
  });

  it('cleans up every temp directory it created', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filepath = await buildClaudeFixtureExport();

    cleanupClaudeFixtureExport();

    expect(fs.existsSync(path.dirname(filepath))).toBe(false);
  });
});
