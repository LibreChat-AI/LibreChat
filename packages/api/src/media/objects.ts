import path from 'node:path';
import { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { FileSources } from 'librechat-data-provider';
import type { MediaOwnerScope } from '@librechat/data-schemas';
import type { FileStorage } from 'librechat-data-provider';
import type { FileStreamStorage, StorageReadOptions } from '~/storage/types';
import { createLocalStreamStorage } from '~/storage/write';
import { parseS3Key } from '~/storage/s3/crud';
import { MediaServiceError } from './errors';

export type MediaStorageSource = FileStorage;
export type MediaObjectLocation = {
  source: string;
  storageKey?: string;
  storageRegion?: string;
  filepath: string;
};
export type MediaObjectReadOptions = StorageReadOptions;

export interface MediaObjectStore {
  readonly source: MediaStorageSource;
  /** Checks existing client configuration without contacting the external storage service. */
  isAvailable?(): Promise<boolean>;
  plan(
    scope: MediaOwnerScope,
    filename: string,
    type: string,
  ): Promise<MediaObjectLocation & { storageKey: string }>;
  put(
    scope: MediaOwnerScope,
    location: MediaObjectLocation,
    stagedPath: string,
    type: string,
  ): Promise<MediaObjectLocation>;
  open(
    scope: MediaOwnerScope,
    location: MediaObjectLocation,
    options?: MediaObjectReadOptions,
  ): Promise<Readable>;
  remove(scope: MediaOwnerScope, location: MediaObjectLocation): Promise<void>;
  revision?(scope: MediaOwnerScope, location: MediaObjectLocation): Promise<string>;
}

export async function removeMediaObjectLocations(
  scope: MediaOwnerScope,
  locations: MediaObjectLocation[],
  resolveStore: (source: string) => MediaObjectStore | undefined,
): Promise<void> {
  const unique = new Map(
    locations.map((location) => [
      `${location.source}:${location.storageRegion ?? ''}:${location.storageKey ?? location.filepath}`,
      location,
    ]),
  );
  for (const location of unique.values()) {
    const store = resolveStore(location.source);
    if (!store) throw new MediaServiceError('unsupported', 422, 'Media storage is unavailable.');
    await store.remove(scope, location);
  }
}

type StorageRequest = { user: { id: string; tenantId?: string } };

/** The existing host strategy contract, narrowed to byte storage without HTTP or database dependencies. */
export interface MediaFileStrategy extends FileStreamStorage {
  /** Host-supplied existing client/config getter; null means storage is not configured. */
  getStorageState?(): object | null | Promise<object | null>;
  getDownloadStream(
    req: StorageRequest,
    filepath: string,
    options?: StorageReadOptions,
  ): Promise<Readable>;
  deleteFile(
    req: StorageRequest,
    file: MediaObjectLocation & { user: string; tenantId?: string | null },
  ): Promise<void>;
  /** Firebase already exports this key-based primitive; it works before an upload URL is known. */
  deleteStoredFile?(basePath: string, filename: string): Promise<void>;
}

export type MediaStrategyResolver = (source: MediaStorageSource) => MediaFileStrategy;

function assertScope(scope: MediaOwnerScope): void {
  if (
    !/^[A-Za-z0-9_-]+$/.test(scope.ownerId) ||
    (scope.tenantId != null && !/^[A-Za-z0-9_-]+$/.test(scope.tenantId))
  ) {
    throw new MediaServiceError('invalid_request', 400, 'Invalid media storage owner.');
  }
}

function missing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (
    ('code' in error &&
      ['ENOENT', 'storage/object-not-found', 'BlobNotFound', 'NoSuchKey'].includes(
        String(error.code),
      )) ||
    ('statusCode' in error && error.statusCode === 404) ||
    ('name' in error && ['NotFound', 'NoSuchKey'].includes(String(error.name)))
  );
}

