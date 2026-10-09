import getStream from 'get-stream';
import { Providers } from '@librechat/agents';
import {
  FileSources,
  mergeFileConfig,
  isExplicitMimeConfig,
  getEndpointFileConfig,
} from 'librechat-data-provider';
import type { ServerRequest, StrategyFunctions, ProcessedFile } from '~/types';
import type { StoredFileRef } from '~/storage/path';
import { resolveDownloadPath } from '~/storage/path';

export class AttachmentObjectNotFoundError extends Error {
  readonly code = 'ATTACHMENT_OBJECT_NOT_FOUND';

  constructor(readonly fileId: string | undefined) {
    super('An attached file is no longer available. Remove it, upload it again, and retry.');
    this.name = 'AttachmentObjectNotFoundError';
  }
}

export function isAttachmentObjectNotFoundError(
  error: unknown,
): error is AttachmentObjectNotFoundError {
  return error instanceof AttachmentObjectNotFoundError;
}

function isStorageNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error == null) {
    return false;
  }
  const storageError = error as {
    name?: string;
    code?: string;
    status?: number;
    statusCode?: number;
    response?: { status?: number };
    $metadata?: { httpStatusCode?: number };
  };
  return (
    storageError.name === 'NoSuchKey' ||
    storageError.code === 'NoSuchKey' ||
    storageError.code === 'ENOENT' ||
    storageError.status === 404 ||
    storageError.statusCode === 404 ||
    storageError.response?.status === 404 ||
    storageError.$metadata?.httpStatusCode === 404
  );
}

/**
 * Extracts the configured file size limit for a specific provider from fileConfig
 * @param req - The server request object containing config
 * @param params - Object containing provider and optional endpoint
 * @param params.provider - The provider to get the limit for
 * @param params.endpoint - Optional endpoint name for lookup
 * @returns The configured file size limit in bytes, or undefined if not configured
 */
export const getConfiguredFileSizeLimit = (
  req: ServerRequest,
  params: {
    provider: Providers;
    endpoint?: string;
  },
): number | undefined => {
  if (!req.config?.fileConfig) {
    return undefined;
  }
  const { provider, endpoint } = params;
  const fileConfig = mergeFileConfig(req.config.fileConfig);
  const endpointConfig = getEndpointFileConfig({
    fileConfig,
    endpoint: endpoint ?? provider,
  });
  return endpointConfig?.fileSizeLimit;
};

/**
 * Whether the admin explicitly allowed `mimeType` for this endpoint via
 * `fileConfig.endpoints.<name>.supportedMimeTypes`. The inherited default list does
 * not count as opting in, mirroring the client's picker and drag-drop logic, so an
 * OpenAI-compatible endpoint only receives video/audio parts when configured for them.
 * @param req - The server request object containing config
 * @param params - Object containing provider and optional endpoint
 * @param params.provider - The provider to look up
 * @param params.endpoint - Optional endpoint name for lookup
 * @param mimeType - The MIME type of the file being attached
 * @returns True when the endpoint config explicitly matches the MIME type
 */
export const isConfiguredProviderMediaType = (
  req: ServerRequest,
  params: {
    provider: Providers;
    endpoint?: string;
  },
  mimeType: string,
): boolean => {
  if (!req.config?.fileConfig) {
    return false;
  }
  const { provider, endpoint } = params;
  const fileConfig = mergeFileConfig(req.config.fileConfig);
  const endpointConfig = getEndpointFileConfig({
    fileConfig,
    endpoint: endpoint ?? provider,
  });
  const types = endpointConfig?.supportedMimeTypes;
  if (!isExplicitMimeConfig(types)) {
    return false;
  }
  return fileConfig.checkType?.(mimeType, types) ?? false;
};

/**
 * Maps accepted audio MIME types to the format token OpenAI-compatible providers expect.
 * Mirrors the canonicalization in `api/server/services/Files/Audio/STTService.js`: the
 * accepted MIME list carries aliases (`audio/wave`, `audio/x-wav`, `audio/mpeg`) whose
 * names are not themselves valid format values.
 */
const audioMimeToFormat: Record<string, string> = {
  'audio/mp3': 'mp3',
  'audio/mpeg': 'mp3',
  'audio/mpeg3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/vorbis': 'ogg',
  'audio/opus': 'ogg',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/webm': 'webm',
  'audio/aac': 'aac',
};

/**
 * Format values OpenAI-compatible providers accept for an `input_audio` part.
 * Used to validate an extension-derived fallback so an arbitrary filename suffix
 * never reaches the provider as a format.
 */
const supportedAudioFormats = new Set([
  'wav',
  'mp3',
  'aiff',
  'aac',
  'ogg',
  'flac',
  'm4a',
  'webm',
  'pcm16',
  'pcm24',
]);

/**
 * Resolves the `input_audio.format` value for a file.
 *
 * Prefers the MIME type, which is validated upstream against `audioMimeTypes`, because
 * the filename extension is user-controlled: it may be absent (`recording`), an alias
 * that is not a valid format (`clip.wave`), or disagree with the actual content. Falls
 * back to the extension only when it is itself a supported format.
 * @param mimeType - The file's MIME type
 * @param filename - The original filename
 * @returns The canonical format, or undefined when neither source yields a supported one
 */
export const getAudioFormat = (mimeType: string, filename: string): string | undefined => {
  const fromMime = audioMimeToFormat[mimeType?.toLowerCase()];
  if (fromMime) {
    return fromMime;
  }
  const parts = filename?.toLowerCase().split('.') ?? [];
  /** `parts[0]` must be non-empty so a dotfile (`.mp3`) is not read as an extension. */
  const extension = parts.length > 1 && parts[0] ? parts[parts.length - 1] : undefined;
  return extension && supportedAudioFormats.has(extension) ? extension : undefined;
};

/**
 * Processes a file by downloading and encoding it to base64
 * @param req - Express request object
 * @param file - File object to process
 * @param encodingMethods - Cache of encoding methods by source
 * @param getStrategyFunctions - Function to get strategy functions for a source
 * @returns Processed file with content and metadata, or null if no download reference exists
 */
export async function getFileStream<T extends ProcessedFile['metadata'] & StoredFileRef>(
  req: ServerRequest,
  file: T,
  encodingMethods: Record<string, StrategyFunctions>,
  getStrategyFunctions: (source: string) => StrategyFunctions,
): Promise<ProcessedFile<T> | null> {
  if (!file?.filepath && !file?.storageKey) {
    return null;
  }

  const source = file.source ?? FileSources.local;
  if (!encodingMethods[source]) {
    encodingMethods[source] = getStrategyFunctions(source);
  }

  const { getDownloadStream } = encodingMethods[source];
  try {
    const stream = await getDownloadStream(req, resolveDownloadPath(file));
    let buffer: Buffer | null = await getStream.buffer(stream);
    const content = buffer.toString('base64');
    buffer = null;

    return {
      file,
      content,
      metadata: {
        file_id: file.file_id,
        temp_file_id: file.temp_file_id,
        filepath: file.filepath,
        source: file.source,
        filename: file.filename,
        type: file.type,
      },
    };
  } catch (error) {
    if (isStorageNotFoundError(error)) {
      throw new AttachmentObjectNotFoundError(file.file_id);
    }
    throw error;
  }
}
