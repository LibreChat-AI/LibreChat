import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { ImportFileTooLargeError, sanitizeImportError } from './errors';
import { assertSafeName, openArchive, ZipBombError } from './archive';

const createdDirs: string[] = [];

async function writeZip(files: Record<string, string>): Promise<string> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-'));
  createdDirs.push(dir);
  const filepath = path.join(dir, 'export.zip');
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

interface ZipEntryFixture {
  name: string;
  content: string;
  compression: 'STORE' | 'DEFLATE';
}

async function writeZipEntries(files: ZipEntryFixture[]): Promise<string> {
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.name, file.content, { compression: file.compression });
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-'));
  createdDirs.push(dir);
  const filepath = path.join(dir, 'export.zip');
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

/**
 * Builds compressible-but-varied JSON well over 64 KB, large enough that
 * inflating it requires more than a single internal zlib output chunk.
 * This is the exact shape of entry that stalled forever under yauzl
 * 3.2.1's inflating `openReadStream` on Node 24 (see `archive.ts`); a
 * uniform repeated-byte string is not representative enough since some
 * naive replacements could special-case degenerate input.
 */
function buildVariedJson(entryCount: number): string {
  const records = Array.from({ length: entryCount }, (_, i) => ({
    id: i,
    name: `item-${i}`,
    tags: ['alpha', 'beta', 'gamma'].slice(0, (i % 3) + 1),
    payload: `payload-value-${i}-${(i * 31) % 997}`,
  }));
  return JSON.stringify(records);
}

/**
 * Rewrites every central-directory record's uncompressed-size field to zero,
 * leaving the actual entry data intact. yauzl indexes from the central
 * directory, so this is how an archive lies about how much it will inflate to.
 */
function zeroDeclaredSizes(filepath: string): void {
  const buffer = fs.readFileSync(filepath);
  const CENTRAL_SIGNATURE = 0x02014b50;
  const UNCOMPRESSED_SIZE_OFFSET = 24;

  for (let i = 0; i <= buffer.length - 4; i++) {
    if (buffer.readUInt32LE(i) === CENTRAL_SIGNATURE) {
      buffer.writeUInt32LE(0, i + UNCOMPRESSED_SIZE_OFFSET);
    }
  }
  fs.writeFileSync(filepath, buffer);
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('openArchive', () => {
  it('lists entries and reads one by name', async () => {
    const filepath = await writeZip({ 'a.json': '{"ok":true}', 'b.txt': 'hello' });
    const archive = await openArchive(filepath);

    expect(archive.entries.map((entry) => entry.name).sort()).toEqual(['a.json', 'b.txt']);
    expect((await archive.read('a.json')).toString()).toBe('{"ok":true}');

    archive.close();
  });

  it('rejects entries that escape the archive root', async () => {
    const filepath = await writeZip({ '../evil.json': '{}' });
    await expect(openArchive(filepath)).rejects.toThrow(/traversal/i);
  });

  it('rejects an archive with too many entries', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) {
      files[`f${i}.json`] = '{}';
    }
    const filepath = await writeZip(files);
    await expect(openArchive(filepath, { maxEntries: 10 })).rejects.toThrow(ZipBombError);
  });

  it('rejects an entry larger than the per-entry cap while streaming', async () => {
    const filepath = await writeZip({ 'big.json': 'x'.repeat(5000) });
    const archive = await openArchive(filepath, { maxEntryBytes: 100 });
    await expect(archive.read('big.json')).rejects.toThrow(ZipBombError);
    archive.close();
  });

  it('throws a clear error for a missing entry', async () => {
    const filepath = await writeZip({ 'a.json': '{}' });
    const archive = await openArchive(filepath);
    await expect(archive.read('nope.json')).rejects.toThrow(/nope\.json/);
    archive.close();
  });

  /**
   * The index-time sum uses the central directory's declared sizes, which an
   * archive controls. Zeroing them walks the whole archive past that check, so
   * the only thing standing between a lying archive and unbounded output is
   * the real byte count accumulated across reads.
   */
  it('accumulates real decompressed bytes even when the archive understates them', async () => {
    /** DEFLATE, because yauzl requires a STORED entry's compressed and
     * uncompressed sizes to match and would reject the doctored header. */
    const filepath = await writeZipEntries([
      { name: 'a.json', content: 'x'.repeat(60), compression: 'DEFLATE' },
      { name: 'b.json', content: 'y'.repeat(60), compression: 'DEFLATE' },
    ]);
    zeroDeclaredSizes(filepath);
    const archive = await openArchive(filepath, { maxTotalBytes: 100 });

    expect(archive.entries.every((entry) => entry.bytes === 0)).toBe(true);
    await archive.read('a.json');
    await expect(archive.read('b.json')).rejects.toThrow(ZipBombError);

    archive.close();
  });

  /**
   * A ChatGPT run reads every shard twice: once to scan for assets, once to
   * convert. Charging both passes made a legitimate export over half the cap
   * fail partway through the second one with a zip-bomb error. The cap bounds
   * how much distinct data the archive can yield; a re-read yields nothing new
   * and is still bounded individually by the per-entry cap.
   */
  it('charges an entry once however many times it is read', async () => {
    const filepath = await writeZip({ 'a.json': 'x'.repeat(60) });
    const archive = await openArchive(filepath, { maxTotalBytes: 100 });

    await expect(archive.read('a.json')).resolves.toHaveLength(60);
    await expect(archive.read('a.json')).resolves.toHaveLength(60);
    await expect(archive.read('a.json')).resolves.toHaveLength(60);

    archive.close();
  });

  it('charges a bare JSON upload once however many times it is read', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-reread-'));
    createdDirs.push(dir);
    const filepath = path.join(dir, 'export.json');
    fs.writeFileSync(filepath, 'x'.repeat(60));
    const archive = await openArchive(filepath, { maxTotalBytes: 100 });

    await expect(archive.read('export.json')).resolves.toHaveLength(60);
    await expect(archive.read('export.json')).resolves.toHaveLength(60);

    archive.close();
  });
});

