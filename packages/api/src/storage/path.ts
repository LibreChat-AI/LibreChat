import type { TFile } from 'librechat-data-provider';

/** A stored file as a download needs it: the recorded object key when one exists, else the URL or path. */
export type StoredFileRef = Pick<TFile, 'filepath'> & {
  source?: string;
  storageKey?: string | null;
};

/**
 * Resolves the argument for a strategy's `getDownloadStream`. S3 and CloudFront records carry
 * the object key since the region-aware storage keys landed; handing it over directly skips
 * re-deriving it from a presigned or CDN URL, which is only sound while that URL still parses.
 * Records without a key (local, Firebase, Azure, code output) fall through to `filepath` as before.
 */
export function resolveDownloadPath(file: StoredFileRef): string {
  return (file.source === 's3' || file.source === 'cloudfront') && file.storageKey
    ? file.storageKey
    : file.filepath;
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
