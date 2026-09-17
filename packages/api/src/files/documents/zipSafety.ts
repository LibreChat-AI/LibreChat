import yauzl from 'yauzl';
import { megabyte } from 'librechat-data-provider';
import type { Readable } from 'node:stream';

/**
 * Default per-archive total decompressed-size cap. Office documents in
 * normal use rarely exceed a few MB inflated; 100 MB leaves generous
 * headroom for image-heavy templates while still catching the
 * pathological zip-bomb case (e.g. a 1 MB compressed XLSX that inflates
 * to 200+ MB of XML — see SEC review on PR #12934).
 */
const DEFAULT_MAX_TOTAL_BYTES = 100 * megabyte;

/**
 * Default per-entry decompressed-size cap. A single inflated entry
 * larger than this is essentially always either a bomb or content the
 * downstream parser would balk at anyway.
 */
const DEFAULT_MAX_ENTRY_BYTES = 25 * megabyte;

/**
 * Default per-archive entry-count cap. Neither byte cap bounds how many
 * entries an archive may hold, yet every entry costs an openReadStream
 * plus an inflate teardown no matter how little it decompresses to:
 * 20,000 one-byte entries are 1.87MB on disk and 20,000 decompressed
 * bytes, comfortably inside both byte caps, but take 835ms to walk
 * (0.042ms/entry), so a 15MB upload buys roughly 6.7s of CPU. Real
 * office documents are orders of magnitude below that: the largest
 * fixture here (a 3-slide deck.pptx) holds 42 entries, the DOCX
 * fixtures 9-19, and even a 700-slide deck carrying per-slide notes,
 * rels and media stays under 4,000.
 */
const DEFAULT_MAX_ENTRIES = 4096;

/** End-Of-Central-Directory record signature, `PK\x05\x06`. */
const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/** Fixed size of the EOCD record, before its variable-length comment. */
const EOCD_RECORD_BYTES = 22;

/** Compound File Binary header used by legacy Office documents. */
const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** Rich Text Format header, including the required format-version control word. */
const RTF_SIGNATURE = Buffer.from('{\\rtf1');

/**
 * Checks the fixed CFB header fields, not only its easily forged leading signature.
 * Version 3 files use 512-byte sectors and version 4 files use 4096-byte sectors.
 */
export function isCompoundFileBinary(buffer: Buffer): boolean {
  if (buffer.length < 512 || !buffer.subarray(0, CFB_SIGNATURE.length).equals(CFB_SIGNATURE)) {
    return false;
  }
  const sectorShift = buffer.readUInt16LE(30);
  return (
    buffer.readUInt16LE(28) === 0xfffe &&
    (sectorShift === 9 || sectorShift === 12) &&
    buffer.readUInt16LE(32) === 6
  );
}

/** A real RTF outer document, rather than a filename or MIME declaration alone. */
export function isRichTextFormat(buffer: Buffer): boolean {
  return buffer.subarray(0, RTF_SIGNATURE.length).equals(RTF_SIGNATURE);
}

/**
 * Tag-distinct error so callers (e.g. the office HTML producers and the
 * RAG document parser) can distinguish a refused zip-bomb from generic
 * parse failures and emit a sensible "file too large to preview" UI
 * instead of silently degrading.
 */
export class ZipBombError extends Error {
  readonly code = 'ZIP_BOMB';
  /** The document itself is the problem, so the caller is told to send a smaller one. */
  readonly userErrorStatusCode = 413;
  constructor(message: string) {
    super(message);
    this.name = 'ZipBombError';
  }
}

/**
 * A buffer the tail identified as an archive that the validator could not walk.
 *
 * Distinct from a plain parse error because of where it happens: past detection, the
 * only honest answers are "validated" and "refused". Reporting it as an ordinary
 * failure lets a caller's fallback chain hand the same bytes to another reader, which
 * is the outcome the guard exists to prevent.
 */
export class ArchiveValidationError extends Error {
  readonly code = 'ARCHIVE_INVALID';
  /** Well-formed request, unreadable content: retrying the same bytes cannot help. */
  readonly userErrorStatusCode = 422;
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveValidationError';
  }
}

export interface ZipSafetyOptions {
  /** Per-archive total decompressed-byte cap. */
  maxTotalBytes?: number;
  /** Per-entry decompressed-byte cap. */
  maxEntryBytes?: number;
  /** Per-archive entry-count cap. */
  maxEntries?: number;
  /** Filename for error messages — does not need to match disk. */
  name?: string;
  /** A verified outer container whose nested ZIP records are not the document itself. */
  knownOuterContainer?: 'cfb' | 'rtf';
  /** Cancels archive walking when the caller stops waiting. */
  signal?: AbortSignal;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Archive validation cancelled');
}

function closeZipFile(zipfile?: yauzl.ZipFile): void {
  if (!zipfile) {
    return;
  }
  try {
    zipfile.close();
  } catch {
    /* Closing during a yauzl callback is best-effort; the outer operation is settled. */
  }
}

