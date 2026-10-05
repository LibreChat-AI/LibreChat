import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { mkdir, readdir, lstat, rm, unlink } from 'node:fs/promises';
import type { MediaConfig } from 'librechat-data-provider';
import type { Request } from 'express';
import { mediaContentByteLimit, normalizeMediaContentType } from './content';
import { mediaTemporaryDirectory } from './temporary';
import { MediaByteCounter } from './storage';

type UploadFile = Express.Multer.File;

/** Structural subset of multer's `StorageEngine`, so the host can hand in multer itself. */
export interface MediaUploadStorage {
  _handleFile(
    req: Request,
    file: UploadFile,
    callback: (error: Error | null, info?: Partial<UploadFile>) => void,
  ): void;
  _removeFile(req: Request, file: UploadFile, callback: (error: Error | null) => void): void;
}

export interface MediaStaging {
  readonly directory: string;
  /** Writes one upload to staging, bounded by the limit of its declared media type. */
  storage(config: MediaConfig): MediaUploadStorage;
  /** Removes staged files last modified before `staleBefore`; returns how many were removed. */
  sweep(staleBefore: number): Promise<number>;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

export function createMediaStaging({
  directory,
  legacyDirectory,
  id,
}: {
  directory: string;
  legacyDirectory?: string;
  id: () => string;
}): MediaStaging {
  const root = path.resolve(directory);
  const remove = (location: string) =>
    unlink(location).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });

  return {
    directory: root,
    storage(config) {
      return {
        _handleFile(req, file, callback) {
          const filename = id();
          let ownerDirectory: string;
          try {
            ownerDirectory = mediaTemporaryDirectory(
              root,
              (req as Request & { user?: { id?: string } }).user?.id ?? '',
            );
          } catch (error) {
            callback(asError(error, 'Media staging requires authentication.'));
            return;
          }
          const location = path.join(ownerDirectory, filename);
          const controller = new AbortController();
          const abort = () => controller.abort();
          let sourceError: Error | undefined;
          const rememberError = (error: Error) => {
            sourceError = error;
          };
          req.once('aborted', abort);
          file.stream.once('error', rememberError);
          const stage = async (): Promise<Partial<UploadFile>> => {
            let created = false;
            try {
              await mkdir(ownerDirectory, { recursive: true });
              if (req.aborted) abort();
              controller.signal.throwIfAborted();
              if (sourceError) throw sourceError;
              if (file.stream.destroyed) throw new Error('The media upload ended prematurely.');
              const limit = mediaContentByteLimit(normalizeMediaContentType(file.mimetype), config);
              const counter = new MediaByteCounter(limit);
              const out = createWriteStream(location, { flags: 'wx', mode: 0o600 });
              out.once('open', () => {
                created = true;
              });
              await pipeline(file.stream, counter, out, { signal: controller.signal });
              return { destination: ownerDirectory, filename, path: location, size: counter.bytes };
            } catch (error) {
              if (created) await remove(location);
              throw error;
            } finally {
              req.removeListener('aborted', abort);
              file.stream.removeListener('error', rememberError);
            }
          };
          void stage().then(
            (info) => callback(null, info),
            (error: unknown) => callback(asError(error, 'Media staging is unavailable.')),
          );
        },
        _removeFile(_req, file, callback) {
          remove(file.path).then(
            () => callback(null),
            (error: unknown) => callback(asError(error, 'Media staging cleanup failed.')),
          );
        },
      };
    },
    async sweep(staleBefore) {
      const sweepDirectory = async (folder: string): Promise<number> => {
        const directoryInfo = await lstat(folder).catch((error: unknown) => {
          if (isMissing(error)) return null;
          throw error;
        });
        if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) return 0;
        let removed = 0;
        for (const entry of await readdir(folder)) {
          const location = path.resolve(folder, entry);
          const relative = path.relative(folder, location);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
          try {
            const info = await lstat(location);
            if (info.isSymbolicLink() || info.mtimeMs >= staleBefore) continue;
            if (info.isDirectory()) await rm(location, { recursive: true, force: true });
            else if (info.isFile()) await remove(location);
            else continue;
            removed++;
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        }
        return removed;
      };
      const owners = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
        if (isMissing(error)) return [];
        throw error;
      });
      let removed = 0;
      for (const owner of owners) {
        if (!owner.isDirectory() || owner.isSymbolicLink() || !/^[a-zA-Z0-9_-]+$/.test(owner.name))
          continue;
        removed += await sweepDirectory(mediaTemporaryDirectory(root, owner.name));
      }
      // Existing deployments can still have staged bytes from before the temp-tree migration.
      if (legacyDirectory) removed += await sweepDirectory(path.resolve(legacyDirectory));
      return removed;
    },
  };
}
