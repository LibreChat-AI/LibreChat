import path from 'path';
import crypto from 'node:crypto';
import { createReadStream } from 'fs';
import { readFile, stat } from 'fs/promises';
import { UnsupportedProviderAudioError } from '~/files/upload/errors';

const USER_FACING_UPLOAD_ERRORS = [
  ['Invalid file format', 'Invalid file format'],
  ['exceeds token limit', 'File content exceeds token limit'],
  ['Unable to extract text from', 'Unable to extract text from file'],
  ['No text found in document', 'No text found in document'],
  ['MB document parser limit', 'File exceeds the document parser size limit'],
  ['MB per-entry decompressed cap', 'Document entry exceeds the decompressed size limit'],
  ['total decompressed size exceeds the', 'Document exceeds the total decompressed size limit'],
  ['MB decompressed limit', 'Document exceeds the decompressed size limit'],
  ['MB storage limit', 'Extracted text exceeds the storage size limit'],
] as const;

const ASCII_FILENAME_SAFE_PATTERN = /^[a-zA-Z0-9._-]$/;
const UNSAFE_UNICODE_FILENAME_PATTERN = /[^\p{L}\p{M}\p{N}\p{Emoji}\u200d._-]/gu;
export const FILENAME_SEGMENT_MAX_BYTES = 255;

function sanitizeFilenameSegment(segment: string): string {
  const asciiSanitized = Array.from(segment.normalize('NFC'), (char) => {
    if (char.charCodeAt(0) > 0x7f) {
      return char;
    }
    return ASCII_FILENAME_SAFE_PATTERN.test(char) ? char : '_';
  }).join('');

  return asciiSanitized.replace(UNSAFE_UNICODE_FILENAME_PATTERN, '_');
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let bytes = 0;
  let result = '';

  for (const char of value) {
    const charBytes = utf8ByteLength(char);
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }

  return result;
}

function truncateWithSuffix(value: string, suffix: string, maxBytes: number): string {
  const suffixBytes = utf8ByteLength(suffix);
  const stemBudget = Math.max(0, maxBytes - suffixBytes);
  const result = truncateUtf8Bytes(value, stemBudget) + suffix;
  return utf8ByteLength(result) <= maxBytes ? result : truncateUtf8Bytes(result, maxBytes);
}

function truncateLeafWithSuffix(leaf: string, suffix: string, maxBytes: number): string {
  if (utf8ByteLength(leaf) <= maxBytes) return leaf;
  const ext = path.extname(leaf);
  const stem = path.basename(leaf, ext);
  const suffixBytes = utf8ByteLength(suffix);
  const extBytes = utf8ByteLength(ext);
  if (extBytes > maxBytes - suffixBytes - 1) {
    return truncateWithSuffix(leaf, suffix, maxBytes);
  }
  const stemBudget = maxBytes - extBytes - suffixBytes;
  return truncateUtf8Bytes(stem, stemBudget) + suffix + ext;
}

/**
 * Composes a leaf as `<stem><suffix><ext>`, trimming the stem so the result
 * stays inside `maxBytes`. Unlike {@link truncateLeafWithSuffix}, whose suffix
 * marks a truncation and is therefore only applied when one happens, this
 * always applies the suffix — callers use it to disambiguate one name from
 * another, so a trim that dropped the suffix would hand back the name they
 * were trying to move away from.
 */
export function appendLeafSuffix(leaf: string, suffix: string, maxBytes: number): string {
  const ext = path.extname(leaf);
  const stem = path.basename(leaf, ext);
  const suffixBytes = utf8ByteLength(suffix);
  const extBytes = utf8ByteLength(ext);
  if (extBytes + suffixBytes >= maxBytes) {
    return truncateUtf8Bytes(`${stem}${suffix}${ext}`, maxBytes);
  }
  return `${truncateUtf8Bytes(stem, maxBytes - extBytes - suffixBytes)}${suffix}${ext}`;
}

