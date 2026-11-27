import { createHash } from 'crypto';

export const DEFAULT_SHARED_LINKS_PAGE_SIZE: number = 10;
export const MAX_SHARED_LINKS_PAGE_SIZE: number = 100;
export const MAX_SHARED_LINK_SEARCH_LENGTH: number = 256;
/* A title cursor carries the boundary row's title, and a conversation title can run to
   about a thousand characters (more once multi-byte). The cap is only here to reject
   absurd input, so it sits well clear of anything the server can issue. */
export const MAX_SHARED_LINK_CURSOR_LENGTH: number = 8192;

/** Clamp a requested page size, falling back to the default for anything unparseable. */
export function parseSharedLinksPageSize(value: unknown): number {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    return DEFAULT_SHARED_LINKS_PAGE_SIZE;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return DEFAULT_SHARED_LINKS_PAGE_SIZE;
  }

  return Math.min(MAX_SHARED_LINKS_PAGE_SIZE, Math.max(1, parsed));
}

/**
 * The list cursor is opaque: base64 `{ primary, id }`, where `id` is the `_id` that
 * breaks ties on a repeated title or timestamp and `primary` is null for a row with no
 * title. Cursors issued before that encoding carry the bare sort value, so a plain date
 * still passes for a `createdAt` page.
 */
export function isValidSharedLinksCursor(cursor: string, sortBy: string): boolean {
  if (cursor.length > MAX_SHARED_LINK_CURSOR_LENGTH) {
    return false;
  }

  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString());
    const primary = decoded?.primary;
    if (
      (typeof primary === 'string' || primary === null) &&
      /^[a-f\d]{24}$/i.test(decoded?.id ?? '')
    ) {
      // A createdAt page can never carry a null boundary: the field is always stamped.
      if (primary === null) {
        return sortBy !== 'createdAt';
      }
      return sortBy !== 'createdAt' || !Number.isNaN(Date.parse(primary));
    }
  } catch {
    /* Not a composite cursor; fall through to the legacy plain-value check. */
  }

  return sortBy !== 'createdAt' || !Number.isNaN(Date.parse(cursor));
}

export interface ShareFileEtagSource {
  file_id: string;
  previewRevision?: string | number | null;
  bytes?: number | null;
  storageKey?: string | null;
  filepath?: string | null;
}

/**
 * Cache validator for a snapshotted file. Beyond the fields the share routes pin the
 * snapshot on (`previewRevision`, `bytes`), it folds in the stored location: a re-publish
 * that swaps the object without changing size or revision still moves
 * `storageKey`/`filepath` (regenerated code outputs carry a `?v=` cache-buster), so the
 * viewer revalidates instead of keeping its stale copy. A same-path, same-size,
 * same-revision replacement stays the best-effort gap inherent to the no-byte-copy
 * snapshot design.
 */
export function buildShareFileEtag(file: ShareFileEtagSource): string {
  const identity = [
    file.file_id,
    file.previewRevision ?? '',
    file.bytes ?? '',
    file.storageKey ?? '',
    file.filepath ?? '',
  ].join('\u0000');
  return `"share-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}"`;
}
