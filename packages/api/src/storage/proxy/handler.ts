import { pipeline } from 'stream/promises';
import { logger, tenantStorage } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { Readable } from 'stream';
import type { ViewerAuthResult } from '~/images/authorization';
import { sanitizeContentDispositionFilename } from '~/storage/validation';
import { getSafeErrorMetadata } from '~/utils/errors';

/** Who a stored object belongs to, read from its key. */
export interface StoredFileKey {
  userId: string;
  fileName: string;
  tenantId?: string;
  /** An avatar, which any signed-in user in the tenant may see. */
  avatar?: boolean;
}

export interface StoredObject {
  body?: Readable;
  contentLength?: number;
}

/** What the route needs from a storage strategy to serve its objects. */
export interface StoredFileSource {
  /** Reads a key's owner and file name; `null` for a key the strategy never writes. */
  parseKey: (key: string) => StoredFileKey | null;
  /** Reads an object, or only its size when `head` is set. */
  read: (key: string, options: { head: boolean; signal: AbortSignal }) => Promise<StoredObject>;
  /** Whether a `read` failure means the object does not exist. */
  isNotFound: (error: unknown) => boolean;
}

export interface StoredFileViewer {
  userId: string;
  role?: string | null;
  tenantId?: string;
}

export interface StoredFileDeps {
  /** Identifies the signed-in user from the request's session cookie, as `/images` does. */
  authenticate: (req: Request) => Promise<ViewerAuthResult>;
  /** The storage strategies served, by file source (`s3`, ...). Other sources get a 404. */
  sources: Partial<Record<string, StoredFileSource>>;
  /**
   * Whether a viewer who does not own the object may read it: the access rules of the
   * file record `ownerId` stored under `key` (for example, a file attached to an agent
   * shared with the viewer). Runs in the viewer's tenant context. Without it, only
   * owners can.
   */
  canViewFile?: (
    viewer: StoredFileViewer,
    file: { source: string; key: string; ownerId: string },
  ) => Promise<boolean>;
}

/** Raster images a browser displays; every other file is sent as a download. */
const INLINE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

/**
 * The files are user uploads served from the app's own origin, so a document
 * opened directly (an SVG or HTML file, say) must not run script there.
 */
const FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** `/<source>/<key>`, each segment URL-encoded. */
function decodePath(path: string): { source: string; key: string } | null {
  const [source, ...segments] = path.replace(/^\/+/, '').split('/');
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

function getDisposition(fileName: string, extension: string): string {
  if (INLINE_TYPES[extension]) {
    return 'inline';
  }
  return `attachment; filename="${sanitizeContentDispositionFilename(fileName)}"`;
}

/**
 * Serves stored files through LibreChat, so browsers never need access to the
 * storage service and it can refuse requests from outside the deployment's
 * network (an S3 bucket policy on aws:SourceVpce, say). Links carry the file's
 * source and object key; the session cookie names the viewer. Within the
 * viewer's tenant, the route serves:
 * - the owner named in the key's user segment;
 * - avatars to any signed-in user, as CloudFront avatar cookies do;
 * - anyone `canViewFile` admits under the stored file's own access rules.
 * Everyone else gets a 404. Mounted at `STORED_FILES_ROUTE`.
 */
export function createStoredFileHandler({ authenticate, sources, canViewFile }: StoredFileDeps) {
  const isAllowed = async (
    viewer: StoredFileViewer,
    file: { source: string; key: string },
    owner: StoredFileKey,
  ): Promise<boolean> => {
    if (owner.userId === viewer.userId) {
      return true;
    }
    if ((owner.tenantId ?? '') !== (viewer.tenantId ?? '')) {
      return false;
    }
    if (owner.avatar) {
      return true;
    }
    if (!canViewFile) {
      return false;
    }
    const check = () => canViewFile(viewer, { ...file, ownerId: owner.userId });
    return viewer.tenantId
      ? tenantStorage.run({ tenantId: viewer.tenantId, userId: viewer.userId }, check)
      : check();
  };

  return async function serveStoredFile(req: Request, res: Response): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.set('Allow', 'GET, HEAD').status(405).end();
      return;
    }

    try {
      const auth = await authenticate(req);
      if (auth.status !== 'authenticated') {
        res.status(auth.status === 'missing' ? 401 : 403).send('Unauthorized');
        return;
      }

      const file = decodePath(req.path);
      const source = file ? sources[file.source] : undefined;
      const owner = file && source ? source.parseKey(file.key) : null;
      const viewer: StoredFileViewer = {
        userId: auth.userId,
        role: auth.role,
        tenantId: auth.tenantId,
      };
      if (!file || !source || !owner || !(await isAllowed(viewer, file, owner))) {
        res.status(404).send('Not Found');
        return;
      }

      const controller = new AbortController();
      res.on('close', () => controller.abort());
      const head = req.method === 'HEAD';
      let object: StoredObject;
      try {
        object = await source.read(file.key, { head, signal: controller.signal });
      } catch (error) {
        if (source.isNotFound(error)) {
          res.status(404).send('Not Found');
          return;
        }
        throw error;
      }

      const extension = owner.fileName.split('.').pop()?.toLowerCase() ?? '';
      res.set({
        'Content-Type': INLINE_TYPES[extension] ?? 'application/octet-stream',
        'Content-Disposition': getDisposition(owner.fileName, extension),
        'Content-Security-Policy': FILE_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=3600',
      });
      if (object.contentLength != null) {
        res.set('Content-Length', String(object.contentLength));
      }
      if (head || !object.body) {
        res.status(200).end();
        return;
      }
      res.status(200);
      await pipeline(object.body, res);
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableFinished) {
          logger.warn('[storedFiles] Stream ended early', getSafeErrorMetadata(error));
        }
        return;
      }
      logger.error('[storedFiles] Error serving file', getSafeErrorMetadata(error));
      res.status(500).send('Internal Server Error');
    }
  };
}