/**
 * Resolves a user-facing error message from a file upload error.
 * When redaction is enabled, maps known error patterns to fixed messages
 * without exposing provider, filesystem, filename, or submitted-content details.
 */
export function resolveUploadErrorMessage(
  error: { message?: string } | null | undefined,
  defaultMessage = 'Error processing file',
  redactDetails = false,
): string {
  if (error instanceof UnsupportedProviderAudioError) {
    return error.message;
  }
  const errorMessage = error?.message;
  if (!errorMessage) {
    return defaultMessage;
  }

  if (errorMessage.includes('file_ids')) {
    return redactDetails
      ? `${defaultMessage}: File limit reached`
      : `${defaultMessage}: ${errorMessage}`;
  }

  for (const [fragment, userMessage] of USER_FACING_UPLOAD_ERRORS) {
    if (errorMessage.includes(fragment)) {
      return redactDetails ? userMessage : errorMessage;
    }
  }

  return defaultMessage;
}

/**
 * Sanitize a filename by removing any directory components, replacing unsafe characters
 * @param inputName
 */
export function sanitizeFilename(inputName: string): string {
  // Remove any directory components
  let name = path.basename(inputName);

  // Preserve Unicode word characters and emoji while replacing unsafe ASCII punctuation.
  name = sanitizeFilenameSegment(name);

  // Ensure the name doesn't start with a dot (hidden file in Unix-like systems)
  if (name.startsWith('.') || name === '') {
    name = '_' + name;
  }

  // Limit the filename to filesystem NAME_MAX, which is byte-based on Linux/APFS.
  name = truncateLeafWithSuffix(
    name,
    '-' + crypto.randomBytes(3).toString('hex'),
    FILENAME_SEGMENT_MAX_BYTES,
  );

  return name;
}

/** Per-path-component byte cap. Mirrors `sanitizeFilename`'s 255-byte
 * basename cap and matches filesystem `NAME_MAX` (255 bytes on Linux/ext4,
 * 255 chars on Windows/NTFS) — without it, `saveBuffer` writes
 * `${file_id}__${flatName}` and a long artifact name surfaces as
 * `ENAMETOOLONG` and falls back to a download URL instead of persisting. */
const ARTIFACT_PATH_SEGMENT_MAX_BYTES = FILENAME_SEGMENT_MAX_BYTES;

/** Whole-path length cap for the path-preserving form. The DB stores this
 * value in `filename`, which participates in a compound unique index on
 * the File schema — `{ filename, conversationId, context, tenantId }`
 * with a partial filter for `context: FileContext.execute_code`
 * (`packages/data-schemas/src/schema/file.ts`). MongoDB 4.0 and earlier
 * reject indexed values past 1024 bytes; even on 4.2+ where the limit
 * is configurable, runaway nested paths bloat the index for no real
 * benefit. 512 bytes is plenty for realistic code-execution outputs
 * (typical depth ≤ 3 segments × short names) and gives headroom for
 * BSON / index-overhead encoding.
 *
 * Above the cap we fall back to leaf-only — the same shape as the
 * absolute-path / `..`-traversal branches above. This loses directory
 * structure for the pathological case (the user's `cat /mnt/data/<deep>/
 * <path>/file.txt` won't survive across turns), but DB-write failure
 * with a missing artifact is strictly worse than a flat-name fallback.
 * Pre-PR every artifact got this treatment regardless of depth, so the
 * cap is monotonically better than the prior behavior. */
const ARTIFACT_PATH_TOTAL_MAX_BYTES = 512;

