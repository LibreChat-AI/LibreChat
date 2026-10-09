import JSZip from 'jszip';
import { megabyte } from 'librechat-data-provider';
import { assertSafeZipSize, ZipBombError } from './zipSafety';

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
});
