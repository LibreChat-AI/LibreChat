import { logger } from '@librechat/data-schemas';
import type { ContainerClient } from '@azure/storage-blob';
import type { Readable } from 'node:stream';
import type { AxiosInstance } from 'axios';
import type { StorageReadOptions, StorageByteRange } from './types';
import { getSafeErrorMetadata } from '../utils/errors';

type OpenStorageStream = (
  request: unknown,
  filepath: string,
  options?: StorageReadOptions,
) => Promise<Readable>;

/** Storage reads are the only place a provider download failure can be diagnosed. */
function logStreamFailure(label: string, open: OpenStorageStream): OpenStorageStream {
  return async (...args) => {
    try {
      return await open(...args);
    } catch (error) {
      logger.error(label, getSafeErrorMetadata(error));
      throw error;
    }
  };
}

/** Parses a single HTTP byte range, including open-ended and suffix requests. */
export function parseStorageRange(value: string, bytes: number): StorageByteRange | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(bytes) || bytes <= 0) return;
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return;
  const start = match[1] ? first : Math.max(0, bytes - last);
  const end = match[1] && match[2] ? Math.min(bytes - 1, last) : bytes - 1;
  if (start < 0 || start >= bytes || end < start) return;
  return { start, end };
}

/** HTTP framing for any authorized file stream; callers retain content/auth policy. */
export function storageRangeResponse(
  value: string | undefined,
  bytes: number,
): {
  status: 200 | 206 | 416;
  headers: Record<string, string>;
  range?: StorageByteRange;
} {
  const range = value ? parseStorageRange(value, bytes) : undefined;
  if (value && !range)
    return {
      status: 416,
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${bytes}` },
    };
  return {
    status: range ? 206 : 200,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Length': String(range ? range.end - range.start + 1 : bytes),
      ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${bytes}` } : {}),
    },
    range,
  };
}

export function storageRangeHeader(range?: StorageByteRange): string | undefined {
  if (!range) return undefined;
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start
  ) {
    throw new Error('Invalid storage byte range');
  }
  return `bytes=${range.start}-${range.end}`;
}

/** A backend ignoring Range must never be presented as the requested tail of an object. */
export function assertStorageRange(
  stream: Readable,
  range?: StorageByteRange,
  contentRange?: string,
): void {
  if (!range) return;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? '');
  if (
    !match ||
    Number(match[1]) !== range.start ||
    Number(match[2]) !== range.end ||
    Number(match[3]) <= range.end
  ) {
    stream.destroy();
    throw new Error('Storage did not return the requested byte range');
  }
}

/** Reuses the host's configured container, including Azurite's account/container path. */
export function createAzureFileStream({
  getContainerClient,
}: {
  getContainerClient(name?: string): Promise<ContainerClient>;
}): OpenStorageStream {
  return logStreamFailure(
    '[getAzureFileStream] Error getting blob stream:',
    async (_request, filepath, options = {}) => {
      storageRangeHeader(options.range);
      const url = new URL(filepath);
      const configuredClient = await getContainerClient();
      const configuredURL = configuredClient.url ? new URL(configuredClient.url) : undefined;
      const configuredPrefix = configuredURL?.pathname.replace(/\/$/, '');
      let containerClient = configuredClient;
      let blobPath: string;
      if (
        configuredURL &&
        configuredPrefix &&
        url.origin === configuredURL.origin &&
        url.pathname.startsWith(`${configuredPrefix}/`)
      ) {
        blobPath = url.pathname.slice(configuredPrefix.length + 1);
      } else {
        const pathSegments = url.pathname.split('/').filter(Boolean);
        const containerName = pathSegments.shift();
        blobPath = pathSegments.join('/');
        if (containerName)
          containerClient = await getContainerClient(decodeURIComponent(containerName));
      }
      blobPath = blobPath.split('/').map(decodeURIComponent).join('/');
      if (!blobPath) throw new Error('Invalid Azure Blob URL');
      const range = options.range;
      const response = await containerClient
        .getBlockBlobClient(blobPath)
        .download(range?.start ?? 0, range ? range.end - range.start + 1 : undefined, {
          abortSignal: options.signal,
        });
      const stream = response.readableStreamBody as Readable | undefined;
      if (!stream) throw new Error('Azure Blob download returned no readable stream');
      assertStorageRange(stream, range, response.contentRange);
      return stream;
    },
  );
}

/** Firebase's signed object URL remains the existing credential boundary. */
export function createFirebaseFileStream({
  getStorage,
  http,
}: {
  getStorage(): object | null | undefined;
  http: AxiosInstance;
}): OpenStorageStream {
  return logStreamFailure(
    'Error getting Firebase file stream:',
    async (_request, filepath, options = {}) => {
      if (!getStorage()) throw new Error('Firebase is not initialized');
      const range = storageRangeHeader(options.range);
      const response = await http.request<Readable>({
        method: 'get',
        url: filepath,
        responseType: 'stream',
        signal: options.signal,
        ...(range ? { headers: { Range: range }, decompress: false } : {}),
      });
      assertStorageRange(response.data, options.range, response.headers['content-range']);
      return response.data;
    },
  );
}