/**
 * Deterministic disambiguator suffix for truncated names. The original
 * `sanitizeFilename` used `crypto.randomBytes(3)`, which made the
 * truncated form non-deterministic — a re-upload of the same long
 * filename would compute a *different* storage key, orphaning the
 * previous on-disk file under `claimCodeFile`'s reused `file_id`.
 *
 * Hashing the input gives stability across calls (same input → same
 * output) while still disambiguating distinct inputs that share a
 * truncation prefix. SHA-256 truncated to 6 hex chars is collision-safe
 * for our scale (24 bits ≈ 16M values; we'd need ~5K simultaneous
 * truncated names in one (filename, conversationId) bucket before a
 * collision becomes likely, vs. the realistic ceiling of single-digit
 * artifacts per turn).
 */
export function deterministicHexSuffix(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 6);
}

/**
 * Truncates a path-leaf segment while preserving its extension, matching the
 * shape `sanitizeFilename` uses for the basename cap. The 6-hex-char
 * suffix is a SHA-256 prefix of the original input, so re-truncating
 * the same name produces the same key (no orphaned uploads).
 *
 * Falls back to whole-segment truncation (no extension preservation) when
 * the extension itself is so long there's no room for a meaningful stem —
 * `path.extname` happily returns 100+ char "extensions" for pathological
 * inputs like `_.<huge-suffix>`, and trying to keep that extension would
 * still blow past the cap.
 */
function truncateLeafSegment(leaf: string): string {
  return truncateLeafWithSuffix(
    leaf,
    '-' + deterministicHexSuffix(leaf),
    ARTIFACT_PATH_SEGMENT_MAX_BYTES,
  );
}

/** Truncates a non-leaf (directory) segment. Directory segments don't
 * carry semantic extensions, so we just slice and append the same 6-hex
 * disambiguation suffix. */
function truncateDirSegment(seg: string): string {
  if (utf8ByteLength(seg) <= ARTIFACT_PATH_SEGMENT_MAX_BYTES) return seg;
  return truncateWithSuffix(
    seg,
    '-' + deterministicHexSuffix(seg),
    ARTIFACT_PATH_SEGMENT_MAX_BYTES,
  );
}

/**
 * Embed a deterministic 6-hex hash of `hashSource` in `segment` (before its
 * extension if any). Used to keep two different raw artifact names that
 * sanitize to the same `segment` distinguishable — without this,
 * `claimCodeFile`'s `(filename, conversationId, context, tenantId)`
 * compound unique index would silently match the second upload to the
 * first record and overwrite the first artifact's bytes.
 *
 * The disambiguator survives length capping: if appending pushes the
 * segment past `ARTIFACT_PATH_SEGMENT_MAX_BYTES`, the stem is trimmed to make
 * room (the hash + extension are load-bearing for collision avoidance
 * and MIME inference, the stem is just the human-readable prefix).
 */
function embedDisambiguatorInLeaf(segment: string, hashSource: string): string {
  const suffix = '-' + deterministicHexSuffix(hashSource);
  const dot = segment.lastIndexOf('.');
  /* `dot <= 1` treats dotfile-prefixed leaves (`_.hidden`, `_.x`) and
   * extensionless names (`Makefile`, `out`) the same way: append the
   * disambiguator at the end rather than splitting `_.hidden` into stem
   * `_` + "extension" `.hidden`, which would produce the awkward
   * `_-<hash>.hidden`. The `_.x.y` case (dotfile with a real extension)
   * still has `dot > 1` and goes through the extension-preserving
   * branch correctly. */
  let result: string;
  if (dot <= 1) {
    const proposed = segment + suffix;
    result =
      utf8ByteLength(proposed) <= ARTIFACT_PATH_SEGMENT_MAX_BYTES
        ? proposed
        : truncateWithSuffix(segment, suffix, ARTIFACT_PATH_SEGMENT_MAX_BYTES);
  } else {
    const stem = segment.slice(0, dot);
    const ext = segment.slice(dot);
    const proposed = stem + suffix + ext;
    if (utf8ByteLength(proposed) <= ARTIFACT_PATH_SEGMENT_MAX_BYTES) {
      result = proposed;
    } else {
      // Trim stem to make room while preserving disambiguator + extension.
      const stemBudget = Math.max(
        0,
        ARTIFACT_PATH_SEGMENT_MAX_BYTES - utf8ByteLength(suffix) - utf8ByteLength(ext),
      );
      result = truncateUtf8Bytes(stem, stemBudget) + suffix + ext;
    }
  }
  /* Defensive final clamp. The branches above already keep the result
   * within `ARTIFACT_PATH_SEGMENT_MAX_BYTES` for any input where the
   * extension fits the segment, but a pathological extension (e.g. the
   * `.aaaaa…` shape `path.extname` returns for contrived inputs) could
   * still produce a longer result. Hard-clamp so the segment cap holds
   * unconditionally. */
  return utf8ByteLength(result) <= ARTIFACT_PATH_SEGMENT_MAX_BYTES
    ? result
    : truncateUtf8Bytes(result, ARTIFACT_PATH_SEGMENT_MAX_BYTES);
}