/**
 * Validate that a ZIP-backed buffer (DOCX, XLSX, XLS-as-OOXML, ODS,
 * ODT, PPTX, …) does not blow up under decompression beyond the given
 * caps. Streams every entry through yauzl and counts real decompressed
 * bytes mid-inflate — the central directory's `uncompressedSize` cannot
 * be trusted (it can be falsified to lie about the payload, the
 * specific bypass technique used in the SEC validation PoC for
 * PR #12934).
 *
 * Drops the decompressed bytes immediately (only counts them), so the
 * validator's own memory footprint is bounded by yauzl's stream
 * buffer regardless of payload size. CPU is bounded by `maxTotalBytes`
 * — once the cap fires, the underlying read stream is destroyed and
 * decompression stops. The `maxEntries` cap bounds the
 * per-entry stream setup that inflated bytes alone never account for.
 *
 * Throws `ZipBombError` on cap violation; throws plain `Error` on a
 * malformed ZIP. Resolves with `void` when the archive is fully walked
 * within caps.
 */
export function assertSafeZipSize(buffer: Buffer, options: ZipSafetyOptions = {}): Promise<void> {
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const label = options.name ?? 'archive';
  const signal = options.signal;

  if (signal?.aborted) {
    return Promise.reject(abortReason(signal));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let zipfile: yauzl.ZipFile | undefined;
    let activeReadStream: Readable | undefined;
    const finish = (error: Error | null) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (activeReadStream && !activeReadStream.destroyed) {
        activeReadStream.destroy();
      }
      closeZipFile(zipfile);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onAbort = () => finish(abortReason(signal as AbortSignal));
    signal?.addEventListener('abort', onAbort, { once: true });

    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, openedZipfile) => {
      if (settled) {
        closeZipFile(openedZipfile ?? undefined);
        return;
      }
      if (err) {
        return finish(err);
      }
      if (!openedZipfile) {
        return finish(new Error('Failed to open zip buffer'));
      }
      zipfile = openedZipfile;

      let totalDecompressed = 0;

      /* Refused before the first `readEntry`, so an over-long archive
       * costs nothing beyond opening it. Unlike `uncompressedSize`, the
       * declared entry count is safe to trust here: it is exactly the
       * number of entries yauzl will emit before ending the walk, so
       * understating it only buys the attacker less work, never more. */
      if (openedZipfile.entryCount > maxEntries) {
        return finish(
          new ZipBombError(
            `${label}: entry count (${openedZipfile.entryCount}) exceeds the ${maxEntries}-entry cap (zip bomb suspected)`,
          ),
        );
      }

      openedZipfile.on('entry', (entry: yauzl.Entry) => {
        if (settled) {
          return;
        }
        /* Directory entries (trailing slash) are zero-byte and don't
         * need to be opened. Saves a stream allocation per directory
         * in archives like .docx that have nested subfolders. */
        if (/\/$/.test(entry.fileName)) {
          openedZipfile.readEntry();
          return;
        }

        openedZipfile.openReadStream(entry, (streamErr, readStream) => {
          if (settled) {
            readStream?.destroy();
            return;
          }
          if (streamErr || !readStream) {
            return finish(streamErr ?? new Error('Failed to open zip entry stream'));
          }
          activeReadStream = readStream;

          let entryBytes = 0;
          let entryCapped = false;

          readStream.on('data', (chunk: Buffer) => {
            if (entryCapped) {
              return;
            }
            entryBytes += chunk.byteLength;
            totalDecompressed += chunk.byteLength;
            if (entryBytes > maxEntryBytes) {
              entryCapped = true;
              readStream.destroy();
              finish(
                new ZipBombError(
                  `${label}: entry "${entry.fileName}" exceeds the ${
                    maxEntryBytes / megabyte
                  }MB per-entry decompressed cap`,
                ),
              );
              return;
            }
            if (totalDecompressed > maxTotalBytes) {
              entryCapped = true;
              readStream.destroy();
              finish(
                new ZipBombError(
                  `${label}: total decompressed size exceeds the ${
                    maxTotalBytes / megabyte
                  }MB cap (zip bomb suspected)`,
                ),
              );
              return;
            }
          });

          readStream.on('end', () => {
            if (activeReadStream === readStream) {
              activeReadStream = undefined;
            }
            if (!settled) {
              openedZipfile.readEntry();
            }
          });
          readStream.on('error', (readErr: Error) => {
            if (!entryCapped) {
              finish(readErr);
            }
          });
        });
      });

      openedZipfile.on('end', () => finish(null));
      openedZipfile.on('error', (zipErr: Error) => finish(zipErr));
      zipfile.readEntry();
    });
  });
}

/** Disk-number field value a zip64 archive writes in place of a real count. */
const ZIP64_MARKER = 0xffff;

