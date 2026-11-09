import getStream from 'get-stream';
import { addAbortSignal } from 'node:stream';
import { Providers } from '@librechat/agents';
import { logger } from '@librechat/data-schemas';
import {
  FileSources,
  mergeFileConfig,
  isExplicitMimeConfig,
  getEndpointFileConfig,
} from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest, StrategyFunctions, ProcessedFile } from '~/types';
import type { outboundRequestBudget } from '~/utils/timeouts';
import type { StoredFileRef } from '~/storage/path';
import { getOutboundTimeout } from '~/utils/timeouts';
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

export type MissingAttachment = Pick<IMongoFile, 'file_id' | 'filename'>;

/**
 * Receives a file whose stored object is gone. Encoders given one leave that file out of the
 * request instead of failing the turn; without one, a miss still throws, because a file the
 * user attached this turn can be removed and uploaded again.
 */
export type MissingAttachmentHandler = (file: MissingAttachment) => void;

/** Reports a storage miss to a tolerant caller; rethrows every other failure and strict misses. */
export function skipMissingAttachment(
  error: unknown,
  file: MissingAttachment,
  onMissingFile?: MissingAttachmentHandler,
): boolean {
  if (!isAttachmentObjectNotFoundError(error)) {
    return false;
  }
  if (!onMissingFile) {
    throw error;
  }
  onMissingFile(file);
  return true;
}

/** Collects the files an encoder skipped as missing for one message. */
export function createMissingAttachmentCollector(): {
  files: MissingAttachment[];
  onMissingFile: MissingAttachmentHandler;
  has: (fileId: string | undefined) => boolean;
} {
  const files: MissingAttachment[] = [];
  const fileIds = new Set<string>();
  return {
    files,
    onMissingFile: (file) => {
      files.push(file);
      fileIds.add(file.file_id);
    },
    has: (fileId) => fileId != null && fileIds.has(fileId),
  };
}

/**
 * Replays one earlier message's attachments with missing files tolerated: the encoders skip
 * whatever storage deleted, the message's file context names those files, and the returned
 * ids are the files that were actually processed.
 */
export async function replayMessageAttachments(params: {
  message: { fileContext?: string };
  addFileContext: () => Promise<void>;
  processAttachments: (
    onMissingFile: MissingAttachmentHandler,
  ) => Promise<Array<{ file_id?: string } | null | undefined> | null | undefined>;
}): Promise<Set<string>> {
  const { message, addFileContext, processAttachments } = params;
  const missing = createMissingAttachmentCollector();
  const [, processedFiles] = await Promise.all([
    addFileContext(),
    processAttachments(missing.onMissingFile),
  ]);
  if (missing.files.length > 0) {
    message.fileContext = appendMissingAttachmentsNote(message.fileContext, missing.files);
  }
  const processedFileIds = new Set<string>();
  for (const file of processedFiles ?? []) {
    if (file?.file_id && !missing.has(file.file_id)) {
      processedFileIds.add(file.file_id);
    }
  }
  return processedFileIds;
}

/**
 * Tells the model which earlier attachments were deleted from storage, so it neither claims
 * to have read them nor stays silent about why they are absent.
 */
export function appendMissingAttachmentsNote(
  fileContext: string | undefined,
  files: MissingAttachment[],
): string | undefined {
  if (!files.length) {
    return fileContext;
  }
  logger.warn('[appendMissingAttachmentsNote] Attachments missing from storage were skipped', {
    fileIds: files.map((file) => file.file_id),
  });
  const names = files.map((file) => `"${file.filename || file.file_id}"`).join(', ');
  const note =
    `The following attached files were deleted from storage and were not read this turn: ${names}. ` +
    'If their contents are needed, ask the user to upload them again.';
  return fileContext ? `${fileContext}\n\n${note}` : note;
}

/** Whether a storage backend reported that the requested object does not exist. */
export function isStorageNotFoundError(error: unknown): boolean {
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

/** The `outboundRequestBudget` fields a stream read needs: the deadline and its overrun message. */
type ReadBudget = Pick<ReturnType<typeof outboundRequestBudget>, 'signal' | 'timeoutErrorMessage'>;

/**
 * Processes a file by downloading and encoding it to base64
 * @param req - Express request object
 * @param file - File object to process
 * @param encodingMethods - Cache of encoding methods by source
 * @param getStrategyFunctions - Function to get strategy functions for a source
 * @param budget - Wall-clock budget for the whole read. The strategy receives its signal, and a
 * stream still open when the signal aborts is destroyed, so a stalled read ends with an
 * `OutboundTimeoutError` instead of holding the caller. Without one the read is unbounded.
 * @returns Processed file with content and metadata, or null if no download reference exists
 */
export async function getFileStream<T extends ProcessedFile['metadata'] & StoredFileRef>(
  req: ServerRequest,
  file: T,
  encodingMethods: Record<string, StrategyFunctions>,
  getStrategyFunctions: (source: string) => StrategyFunctions,
  budget?: ReadBudget,
): Promise<ProcessedFile<T> | null> {
  if (!file?.filepath && !file?.storageKey) {
    return null;
  }

  const source = file.source ?? FileSources.local;
  if (!encodingMethods[source]) {
    encodingMethods[source] = getStrategyFunctions(source);
  }

  const { getDownloadStream } = encodingMethods[source];
  const downloadPath = resolveDownloadPath(file);
  try {
    const stream = budget
      ? await getDownloadStream(req, downloadPath, { signal: budget.signal })
      : await getDownloadStream(req, downloadPath);
    let buffer: Buffer | null = await getStream.buffer(
      budget ? addAbortSignal(budget.signal, stream) : stream,
    );
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
    /** A budget has the shape of the request config `getOutboundTimeout` reads its deadline from. */
    const overrun = budget && getOutboundTimeout({ config: budget });
    if (overrun) {
      logger.warn(`[getFileStream] ${overrun.message} (file ${file.file_id}, source ${source})`);
      throw overrun;
    }
    if (isStorageNotFoundError(error)) {
      throw new AttachmentObjectNotFoundError(file.file_id);
    }
    throw error;
  }
}
