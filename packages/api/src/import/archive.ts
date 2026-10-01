import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import yauzl from 'yauzl';
import { megabyte } from 'librechat-data-provider';
import type { Readable } from 'stream';
import { resolveImportMaxFileSize, resolveImportMaxShardSize } from '~/utils/import';
import { ZipBombError } from '~/files/documents/zipSafety';
import { ImportFileTooLargeError } from './errors';

export { ZipBombError };

const DEFAULT_MAX_ENTRIES = 20000;
const DEFAULT_MAX_TOTAL_BYTES = 4096 * megabyte;
/**
 * Hard ceiling on the per-entry cap for every archive type, whatever a
 * deployment configures. V8 caps a string at 536,870,888 characters
 * (`buffer.constants.MAX_STRING_LENGTH`), just under 512 MiB, so a larger
 * archive entry can never survive the `.toString('utf8')` every reader
 * performs; allowing one would trade a clear rejection for an opaque V8
 * allocation failure. Bare uploads use the shard limit as well because their
 * JSON is read as one in-memory entry, not the larger upload limit sized for
 * a ZIP container.
 */
const ABSOLUTE_MAX_ENTRY_BYTES = 512 * megabyte;
/** Local file header signature every ZIP file begins with. Its absence
 * means the upload is a bare file (e.g. a legacy un-zipped ChatGPT
 * `.json` export), not that it is malformed; `openArchive` wraps it in a
 * single-entry `Archive` instead of attempting to parse it as a zip. */
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export interface ArchiveEntry {
  name: string;
  bytes: number;
}

export interface ArchiveOptions {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
}

export interface Archive {
  entries: ArchiveEntry[];
  /** True when the upload was not a zip at all and has been wrapped in a
   * synthetic single-entry archive. Layout resolution needs the distinction:
   * a bare upload's sole entry is the export by definition, where a zip's sole
   * entry is only a shard if it looks like one. */
  bare: boolean;
  read(name: string): Promise<Buffer>;
  close(): void;
}

type ArchiveLimits = Required<ArchiveOptions>;

/**
 * Actual decompressed bytes delivered so far, shared by every `read()` call on
 * one archive instance so the aggregate cap is enforced against real bytes
 * rather than the (spoofable) central directory total.
 *
 * Counted once per distinct entry. A ChatGPT run reads every shard twice,
 * once to scan for assets, once to convert, and charging both passes made a
 * legitimate export over half the cap fail partway through the second one with
 * a zip-bomb error. What the cap bounds is how much distinct data the archive
 * can yield; re-reading an entry yields nothing new, and each read is still
 * bounded individually by the per-entry cap.
 */
interface ArchiveTotals {
  bytesRead: number;
  counted: Set<string>;
}

/** Charges an entry's decompressed size against the aggregate budget the
 * first time that entry is read, and throws once the budget is exceeded. */
function chargeEntry(
  name: string,
  bytes: number,
  limits: ArchiveLimits,
  totals: ArchiveTotals,
): void {
  if (totals.counted.has(name)) {
    return;
  }
  totals.counted.add(name);
  totals.bytesRead += bytes;
  if (totals.bytesRead > limits.maxTotalBytes) {
    throw new ZipBombError('Archive exceeds the maximum decompressed size');
  }
}

export function assertSafeName(name: string): void {
  if (path.isAbsolute(name) || /^[a-zA-Z]:[\\/]/.test(name)) {
    throw new Error(`Refusing absolute path in archive: ${name}`);
  }
  const normalized = path.normalize(name);
  if (normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) {
    throw new Error(`Refusing path traversal in archive: ${name}`);
  }
}

/**
 * yauzl validates entry names itself before an `entry` event is ever
 * emitted, rejecting the whole read with a generic `Error` ("invalid
 * relative path: ...", "absolute path: ..."). Translate those into the
 * same wording `assertSafeName` uses so callers get one consistent
 * traversal/absolute-path error regardless of which layer caught it.
 */