/**
 * Sanitize a code-execution artifact path while preserving directory components
 * so subsequent prime() runs can place the file at the same nested location in
 * the next sandbox session. Each segment is sanitized independently with the
 * same rules as `sanitizeFilename`. Falls back to the basename for absolute
 * paths or names containing `..` traversal.
 *
 * Each path component is capped at `ARTIFACT_PATH_SEGMENT_MAX_BYTES` (255 bytes)
 * — the leaf with extension preservation (matching `sanitizeFilename`),
 * non-leaf segments with a plain truncate-and-disambiguate. Without the
 * cap, long artifact names flow into `saveBuffer`'s storage key
 * unbounded and trip `ENAMETOOLONG` instead of persisting.
 */
export function sanitizeArtifactPath(inputName: string): string {
  if (!inputName) return '_';
  if (path.isAbsolute(inputName)) return sanitizeFilename(inputName);
  const normalized = path.posix.normalize(inputName);
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized.endsWith('/..') ||
    normalized.endsWith('/')
  ) {
    return sanitizeFilename(inputName);
  }
  const segments = normalized
    .split('/')
    .map(sanitizeFilenameSegment)
    .filter((seg) => seg.length > 0 && seg !== '.');
  if (segments.length === 0) return '_';
  const leafIdx = segments.length - 1;
  if (segments[leafIdx].startsWith('.')) segments[leafIdx] = '_' + segments[leafIdx];
  /* Snapshot the post-regex-and-dotfile form BEFORE per-segment
   * truncation so the collision-avoidance check below only fires for
   * character-level mutations (regex replacement, normalization,
   * dotfile prefix, empty-segment collapse). Truncation by itself is
   * already disambiguated by `truncateLeafSegment`'s seg-hash; firing
   * the input-hash branch on truncation alone would just stack a
   * second hash for no collision-avoidance benefit. */
  const preCapJoined = segments.join('/');
  const capped = segments.map((seg, i) =>
    i === leafIdx ? truncateLeafSegment(seg) : truncateDirSegment(seg),
  );
  let joined = capped.join('/');
  /* Collision avoidance. `sanitizeArtifactPath` is not injective:
   * `out@1.csv` and `out#1.csv` (and `out 1.csv` and `out_1.csv`, and
   * `.x` and `_.x`) all collapse onto the same safe form. Without
   * disambiguation, `claimCodeFile` — keyed on the schema's compound
   * unique `(filename, conversationId, context, tenantId)` index —
   * matches the later upload to the earlier record and silently
   * overwrites the first artifact's bytes via the reused `file_id`.
   *
   * When character-level sanitization changed something, embed a
   * SHA-256 prefix of the raw input in the leaf segment. Same raw
   * input → same safe form (idempotent for re-uploads); different raw
   * inputs that would have collided → different safe forms.
   *
   * Clean inputs (where the regex/normalize pass was a raw-string no-op) skip
   * the disambiguator — no collision is possible because they're
   * already distinct strings, and we don't want to clutter human-
   * readable filenames with a hash when nothing was at risk. */
  if (preCapJoined !== inputName) {
    capped[leafIdx] = embedDisambiguatorInLeaf(capped[leafIdx], inputName);
    joined = capped.join('/');
  }
  /* Per-segment caps are necessary but not sufficient — a deeply nested
   * path with many at-cap segments can still exceed the DB's indexed-key
   * limit (Mongo 4.0 ≤ 1024 bytes; later versions configurable). Fall
   * back to leaf-only when the joined form blows past the total cap, so
   * the (filename, conversationId, context, tenantId) compound unique
   * index never sees an oversized key. The leaf is already capped by
   * `truncateLeafSegment` + `embedDisambiguatorInLeaf`, so this
   * guarantees ≤ ARTIFACT_PATH_SEGMENT_MAX_BYTES (255 bytes). Same shape as
   * the absolute-path / `..`-traversal fallback above. */
  if (utf8ByteLength(joined) > ARTIFACT_PATH_TOTAL_MAX_BYTES) {
    return capped[leafIdx];
  }
  return joined;
}

