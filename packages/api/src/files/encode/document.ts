import { Providers } from '@librechat/agents';
import {
  isOpenAILikeProvider,
  isBedrockDocumentType,
  bedrockDocumentFormats,
  isAnthropicDocumentType,
  isDocumentSupportedProvider,
  isAnthropicTextDocumentType,
} from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type {
  ValidationFailureReason,
  AnthropicDocumentBlock,
  NativeValidationMode,
  DocumentRejection,
  StrategyFunctions,
  DocumentResult,
  ProcessedFile,
  DocumentBlock,
  ServerRequest,
} from '~/types';
import {
  validatePdf,
  validateBedrockDocument,
  getNativeDocumentSizeLimit,
} from '~/files/validation';
import {
  getFileStream,
  getConfiguredFileSizeLimit,
  isAttachmentObjectNotFoundError,
} from './utils';
import { runGuardedEncode } from './memoryGuard';

/** Anthropic only accepts PDFs as base64 documents; textual types must use a text source */
function getAnthropicDocumentSource(
  mimeType: string,
  content: string,
): AnthropicDocumentBlock['source'] | null {
  if (isAnthropicTextDocumentType(mimeType)) {
    return {
      type: 'text',
      media_type: 'text/plain',
      data: Buffer.from(content, 'base64').toString('utf8'),
    };
  }

  if (mimeType === 'application/pdf') {
    return {
      type: 'base64',
      media_type: mimeType,
      data: content,
    };
  }

  return null;
}

/**
 * Whether the model behind this provider is Claude, which accepts only PDFs as base64
 * documents. OpenAI-compatible gateways report an OpenAI-like provider for Claude models.
 */
export function usesAnthropicDocumentCapabilities(provider: Providers, model?: string): boolean {
  return (
    provider === Providers.ANTHROPIC ||
    (isOpenAILikeProvider(provider) && (model?.toLowerCase().includes('claude') ?? false))
  );
}

/**
 * Formats a base64-encoded document into the appropriate provider-specific block.
 * Returns `null` when the provider has no matching handler.
 */
function formatDocumentBlock(
  provider: Providers,
  mimeType: string,
  content: string,
  filename: string | undefined,
  useResponsesApi: boolean | undefined,
  model?: string,
): DocumentBlock | null {
  if (provider === Providers.ANTHROPIC) {
    const source = getAnthropicDocumentSource(mimeType, content);
    if (!source) {
      return null;
    }

    const document: AnthropicDocumentBlock = {
      type: 'document',
      source,
      citations: { enabled: true },
    };

    if (filename) {
      document.context = `File: "${filename}"`;
    }

    return document;
  }

  if (provider === Providers.GOOGLE || provider === Providers.VERTEXAI) {
    return {
      type: 'media',
      mimeType,
      data: content,
    };
  }

  const resolvedFilename = filename ?? 'document';

  /* A gateway translates an OpenAI `file` part into a base64 document with the file's own
   * media type, which Claude rejects for anything but PDF. Send textual files as text. */
  if (
    !useResponsesApi &&
    isAnthropicTextDocumentType(mimeType) &&
    usesAnthropicDocumentCapabilities(provider, model)
  ) {
    return {
      type: 'text',
      text: `File: "${resolvedFilename}"\n\n${Buffer.from(content, 'base64').toString('utf8')}`,
    };
  }

  if (useResponsesApi) {
    return {
      type: 'input_file',
      filename: resolvedFilename,
      file_data: `data:${mimeType};base64,${content}`,
    };
  }

  if (isOpenAILikeProvider(provider) && provider !== Providers.AZURE) {
    return {
      type: 'file',
      file: {
        filename: resolvedFilename,
        file_data: `data:${mimeType};base64,${content}`,
      },
    };
  }

  return null;
}

interface ProviderDocumentFiles {
  processable: IMongoFile[];
  unsupported: IMongoFile[];
}