function translateZipSafetyError(error: Error): Error {
  if (/^invalid relative path:/.test(error.message)) {
    return new Error(`Refusing path traversal in archive: ${error.message}`);
  }
  if (/^absolute path:/.test(error.message)) {
    return new Error(`Refusing absolute path in archive: ${error.message}`);
  }
  return error;
}

function openZip(filepath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filepath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error('Unable to read archive'));
        return;
      }
      resolve(zipfile);
    });
  });
}

function indexEntries(
  zipfile: yauzl.ZipFile,
  options: ArchiveLimits,
): Promise<Map<string, yauzl.Entry>> {
  return new Promise((resolve, reject) => {
    const index = new Map<string, yauzl.Entry>();
    let total = 0;
    /** Counted per record, not per indexed entry. `index.size` undercounts:
     * directory records return before it is ever consulted, and a repeated
     * filename overwrites the same key. Either lets an archive hold millions
     * of records that cost real central-directory traversal while the cap
     * believes it is nearly empty. */
    let records = 0;

    zipfile.on('entry', (entry: yauzl.Entry) => {
      records += 1;
      if (records > options.maxEntries) {
        reject(new ZipBombError(`Archive exceeds ${options.maxEntries} entries`));
        return;
      }

      if (/\/$/.test(entry.fileName)) {
        zipfile.readEntry();
        return;
      }

      try {
        assertSafeName(entry.fileName);
      } catch (error) {
        reject(error);
        return;
      }

      /** Cheap early reject from the central directory's declared sizes.
       * This field is attacker-controlled and not trusted on its own:
       * `ArchiveTotals` re-checks the real, streamed byte count on every
       * `read()` call regardless of what this loop found. */
      total += entry.uncompressedSize;
      if (total > options.maxTotalBytes) {
        reject(new ZipBombError('Archive exceeds the maximum decompressed size'));
        return;
      }

      index.set(entry.fileName, entry);
      zipfile.readEntry();
    });

    zipfile.on('end', () => resolve(index));
    zipfile.on('error', (error: Error) => reject(translateZipSafetyError(error)));
    zipfile.readEntry();
  });
}

/**
 * `decompress: false` hands back a DEFLATE entry's raw (still-compressed)
 * bytes instead of routing them through yauzl's own inflate pipe. See the
 * module-level note above `inflateEntry` for why that pipe must never be
 * used. yauzl rejects `decompress` outright for a STORED entry (its bytes
 * are never inflated to begin with, so the option is meaningless);
 * `openReadStream(entry, callback)` already returns those raw.
 */
function openEntryStream(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    const onStream = (err: Error | null, readStream: Readable | undefined): void => {
      if (err || !readStream) {
        reject(err ?? new Error(`Unable to read entry: ${entry.fileName}`));
        return;
      }
      resolve(readStream);
    };

    if (entry.compressionMethod === 0) {
      zipfile.openReadStream(entry, onStream);
      return;
    }
    zipfile.openReadStream(
      entry,
      { decompress: false, decrypt: null, start: null, end: null },
      onStream,
    );
  });
}

/**
 * Drains a raw (non-inflated) entry stream into a single buffer. The cap
 * checked here is the compressed byte count, not the eventual decompressed
 * size: for a STORED entry (`compressionMethod === 0`) the two are
 * identical, and for a DEFLATE entry the compressed stream can only be
 * marginally larger than the uncompressed content (deflate's stored-block
 * fallback adds a few bytes per 64 KB block at worst), so this still
 * catches a runaway/corrupt entry before it is held in memory in full.
 * The authoritative per-entry cap for DEFLATE entries is enforced by
 * `zlib.inflateRaw`'s `maxOutputLength` in `inflateEntry`.
 */