/**
 * Candidate EOCD signatures examined before the scan gives up and calls the buffer an
 * archive anyway.
 *
 * A real file holds one, and random data holds none: 15MB has an expected 0.003 hits.
 * Thousands means the signature was seeded deliberately, which is the shape of an
 * attempt to make the scan expensive. Exhaustion resolves toward "archive" so the guard
 * still runs, since the alternative is to skip every cap on a file built to look
 * confusing.
 */
const MAX_EOCD_CANDIDATES = 4096;

/**
 * Whether an EOCD candidate's own fields agree with each other and with the buffer.
 *
 * The comment-length test below cannot confirm a record followed by trailing bytes, so
 * this is what separates a real archive from a stray `PK\x05\x06` inside an unrelated
 * binary: single-disk fields, matching entry counts, and a central directory that fits
 * within the file. A false positive here costs a legitimate `.xls` its upload, since
 * detection and enforcement are welded together, so the checks stay strict.
 */
function isCoherentEocd(buffer: Buffer, index: number): boolean {
  const thisDisk = buffer.readUInt16LE(index + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(index + 6);
  const entriesOnDisk = buffer.readUInt16LE(index + 8);
  const totalEntries = buffer.readUInt16LE(index + 10);
  if (thisDisk !== 0 || centralDirectoryDisk !== 0) {
    return thisDisk === ZIP64_MARKER && centralDirectoryDisk === ZIP64_MARKER;
  }
  if (entriesOnDisk !== totalEntries) {
    return false;
  }
  const centralDirectoryBytes = buffer.readUInt32LE(index + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(index + 16);
  return centralDirectoryOffset + centralDirectoryBytes <= buffer.length;
}

/**
 * Detects a ZIP archive the way the consuming parsers do: by locating the
 * End-Of-Central-Directory record from the tail.
 *
 * Testing the leading `PK` magic bytes is not enough. Real zip readers (anydoc's
 * Rust zip crate, SheetJS) seek the EOCD backwards and tolerate arbitrary data on
 * either side of the archive; that is how self-extracting archives work. Padding a zip
 * bomb therefore makes a magic-byte test report "not a zip" while the parser still
 * happily inflates it, and requiring the record's comment to run exactly to the end of
 * the buffer leaves the same hole open for a single appended byte. A candidate is
 * accepted when its comment ends the file or when its own fields are internally
 * coherent.
 *
 * The whole buffer is searched rather than the 65,557 bytes a comment may legally
 * occupy: measured against anydoc, a DOCX with 100KB appended still has its entries
 * read, so a window that small is a documented bypass rather than a saving. Uploads are
 * capped at 15MB and each candidate costs a handful of reads, so the scan is bounded.
 */
export function isZipArchive(buffer: Buffer): boolean {
  if (buffer.length < EOCD_RECORD_BYTES) {
    return false;
  }

  let index = buffer.lastIndexOf(EOCD_SIGNATURE, buffer.length - EOCD_RECORD_BYTES);
  for (let examined = 0; index >= 0; examined++) {
    if (examined >= MAX_EOCD_CANDIDATES) {
      return true;
    }
    const commentEndsTheFile =
      index + EOCD_RECORD_BYTES + buffer.readUInt16LE(index + 20) === buffer.length;
    if (commentEndsTheFile || isCoherentEocd(buffer, index)) {
      return true;
    }
    if (index === 0) {
      return false;
    }
    index = buffer.lastIndexOf(EOCD_SIGNATURE, index - 1);
  }
  return false;
}

/**
 * Runs the decompression guard only when the buffer really is a ZIP.
 *
 * Detection and enforcement have to stay welded together. Once the tail says
 * "archive", a validator failure is a rejection and never a fall-through: yauzl
 * does not compensate for the offset shift that prepended bytes introduce, so a
 * padded bomb surfaces here as a malformed-central-directory error, and passing
 * that to the parser would hand it exactly the file the guard exists to stop.
 * Non-archives (`.xls` is CFB, not ZIP) skip the validator entirely, which is
 * why the check cannot simply be made unconditional.
 */
export async function assertSafeZipSizeIfArchive(
  buffer: Buffer,
  options: ZipSafetyOptions = {},
): Promise<void> {
  if (options.signal?.aborted) {
    throw abortReason(options.signal);
  }
  if (options.knownOuterContainer === 'cfb' && isCompoundFileBinary(buffer)) {
    return;
  }
  if (options.knownOuterContainer === 'rtf' && isRichTextFormat(buffer)) {
    return;
  }
  if (!isZipArchive(buffer)) {
    return;
  }
  try {
    await assertSafeZipSize(buffer, options);
  } catch (error) {
    if (options.signal?.aborted) {
      throw abortReason(options.signal);
    }
    if (error instanceof ZipBombError) {
      throw error;
    }
    const label = options.name ?? 'archive';
    const reason = error instanceof Error ? error.message : String(error);
    throw new ArchiveValidationError(`${label}: archive could not be read safely (${reason})`);
  }
}