/** Limit on `path.extname`'s "extension" byte length we'll honor when
 * truncating a flat key. Real file extensions cap out around 8 chars
 * (`.parquet`, `.tsv`, `.html`); a 16-char ceiling keeps us tolerant of
 * legitimate edge cases (`.openshift`) while ignoring pathological
 * outputs from `path.extname` on contrived inputs. Above that we treat
 * the trailing `.foo` as part of the stem and just hard-truncate. */
const FLAT_KEY_MAX_EXT_BYTES = 16;

/**
 * Map a (sanitized) artifact path to a flat storage-safe key. The local
 * storage strategies key by single component; this avoids creating
 * unintended subdirectories on disk while the DB record retains the
 * nested path for the next prime().
 *
 * Optionally caps the result at `maxLength` UTF-8 bytes. Per-segment caps
 * applied by `sanitizeArtifactPath` aren't enough on their own —
 * `${file_id}__${flatName}` has to fit in one filesystem path component
 * (NAME_MAX = 255 on most filesystems), so a deeply-nested path whose
 * segments are individually within bounds can still produce a flat form
 * that overflows once `${file_id}__` is prepended. The caller passes
 * `255 - prefix.length` and the truncation preserves the leaf extension
 * with the same disambiguating hex suffix that `sanitizeFilename` uses.
 *
 * Without this cap, oversized flat keys hit `ENAMETOOLONG` inside
 * `saveBuffer`, the artifact falls back to a download URL, and the next
 * prime() never sees it.
 */