function readRawEntry(readStream: Readable, name: string, limits: ArchiveLimits): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;

    readStream.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > limits.maxEntryBytes) {
        reject(new ZipBombError(`Entry ${name} exceeds the maximum decompressed size`));
        readStream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    readStream.on('error', reject);
    readStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Inflates a raw DEFLATE entry ourselves instead of letting yauzl pipe it
 * through zlib internally.
 *
 * On Node 24.16.0 with yauzl 3.2.1, `openReadStream(entry, cb)` (the
 * default, inflating path) stalls for any entry whose decompressed output
 * needs more than one internal zlib chunk (roughly 64 KB): the stream
 * emits no `data`, `end`, or `error`, so a caller awaiting the read hangs
 * forever. Confirmed against a 778 MB real ChatGPT export: a 2-byte entry
 * completed instantly, a 453 KB entry never returned in any
 * `lazyEntries`/`autoClose` combination, and reading the very same entry
 * raw (`decompress: false`) and inflating it here completed in single-digit
 * milliseconds. Do not revert to `openReadStream(entry, cb)` without first
 * re-testing a multi-chunk entry on Node >= 24.
 *
 * `maxOutputLength` makes zlib itself refuse to allocate more than the
 * per-entry cap while inflating, which is a stronger guarantee than
 * counting decompressed chunks after the fact: the oversized buffer is
 * never allocated at all. zlib surfaces that refusal as a `RangeError`
 * with `code === 'ERR_BUFFER_TOO_LARGE'`, which is mapped onto the same
 * `ZipBombError` every other cap violation in this module raises.
 */
function inflateEntry(raw: Buffer, name: string, maxOutputLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.inflateRaw(raw, { maxOutputLength }, (error, result) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
          reject(new ZipBombError(`Entry ${name} exceeds the maximum decompressed size`));
          return;
        }
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

function ensureWithinTotalBudget(name: string, limits: ArchiveLimits, totals: ArchiveTotals): void {
  if (totals.bytesRead > limits.maxTotalBytes) {
    throw new ZipBombError(`Archive exceeds the maximum decompressed size before reading ${name}`);
  }
}

async function isZipFile(filepath: string): Promise<boolean> {
  const handle = await fs.promises.open(filepath, 'r');
  try {
    const buffer = Buffer.alloc(ZIP_SIGNATURE.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead === buffer.length && buffer.equals(ZIP_SIGNATURE);
  } finally {
    await handle.close();
  }
}

/**
 * Wraps a bare (non-zip) upload in the same `Archive` interface a real zip
 * exposes: one entry, named after the uploaded file, readable under the
 * same per-entry and aggregate byte caps. `resolveLayout`'s
 * lone-json fallback then treats it exactly like a single-file zip export,
 * so a bare `.json` upload and a `.zip` upload share one inspect/import
 * pipeline instead of two.
 */
async function openSingleFileArchive(
  filepath: string,
  limits: ArchiveLimits,
  totals: ArchiveTotals,
): Promise<Archive> {
  const name = path.basename(filepath);
  const stat = await fs.promises.stat(filepath);

  /**
   * Checked up front against the same configured import limit enforced by
   * multer. Failing on the stat means a direct archive read of an oversized
   * bare upload fails immediately and for the real reason, instead of after
   * reading the whole file and reporting it as an oversized archive.
   */
  if (stat.size > limits.maxEntryBytes) {
    throw new ImportFileTooLargeError(
      `Upload of ${stat.size} bytes exceeds the ${limits.maxEntryBytes}-byte single-file limit`,
    );
  }
  if (stat.size > limits.maxTotalBytes) {
    throw new ZipBombError('Archive exceeds the maximum decompressed size');
  }

  function assertKnownEntry(entryName: string): void {
    if (entryName !== name) {
      throw new Error(`Entry not found in archive: ${entryName}`);
    }
  }

  async function read(entryName: string): Promise<Buffer> {
    assertKnownEntry(entryName);
    ensureWithinTotalBudget(entryName, limits, totals);
    const readStream = fs.createReadStream(filepath);

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;

      readStream.on('data', (chunk: Buffer | string) => {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        bytes += buffer.byteLength;

        if (bytes > limits.maxEntryBytes) {
          reject(new ZipBombError(`Entry ${entryName} exceeds the maximum decompressed size`));
          readStream.destroy();
          return;
        }
        chunks.push(buffer);
      });
      readStream.on('error', reject);
      readStream.on('end', () => {
        /** Charged on completion, and only for the first read of this entry:
         * the conversion pass re-reads what the scan already read, and
         * charging both made a legitimate large export fail partway through. */
        try {
          chargeEntry(entryName, bytes, limits, totals);
        } catch (error) {
          reject(error);
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
  }

  return {
    entries: [{ name, bytes: stat.size }],
    bare: true,
    read,
    close: () => undefined,
  };
}

export async function openArchive(
  filepath: string,
  options: ArchiveOptions = {},
): Promise<Archive> {
  const bare = !(await isZipFile(filepath));
  /**
   * Bare imports deliberately use the shard cap instead of the upload limit.
   * The upload limit is sized for a ZIP container, while bare JSON is parsed
   * as one in-memory entry and must stay within the shard and V8-safe limits.
   */
  const configuredMaxEntryBytes = options.maxEntryBytes ?? resolveImportMaxShardSize();
  const limits: ArchiveLimits = {
    maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxEntryBytes: Math.min(configuredMaxEntryBytes, ABSOLUTE_MAX_ENTRY_BYTES),
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
  };
  const totals: ArchiveTotals = { bytesRead: 0, counted: new Set() };

  if (bare) {
    return openSingleFileArchive(filepath, limits, totals);
  }

  const zipfile = await openZip(filepath);

  let index: Map<string, yauzl.Entry>;
  try {
    index = await indexEntries(zipfile, limits);
  } catch (error) {
    zipfile.close();
    throw error;
  }

  function entryOf(name: string): yauzl.Entry {
    const entry = index.get(name);
    if (!entry) {
      throw new Error(`Entry not found in archive: ${name}`);
    }
    return entry;
  }

  async function read(name: string): Promise<Buffer> {
    ensureWithinTotalBudget(name, limits, totals);
    const entry = entryOf(name);
    const readStream = await openEntryStream(zipfile, entry);
    const raw = await readRawEntry(readStream, name, limits);
    const output =
      entry.compressionMethod === 0 ? raw : await inflateEntry(raw, name, limits.maxEntryBytes);

    chargeEntry(name, output.byteLength, limits, totals);

    return output;
  }

  return {
    entries: Array.from(index.values(), (entry) => ({
      name: entry.fileName,
      bytes: entry.uncompressedSize,
    })),
    bare: false,
    read,
    close: () => zipfile.close(),
  };
}

export interface LegacyArchiveEntry {
  filepath: string;
  cleanup(): Promise<void>;
}

/** Extracts a sole JSON entry through the archive reader's path and size
 * checks so the legacy importer can consume a ZIP without handling archives. */
export async function extractLegacyArchiveEntry(
  filepath: string,
): Promise<LegacyArchiveEntry | null> {
  const maxBytes = resolveImportMaxFileSize();
  const archive = await openArchive(filepath, {
    maxEntryBytes: maxBytes,
    maxTotalBytes: maxBytes,
  });

  try {
    if (
      archive.bare ||
      archive.entries.length !== 1 ||
      path.extname(archive.entries[0].name).toLowerCase() !== '.json'
    ) {
      return null;
    }

    const buffer = await archive.read(archive.entries[0].name);
    const directory = await fs.promises.mkdtemp(path.join(path.dirname(filepath), 'legacy-'));
    const extracted = path.join(directory, 'legacy.json');
    try {
      await fs.promises.writeFile(extracted, buffer, { mode: 0o600 });
    } catch (error) {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return {
      filepath: extracted,
      cleanup: () => fs.promises.rm(directory, { recursive: true, force: true }),
    };
  } finally {
    archive.close();
  }
}
