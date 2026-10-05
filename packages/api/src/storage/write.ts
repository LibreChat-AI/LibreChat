import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import type { ContainerClient } from '@azure/storage-blob';
import type {
  FileStreamStorage,
  GetURLParams,
  SaveBufferParams,
  SaveStreamParams,
  StorageFileLocation,
  UploadResult,
} from './types';
import { assertPathSegment } from './validation';

/** Shared non-S3 key layout; adapters, rather than callers, own tenant placement. */
function scopedPath(params: GetURLParams): {
  basePath: string;
  userId: string;
  fileName: string;
  tenantPath: string;
} {
  return {
    basePath: assertPathSegment('base path', params.basePath ?? 'images', 'storage'),
    userId: assertPathSegment('owner', params.userId, 'storage'),
    fileName: assertPathSegment('filename', params.fileName, 'storage'),
    tenantPath: params.tenantId
      ? `t/${assertPathSegment('tenant', params.tenantId, 'storage')}/`
      : '',
  };
}

export interface AzureStreamStorage extends FileStreamStorage {
  streamFile(
    params: Omit<SaveStreamParams, 'path'> & { filePath: string; containerName?: string },
  ): Promise<string>;
}

export function createAzureStreamStorage({
  getContainerClient,
  getContentType,
  publicAccess,
}: {
  getContainerClient(name?: string): Promise<ContainerClient>;
  getContentType(fileName: string): string | null;
  publicAccess?: string;
}): AzureStreamStorage {
  const location = async (params: GetURLParams & { containerName?: string }) => {
    const { basePath, userId, fileName, tenantPath } = scopedPath(params);
    const storageKey = `${tenantPath}${basePath}/${userId}/${fileName}`;
    const container = await getContainerClient(params.containerName);
    const blob = container.getBlockBlobClient(storageKey);
    return { storageKey, container, blob };
  };
  const saveStream = async (
    params: SaveStreamParams & { containerName?: string },
  ): Promise<UploadResult> => {
    const { storageKey, container, blob } = await location(params);
    await container.createIfNotExists({
      access: publicAccess?.toLowerCase() === 'true' ? 'blob' : undefined,
    });
    const { size: bytes } = await stat(params.path);
    const stream = createReadStream(params.path);
    try {
      await blob.uploadStream(stream, undefined, undefined, {
        blobHTTPHeaders: {
          blobContentType: params.contentType ?? getContentType(params.fileName) ?? undefined,
        },
      });
    } finally {
      stream.destroy();
    }
    return { storageKey, filepath: blob.url, bytes };
  };
  return {
    async planFile(params) {
      const { storageKey, blob } = await location(params);
      return { storageKey, filepath: blob.url };
    },
    saveStream,
    async streamFile({ filePath, ...params }) {
      return (await saveStream({ ...params, path: filePath })).filepath;
    },
  };
}

/** Firebase's client SDK accepts buffers; callers provide a disk path with the same bounded contract. */
export function createBufferStreamStorage({
  saveBuffer,
}: {
  saveBuffer(params: SaveBufferParams): Promise<string | null>;
}): FileStreamStorage {
  const plan = (params: GetURLParams): StorageFileLocation => {
    const { basePath, userId, fileName, tenantPath } = scopedPath(params);
    const storageKey = `${tenantPath}${basePath}/${userId}/${fileName}`;
    return { storageKey, filepath: storageKey };
  };
  return {
    async planFile(params) {
      return plan(params);
    },
    async saveStream(params) {
      const location = plan(params);
      const { basePath, tenantPath } = scopedPath(params);
      const buffer = await readFile(params.path);
      const filepath = await saveBuffer({
        ...params,
        basePath: `${tenantPath}${basePath}`,
        buffer,
      });
      if (!filepath) throw new Error('Storage did not confirm the stream upload.');
      return { ...location, filepath, bytes: buffer.length };
    },
  };
}

export function createLocalStreamStorage({
  imageDirectory,
  uploadDirectory,
}: {
  imageDirectory: string;
  uploadDirectory: string;
}): FileStreamStorage {
  const plan = (params: GetURLParams) => {
    const { basePath, userId, fileName, tenantPath } = scopedPath(params);
    if (basePath !== 'images' && basePath !== 'uploads')
      throw new Error('Unsupported local storage base path.');
    const relative = `${tenantPath}${userId}/${fileName}`;
    const storageKey = `${basePath}/${relative}`;
    const destination = path.join(
      basePath === 'images' ? imageDirectory : uploadDirectory,
      relative,
    );
    return { storageKey, filepath: `/${storageKey}`, destination };
  };
  return {
    async planFile(params) {
      const { destination: _destination, ...location } = plan(params);
      return location;
    },
    async saveStream(params) {
      const { destination, ...location } = plan(params);
      await mkdir(path.dirname(destination), { recursive: true });
      await pipeline(
        createReadStream(params.path),
        createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
      );
      return { ...location, bytes: (await stat(destination)).size };
    },
  };
}
