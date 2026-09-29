import { Providers } from '@librechat/agents';
import {
  isOpenAILikeProvider,
  isBedrockDocumentType,
  bedrockDocumentFormats,
  isNativelyReadableText,
  isAnthropicDocumentType,
  isDocumentSupportedProvider,
  isAnthropicTextDocumentType,
} from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type {
  DocumentBlock,
  AnthropicDocumentBlock,
  StrategyFunctions,
  DocumentResult,
  ServerRequest,
} from '~/types';
import {
  getFileStream,
  getConfiguredFileSizeLimit,
  isConfiguredProviderMediaType,
  isAttachmentObjectNotFoundError,
} from './utils';
import { validatePdf, validateBedrockDocument } from '~/files/validation';
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
function usesAnthropicDocumentCapabilities(provider: Providers, model?: string): boolean {
  return (
    provider === Providers.ANTHROPIC ||
    (isOpenAILikeProvider(provider) && (model?.toLowerCase().includes('claude') ?? false))
  );
}

const isGoogleProvider = (provider: Providers): boolean =>
  provider === Providers.GOOGLE || provider === Providers.VERTEXAI;

/**
 * Whether the model behind this provider is Gemini, which rejects inline Office documents
 * and textual `application/*` types (JSON, SQL) with a 400. OpenAI-compatible gateways
 * report an OpenAI-like provider for Gemini models.
 */
function usesGeminiDocumentCapabilities(provider: Providers, model?: string): boolean {
  return (
    isGoogleProvider(provider) ||
    (isOpenAILikeProvider(provider) && (model?.toLowerCase().includes('gemini') ?? false))
  );
}

/**
 * Textual types that OpenAI-compatible gateways can reject as a `file` part (Azure OpenAI
 * answers 400 "Invalid file data" for these), so they go as text unless the endpoint lists
 * them. `text/*`, JSON, YAML and TypeScript stay file parts.
 */
const textPartApplicationTypes = new Set([
  'application/sql',
  'application/x-sh',
  'application/xml',
]);

/**
 * Whether a document goes as a text part because the endpoint's own `supportedMimeTypes`
 * does not list it. Gemini accepts `text/*` inline but rejects every textual
 * `application/*` type (JSON, YAML, XML, SQL, CoffeeScript). "Textual" is the same
 * classification that routes a file to the provider (`isNativelyReadableText`).
 */
function sendsAsTextWithoutOptIn(provider: Providers, mimeType: string, model?: string): boolean {
  if (usesGeminiDocumentCapabilities(provider, model)) {
    return !mimeType.startsWith('text/') && isNativelyReadableText(mimeType);
  }
  return textPartApplicationTypes.has(mimeType);
}

/** A textual file as a plain text part, which every provider and API shape accepts. */
function formatTextDocumentBlock(filename: string, content: string): DocumentBlock {
  return {
    type: 'text',
    text: `File: "${filename}"\n\n${Buffer.from(content, 'base64').toString('utf8')}`,
  };
}

/**
 * Formats a base64-encoded document into the appropriate provider-specific block.
 * Returns `null` when the provider has no matching handler.
 *
 * `optedIn` is true when the endpoint's own `supportedMimeTypes` lists the type, rather
 * than the built-in list it inherits.
 */
