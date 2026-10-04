import {
  GROK_ASSET_PATH,
  GROK_ENTRY_PATH,
  buildGrokFixtureExport,
  cleanupGrokFixtureExport,
} from './grok';
import { resolveLayout, detectExportFormat } from '~/import/manifest';
import { openArchive } from '~/import/archive';

describe('buildGrokFixtureExport', () => {
  afterEach(() => {
    cleanupGrokFixtureExport();
  });

  it('nests the conversation file under a per-export uuid and finds it by name', async () => {
    const filepath = await buildGrokFixtureExport();
    const archive = await openArchive(filepath);

    const layout = resolveLayout(archive.entries, null);
    expect(layout.conversationShards).toEqual([GROK_ENTRY_PATH]);
    expect(layout.assetEntries).toHaveLength(0);

    const parsed: unknown = JSON.parse((await archive.read(GROK_ENTRY_PATH)).toString('utf8'));
    expect(detectExportFormat(parsed)).toBe('grok');

    archive.close();
  });

  it('keeps the doubled separator a real export writes into its asset paths', async () => {
    const filepath = await buildGrokFixtureExport();
    const archive = await openArchive(filepath);

    const names = archive.entries.map((entry) => entry.name);
    expect(names).toContain(GROK_ASSET_PATH);
    expect(GROK_ASSET_PATH).toContain('prod-mc-asset-server//');
    expect((await archive.read(GROK_ASSET_PATH)).byteLength).toBe(4);

    archive.close();
  });

  it('ships the sibling json files that make the lone-json fallback inapplicable', async () => {
    const filepath = await buildGrokFixtureExport();
    const archive = await openArchive(filepath);

    const jsonEntries = archive.entries.filter((entry) => entry.name.endsWith('.json'));
    expect(jsonEntries).toHaveLength(3);

    archive.close();
  });

  it('bare mode writes the export object as a single json upload', async () => {
    const filepath = await buildGrokFixtureExport({ bare: true });
    const archive = await openArchive(filepath);

    expect(archive.entries.map((entry) => entry.name)).toEqual(['prod-grok-backend.json']);
    expect(resolveLayout(archive.entries, null).conversationShards).toEqual([
      'prod-grok-backend.json',
    ]);

    archive.close();
  });

  it('cleans up every temp directory it created', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filepath = await buildGrokFixtureExport();

    cleanupGrokFixtureExport();

    expect(fs.existsSync(path.dirname(filepath))).toBe(false);
  });
});
