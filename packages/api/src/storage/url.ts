import { Transform } from 'stream';
import type { TransformCallback } from 'stream';

export const DEFAULT_REMOTE_FILE_FETCH_TIMEOUT_MS: number = 15000;
export const DEFAULT_REMOTE_FILE_FETCH_MAX_BYTES: number = 512 * 1024 * 1024;

const REMOTE_FILE_PROTOCOLS = new Set(['http:', 'https:']);

type HeaderGetter = {
  get: (name: string) => string | null;
};

type HeaderRecord = Record<string, string | string[] | number | undefined>;

export type RemoteFileHeaders = HeaderGetter | HeaderRecord;

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isHeaderGetter(headers: RemoteFileHeaders): headers is HeaderGetter {
  return typeof (headers as HeaderGetter).get === 'function';
}

function getHeader(headers: RemoteFileHeaders, name: string): string | null {
  if (isHeaderGetter(headers)) {
    return headers.get(name);
  }

  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value == null ? null : String(value);
}

export function getRemoteFileFetchTimeoutMs(): number {
  return readPositiveIntEnv('REMOTE_FILE_FETCH_TIMEOUT_MS', DEFAULT_REMOTE_FILE_FETCH_TIMEOUT_MS);
}

export function getRemoteFileFetchMaxBytes(): number {
  return readPositiveIntEnv('REMOTE_FILE_FETCH_MAX_BYTES', DEFAULT_REMOTE_FILE_FETCH_MAX_BYTES);
}

export function assertRemoteFileURL(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Invalid remote file URL');
  }

  if (!REMOTE_FILE_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Refusing to fetch remote file over ${parsed.protocol}`);
  }

  return parsed.href;
}

export function assertRemoteFileContentLength(
  headers: RemoteFileHeaders,
  maxBytes: number = getRemoteFileFetchMaxBytes(),
): void {
  const contentLength = Number.parseInt(getHeader(headers, 'content-length') ?? '0', 10);
  if (contentLength > maxBytes) {
    throw new Error(`Remote file response too large: ${contentLength} bytes`);
  }
}

class RemoteFileByteLimitTransform extends Transform {
  private bytes = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
    if (this.bytes > this.maxBytes) {
      callback(new Error(`Remote file response too large: ${this.bytes} bytes`));
      return;
    }

    callback(null, chunk);
  }
}

export function createRemoteFileByteLimitTransform(
  maxBytes: number = getRemoteFileFetchMaxBytes(),
): Transform {
  return new RemoteFileByteLimitTransform(maxBytes);
}