function formatDocumentBlock(
  provider: Providers,
  mimeType: string,
  content: string,
  filename: string | undefined,
  useResponsesApi: boolean | undefined,
  model?: string,
  optedIn = false,
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

  const resolvedFilename = filename ?? 'document';

  if (!optedIn && sendsAsTextWithoutOptIn(provider, mimeType, model)) {
    return formatTextDocumentBlock(resolvedFilename, content);
  }

  if (isGoogleProvider(provider)) {
    return {
      type: 'media',
      mimeType,
      data: content,
    };
  }

  /* A gateway translates an OpenAI `file` part into a base64 document with the file's own
   * media type, which Claude rejects for anything but PDF. Send textual files as text. */
  if (
    !useResponsesApi &&
    isAnthropicTextDocumentType(mimeType) &&
    usesAnthropicDocumentCapabilities(provider, model)
  ) {
    return formatTextDocumentBlock(resolvedFilename, content);
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

/**
 * Filters out files the provider's document path cannot send to the model.
 * Claude rejects non-PDF binary documents with a 400 that recurs on every retry,
 * including when it is reached through an OpenAI-compatible gateway. Gemini rejects
 * inline Office documents the same way, so for Gemini a type other than PDF or text
 * goes only when the endpoint lists it. Unsupported types are skipped instead of
 * bricking the conversation.
 */
function filterProviderDocumentFiles(
  provider: Providers,
  files: IMongoFile[],
  model: string | undefined,
  isOptedIn: (mimeType: string) => boolean,
): IMongoFile[] {
  if (provider === Providers.BEDROCK) {
    return files.filter((file) => isBedrockDocumentType(file.type));
  }

  let label: string;
  let isSupported: (file: IMongoFile) => boolean;
  if (usesAnthropicDocumentCapabilities(provider, model)) {
    label = 'Claude';
    isSupported = (file) => isAnthropicDocumentType(file.type);
  } else if (usesGeminiDocumentCapabilities(provider, model)) {
    label = 'Gemini';
    isSupported = (file) =>
      file.type === 'application/pdf' ||
      isNativelyReadableText(file.type ?? '') ||
      isOptedIn(file.type ?? '');
  } else {
    return files;
  }

  const processable: IMongoFile[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    if (isSupported(file)) {
      processable.push(file);
    } else {
      skipped.push(`"${file.filename}" (${file.type})`);
    }
  }

  if (skipped.length) {
    console.warn(
      `Skipping attachment(s) unsupported by ${label} document input: ${skipped.join(', ')}`,
    );
  }

  return processable;
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
 * - **Google/Vertex**: Encodes PDFs and textual types, plus types the endpoint's own
 *   `supportedMimeTypes` lists; all others are skipped.
 * - **PDF**: Validated via `validatePdf` before encoding.
 * - **Generic types**: Encoded with a provider-specific size check. Textual types a
 *   provider can reject as a file part go as a text part unless the endpoint lists them.
 */
export async function encodeAndFormatDocuments(
  req: ServerRequest,
  files: IMongoFile[],
  params: { provider: Providers; endpoint?: string; useResponsesApi?: boolean; model?: string },
  getStrategyFunctions: (source: string) => StrategyFunctions,
): Promise<DocumentResult> {
  const { provider, endpoint, useResponsesApi, model } = params;
  if (!files?.length) {
    return { documents: [], files: [] };
  }

  const encodingMethods: Record<string, StrategyFunctions> = {};
  const result: DocumentResult = { documents: [], files: [] };

  const isBedrock = provider === Providers.BEDROCK;
  const isDocSupported = isDocumentSupportedProvider(provider);

  if (!isDocSupported && !isBedrock) {
    return result;
  }

  const isOptedIn = (mimeType: string) =>
    isConfiguredProviderMediaType(req, { provider, endpoint }, mimeType);
  const processableFiles = filterProviderDocumentFiles(provider, files, model, isOptedIn);

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

  for (const settledResult of results) {
    if (settledResult.status === 'rejected') {
      if (isAttachmentObjectNotFoundError(settledResult.reason)) {
        throw settledResult.reason;
      }
      console.error('Document processing failed:', settledResult.reason);
      continue;
    }

    const processed = settledResult.value;
    if (!processed) continue;

    const { file, content, metadata } = processed;

    if (!content || !file) {
      if (metadata) result.files.push(metadata);
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
        throw new Error(`Document validation failed: ${validation.error}`);
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
        throw new Error(`PDF validation failed: ${validation.error}`);
      }

      const block = formatDocumentBlock(
        provider,
        mimeType,
        content,
        file.filename,
        useResponsesApi,
        model,
      );
      if (block) {
        result.documents.push(block);
        result.files.push(metadata);
      }
    } else if (isDocSupported && !isBedrock) {
      const decodedByteCount = getBase64DecodedByteCount(content);
      if (configuredFileSizeLimit && decodedByteCount > configuredFileSizeLimit) {
        throw new Error(
          `File size (~${(decodedByteCount / 1024 / 1024).toFixed(1)}MB) exceeds the configured limit for ${provider}`,
        );
      }

      const block = formatDocumentBlock(
        provider,
        mimeType,
        content,
        file.filename,
        useResponsesApi,
        model,
        isOptedIn(mimeType),
      );
      if (block) {
        result.documents.push(block);
        result.files.push(metadata);
      }
    }
  }

  return result;
}