export function createLocalMediaObjectStore({
  imageDirectory,
  uploadDirectory,
}: {
  imageDirectory: string;
  uploadDirectory: string;
}): MediaObjectStore {
  const writer = createLocalStreamStorage({ imageDirectory, uploadDirectory });
  const roots = { images: path.resolve(imageDirectory), uploads: path.resolve(uploadDirectory) };
  const resolve = (location: MediaObjectLocation): string => {
    const key = location.storageKey ?? location.filepath.replace(/^\//, '');
    const prefix = (['images', 'uploads'] as const).find((value) => key.startsWith(`${value}/`));
    if (location.source !== 'local' || !prefix)
      throw new MediaServiceError('not_found', 404, 'Media content is unavailable.');
    const destination = path.resolve(roots[prefix], key.slice(prefix.length + 1));
    const relative = path.relative(roots[prefix], destination);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new MediaServiceError('not_found', 404, 'Media content is unavailable.');
    return destination;
  };
  return {
    source: FileSources.local,
    async plan(scope, filename) {
      assertScope(scope);
      return {
        source: 'local',
        ...(await writer.planFile({
          userId: scope.ownerId,
          tenantId: scope.tenantId,
          fileName: filename,
        })),
      };
    },
    async put(scope, location, stagedPath, type) {
      const result = await writer.saveStream({
        userId: scope.ownerId,
        tenantId: scope.tenantId,
        fileName: path.posix.basename(location.storageKey ?? ''),
        path: stagedPath,
        contentType: type,
      });
      return { source: 'local', ...result };
    },
    async open(_scope, location, options) {
      return createReadStream(resolve(location), { ...options?.range, signal: options?.signal });
    },
    async remove(_scope, location) {
      try {
        await unlink(resolve(location));
      } catch (error) {
        if (!missing(error)) throw error;
      }
    },
    async revision(_scope, location) {
      const info = await stat(resolve(location));
      return `${info.ino}:${info.size}:${info.mtimeMs}`;
    },
  };
}

/** Reuses the application's initialized storage strategies, credentials, buckets, and URL policies. */
export function createMediaStrategyObjectStores(
  resolveStrategy: MediaStrategyResolver,
): MediaObjectStore[] {
  return (
    [FileSources.s3, FileSources.cloudfront, FileSources.azure_blob, FileSources.firebase] as const
  ).map((source) => {
    const request = (scope: MediaOwnerScope): StorageRequest => ({
      user: { id: scope.ownerId, tenantId: scope.tenantId ?? undefined },
    });
    return {
      source,
      async isAvailable() {
        try {
          const strategy = resolveStrategy(source);
          if (!strategy.getStorageState) return true;
          return (await strategy.getStorageState()) != null;
        } catch {
          return false;
        }
      },
      async plan(scope, filename, type) {
        assertScope(scope);
        const location = await resolveStrategy(source).planFile({
          userId: scope.ownerId,
          fileName: filename,
          basePath: 'images',
          tenantId: scope.tenantId,
          contentType: type,
          useInlinePath: source === 'cloudfront' && type.startsWith('image/'),
        });
        return { source, ...location };
      },
      async put(scope, location, stagedPath, type) {
        const parts =
          source === 's3' || source === 'cloudfront'
            ? parseS3Key(location.storageKey ?? '')
            : undefined;
        const result = await resolveStrategy(source).saveStream({
          userId: scope.ownerId,
          path: stagedPath,
          fileName: parts?.fileName ?? path.posix.basename(location.storageKey ?? ''),
          contentType: type,
          basePath: parts?.basePath ?? 'images',
          tenantId: scope.tenantId,
          storageRegion: parts?.storageRegion,
          includeRegionInPath: parts?.includeRegionInPath,
          useInlinePath: parts?.useInlinePath,
        });
        return { ...location, ...result };
      },
      async open(scope, location, options) {
        const stream = await resolveStrategy(source).getDownloadStream(
          request(scope),
          source === 's3' || source === 'cloudfront'
            ? (location.storageKey ?? location.filepath)
            : location.filepath,
          options,
        );
        return stream;
      },
      async remove(scope, location) {
        try {
          const strategy = resolveStrategy(source);
          if (source === 'firebase' && location.storageKey && strategy.deleteStoredFile) {
            await strategy.deleteStoredFile('', location.storageKey);
            return;
          }
          await strategy.deleteFile(request(scope), {
            ...location,
            user: scope.ownerId,
            tenantId: scope.tenantId,
          });
        } catch (error) {
          if (!missing(error)) throw error;
        }
      },
    };
  });
}
