import { buildFixtureExport, cleanupFixtureExport } from './fixture';
import { parseManifest, resolveLayout } from '~/import/manifest';
import { openArchive } from '~/import/archive';

describe('buildFixtureExport', () => {
  afterEach(() => {
    cleanupFixtureExport();
  });

  it('produces a manifest-driven two-shard export with assets', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);

    const manifest = parseManifest(await archive.read('export_manifest.json'));
    const layout = resolveLayout(archive.entries, manifest);

    expect(layout.version).toBe(1);
    expect(layout.conversationShards).toEqual(['conversations-000.json', 'conversations-001.json']);
    expect(layout.assetEntries).toHaveLength(4);
    expect(layout.assetNames).toBe('conversation_asset_file_names.json');

    archive.close();
  });

  it('omitManifest creates archive without manifest, shards discovered by filename', async () => {
    const filepath = await buildFixtureExport({ omitManifest: true });
    const archive = await openArchive(filepath);

    const hasManifest = archive.entries.some((e) => e.name === 'export_manifest.json');
    expect(hasManifest).toBe(false);

    const layout = resolveLayout(archive.entries, null);

    expect(layout.conversationShards).toEqual(['conversations-000.json', 'conversations-001.json']);
    expect(layout.assetEntries).toHaveLength(4);

    archive.close();
  });
});

/**
 * The fixture's structures, not its layout.
 *
 * `CITE` is U+E202, which renders as nothing in an editor and in a diff, so
 * "tidying" it away is a plausible accident rather than a hypothetical one,
 * and every citation assertion downstream would still pass, because they match
 * on the text before the marker. These guards fail loudly instead.
 */
describe('fixture structures every downstream test depends on', () => {
  async function readShard(name: string): Promise<Array<Record<string, never>>> {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    try {
      return JSON.parse((await archive.read(name)).toString('utf8'));
    } finally {
      archive.close();
    }
  }

  it('keeps a real citation anchor with its content reference', async () => {
    const shard = await readShard('conversations-000.json');
    const mapping = (shard[0] as unknown as { mapping: Record<string, { message?: unknown }> })
      .mapping;
    const cited = (mapping.a1 as { message: { content: { parts: string[] }; metadata: unknown } })
      .message;

    expect(cited.content.parts[0]).toBe('Stay in Positano.turn0search0');
    expect(cited.content.parts[0]).toContain('');
    expect((cited.metadata as { content_references: unknown[] }).content_references).toHaveLength(
      1,
    );
  });

  it('keeps the thoughts to reasoning_recap chain the thinking part is built from', async () => {
    const shard = await readShard('conversations-000.json');
    const mapping = (
      shard[0] as unknown as {
        mapping: Record<string, { message: { content: { content_type: string } } }>;
      }
    ).mapping;

    expect(mapping.t1.message.content.content_type).toBe('thoughts');
    expect(mapping.r1.message.content.content_type).toBe('reasoning_recap');
  });

  it('keeps the multimodal parts the asset pipeline resolves', async () => {
    const shard = await readShard('conversations-001.json');
    const mapping = (
      shard[0] as unknown as {
        mapping: Record<
          string,
          { message: { content: { parts: Array<{ content_type?: string }> } } }
        >;
      }
    ).mapping;

    const types = Object.values(mapping)
      .flatMap((node) => node.message?.content?.parts ?? [])
      .map((part) => (typeof part === 'string' ? 'text' : part.content_type));

    expect(types).toContain('image_asset_pointer');
    expect(types).toContain('audio_transcription');
    expect(types).toContain('audio_asset_pointer');
  });
});
