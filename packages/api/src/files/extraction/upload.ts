import { FileSources } from 'librechat-data-provider';
import type { ExtractionServiceConfig } from 'librechat-data-provider';
import type { ExtractionUploadPersistence } from './commit';
import type { MistralOCRUploadResult } from '~/types';
import type { ExtractionLifetime } from './lifetime';
import type { DocumentExtractor } from './client';
import {
  createDocumentExtractor,
  extractionText,
  getExtractionFormat,
  readExtractionInput,
} from './client';
import { withExtractionLifetime, assertExtractionActive } from './lifetime';
import { ExtractionServiceError } from './client';

interface DocumentText {
  text?: string | null;
}

/** PDF/DOCX use isolation unless an explicitly configured cloud OCR succeeds. */
export async function resolveUploadDocumentText<T extends DocumentText>(
  input: {
    file: Express.Multer.File;
    signal?: ExtractionLifetime['signal'];
    request?: ExtractionLifetime['request'];
    response?: ExtractionLifetime['response'];
    config?: ExtractionServiceConfig;
    extractor?: DocumentExtractor;
    persistence?: ExtractionUploadPersistence;
  } & (
    | { extract: () => Promise<T> }
    | {
        configuredOCR?: boolean;
        ocrStrategy?: string;
        configuredText?: boolean;
        extractOCR: () => Promise<T>;
        extractConfiguredText: () => Promise<T>;
        extractDocument: () => Promise<T>;
        onFailure: (source: 'ocr' | 'rag' | 'document', error: unknown) => void;
      }
  ),
): Promise<T | MistralOCRUploadResult> {
  const format = getExtractionFormat(input.file.originalname, input.file.mimetype);
  if (format) input.persistence?.select();
  if (
    format &&
    'configuredOCR' in input &&
    input.configuredOCR &&
    input.ocrStrategy != null &&
    input.ocrStrategy !== FileSources.document_parser
  ) {
    try {
      const result = await withExtractionLifetime({ ...input, deadlineMs: false }, () =>
        input.extractOCR(),
      );
      assertExtractionActive(input);
      return result;
    } catch (error) {
      if (error instanceof ExtractionServiceError && error.code === 'CANCELLED') throw error;
      input.onFailure('ocr', error);
    }
  }
  if (format) {
    const extractor = input.extractor ?? createDocumentExtractor(input.config);
    return withExtractionLifetime(
      { ...input, deadlineMs: extractor.deadlineMs },
      async (signal) => {
        const result = await extractor.extract(
          await readExtractionInput(input.file, extractor, signal),
          format,
          signal,
        );
        const text = extractionText(result);
        return {
          filename: input.file.originalname,
          bytes: Buffer.byteLength(text, 'utf8'),
          filepath: FileSources.document_parser,
          text,
          images: [],
        };
      },
    );
  }
  if ('extract' in input) return input.extract();
  if (input.configuredText) {
    try {
      return await input.extractConfiguredText();
    } catch (error) {
      input.onFailure('rag', error);
    }
  }
  if (input.configuredOCR) {
    try {
      return await input.extractOCR();
    } catch (error) {
      input.onFailure('ocr', error);
    }
  }
  try {
    return await input.extractDocument();
  } catch (error) {
    input.onFailure('document', error);
    throw error;
  }
}
