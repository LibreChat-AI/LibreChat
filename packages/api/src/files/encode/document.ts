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
import type { ReachableAgent } from '~/agents/traversal';
import type { MissingAttachmentHandler } from './utils';
import {
  CONTENT_TRAVERSAL_MAX_DEPTH,
  CONTENT_TRAVERSAL_MAX_NODES,
  ContentTraversalLimitError,
} from '~/protection/adapters/nested';
import {
  validatePdf,
  validateBedrockDocument,
  getNativeDocumentSizeLimit,
} from '~/files/validation';
import { getFileStream, getConfiguredFileSizeLimit, skipMissingAttachment } from './utils';
import { someReachableAgent } from '~/agents/traversal';
import { runGuardedEncode } from './memoryGuard';

/** The longest document name LibreChat sends to Bedrock. */
const BEDROCK_DOCUMENT_NAME_LIMIT = 200;

/** A content part of a formatted message, as far as document naming needs to read it. */
export interface PayloadContentPart {
  type?: string;
  document?: { name?: string };
  /** A replayed steer's own content, stamped for the formatter (`stampSteerPartMedia`). */
  media?: PayloadContentPart[];
}

/** Hands out each name once, sharing suffix progress between colliding truncated prefixes. */
function createDocumentNamer(): (name: string) => string {
  const used = new Set<string>();
  const nextIndex = new Map<string, number>();
  return (input) => {
    const original = input.slice(0, BEDROCK_DOCUMENT_NAME_LIMIT);
    let name = original;
    let index = 2;
    while (used.has(name.toLowerCase())) {
      const suffix = ` (${index})`;
      const prefix = original.slice(0, BEDROCK_DOCUMENT_NAME_LIMIT - suffix.length).trimEnd();
      const key = `${suffix.length}:${prefix.toLowerCase()}`;
      const next = nextIndex.get(key);
      if (next != null && next > index) {
        index = next;
        continue;
      }
      name = `${prefix}${suffix}`;
      nextIndex.set(key, ++index);
    }
    used.add(name.toLowerCase());
    return name;
  };
}

/** The parts with every Bedrock document renamed by `nameOf`; the same array when none changed. */
function renameDocumentParts(
  parts: PayloadContentPart[],
  nameOf: (name: string) => string,
  budget: { remaining: number },
  depth = 0,
): PayloadContentPart[] {
  if (depth > CONTENT_TRAVERSAL_MAX_DEPTH || parts.length > budget.remaining) {
    throw new ContentTraversalLimitError();
  }
  budget.remaining -= parts.length;
  let renamed: PayloadContentPart[] | undefined;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    let next = part;
    const original = part?.type === 'document' ? part.document?.name : undefined;
    if (typeof original === 'string') {
      const name = nameOf(original);
      next = name === original ? part : { ...part, document: { ...part.document, name } };
    } else if (Array.isArray(part?.media)) {
      const media = renameDocumentParts(part.media, nameOf, budget, depth + 1);
      next = media === part.media ? part : { ...part, media };
    }
    if (next !== part) {
      renamed ??= [...parts];
      renamed[i] = next;
    }
  }
  return renamed ?? parts;
}

interface DocumentRecipient extends ReachableAgent<DocumentRecipient> {
  readonly provider?: string;
}

function isBedrockRecipient({ provider }: DocumentRecipient): boolean {
  return provider === Providers.BEDROCK;
}

function hasBedrockRecipient(recipients: Iterable<DocumentRecipient>): boolean {
  return someReachableAgent(recipients, isBedrockRecipient);
}

/**
 * Bedrock rejects a request in which two documents share a name, and every turn resends the
 * documents of earlier turns (and of steers replayed with their attachments), so two uploads with
 * the same filename would fail every later turn of the conversation. Renames each repeat across the
 * formatted payload in conversation order (`report`, `report (2)`), leaving the first occurrence,
 * every other kind of part, and the parts themselves untouched: a message whose documents change
 * gets a new content array. Names compare case-insensitively, as the restriction is not
 * documented to be case-sensitive. Recipient metadata includes lazy children and graph
 * members without resolving them. Only runs with a Bedrock recipient need naming;
 * Structural limits apply per message, not to the lifetime of the conversation.
 */
export function dedupeDocumentNames(
  messages: Array<{ content?: string | PayloadContentPart[] | null }>,
  recipients?: Iterable<DocumentRecipient>,
): void {
  if (recipients != null && !hasBedrockRecipient(recipients)) {
    return;
  }
  const nameOf = createDocumentNamer();
  for (const message of messages) {
    if (message == null) {
      throw new ContentTraversalLimitError();
    }
    if (!Array.isArray(message.content)) {
      continue;
    }
    const budget = { remaining: CONTENT_TRAVERSAL_MAX_NODES - 1 };
    const content = renameDocumentParts(message.content, nameOf, budget);
    if (content !== message.content) {
      message.content = content;
    }
  }
}

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
 * storage object still throws unless `onMissingFile` takes it.
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
    onMissingFile?: MissingAttachmentHandler;
  },
  getStrategyFunctions: (source: string) => StrategyFunctions,
): Promise<DocumentResult> {
  const {
    provider,
    endpoint,
    useResponsesApi,
    model,
    onMissingFile,
    onValidationFailure = 'throw',
  } = params;
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

  for (const [index, settledResult] of results.entries()) {
    const sourceFile = processableFiles[index];
    if (settledResult.status === 'rejected') {
      if (skipMissingAttachment(settledResult.reason, sourceFile, onMissingFile)) {
        continue;
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
        .slice(0, BEDROCK_DOCUMENT_NAME_LIMIT);
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