describe('openArchive (large / compressed entries)', () => {
  it('reads a DEFLATE entry spanning multiple inflate chunks and returns the exact original bytes', async () => {
    const content = buildVariedJson(4000);
    expect(content.length).toBeGreaterThan(64 * 1024);

    const filepath = await writeZipEntries([{ name: 'big.json', content, compression: 'DEFLATE' }]);
    const archive = await openArchive(filepath);

    const result = await archive.read('big.json');
    expect(result.toString('utf8')).toBe(content);

    archive.close();
  });

  it('reads a STORED (uncompressed) entry and returns the exact original bytes', async () => {
    const content = 'hello from a stored entry';
    const filepath = await writeZipEntries([{ name: 'stored.txt', content, compression: 'STORE' }]);
    const archive = await openArchive(filepath);

    const result = await archive.read('stored.txt');
    expect(result.toString('utf8')).toBe(content);

    archive.close();
  });

  it('rejects a DEFLATE entry whose decompressed size exceeds the per-entry cap', async () => {
    const content = buildVariedJson(4000);
    const filepath = await writeZipEntries([{ name: 'big.json', content, compression: 'DEFLATE' }]);
    const archive = await openArchive(filepath, { maxEntryBytes: 1000 });

    await expect(archive.read('big.json')).rejects.toThrow(ZipBombError);

    archive.close();
  });
});

describe('openArchive (bare / non-zip upload)', () => {
  function writeBareFile(content: string, filename: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-bare-'));
    createdDirs.push(dir);
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, content);
    return filepath;
  }

  it('wraps a bare JSON file as a single entry named after the upload', async () => {
    const filepath = writeBareFile('{"ok":true}', 'my-export.json');
    const archive = await openArchive(filepath);

    expect(archive.entries).toEqual([{ name: 'my-export.json', bytes: 11 }]);
    expect((await archive.read('my-export.json')).toString()).toBe('{"ok":true}');

    archive.close();
  });

  it('uses the configured shard limit for bare uploads', async () => {
    const originalFileLimit = process.env.CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES;
    const originalShardLimit = process.env.CONVERSATION_IMPORT_MAX_SHARD_SIZE_BYTES;
    process.env.CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES = '1000';
    process.env.CONVERSATION_IMPORT_MAX_SHARD_SIZE_BYTES = '100';

    try {
      const oversized = writeBareFile('x'.repeat(700), 'large.json');
      await expect(openArchive(oversized)).rejects.toThrow(ImportFileTooLargeError);

      const filepath = writeBareFile('x'.repeat(50), 'small.json');
      const archive = await openArchive(filepath);
      await expect(archive.read('small.json')).resolves.toHaveLength(50);
      archive.close();
    } finally {
      if (originalFileLimit === undefined) {
        delete process.env.CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES;
      } else {
        process.env.CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES = originalFileLimit;
      }
      if (originalShardLimit === undefined) {
        delete process.env.CONVERSATION_IMPORT_MAX_SHARD_SIZE_BYTES;
      } else {
        process.env.CONVERSATION_IMPORT_MAX_SHARD_SIZE_BYTES = originalShardLimit;
      }
    }
  });

  /** The upload limit is sized for a `.zip`, so a bare JSON between the two
   * caps clears both the client-side check and multer. Rejecting on the stat
   * means it fails in milliseconds and as its own error, rather than after
   * streaming the whole file and reporting it as an oversized archive. */
  it('rejects a bare JSON file larger than the per-entry cap without reading it', async () => {
    const filepath = writeBareFile('x'.repeat(5000), 'big.json');

    await expect(openArchive(filepath, { maxEntryBytes: 100 })).rejects.toThrow(
      ImportFileTooLargeError,
    );
  });

  it('maps an oversized bare JSON file onto a message naming the workaround', async () => {
    const filepath = writeBareFile('x'.repeat(5000), 'big.json');
    const error = await openArchive(filepath, { maxEntryBytes: 100 }).catch((e: unknown) => e);

    expect(sanitizeImportError(error, 'test')).toMatch(/compress it into a \.zip/i);
  });

  it('rejects immediately when a bare JSON file exceeds the total-bytes cap by its own size', async () => {
    const filepath = writeBareFile('x'.repeat(200), 'huge.json');

    await expect(openArchive(filepath, { maxTotalBytes: 100 })).rejects.toThrow(ZipBombError);
  });

  it('throws a clear error for an unknown entry name on a bare JSON file', async () => {
    const filepath = writeBareFile('{}', 'export.json');
    const archive = await openArchive(filepath);

    await expect(archive.read('nope.json')).rejects.toThrow(/nope\.json/);
    archive.close();
  });
});

describe('assertSafeName', () => {
  it('rejects a relative traversal segment', () => {
    expect(() => assertSafeName('../evil.json')).toThrow(/traversal/i);
  });

  it('rejects an absolute POSIX path', () => {
    expect(() => assertSafeName('/etc/passwd')).toThrow(/absolute/i);
  });

  it('rejects a Windows drive-letter path', () => {
    expect(() => assertSafeName('C:\\windows\\evil.json')).toThrow(/absolute/i);
  });

  it('rejects a traversal segment nested inside a longer path', () => {
    expect(() => assertSafeName('a/../../b')).toThrow(/traversal/i);
  });

  it('accepts a benign nested path', () => {
    expect(() => assertSafeName('dir/file.json')).not.toThrow();
  });
});