export function flattenArtifactPath(safePath: string, maxLength?: number): string {
  const flat = safePath.replace(/\//g, '__');
  if (maxLength == null || utf8ByteLength(flat) <= maxLength) return flat;
  if (maxLength <= 0) return '';

  /* Find the leaf's extension (last `.`) — segment separators are `__`,
   * never `.`, so the last dot is always inside the leaf. Ignore
   * "extensions" longer than `FLAT_KEY_MAX_EXT_BYTES` so a pathological
   * input doesn't leave us with no stem budget. */
  const lastDot = flat.lastIndexOf('.');
  const candidateExt = lastDot >= 0 ? flat.slice(lastDot) : '';
  const ext =
    candidateExt.length > 0 && utf8ByteLength(candidateExt) <= FLAT_KEY_MAX_EXT_BYTES
      ? candidateExt
      : '';
  const stem = ext ? flat.slice(0, lastDot) : flat;
  // 7 = '-' + 6 hex disambiguator. Stem budget can collapse to 0 when
  // `ext` byte length > maxLength - 7 — that's fine; the stem just disappears
  // and we fall back to `-<hash><ext>` (still bounded). The hash is a
  // SHA-256 prefix of `safePath` so re-flattening the same input
  // produces the same key (same storage location across re-uploads).
  const stemBudget = Math.max(0, maxLength - utf8ByteLength(ext) - 7);
  const truncated =
    truncateUtf8Bytes(stem, stemBudget) + '-' + deterministicHexSuffix(safePath) + ext;
  /* Final clamp. The stemBudget formula above keeps `truncated.length`
   * exactly at `maxLength` for any maxLength ≥ ext byte length + 7, and at
   * `7 + ext byte length` otherwise. The latter can still exceed maxLength
   * for absurdly small budgets (maxLength < ext byte length + 7) — clamp
   * defensively so callers always get a key ≤ maxLength regardless of
   * what they passed in. */
  return utf8ByteLength(truncated) <= maxLength
    ? truncated
    : truncateUtf8Bytes(truncated, maxLength);
}

/**
 * Options for reading files
 */
export interface ReadFileOptions {
  encoding?: BufferEncoding;
  /** Size threshold in bytes. Files larger than this will be streamed. Default: 10MB */
  streamThreshold?: number;
  /** Size of chunks when streaming. Default: 64KB */
  highWaterMark?: number;
  /** File size in bytes if known (e.g. from multer). Avoids extra stat() call. */
  fileSize?: number;
}

/**
 * Result from reading a file
 */
export interface ReadFileResult<T> {
  content: T;
  bytes: number;
}

/**
 * Reads a file asynchronously. Uses streaming for large files to avoid memory issues.
 *
 * @param filePath - Path to the file to read
 * @param options - Options for reading the file
 * @returns Promise resolving to the file contents and size
 * @throws Error if the file cannot be read
 */
export async function readFileAsString(
  filePath: string,
  options: ReadFileOptions = {},
): Promise<ReadFileResult<string>> {
  const {
    encoding = 'utf8',
    streamThreshold = 10 * 1024 * 1024, // 10MB
    highWaterMark = 64 * 1024, // 64KB
    fileSize,
  } = options;

  // Get file size if not provided
  const bytes = fileSize ?? (await stat(filePath)).size;

  // For large files, use streaming to avoid memory issues
  if (bytes > streamThreshold) {
    const chunks: string[] = [];
    const stream = createReadStream(filePath, {
      encoding,
      highWaterMark,
    });

    for await (const chunk of stream) {
      chunks.push(chunk as string);
    }

    return { content: chunks.join(''), bytes };
  }

  // For smaller files, read directly
  const content = await readFile(filePath, encoding);
  return { content, bytes };
}

/**
 * Reads a file as a Buffer asynchronously. Uses streaming for large files.
 *
 * @param filePath - Path to the file to read
 * @param options - Options for reading the file
 * @returns Promise resolving to the file contents and size
 * @throws Error if the file cannot be read
 */
export async function readFileAsBuffer(
  filePath: string,
  options: Omit<ReadFileOptions, 'encoding'> = {},
): Promise<ReadFileResult<Buffer>> {
  const {
    streamThreshold = 10 * 1024 * 1024, // 10MB
    highWaterMark = 64 * 1024, // 64KB
    fileSize,
  } = options;

  // Get file size if not provided
  const bytes = fileSize ?? (await stat(filePath)).size;

  // For large files, use streaming to avoid memory issues
  if (bytes > streamThreshold) {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath, {
      highWaterMark,
    });

    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }

    return { content: Buffer.concat(chunks), bytes };
  }

  // For smaller files, read directly
  const content = await readFile(filePath);
  return { content, bytes };
}

/**
 * Reads a JSON file asynchronously
 *
 * @param filePath - Path to the JSON file to read
 * @param options - Options for reading the file
 * @returns Promise resolving to the parsed JSON object
 * @throws Error if the file cannot be read or parsed
 */
export async function readJsonFile<T = unknown>(
  filePath: string,
  options: Omit<ReadFileOptions, 'encoding'> = {},
): Promise<T> {
  const { content } = await readFileAsString(filePath, { ...options, encoding: 'utf8' });
  return JSON.parse(content);
}
