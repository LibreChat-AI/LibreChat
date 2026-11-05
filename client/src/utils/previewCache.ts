/**
 * Module-level cache for local blob preview URLs keyed by file_id.
 * Survives message replacements from SSE but clears on page refresh.
 */
const previewCache = new Map<string, string>();

export function cachePreview(fileId: string, previewUrl: string): void {
  const existing = previewCache.get(fileId);
  if (existing && existing !== previewUrl) {
    URL.revokeObjectURL(existing);
  }
  previewCache.set(fileId, previewUrl);
}

export function getCachedPreview(fileId: string): string | undefined {
  return previewCache.get(fileId);
}

/** Removes the cache entry without revoking the blob (used when transferring between keys) */
export function removePreviewEntry(fileId: string): void {
  previewCache.delete(fileId);
}

export function deletePreview(fileId: string): void {
  const url = previewCache.get(fileId);
  if (url) {
    URL.revokeObjectURL(url);
    previewCache.delete(fileId);
  }
}
