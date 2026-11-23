import path from 'path';
import type { TFile } from 'librechat-data-provider';

/** A stored file as a download needs it: the recorded object key when one exists, else the URL or path. */
export type StoredFileRef = Pick<TFile, 'filepath'> & { storageKey?: string | null };

/**
 * Resolves the argument for a strategy's `getDownloadStream`. S3 and CloudFront records carry
 * the object key since the region-aware storage keys landed; handing it over directly skips
 * re-deriving it from a presigned or CDN URL, which is only sound while that URL still parses.
 * Records without a key (local, Firebase, Azure, code output) fall through to `filepath` as before.
 */
export function resolveDownloadPath(file: StoredFileRef): string {
  return file.storageKey || file.filepath;
}

/**
 * Strips the query string from a stored `filepath` before it is resolved on disk.
 *
 * A regenerated code-interpreter output persists a cache-busting `?v=<timestamp>` suffix on its
 * file document's `filepath` (`processCodeOutput`), and shared-link cache validators fold that
 * field in deliberately (`buildShareFileEtag`), so the suffix cannot be dropped at write time.
 * Local storage is the only strategy that turns `filepath` into a filesystem path, so it is the
 * only one that has to remove the suffix before reading or deleting. A remote strategy receives a
 * URL whose query string can carry a presigned signature, which is why `resolveDownloadPath`
 * hands its result over untouched.
 *
 * Unambiguous for local paths because `sanitizeFilename` replaces `?` with `_` in every stored
 * name, so no file on disk carries one.
 */
export function stripCacheBust(filepath: string): string {
  const queryIndex = filepath.indexOf('?');
  return queryIndex === -1 ? filepath : filepath.slice(0, queryIndex);
}

/** Characters that change what a name means once it sits in a URL path. */
const UNSAFE_URL_SEGMENT = /[%#?\\\t\n\r]/;

/** Escapes a segment only when it holds such a character, so every other name is recorded as it always was. */
const encodeSegment = (segment: string): string =>
  UNSAFE_URL_SEGMENT.test(segment) ? encodeURIComponent(segment) : segment;

/**
 * Undoes `encodeSegment`, keeping a segment the encoder could not have produced as it was recorded.
 * The encoder never emits a separator inside a segment, so a decoded name holding one is not its output.
 */
const decodeSegment = (segment: string): string => {
  if (!segment.includes('%')) {
    return segment;
  }
  try {
    const decoded = decodeURIComponent(segment);
    const holdsSeparator = decoded.includes('/') || decoded.includes(path.sep);
    return !holdsSeparator && encodeSegment(decoded) === segment ? decoded : segment;
  } catch {
    return segment;
  }
};

/**
 * Builds the URL path a locally stored file is recorded and served at. The parts are joined and
 * normalized like a file path. A segment holding `%`, `#`, `?`, `\`, a tab or a line break is then
 * percent-encoded, so the name addresses the file instead of a fragment, a query string or another
 * path; any other segment is recorded as it is, so URLs that already worked do not change. A `/`
 * inside a part stays a separator, so a part such as `userId/name` keeps its directory.
 */
export function toLocalUrlPath(...parts: string[]): string {
  return path.posix
    .join('/', ...parts)
    .split('/')
    .map(encodeSegment)
    .join('/');
}

/**
 * Maps a recorded local URL path back to the path it names on disk; the inverse of
 * `toLocalUrlPath`. A segment is decoded only when `toLocalUrlPath` would have produced it from the
 * decoded name. Anything else was recorded raw, so a legacy `a%20b.txt` or `50%.png` still resolves
 * to the file of that name. Strip any cache-busting query string first: an encoded name never
 * carries a raw `?`.
 */
export function fromLocalUrlPath(urlPath: string): string {
  return urlPath.split('/').map(decodeSegment).join('/');
}
