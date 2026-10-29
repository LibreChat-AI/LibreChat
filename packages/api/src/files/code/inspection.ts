import path from 'node:path';
import { inferMimeType } from 'librechat-data-provider';
import type { ExtractionServiceConfig } from 'librechat-data-provider';
import type { DocumentExtractor } from '~/files/extraction/client';
import type { PreparedCodeOutput } from './preflight';
import {
  createDocumentExtractor,
  extractionText,
  getExtractionFormat,
} from '~/files/extraction/client';
import { extractCodeArtifactRawText, extractCodeArtifactInspectionText } from './extract';
import { withExtractionLifetime } from '~/files/extraction/lifetime';
import { sanitizeArtifactPath } from '~/utils/files';
import { classifyCodeArtifact } from './classify';

export type CodeOutputTypeDetector = (
  buffer: Buffer,
  returnFileType: true,
) => Promise<{ mime: string } | undefined | null>;

/** Inspects supplied bytes without downloading them or adding them to a request cache. */
export async function prepareCodeOutputBufferForInspection({
  buffer,
  name,
  fileSizeLimit,
  inspectContent = true,
  determineFileType,
  classify = classifyCodeArtifact,
  extractRawText = extractCodeArtifactRawText,
  extractInspectionText = extractCodeArtifactInspectionText,
  extractionService,
  extractor = createDocumentExtractor(extractionService),
  signal,
}: {
  buffer: Buffer;
  extractionService?: ExtractionServiceConfig;
  extractor?: DocumentExtractor;
  signal?: AbortSignal;
  name: string;
  fileSizeLimit: number;
  inspectContent?: boolean;
  determineFileType: CodeOutputTypeDetector;
  classify?: typeof classifyCodeArtifact;
  extractRawText?: typeof extractCodeArtifactRawText;
  extractInspectionText?: typeof extractCodeArtifactInspectionText;
}): Promise<PreparedCodeOutput> {
  const safeName = sanitizeArtifactPath(name);
  const fallbackType = inferMimeType(name, '') || 'application/octet-stream';
  const file = { name, filename: safeName, type: fallbackType };
  if (!inspectContent) return { buffer, file };
  if (buffer.length > fileSizeLimit) {
    return { buffer, extractedTextComplete: false, file };
  }

  const detectedType = await determineFileType(buffer, true);
  const detectedMimeType = detectedType?.mime?.toLowerCase();
  if (detectedMimeType?.startsWith('image/')) {
    return { buffer, extractedTextComplete: false, file: { ...file, type: detectedMimeType } };
  }

  const leafName = path.basename(safeName);
  const format = getExtractionFormat(leafName, detectedMimeType ?? fallbackType);
  if (format) {
    const result = await withExtractionLifetime(
      { signal, deadlineMs: extractor.deadlineMs },
      (signal) => extractor.extract(buffer, format, signal),
    );
    return {
      buffer,
      extractedTextComplete: true,
      file: {
        ...file,
        type: detectedMimeType ?? fallbackType,
        extractedText: extractionText(result),
      },
    };
  }
  const unknownText = detectedType == null ? extractRawText(buffer, 'utf8-text') : null;
  const mimeType = unknownText != null ? 'text/plain' : (detectedMimeType ?? fallbackType);
  const category = unknownText != null ? 'utf8-text' : classify(leafName, mimeType);
  const content = unknownText ?? extractRawText(buffer, category);
  const extractedText = await extractInspectionText(buffer, leafName, mimeType, category);
  return {
    buffer,
    extractedTextComplete: extractedText.complete,
    file: {
      ...file,
      type: mimeType,
      content: content ?? undefined,
      extractedText: extractedText.text ?? undefined,
    },
  };
}
