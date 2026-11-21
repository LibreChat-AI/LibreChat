import path from 'path';
import { CODE_OUTPUT_PREFLIGHT_MAX_BYTES, CODE_OUTPUT_PREFLIGHT_MAX_COUNT } from './limits';

/** The Code API route a buffer was fetched through; one of these identifies it. */
export interface CodeOutputRoute {
  readonly codeApiBaseUrl?: string;
  readonly executionProfile?: string;
  readonly executionRouteKey?: string;
}

export interface CodeOutputBufferRef extends CodeOutputRoute {
  readonly req: unknown;
  readonly id: unknown;
  readonly session_id: unknown;
}

export interface CachedCodeOutputBufferInput extends CodeOutputBufferRef {
  readonly name: string;
  readonly buffer: unknown;
}

export interface SandboxArtifactRef {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly storage_session_id?: unknown;
  readonly session_id?: unknown;
}

export interface PreparedCodeOutputLookup extends CodeOutputRoute {
  readonly req: unknown;
  readonly file_path: unknown;
  readonly session_id?: unknown;
  readonly files: unknown;
}

interface CachedBuffer {
  readonly name: string;
  readonly buffer: Buffer;
}

interface RequestCache {
  readonly buffers: Map<string, CachedBuffer>;
  totalBytes: number;
}

/** Request-scoped references to buffers already fetched by artifact preflight.
 * The request object is the ownership boundary, and WeakMap keeps completed
 * requests from retaining generated-file bytes. */
const preparedCodeOutputBuffers = new WeakMap<object, RequestCache>();

const codeOutputBufferKey = (routeKey: string, sessionId: string, fileId: string): string =>
  `${routeKey}\0${sessionId}\0${fileId}`;

const getCodeOutputRouteKey = ({
  executionRouteKey,
  codeApiBaseUrl,
  executionProfile,
}: CodeOutputRoute): string => executionRouteKey ?? codeApiBaseUrl ?? executionProfile ?? 'default';

const isRequest = (req: unknown): req is object =>
  req != null && (typeof req === 'object' || typeof req === 'function');

function normalizeSandboxArtifactName(filePath: unknown): string | null {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return null;
  }
  if (filePath.includes('\\')) {
    return null;
  }
  let relativePath = filePath;
  if (filePath.startsWith('/mnt/data/')) {
    relativePath = filePath.slice('/mnt/data/'.length);
  } else if (filePath.startsWith('/')) {
    return null;
  }
  if (relativePath.split('/').some((segment) => segment === '.' || segment === '..')) {
    return null;
  }
  const normalized = path.posix.normalize(relativePath).replace(/^\.\//, '');
  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    return null;
  }
  return normalized;
}

function deleteEntry(cache: RequestCache, key: string): CachedBuffer | undefined {
  const cached = cache.buffers.get(key);
  if (cached) {
    cache.buffers.delete(key);
    cache.totalBytes -= cached.buffer.length;
  }
  return cached;
}

/** Keeps a preflight buffer for the request, within the preflight count and byte ceilings. */
export function cachePreparedCodeOutputBuffer(input: CachedCodeOutputBufferInput): void {
  const { req, id, name, session_id, buffer } = input;
  if (
    !isRequest(req) ||
    typeof id !== 'string' ||
    typeof session_id !== 'string' ||
    !Buffer.isBuffer(buffer)
  ) {
    return;
  }
  let cache = preparedCodeOutputBuffers.get(req);
  if (!cache) {
    cache = { buffers: new Map(), totalBytes: 0 };
    preparedCodeOutputBuffers.set(req, cache);
  }
  const key = codeOutputBufferKey(getCodeOutputRouteKey(input), session_id, id);
  deleteEntry(cache, key);
  if (buffer.length > CODE_OUTPUT_PREFLIGHT_MAX_BYTES) {
    return;
  }
  while (
    cache.buffers.size >= CODE_OUTPUT_PREFLIGHT_MAX_COUNT ||
    cache.totalBytes + buffer.length > CODE_OUTPUT_PREFLIGHT_MAX_BYTES
  ) {
    const oldestKey = cache.buffers.keys().next().value;
    if (oldestKey == null) {
      break;
    }
    deleteEntry(cache, oldestKey);
  }
  cache.buffers.set(key, { name, buffer });
  cache.totalBytes += buffer.length;
}

/** Evicts one preflight buffer, for a prefetched file its batch discarded. */
export function releasePreparedCodeOutputBuffer(input: CodeOutputBufferRef): void {
  const { req, id, session_id } = input;
  const cache = isRequest(req) ? preparedCodeOutputBuffers.get(req) : undefined;
  if (!cache || typeof id !== 'string' || typeof session_id !== 'string') {
    return;
  }
  deleteEntry(cache, codeOutputBufferKey(getCodeOutputRouteKey(input), session_id, id));
}

/** Takes the preflight buffer for a sandbox path, removing it from the request cache. */
export function getPreparedCodeOutputBuffer(input: PreparedCodeOutputLookup): Buffer | null {
  const { req, file_path, session_id, files } = input;
  if (!isRequest(req) || !Array.isArray(files)) {
    return null;
  }
  const cache = preparedCodeOutputBuffers.get(req);
  const requestedName = normalizeSandboxArtifactName(file_path);
  if (!cache || !requestedName) {
    return null;
  }

  const routeKey = getCodeOutputRouteKey(input);
  for (const file of files as SandboxArtifactRef[]) {
    if (!file || typeof file.id !== 'string' || typeof file.name !== 'string') {
      continue;
    }
    if (normalizeSandboxArtifactName(file.name) !== requestedName) {
      continue;
    }
    const storageSessionId = file.storage_session_id ?? file.session_id ?? session_id;
    if (typeof storageSessionId !== 'string') {
      continue;
    }
    const key = codeOutputBufferKey(routeKey, storageSessionId, file.id);
    const cached = cache.buffers.get(key);
    if (cached && normalizeSandboxArtifactName(cached.name) === requestedName) {
      deleteEntry(cache, key);
      return cached.buffer;
    }
  }
  return null;
}