function partitionDocumentFiles(
  files: IMongoFile[],
  isSupported: (mimeType?: string) => boolean,
): ProviderDocumentFiles {
  const processable: IMongoFile[] = [];
  const unsupported: IMongoFile[] = [];
  for (const file of files) {
    if (isSupported(file.type)) {
      processable.push(file);
    } else {
      unsupported.push(file);
    }
  }
  return { processable, unsupported };
}

/**
 * Separates out files the provider's document path cannot send to the model.
 * Claude rejects non-PDF binary documents with a 400 that recurs on every retry,
 * including when it is reached through an OpenAI-compatible gateway. Unsupported
 * types are skipped instead of bricking the conversation.
 */
function filterProviderDocumentFiles(
  provider: Providers,
  files: IMongoFile[],
  model?: string,
): ProviderDocumentFiles {
  if (provider === Providers.BEDROCK) {
    return partitionDocumentFiles(files, isBedrockDocumentType);
  }

  if (!usesAnthropicDocumentCapabilities(provider, model)) {
    return { processable: files, unsupported: [] };
  }

  const partition = partitionDocumentFiles(files, isAnthropicDocumentType);
  if (partition.unsupported.length) {
    const skipped = partition.unsupported.map((file) => `"${file.filename}" (${file.type})`);
    console.warn(
      `Skipping attachment(s) unsupported by Claude document input: ${skipped.join(', ')}`,
    );
  }

  return partition;
}

/** Records files left out in skip mode; a no-op in throw mode, where `rejected` is absent. */
function recordRejections(
  result: DocumentResult,
  files: IMongoFile[],
  reason: DocumentRejection['reason'],
): void {
  result.rejected?.push(...files.map((file) => ({ file_id: file.file_id, reason })));
}

function getBase64DecodedByteCount(content: string): number {
  let paddingChars = 0;

  if (content.endsWith('==')) {
    paddingChars = 2;
  } else if (content.endsWith('=')) {
    paddingChars = 1;
  }

  return Math.floor((content.length * 3) / 4) - paddingChars;
}

/**
 * Encodes and formats document files for various providers.
 *
 * Callers are responsible for pre-filtering `files` to types the endpoint accepts
 * (e.g., via `supportedMimeTypes` in `processAttachments`). This function processes
 * every file it receives and dispatches to the appropriate provider format:
 * - **Bedrock**: Only encodes types in `bedrockDocumentFormats`; all others are skipped.
 * - **Anthropic**: Only encodes PDFs (base64 source) and textual types (plain-text source);
 *   all others are skipped.
 * - **PDF**: Validated via `validatePdf` before encoding.
 * - **Generic types**: Encoded with a provider-specific size check.
 *
 * A validation failure throws by default. With `onValidationFailure: 'skip'` every file
 * that yields no block is listed in `rejected` with its reason instead: a failed
 * validation, a type the provider cannot take, or bytes that could not be read. A missing
 * storage object still throws.
 */
