import { Readable } from 'node:stream';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mergeFileConfig, mediaURLUploadRequestSchema } from 'librechat-data-provider';
import type { MediaURLUploadRequest, MediaURLUploadResponse } from 'librechat-data-provider';
import type { MediaTransport } from './transport';
import type { MediaContext } from './context';
import type { MediaStorage } from './storage';
import { detectMediaReferenceType, mediaContentExtension, mediaInputByteLimit } from './content';
import { isContentFilterError } from '~/middleware/contentFilter';
import { assertUploadContentAllowed } from '~/files/preflight';
import { UninspectableFileError } from '~/protection/files';
import { isMediaTransferLimitError } from './transport';
import { assertMediaStorage } from './storage';
import { MediaServiceError } from './errors';

export interface MediaHostedDependencies {
  transport: MediaTransport;
  storage: MediaStorage;
  now: () => number;
  id: () => string;
}

export function parseHostedMediaReference(input: MediaURLUploadRequest): MediaURLUploadRequest {
  const parsed = mediaURLUploadRequestSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  if (parsed.error.issues.every((issue) => issue.path[0] === 'url')) {
    throw new MediaServiceError(
      'reference_unavailable',
      422,
      'A public HTTPS media URL is required.',
    );
  }
  throw parsed.error;
}

/** Fetch only public HTTPS content, without user, provider, or application credentials. */
async function readHostedMediaReference(
  input: MediaURLUploadRequest,
  context: MediaContext,
  transport: MediaTransport,
  signal: AbortSignal | undefined,
  consume: (chunk: Buffer) => void,
): Promise<{ sourceURL: string; bytes: number; role: MediaURLUploadRequest['role'] }> {
  const request = parseHostedMediaReference(input);
  const fileConfig = mergeFileConfig(context.appConfig.fileConfig);
  const maxBytes = Math.min(
    mediaInputByteLimit(request.role, context.config),
    fileConfig.serverFileSizeLimit ?? Number.MAX_SAFE_INTEGER,
  );
  const sourceURL = new URL(request.url).href;
  /** The transport timeout only bounds socket idleness; a public URL must not drip indefinitely. */
  const deadline = AbortSignal.timeout(context.config.timeouts.downloadMs);
  let bytes = 0;
  try {
    const stream = await transport.stream({
      url: sourceURL,
      headers: {},
      publicOnly: true,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      timeoutMs: context.config.timeouts.downloadMs,
      maxBytes,
      maxRedirects: context.config.transfers.maxRedirects,
    });
    try {
      for await (const chunk of stream) {
        if (!Buffer.isBuffer(chunk)) {
          throw new MediaServiceError('invalid_request', 422, 'Invalid remote media content.');
        }
        bytes += chunk.length;
        if (bytes > maxBytes) {
          throw new MediaServiceError(
            'invalid_request',
            413,
            'Media exceeds the configured file limit.',
          );
        }
        consume(chunk);
      }
    } finally {
      stream.destroy();
    }
  } catch (error) {
    if (error instanceof MediaServiceError) throw error;
    if (error instanceof Error && isMediaTransferLimitError(error, maxBytes)) {
      throw new MediaServiceError(
        'invalid_request',
        413,
        'Media exceeds the configured file limit.',
      );
    }
    throw new MediaServiceError(
      'reference_unavailable',
      422,
      'The media URL could not be downloaded safely.',
    );
  }
  return { sourceURL, bytes, role: request.role };
}

export async function fetchHostedMediaReference(
  input: MediaURLUploadRequest,
  context: MediaContext,
  transport: MediaTransport,
  signal?: AbortSignal,
): Promise<{ sourceURL: string; data: Buffer; type: string }> {
  const chunks: Buffer[] = [];
  const { sourceURL, bytes, role } = await readHostedMediaReference(
    input,
    context,
    transport,
    signal,
    (chunk) => chunks.push(chunk),
  );
  const data = Buffer.concat(chunks, bytes);
  return { sourceURL, data, type: detectMediaReferenceType(data, role) };
}

/** Re-reads the public URL through a digest only; neither copy is held in memory. */
export async function verifyHostedMediaReference(
  input: MediaURLUploadRequest,
  archivedDigest: string,
  context: MediaContext,
  transport: MediaTransport,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash('sha256');
  const { sourceURL } = await readHostedMediaReference(input, context, transport, signal, (chunk) =>
    hash.update(chunk),
  );
  const expected = Buffer.from(archivedDigest, 'hex');
  const actual = hash.digest();
  if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
    throw new MediaServiceError(
      'reference_changed',
      422,
      'The media URL no longer matches the archived reference.',
    );
  }
  return sourceURL;
}

export async function importHostedMediaReference(
  input: MediaURLUploadRequest,
  context: MediaContext,
  deps: MediaHostedDependencies,
  signal?: AbortSignal,
): Promise<MediaURLUploadResponse> {
  assertMediaStorage(context);
  const { sourceURL, data, type } = await fetchHostedMediaReference(
    input,
    context,
    deps.transport,
    signal,
  );
  const filename = `${input.role}-reference.${mediaContentExtension(type)}`;
  try {
    await assertUploadContentAllowed({
      filters: context.appConfig.filters,
      file: { originalname: filename, mimetype: type, size: data.length, path: sourceURL },
      fileConfig: mergeFileConfig(context.appConfig.fileConfig),
      ocrConfigured: false,
      ragConfigured: false,
      readFile: async () => data,
    });
  } catch (error) {
    if (isContentFilterError(error) || error instanceof UninspectableFileError) {
      throw new MediaServiceError('forbidden', 403, 'Media input was blocked by content policy.');
    }
    throw error;
  }
  const file = await deps.storage.publish({
    scope: context.scope,
    outputKey: `upload:${deps.id()}`,
    stream: Readable.from([data]),
    type,
    filename,
    config: context.config,
    expiredAt: new Date(deps.now() + context.config.assets.orphanRetentionMs).toISOString(),
  });
  return { file, sourceURL };
}
