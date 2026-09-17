import path from 'path';
import * as fs from 'fs';
import JSZip from 'jszip';
import yauzl from 'yauzl';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { megabyte } from 'librechat-data-provider';
import {
  ArchiveValidationError,
  assertSafeZipSize,
  assertSafeZipSizeIfArchive,
  isZipArchive,
  ZipBombError,
} from './zipSafety';

const fixturesDir = __dirname;
const readFixture = (name: string): Buffer => fs.readFileSync(path.join(fixturesDir, name));

/**
 * Build a ZIP archive whose entries inflate to exactly `decompressedBytes`
 * each. The data is highly compressible (single repeated character) so
 * compressed size stays small — roughly 0.5% of inflated size for runs
 * of zero bytes. Used to simulate the zip-bomb attack pattern from the
 * SEC validation PoC on PR #12934.
 */
const buildBombArchive = async (
  entries: Array<{ name: string; decompressedBytes: number }>,
): Promise<Buffer> => {
  const zip = new JSZip();
  for (const { name, decompressedBytes } of entries) {
    zip.file(name, Buffer.alloc(decompressedBytes, 0));
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
};

/**
 * Build a ZIP of `count` one-byte entries. Both the compressed archive
 * and the `count` inflated bytes sit far inside the size caps, so this
 * isolates the per-entry openReadStream + inflate-teardown cost that
 * only the entry cap bounds.
 */
const buildManyEntryArchive = async (count: number): Promise<Buffer> => {
  const zip = new JSZip();
  for (let i = 0; i < count; i++) {
    zip.file(`entry${i}.bin`, 'x');
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
};

/** Build a small, well-formed ZIP for the happy-path tests. */
const buildBenignArchive = async (): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file('hello.txt', 'hello world');
  zip.file('subdir/note.txt', 'second entry');
  return zip.generateAsync({ type: 'nodebuffer' });
};

describe('assertSafeZipSize', () => {
  test('passes a benign small archive', async () => {
    const buffer = await buildBenignArchive();
    await expect(assertSafeZipSize(buffer)).resolves.toBeUndefined();
  });

  test('aborts an active entry stream and closes the archive', async () => {
    const controller = new AbortController();
    const readStream = new PassThrough();
    const close = jest.fn();
    const zipEvents = new EventEmitter();
    const readEntry = jest.fn(() => {
      queueMicrotask(() => zipEvents.emit('entry', { fileName: 'slow.bin' } as yauzl.Entry));
    });
    const openReadStream = jest.fn(
      (
        _entry: yauzl.Entry,
        callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void,
      ) => callback(null, readStream),
    );
    const zipfile = Object.assign(zipEvents, {
      entryCount: 1,
      close,
      readEntry,
      openReadStream,
    }) as unknown as yauzl.ZipFile;
    const fromBuffer = jest
      .spyOn(yauzl, 'fromBuffer')
      /* @types/yauzl types the last overload as `(buffer, callback?)`, which is not the
       * one the implementation calls; the cast keeps the three-argument form the code uses. */
      .mockImplementation(((
        _buffer: Buffer,
        _options: yauzl.Options,
        callback: (error: Error | null, opened: yauzl.ZipFile) => void,
      ) => callback(null, zipfile)) as unknown as typeof yauzl.fromBuffer);
    const reason = new Error('artifact extraction timed out');

    try {
      const pending = assertSafeZipSize(Buffer.from('stub'), { signal: controller.signal });
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort(reason);

      await expect(pending).rejects.toBe(reason);
      expect(openReadStream).toHaveBeenCalledTimes(1);
      expect(readStream.destroyed).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      fromBuffer.mockRestore();
      readStream.destroy();
    }
  });

  test('passes an archive whose entries are all under both caps', async () => {
    const buffer = await buildBombArchive([
      { name: 'a.bin', decompressedBytes: 1 * megabyte },
      { name: 'b.bin', decompressedBytes: 1 * megabyte },
    ]);
    await expect(
      assertSafeZipSize(buffer, { maxTotalBytes: 10 * megabyte, maxEntryBytes: 5 * megabyte }),
    ).resolves.toBeUndefined();
  });

  test('throws ZipBombError when a single entry exceeds the per-entry cap', async () => {
    /* Single 5 MB inflated entry compresses to a few KB. Per-entry cap of
     * 1 MB should fire mid-inflate. */
    const buffer = await buildBombArchive([{ name: 'big.bin', decompressedBytes: 5 * megabyte }]);
    await expect(assertSafeZipSize(buffer, { maxEntryBytes: 1 * megabyte })).rejects.toThrow(
      ZipBombError,
    );
  });

  test('throws ZipBombError when total decompressed size exceeds the total cap', async () => {
    /* Many small-but-not-tiny entries that individually pass the per-entry
     * cap but collectively bust the total cap. Catches the multi-entry
     * variant of the attack. */
    const buffer = await buildBombArchive(
      Array.from({ length: 5 }, (_, i) => ({
        name: `chunk${i}.bin`,
        decompressedBytes: 1 * megabyte,
      })),
    );
    await expect(
      assertSafeZipSize(buffer, { maxTotalBytes: 3 * megabyte, maxEntryBytes: 2 * megabyte }),
    ).rejects.toThrow(ZipBombError);
  });

  test('cap-violation error is a ZipBombError, not a generic Error', async () => {
    const buffer = await buildBombArchive([{ name: 'big.bin', decompressedBytes: 5 * megabyte }]);
    /* Distinguishing the bomb case from a generic parse failure lets
     * the UI surface a meaningful "preview unavailable, file too large
     * to inflate" message instead of a vague 500. */
    await expect(assertSafeZipSize(buffer, { maxEntryBytes: 1 * megabyte })).rejects.toMatchObject({
      name: 'ZipBombError',
      code: 'ZIP_BOMB',
    });
  });

  test('rejects a malformed zip', async () => {
    /* Not a real zip — yauzl will throw a parse error (NOT a
     * ZipBombError; that distinction matters to callers). */
    const buffer = Buffer.from('not a real zip');
    await expect(assertSafeZipSize(buffer)).rejects.toThrow();
    await expect(assertSafeZipSize(buffer)).rejects.not.toBeInstanceOf(ZipBombError);
  });

  test('handles archives containing directory entries without crashing', async () => {
    const zip = new JSZip();
    zip.folder('emptydir');
    zip.file('emptydir/file.txt', 'data');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(assertSafeZipSize(buffer)).resolves.toBeUndefined();
  });

  test('uses provided name in the error message for caller-side surfacing', async () => {
    const buffer = await buildBombArchive([{ name: 'big.bin', decompressedBytes: 5 * megabyte }]);
    await expect(
      assertSafeZipSize(buffer, { maxEntryBytes: 1 * megabyte, name: 'evil.docx' }),
    ).rejects.toThrow(/evil\.docx/);
  });

  test('re-PoC: catches the SEC-validation attack pattern (sub-1MB compressed → 100MB+ inflated)', async () => {
    /* Mirrors the SEC validation PoC shape: a sub-1MB compressed
     * archive whose entries inflate to many tens of MB. Tests that the
     * default caps fire on this canonical attack without the caller
     * needing to override anything. The PoC inflated to ~200MB across
     * several entries; we use 50MB for test-suite speed (still well
     * over both default caps). */
    const buffer = await buildBombArchive([
      { name: 'word/document.xml', decompressedBytes: 50 * megabyte },
    ]);
    /* Defense-in-depth check: the compressed payload IS small (proves
     * the input would slip past a compressed-size gate). */
    expect(buffer.length).toBeLessThan(1 * megabyte);
    /* And the validator catches it on default caps. */
    await expect(assertSafeZipSize(buffer)).rejects.toThrow(ZipBombError);
  });

  test('throws ZipBombError when the archive holds more entries than the entry cap', async () => {
    /* Neither byte cap sees this: 64 one-byte entries inflate to 64
     * bytes. The cost is the 64 stream setups, which only the entry
     * cap bounds. */
    const buffer = await buildManyEntryArchive(64);
    await expect(assertSafeZipSize(buffer, { maxEntries: 32 })).rejects.toThrow(ZipBombError);
  });

  test('passes an archive sitting exactly on the entry cap', async () => {
    const buffer = await buildManyEntryArchive(32);
    await expect(assertSafeZipSize(buffer, { maxEntries: 32 })).resolves.toBeUndefined();
  });

  test('entry-count error names the archive and both counts', async () => {
    const buffer = await buildManyEntryArchive(64);
    await expect(assertSafeZipSize(buffer, { maxEntries: 8, name: 'evil.pptx' })).rejects.toThrow(
      /evil\.pptx: entry count \(64\) exceeds the 8-entry cap/,
    );
  });

  test('refuses an over-count archive without inflating a single entry', async () => {
    /* The bomb is the FIRST entry and busts the per-entry byte cap on
     * its own. A validator that enumerated entries before checking the
     * count would inflate it and report the per-entry violation; only
     * a pre-walk refusal reports the entry count. */
    const zip = new JSZip();
    zip.file('bomb.bin', Buffer.alloc(50 * megabyte, 0));
    for (let i = 0; i < 8; i++) {
      zip.file(`filler${i}.bin`, 'x');
    }
    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });

    await expect(
      assertSafeZipSize(buffer, { maxEntries: 4, maxEntryBytes: 1 * megabyte }),
    ).rejects.toThrow(/entry count \(9\) exceeds the 4-entry cap/);
  });

  test('default entry cap catches a many-tiny-entry archive both byte caps wave through', async () => {
    /* 5,000 one-byte entries: ~5 KB inflated, well under 1 MB
     * compressed, and yet thousands of stream setups per upload. */
    const buffer = await buildManyEntryArchive(5000);
    expect(buffer.length).toBeLessThan(1 * megabyte);
    await expect(assertSafeZipSize(buffer)).rejects.toThrow(ZipBombError);
  });

  test.each([
    'deck.pptx',
    'sample.docx',
    'structured.docx',
    'empty.docx',
    'sample.xlsx',
    'empty.xlsx',
    'sample.ods',
    'sample.odt',
  ])('real %s fixture passes the default caps', async (name) => {
    await expect(assertSafeZipSize(readFixture(name))).resolves.toBeUndefined();
  });
});

