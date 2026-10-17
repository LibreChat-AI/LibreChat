import { getBasePath } from '~/utils/path';
import { isEnabled } from '~/utils/common';

/**
 * Where LibreChat serves stored files itself when `STORAGE_PROXY_FILES` is on.
 * A link is this route, the file's storage source, then its object key, so it
 * never expires; the route decides who may read it (see `createStoredFileHandler`).
 */
export const STORED_FILES_ROUTE = '/api/stored-files';

/** Whether storage strategies link files to LibreChat instead of to the storage service. */
export function isStoredFileProxyEnabled(): boolean {
  return isEnabled(process.env.STORAGE_PROXY_FILES);
}

/** LibreChat's link to an object in a storage source. */
export function getStoredFileURL(source: string, key: string): string {
  const path = key
    .replace(/^\/+/, '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${getBasePath()}${STORED_FILES_ROUTE}/${encodeURIComponent(source)}/${path}`;
}

/** The source and object key behind one of LibreChat's links, or `null` for any other value. */
export function parseStoredFileURL(value: string): { source: string; key: string } | null {
  const prefix = `${getBasePath()}${STORED_FILES_ROUTE}/`;
  if (!value.startsWith(prefix)) {
    return null;
  }
  const [source, ...segments] = value.slice(prefix.length).split(/[?#]/, 1)[0].split('/');
  if (!source || segments.length === 0) {
    return null;
  }
  try {
    const key = segments.map(decodeURIComponent).join('/');
    return key ? { source: decodeURIComponent(source), key } : null;
  } catch {
    return null;
  }
}

/** The object key behind one of LibreChat's links to `source`, or `null`. */
export function getKeyFromStoredFileURL(value: string, source: string): string | null {
  const parsed = parseStoredFileURL(value);
  return parsed?.source === source ? parsed.key : null;
}
