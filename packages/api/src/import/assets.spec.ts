import type { Archive } from './archive';

import { buildFixtureExport, cleanupFixtureExport } from './__data__/fixture';
import { ASSET_NAMES_ENTRY, parseManifest, resolveLayout } from './manifest';
import { pointerToEntry, ingestAssets } from './assets';
import { throttleCancelCheck } from './cancel';
import { openArchive } from './archive';

/** Redirects reads of the asset name map to `raw`, delegating every other
 * entry to the real archive, so a test can control that one file's
 * contents without hand-building a whole zip fixture. */
function withAssetNames(archive: Archive, raw: string): Archive {
  return {
    ...archive,
    read: (name: string) =>
      name === ASSET_NAMES_ENTRY ? Promise.resolve(Buffer.from(raw, 'utf8')) : archive.read(name),
  };
}

describe('pointerToEntry', () => {
  it('maps both pointer schemes onto .dat names', () => {
    expect(pointerToEntry('file-service://file-ABC')).toBe('file-ABC.dat');
    expect(pointerToEntry('sediment://file_0000abc')).toBe('file_0000abc.dat');
    expect(pointerToEntry('file-XYZ')).toBe('file-XYZ.dat');
  });
});

describe('ingestAssets', () => {
  afterEach(() => {
    cleanupFixtureExport();
  });

  it('reports invalid runtime pointers without dereferencing them', async () => {
    const archive: Archive = {
      entries: [],
      bare: false,
      read: async () => Buffer.alloc(0),
      close: () => undefined,
    };

    const result = await ingestAssets({
      archive,
      layout: resolveLayout(archive.entries, null),
      userId: 'u1',
      tenantId: undefined,
      pointers: [undefined as never, ''],
      deps: {
        saveBuffer: async () => ({ filepath: '', source: 'local' }),
        createFile: async () => null,
      },
    });

    expect(result.unavailable).toBe(2);
    expect(result.errors).toEqual([
      { code: 'asset_pointer_invalid' },
      { code: 'asset_pointer_invalid' },
    ]);
  });

  it('imports referenced assets and reports the missing ones', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    const saved: Array<{ fileName: string; bytes: number }> = [];
    const result = await ingestAssets({
      archive,
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one', 'file-service://file-two', 'sediment://file_gone'],
      deps: {
        saveBuffer: async ({ fileName, buffer }) => {
          saved.push({ fileName, bytes: buffer.byteLength });
          return { filepath: `/uploads/u1/${fileName}`, source: 'local' };
        },
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(result.imported).toBe(2);
    expect(result.unavailable).toBe(1);
    expect(result.map.size).toBe(2);
    expect(result.map.has('file-service://file-one')).toBe(true);
    expect(result.map.has('sediment://file_gone')).toBe(false);
    expect(saved).toHaveLength(2);

    archive.close();
  });

  it('restores original filenames from the asset name map', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    const names: string[] = [];
    await ingestAssets({
      archive,
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one'],
      deps: {
        saveBuffer: async ({ fileName }) => {
          names.push(fileName);
          return { filepath: `/uploads/u1/${fileName}`, source: 'local' };
        },
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(names[0]).toContain('first.jpg');
    archive.close();
  });

  it('records a storage failure without aborting the rest', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    let calls = 0;
    const result = await ingestAssets({
      archive,
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one', 'file-service://file-two'],
      deps: {
        saveBuffer: async ({ fileName }) => {
          calls += 1;
          if (calls === 1) {
            throw new Error('quota exceeded');
          }
          return { filepath: `/uploads/u1/${fileName}`, source: 'local' };
        },
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(result.imported).toBe(1);
    /** Present in the archive but never stored, so no message can show it. */
    expect(result.unavailable).toBe(1);
    expect(result.errors).toHaveLength(1);
    // The raw storage-driver message never reaches the client. Only a stable
    // error code and export-supplied location reach the report.
    expect(result.errors[0]).toEqual({ code: 'failed', location: 'file-one.dat' });

    archive.close();
  });

  it('populates width and height from a matching attachment', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    const result = await ingestAssets({
      archive,
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one'],
      attachments: new Map([['file-one', { id: 'file-one', width: 640, height: 480 }]]),
      deps: {
        saveBuffer: async ({ fileName }) => ({
          filepath: `/uploads/u1/${fileName}`,
          source: 'local',
        }),
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    const asset = result.map.get('file-service://file-one');
    expect(asset?.width).toBe(640);
    expect(asset?.height).toBe(480);

    archive.close();
  });

  it('prefers the attachment mime_type over the filename extension', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    const result = await ingestAssets({
      archive: withAssetNames(archive, JSON.stringify({ 'file-one.dat': 'first.pdf' })),
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one'],
      attachments: new Map([['file-one', { id: 'file-one', mime_type: 'audio/ogg' }]]),
      deps: {
        saveBuffer: async ({ fileName }) => ({
          filepath: `/uploads/u1/${fileName}`,
          source: 'local',
        }),
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(result.map.get('file-service://file-one')?.type).toBe('audio/ogg');

    archive.close();
  });

  it('keeps a declared image type when the bytes are that image', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    const result = await ingestAssets({
      archive,
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file_generated'],
      attachments: new Map([['file_generated', { id: 'file_generated', mime_type: 'image/png' }]]),
      deps: {
        saveBuffer: async ({ fileName }) => ({
          filepath: `/uploads/u1/${fileName}`,
          source: 'local',
        }),
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(result.map.get('file-service://file_generated')?.type).toBe('image/png');

    archive.close();
  });

  it('does not honour an image type the bytes do not back', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    const result = await ingestAssets({
      archive: withAssetNames(archive, JSON.stringify({ 'file-one.dat': 'first.bin' })),
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one'],
      attachments: new Map([['file-one', { id: 'file-one', mime_type: 'image/heic' }]]),
      deps: {
        saveBuffer: async ({ fileName }) => ({
          filepath: `/uploads/u1/${fileName}`,
          source: 'local',
        }),
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(result.map.get('file-service://file-one')?.type).toBe('application/octet-stream');

    archive.close();
  });

  it('sniffs the mime type when the asset has no name and no attachment metadata', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    const result = await ingestAssets({
      archive,
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['sediment://file_generated'],
      deps: {
        saveBuffer: async ({ fileName }) => ({
          filepath: `/uploads/u1/${fileName}`,
          source: 'local',
        }),
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    const asset = result.map.get('sediment://file_generated');
    expect(asset?.filename).toBe('file_generated');
    expect(asset?.type).toBe('image/png');

    archive.close();
  });

  it('uses the sniffed image extension for the public storage path', async () => {
    const imageWithHtmlSuffix = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      Buffer.from('<script>alert(1)</script>'),
    ]);
    const archive: Archive = {
      entries: [
        { name: ASSET_NAMES_ENTRY, bytes: 32 },
        { name: 'file-one.dat', bytes: imageWithHtmlSuffix.byteLength },
      ],
      bare: false,
      read: async (entry: string) =>
        entry === ASSET_NAMES_ENTRY
          ? Buffer.from(JSON.stringify({ 'file-one.dat': 'payload.html' }))
          : imageWithHtmlSuffix,
      close: () => undefined,
    };
    const stored: Array<{ fileName: string; type: string }> = [];

    const result = await ingestAssets({
      archive,
      layout: { ...resolveLayout(archive.entries, null), assetNames: ASSET_NAMES_ENTRY },
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one'],
      deps: {
        saveBuffer: async ({ fileName, type }) => {
          stored.push({ fileName, type });
          return { filepath: `/images/${fileName}`, source: 'local' };
        },
        createFile: async (data) => ({ file_id: data.file_id }),
      },
    });

    expect(stored).toHaveLength(1);
    expect(stored[0].type).toBe('image/png');
    expect(stored[0].fileName).toMatch(/\.png$/);
    expect(stored[0].fileName).not.toMatch(/\.html$/);
    expect(result.map.get('file-service://file-one')?.filename).toBe('payload.html');
  });

  it('falls back to the dimensions recorded inline on the pointer', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    const result = await ingestAssets({
      archive,
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['sediment://file_generated'],
      references: new Map([
        [
          'sediment://file_generated',
          { pointer: 'sediment://file_generated', width: 1024, height: 1536 },
        ],
      ]),
      deps: {
        saveBuffer: async ({ fileName }) => ({
          filepath: `/uploads/u1/${fileName}`,
          source: 'local',
        }),
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    const asset = result.map.get('sediment://file_generated');
    expect(asset?.width).toBe(1024);
    expect(asset?.height).toBe(1536);

    archive.close();
  });

  it('counts a pointer missing from the archive as processed, so progress reaches its total', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    const progress: number[] = [];
    const pointers = ['file-service://file-one', 'sediment://file_gone'];
    await ingestAssets({
      archive,
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers,
      onProgress: (done) => {
        progress.push(done);
      },
      deps: {
        saveBuffer: async ({ fileName }) => ({
          filepath: `/uploads/u1/${fileName}`,
          source: 'local',
        }),
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(progress[progress.length - 1]).toBe(pointers.length);

    archive.close();
  });

  it('stops after isCancelled turns true, without touching later assets', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    const saveCalls: string[] = [];
    let cancelChecks = 0;
    const result = await ingestAssets({
      archive,
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one', 'file-service://file-two'],
      isCancelled: async () => {
        cancelChecks += 1;
        return cancelChecks > 1;
      },
      deps: {
        saveBuffer: async ({ fileName }) => {
          saveCalls.push(fileName);
          return { filepath: `/uploads/u1/${fileName}`, source: 'local' };
        },
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(saveCalls).toHaveLength(1);
    expect(result.imported).toBe(1);
    expect(result.map.size).toBe(1);

    archive.close();
  });

  it('treats cancellation-store failures as not cancelled and continues importing', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    let cancelChecks = 0;
    const checkCancelled = throttleCancelCheck(async () => {
      cancelChecks += 1;
      throw new Error('cancellation store unavailable');
    });

    await expect(checkCancelled()).resolves.toBe(false);

    const result = await ingestAssets({
      archive,
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one', 'file-service://file-two'],
      isCancelled: checkCancelled,
      deps: {
        saveBuffer: async ({ fileName }) => ({
          filepath: `/uploads/u1/${fileName}`,
          source: 'local',
        }),
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(result.imported).toBe(2);
    expect(result.map.size).toBe(2);
    expect(cancelChecks).toBe(1);
    archive.close();
  });

  it('keeps cancellation-store failures best-effort so created assets stay visible', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    let cancelChecks = 0;
    const result = await ingestAssets({
      archive,
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one', 'file-service://file-two'],
      isCancelled: async () => {
        cancelChecks += 1;
        if (cancelChecks === 2) {
          throw new Error('cancellation store unavailable');
        }
        return false;
      },
      deps: {
        saveBuffer: async ({ fileName }) => ({
          filepath: `/uploads/u1/${fileName}`,
          source: 'local',
        }),
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(result.imported).toBe(2);
    expect(result.map.size).toBe(2);
    archive.close();
  });

  it('reserves the UUID prefix inside the filesystem filename byte limit', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );
    const originalName = `${'a'.repeat(251)}.txt`;
    let storedName = '';

    const result = await ingestAssets({
      archive: withAssetNames(archive, JSON.stringify({ 'file-one.dat': originalName })),
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one'],
      deps: {
        saveBuffer: async ({ fileName }) => {
          storedName = fileName;
          return { filepath: `/uploads/u1/${fileName}`, source: 'local' };
        },
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(Buffer.byteLength(storedName, 'utf8')).toBeLessThanOrEqual(255);
    expect(result.map.get('file-service://file-one')?.filename).toBe(originalName);
    archive.close();
  });

  it('ingests a pointer referenced multiple times exactly once', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    const saveCalls: string[] = [];
    const result = await ingestAssets({
      archive,
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one', 'file-service://file-one', 'file-service://file-one'],
      deps: {
        saveBuffer: async ({ fileName }) => {
          saveCalls.push(fileName);
          return { filepath: `/uploads/u1/${fileName}`, source: 'local' };
        },
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(saveCalls).toHaveLength(1);
    expect(result.map.size).toBe(1);
    expect(result.imported).toBe(1);

    archive.close();
  });

  it('falls back to the bare entry name when the export has no asset name map', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    const result = await ingestAssets({
      archive,
      layout: { ...layout, assetNames: null },
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one'],
      deps: {
        saveBuffer: async ({ fileName }) => ({
          filepath: `/uploads/u1/${fileName}`,
          source: 'local',
        }),
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(result.map.get('file-service://file-one')?.filename).toBe('file-one');

    archive.close();
  });

  it('continues ingesting when the asset name map is malformed JSON', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    const result = await ingestAssets({
      archive: withAssetNames(archive, 'not json'),
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one'],
      deps: {
        saveBuffer: async ({ fileName }) => ({
          filepath: `/uploads/u1/${fileName}`,
          source: 'local',
        }),
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(result.imported).toBe(1);
    expect(result.map.get('file-service://file-one')?.filename).toBe('file-one');

    archive.close();
  });

  it('falls back to the entry name for a .dat file missing from the name map', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    const result = await ingestAssets({
      archive: withAssetNames(archive, JSON.stringify({ 'file-two.dat': 'second.jpg' })),
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one'],
      deps: {
        saveBuffer: async ({ fileName }) => ({
          filepath: `/uploads/u1/${fileName}`,
          source: 'local',
        }),
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(result.map.get('file-service://file-one')?.filename).toBe('file-one');

    archive.close();
  });

  it('reports progress as each asset completes', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    const progress: number[] = [];
    await ingestAssets({
      archive,
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one', 'file-service://file-two'],
      onProgress: (done) => {
        progress.push(done);
      },
      deps: {
        saveBuffer: async ({ fileName }) => ({
          filepath: `/uploads/u1/${fileName}`,
          source: 'local',
        }),
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(progress).toEqual([1, 2]);

    archive.close();
  });

  it('falls back to application/octet-stream for an unknown extension while keeping a real MIME type for known ones', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    const result = await ingestAssets({
      archive: withAssetNames(
        archive,
        JSON.stringify({ 'file-one.dat': 'first.pdf', 'file-two.dat': 'clip.xyz' }),
      ),
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one', 'file-service://file-two'],
      deps: {
        saveBuffer: async ({ fileName }) => ({
          filepath: `/uploads/u1/${fileName}`,
          source: 'local',
        }),
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(result.map.get('file-service://file-one')?.type).toBe('application/pdf');
    expect(result.map.get('file-service://file-two')?.type).toBe('application/octet-stream');

    archive.close();
  });

  it('strips directory components from a mapped name containing forward slashes', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    const saved: string[] = [];
    const result = await ingestAssets({
      archive: withAssetNames(
        archive,
        JSON.stringify({
          'file-one.dat':
            '69a6e640-9640-8397-9003-84ae676527f2/audio/75b7513a-d0e2-4024-9156-c2a2d96321b2.wav',
        }),
      ),
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one'],
      deps: {
        saveBuffer: async ({ fileName }) => {
          saved.push(fileName);
          return { filepath: `/uploads/u1/${fileName}`, source: 'local' };
        },
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(result.imported).toBe(1);
    expect(result.errors).toEqual([]);
    expect(saved[0]).not.toContain('/');
    expect(saved[0].endsWith('-75b7513a-d0e2-4024-9156-c2a2d96321b2.wav')).toBe(true);
    expect(result.map.get('file-service://file-one')?.filename).toBe(
      '75b7513a-d0e2-4024-9156-c2a2d96321b2.wav',
    );

    archive.close();
  });

  it('cannot escape the upload directory via a mapped name containing ".." segments', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    const saved: string[] = [];
    const result = await ingestAssets({
      archive: withAssetNames(archive, JSON.stringify({ 'file-one.dat': '../../etc/passwd' })),
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one'],
      deps: {
        saveBuffer: async ({ fileName }) => {
          saved.push(fileName);
          return { filepath: `/uploads/u1/${fileName}`, source: 'local' };
        },
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(result.imported).toBe(1);
    expect(saved[0]).not.toContain('..');
    expect(saved[0]).not.toContain('/');
    expect(result.map.get('file-service://file-one')?.filename).toBe('passwd');

    archive.close();
  });

  it('neutralizes a mapped name containing Windows-style backslash separators', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    const saved: string[] = [];
    const result = await ingestAssets({
      archive: withAssetNames(
        archive,
        JSON.stringify({
          'file-one.dat':
            '699ef7b9-eaa4-838a-b307-eba213e48730\\video\\0add091d-1b12-4535-8592-edcb23153e14.mp4',
        }),
      ),
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one'],
      deps: {
        saveBuffer: async ({ fileName }) => {
          saved.push(fileName);
          return { filepath: `/uploads/u1/${fileName}`, source: 'local' };
        },
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(result.imported).toBe(1);
    expect(saved[0]).not.toContain('\\');
    expect(saved[0]).not.toContain('/');
    expect(result.map.get('file-service://file-one')?.filename).toBe(
      '0add091d-1b12-4535-8592-edcb23153e14.mp4',
    );

    archive.close();
  });

  it('keeps two entries that sanitize to the same leaf name from overwriting each other', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    const saved: string[] = [];
    const result = await ingestAssets({
      archive: withAssetNames(
        archive,
        JSON.stringify({
          'file-one.dat': 'conv-a/audio/clip.wav',
          'file-two.dat': 'conv-b/audio/clip.wav',
        }),
      ),
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one', 'file-service://file-two'],
      deps: {
        saveBuffer: async ({ fileName }) => {
          saved.push(fileName);
          return { filepath: `/uploads/u1/${fileName}`, source: 'local' };
        },
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(result.imported).toBe(2);
    expect(new Set(saved).size).toBe(2);
    expect(result.map.get('file-service://file-one')?.filename).toBe('clip.wav');
    expect(result.map.get('file-service://file-two')?.filename).toBe('clip.wav');

    archive.close();
  });

  it('falls back to a slash-bearing attachment name and still stores it as a leaf', async () => {
    const filepath = await buildFixtureExport();
    const archive = await openArchive(filepath);
    const layout = resolveLayout(
      archive.entries,
      parseManifest(await archive.read('export_manifest.json')),
    );

    const saved: string[] = [];
    const result = await ingestAssets({
      archive: withAssetNames(archive, JSON.stringify({})),
      layout,
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one'],
      attachments: new Map([['file-one', { id: 'file-one', name: 'conv-a/images/photo.png' }]]),
      deps: {
        saveBuffer: async ({ fileName }) => {
          saved.push(fileName);
          return { filepath: `/uploads/u1/${fileName}`, source: 'local' };
        },
        createFile: async (data) => ({ file_id: data.file_id as string }),
      },
    });

    expect(result.map.get('file-service://file-one')?.filename).toBe('photo.png');
    expect(saved[0]).not.toContain('/');

    archive.close();
  });
});

/** The name map is optional decoration; any shape other than an object of
 * strings used to reach `originalLeafName` and throw on `.split`, losing the
 * attachment over a cosmetic file the import does not need. */
describe('ingestAssets with a malformed asset-name map', () => {
  function stubArchive(names: string): Archive {
    return {
      entries: [
        { name: ASSET_NAMES_ENTRY, bytes: names.length },
        { name: 'file-one.dat', bytes: 4 },
      ],
      bare: false,
      read: async (entry: string) =>
        entry === ASSET_NAMES_ENTRY ? Buffer.from(names) : Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      close: () => undefined,
    };
  }

  const deps = {
    saveBuffer: async ({ fileName }: { fileName: string }) => ({
      filepath: `/uploads/u1/${fileName}`,
      source: 'local',
    }),
    createFile: async (data: { file_id: string }) => ({ file_id: data.file_id }),
  };

  it.each([
    ['null', 'null'],
    ['an array', '[1,2,3]'],
    ['a non-string value', '{"file-one.dat":{"nested":true}}'],
    ['a number value', '{"file-one.dat":42}'],
    ['a mixed string and non-string value', '{"file-one.dat":"override.txt","other.dat":42}'],
  ])('ignores a map that is %s and still imports the asset', async (_label, names) => {
    const archive = stubArchive(names);
    const layout = resolveLayout(archive.entries, null);

    const result = await ingestAssets({
      archive,
      layout: { ...layout, assetNames: ASSET_NAMES_ENTRY },
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one'],
      deps,
    });

    expect(result.imported).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.map.get('file-service://file-one')?.type).toBe('image/png');
    expect(result.map.get('file-service://file-one')?.filename).toBe('file-one');
  });

  it('still honours a well-formed map', async () => {
    const archive = stubArchive('{"file-one.dat":"holiday.png"}');
    const layout = resolveLayout(archive.entries, null);

    const result = await ingestAssets({
      archive,
      layout: { ...layout, assetNames: ASSET_NAMES_ENTRY },
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://file-one'],
      deps,
    });

    expect(result.map.get('file-service://file-one')?.filename).toBe('holiday.png');
  });
});

/** A deployment can point `fileStrategies.image` and `.document` at different
 * backends, and an export mixes images with audio, video, and PDFs. Resolving
 * one strategy for the whole archive put non-image attachments on the image
 * backend, where the deployment never meant them to live. */
describe('ingestAssets storage strategy', () => {
  it('passes each asset its resolved type and records the backend it landed on', async () => {
    const seen: Array<{ type: string }> = [];
    const archive: Archive = {
      entries: [
        { name: 'png-one.dat', bytes: 4 },
        { name: 'pdf-one.dat', bytes: 4 },
      ],
      bare: false,
      read: async (entry: string) =>
        entry === 'png-one.dat'
          ? Buffer.from([0x89, 0x50, 0x4e, 0x47])
          : Buffer.from([0x25, 0x50, 0x44, 0x46]),
      close: () => undefined,
    };

    const result = await ingestAssets({
      archive,
      layout: resolveLayout(archive.entries, null),
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://png-one', 'file-service://pdf-one'],
      deps: {
        saveBuffer: async ({ fileName, type }) => {
          seen.push({ type });
          return {
            filepath: `/${type.startsWith('image/') ? 'images' : 'documents'}/${fileName}`,
            source: type.startsWith('image/') ? 'image_backend' : 'document_backend',
          };
        },
        createFile: async (data) => ({ file_id: data.file_id }),
      },
    });

    expect(seen.map((entry) => entry.type).sort()).toEqual(['application/pdf', 'image/png']);
    expect(result.map.get('file-service://png-one')?.filepath).toMatch(/^\/images\//);
    expect(result.map.get('file-service://pdf-one')?.filepath).toMatch(/^\/documents\//);
  });

  it('records the backend on the file row, not a single archive-wide value', async () => {
    const sources: string[] = [];
    const archive: Archive = {
      entries: [{ name: 'pdf-one.dat', bytes: 4 }],
      bare: false,
      read: async () => Buffer.from([0x25, 0x50, 0x44, 0x46]),
      close: () => undefined,
    };

    await ingestAssets({
      archive,
      layout: resolveLayout(archive.entries, null),
      userId: 'u1',
      tenantId: undefined,
      pointers: ['file-service://pdf-one'],
      deps: {
        saveBuffer: async () => ({ filepath: '/documents/x', source: 'document_backend' }),
        createFile: async (data) => {
          sources.push(data.source);
          return { file_id: data.file_id };
        },
      },
    });

    expect(sources).toEqual(['document_backend']);
  });
});

/** Under `retentionMode: all` the batch builder gives imported conversations
 * and messages a deadline. An attachment without the same deadline outlives
 * the chat that shows it, in exactly the deployments that require everything
 * to expire. */
describe('ingestAssets retention', () => {
  const archive: Archive = {
    entries: [{ name: 'png-one.dat', bytes: 4 }],
    bare: false,
    read: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    close: () => undefined,
  };

  async function ingestWith(expiredAt?: Date) {
    const rows: Array<{ expiredAt?: Date }> = [];
    await ingestAssets({
      archive,
      layout: resolveLayout(archive.entries, null),
      userId: 'u1',
      tenantId: undefined,
      expiredAt,
      pointers: ['file-service://png-one'],
      deps: {
        saveBuffer: async ({ fileName }) => ({
          filepath: `/uploads/u1/${fileName}`,
          source: 'local',
        }),
        createFile: async (data) => {
          rows.push(data);
          return { file_id: data.file_id };
        },
      },
    });
    return rows;
  }

  it('stamps the retention deadline on the imported file row', async () => {
    const expiredAt = new Date('2030-01-01T00:00:00.000Z');

    const rows = await ingestWith(expiredAt);

    expect(rows).toHaveLength(1);
    expect(rows[0].expiredAt).toEqual(expiredAt);
  });

  it('leaves the row without a deadline when the deployment sets none', async () => {
    const rows = await ingestWith(undefined);

    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('expiredAt');
  });
});