export async function encodeAndFormatDocuments(
  req: ServerRequest,
  files: IMongoFile[],
  params: {
    provider: Providers;
    endpoint?: string;
    useResponsesApi?: boolean;
    model?: string;
    onValidationFailure?: NativeValidationMode;
  },
  getStrategyFunctions: (source: string) => StrategyFunctions,
): Promise<DocumentResult> {
  const { provider, endpoint, useResponsesApi, model, onValidationFailure = 'throw' } = params;
  const skipInvalid = onValidationFailure === 'skip';
  const result: DocumentResult = skipInvalid
    ? { documents: [], files: [], rejected: [] }
    : { documents: [], files: [] };
  if (!files?.length) {
    return result;
  }

  const encodingMethods: Record<string, StrategyFunctions> = {};

  const rejectInvalid = (
    file: IMongoFile,
    reason: ValidationFailureReason,
    message: string,
  ): void => {
    if (!skipInvalid) {
      throw new Error(message);
    }
    recordRejections(result, [file], reason);
  };

  const addBlock = (
    file: IMongoFile,
    block: DocumentBlock | null,
    metadata: ProcessedFile['metadata'],
  ): void => {
    if (!block) {
      recordRejections(result, [file], 'unsupported');
      return;
    }
    result.documents.push(block);
    result.files.push(metadata);
  };

  const isBedrock = provider === Providers.BEDROCK;
  const isDocSupported = isDocumentSupportedProvider(provider);

  if (!isDocSupported && !isBedrock) {
    recordRejections(result, files, 'unsupported');
    return result;
  }

  const { processable: processableFiles, unsupported } = filterProviderDocumentFiles(
    provider,
    files,
    model,
  );
  recordRejections(result, unsupported, 'unsupported');

  if (!processableFiles.length) {
    return result;
  }

  const configuredFileSizeLimit = getConfiguredFileSizeLimit(req, { provider, endpoint });

  const results = await Promise.allSettled(
    processableFiles.map((file) =>
      runGuardedEncode(file.bytes ?? 0, () =>
        getFileStream(req, file, encodingMethods, getStrategyFunctions),
      ),
    ),
  );

  for (let i = 0; i < results.length; i++) {
    const settledResult = results[i];
    const sourceFile = processableFiles[i];
    if (settledResult.status === 'rejected') {
      if (isAttachmentObjectNotFoundError(settledResult.reason)) {
        throw settledResult.reason;
      }
      console.error('Document processing failed:', settledResult.reason);
      recordRejections(result, [sourceFile], 'integrity');
      continue;
    }

    const processed = settledResult.value;
    if (!processed) {
      recordRejections(result, [sourceFile], 'integrity');
      continue;
    }

    const { file, content, metadata } = processed;

    if (!content || !file) {
      if (metadata && !skipInvalid) result.files.push(metadata);
      recordRejections(result, [sourceFile], 'integrity');
      continue;
    }

    const mimeType = file.type ?? '';

    if (isBedrock && isBedrockDocumentType(mimeType)) {
      const fileBuffer = Buffer.from(content, 'base64');
      const format = bedrockDocumentFormats[mimeType];

      const validation = await validateBedrockDocument(
        fileBuffer.length,
        mimeType,
        fileBuffer,
        configuredFileSizeLimit,
        model,
      );

      if (!validation.isValid) {
        rejectInvalid(
          file,
          validation.reason ?? 'integrity',
          `Document validation failed: ${validation.error}`,
        );
        continue;
      }

      const sanitizedName = (file.filename || 'document')
        .replace(/[^a-zA-Z0-9\s\-()[\]]/g, '_')
        .slice(0, 200);
      result.documents.push({
        type: 'document',
        document: {
          name: sanitizedName,
          format,
          source: {
            bytes: fileBuffer,
          },
        },
      });
      result.files.push(metadata);
    } else if (file.type === 'application/pdf' && isDocSupported) {
      const pdfBuffer = Buffer.from(content, 'base64');

      const validation = await validatePdf(
        pdfBuffer,
        pdfBuffer.length,
        provider,
        configuredFileSizeLimit,
        model,
      );

      if (!validation.isValid) {
        rejectInvalid(
          file,
          validation.reason ?? 'integrity',
          `PDF validation failed: ${validation.error}`,
        );
        continue;
      }

      addBlock(
        file,
        formatDocumentBlock(provider, mimeType, content, file.filename, useResponsesApi, model),
        metadata,
      );
    } else if (isDocSupported && !isBedrock) {
      const decodedByteCount = getBase64DecodedByteCount(content);
      const sizeLimit = getNativeDocumentSizeLimit({
        provider,
        mimeType,
        model,
        configuredFileSizeLimit,
      });
      if (sizeLimit !== undefined && decodedByteCount > sizeLimit) {
        rejectInvalid(
          file,
          'capacity',
          `File size (~${(decodedByteCount / 1024 / 1024).toFixed(1)}MB) exceeds the configured limit for ${provider}`,
        );
        continue;
      }

      addBlock(
        file,
        formatDocumentBlock(provider, mimeType, content, file.filename, useResponsesApi, model),
        metadata,
      );
    }
  }

  return result;
}