describe('configurable archive byte ceilings', () => {
  test('refuses an entry above the 25MB default until the configured entry ceiling is raised', async () => {
    const buffer = await buildBombArchive([
      { name: 'worksheet.xml', decompressedBytes: 26 * megabyte },
    ]);

    await expect(assertSafeZipSize(buffer)).rejects.toThrow(
      /exceeds the 25MB per-entry decompressed cap/,
    );
    await expect(
      assertSafeZipSizeIfArchive(buffer, {
        maxEntryBytes: 30 * megabyte,
      }),
    ).resolves.toBeUndefined();
  });

  test('refuses an archive above the 100MB default until the configured total ceiling is raised', async () => {
    const buffer = await buildBombArchive(
      Array.from({ length: 5 }, (_, index) => ({
        name: `part-${index}.xml`,
        decompressedBytes: 21 * megabyte,
      })),
    );

    await expect(assertSafeZipSize(buffer)).rejects.toThrow(ZipBombError);
    await expect(
      assertSafeZipSizeIfArchive(buffer, {
        maxEntryBytes: 25 * megabyte,
        maxTotalBytes: 110 * megabyte,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('isZipArchive', () => {
  /**
   * Real zip readers find the central directory by scanning backwards and tolerate data
   * on either side of the archive, so padding is not a disguise to them. Detection and
   * enforcement are welded together here: whatever this misses skips every cap.
   */
  test.each([['deck.pptx'], ['sample.docx'], ['sample.xlsx'], ['sample.odt']])(
    'detects the real %s fixture',
    (name) => {
      expect(isZipArchive(readFixture(name))).toBe(true);
    },
  );

  /**
   * A comment may legally run 65,535 bytes, so a window that size looks like the natural
   * bound. It is not the one that matters: measured against anydoc, a DOCX with 100KB
   * appended still has its inner entries read, so anything the scan cannot see is a
   * bypass of every decompression cap rather than a saving.
   */
  test.each([
    ['a single appended byte', Buffer.from([0x00])],
    ['an appended block', Buffer.alloc(4096, 0x41)],
    ['a suffix longer than a legal comment', Buffer.alloc(100 * 1024, 0x41)],
    ['a suffix far past the comment window', Buffer.alloc(2 * megabyte, 0x41)],
  ])('detects an archive followed by %s', (_label, trailer) => {
    const padded = Buffer.concat([readFixture('sample.docx'), trailer]);
    expect(isZipArchive(padded)).toBe(true);
  });

  test('runs the decompression guard on a bomb hidden behind an overlong suffix', async () => {
    const bomb = await buildBombArchive([
      { name: 'document.xml', decompressedBytes: 40 * megabyte },
    ]);
    const padded = Buffer.concat([bomb, Buffer.alloc(100 * 1024, 0x41)]);

    expect(isZipArchive(padded)).toBe(true);
    await expect(assertSafeZipSizeIfArchive(padded, { name: 'suffixed.docx' })).rejects.toThrow();
  });

  test('resolves toward archive rather than spending the scan on seeded signatures', () => {
    /* Random data holds an expected 0.003 of these in 15MB, so thousands means they were
     * planted. Giving up toward "not an archive" would skip every cap on exactly the
     * file built to look confusing, so the scan stops and lets the guard decide. */
    const seeded = Buffer.alloc(2 * megabyte);
    for (let offset = 0; offset + 4 <= seeded.length; offset += 4) {
      seeded.write('PK\u0005\u0006', offset, 'latin1');
    }

    const started = Date.now();
    expect(isZipArchive(seeded)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('detects an archive preceded by junk, as a self-extracting archive would be', () => {
    const padded = Buffer.concat([Buffer.from('JUNKJUNK'), readFixture('sample.docx')]);
    expect(isZipArchive(padded)).toBe(true);
  });

  test.each([
    ['a legacy Compound File workbook', 'sample.xls'],
    ['a PDF', 'sample.pdf'],
  ])('does not mistake %s for an archive', (_label, name) => {
    expect(isZipArchive(readFixture(name))).toBe(false);
  });

  test('does not mistake a stray EOCD signature inside a binary for an archive', () => {
    /* The signature with incoherent fields: multi-disk, mismatched entry counts and a
     * central directory that runs past the end of the file. */
    const stray = Buffer.alloc(512, 0x7f);
    stray.write('PK\x05\x06', 100, 'binary');
    stray.writeUInt16LE(3, 104);
    stray.writeUInt16LE(9, 106);
    stray.writeUInt16LE(2, 108);
    stray.writeUInt16LE(7, 110);
    stray.writeUInt32LE(0xffffff, 112);
    stray.writeUInt32LE(0xffffff, 116);
    stray.writeUInt16LE(64, 120);
    expect(isZipArchive(stray)).toBe(false);
  });

  test('runs the decompression guard on a bomb hidden behind trailing bytes', async () => {
    /* Detection is what matters: before this the padded bomb skipped every cap and went
     * straight to a parser that tolerates the padding. yauzl does not, so the refusal
     * arrives as a malformed-archive error rather than the cap message, exactly as it
     * does for the prepended-junk case. Either way the bytes never reach the parser. */
    const bomb = await buildBombArchive([
      { name: 'document.xml', decompressedBytes: 40 * megabyte },
    ]);
    const padded = Buffer.concat([bomb, Buffer.from([0x00])]);

    expect(isZipArchive(padded)).toBe(true);
    await expect(assertSafeZipSizeIfArchive(padded, { name: 'padded.docx' })).rejects.toThrow();
  });
});

describe('assertSafeZipSizeIfArchive', () => {
  test('passes a real office document through', async () => {
    await expect(
      assertSafeZipSizeIfArchive(readFixture('structured.docx'), { name: 'structured.docx' }),
    ).resolves.toBeUndefined();
  });

  test('ignores a buffer the tail does not identify as an archive', async () => {
    await expect(assertSafeZipSizeIfArchive(readFixture('sample.xls'))).resolves.toBeUndefined();
  });

  test('ignores a ZIP attachment nested inside a declared CFB container', async () => {
    const attachment = new JSZip();
    attachment.file('attachment.txt', 'nested');
    const combined = Buffer.concat([
      readFixture('sample.xls'),
      await attachment.generateAsync({ type: 'nodebuffer' }),
    ]);

    expect(isZipArchive(combined)).toBe(true);
    await expect(
      assertSafeZipSizeIfArchive(combined, {
        name: 'sample.xls',
        knownOuterContainer: 'cfb',
      }),
    ).resolves.toBeUndefined();
  });

  test('ignores a ZIP attachment nested inside a verified RTF container', async () => {
    const attachment = await buildBenignArchive();
    const combined = Buffer.concat([
      Buffer.from(String.raw`{\rtf1\ansi{\object\objdata\bin${attachment.length} `),
      attachment,
      Buffer.from('}}'),
    ]);

    expect(isZipArchive(combined)).toBe(true);
    await expect(
      assertSafeZipSizeIfArchive(combined, {
        name: 'notes.rtf',
        knownOuterContainer: 'rtf',
      }),
    ).resolves.toBeUndefined();
  });

  test('does not trust an RTF declaration without a valid RTF header', async () => {
    const attachment = await buildBenignArchive();
    const combined = Buffer.concat([Buffer.from(String.raw`{\rtf0\ansi `), attachment]);

    await expect(
      assertSafeZipSizeIfArchive(combined, {
        name: 'fake.rtf',
        knownOuterContainer: 'rtf',
      }),
    ).rejects.toBeInstanceOf(ArchiveValidationError);
  });

  test('does not trust a CFB declaration without a valid CFB header', async () => {
    const bomb = await buildBombArchive([
      { name: 'document.xml', decompressedBytes: 40 * megabyte },
    ]);

    await expect(
      assertSafeZipSizeIfArchive(bomb, { name: 'bomb.xls', knownOuterContainer: 'cfb' }),
    ).rejects.toBeInstanceOf(ZipBombError);
  });

  /**
   * Past detection there are only two honest answers, validated or refused. An ordinary
   * Error is neither: callers treat it as "this reader could not manage it" and hand the
   * same bytes to the next one, which for a configured OCR provider means paying to send
   * it exactly what the guard refused.
   */
  test('tags a malformed detected archive as a refusal, not a parse failure', async () => {
    const bomb = await buildBombArchive([
      { name: 'document.xml', decompressedBytes: 40 * megabyte },
    ]);
    const padded = Buffer.concat([Buffer.from('JUNKJUNK'), bomb]);

    const failure = await assertSafeZipSizeIfArchive(padded, { name: 'padded.docx' }).catch(
      (error: Error) => error,
    );

    expect(failure).toBeInstanceOf(ArchiveValidationError);
    expect(failure).toMatchObject({ code: 'ARCHIVE_INVALID', userErrorStatusCode: 422 });
    expect((failure as Error).message).toMatch(/padded\.docx: archive could not be read safely/);
    /** The underlying reason is kept, so logs still say what yauzl objected to. */
    expect((failure as Error).message).toMatch(/central directory/i);
  });

  test('keeps a cap violation reported as a zip bomb', async () => {
    const bomb = await buildBombArchive([
      { name: 'document.xml', decompressedBytes: 40 * megabyte },
    ]);

    await expect(assertSafeZipSizeIfArchive(bomb, { name: 'bomb.docx' })).rejects.toBeInstanceOf(
      ZipBombError,
    );
  });
});
