import { readFile } from 'node:fs/promises';
import type { FileConfig, FiltersConfig } from 'librechat-data-provider';
import {
  canInspectUploadExtractedTextAfterProcessing,
  ContentFilterInputTooLargeError,
  getBlockedUninspectableFileField,
  getBlockedUploadTranscriptField,
  hasActiveFileFieldPolicy,
  hasActiveFilePolicy,
  isTextualFileMimeType,
  UninspectableFileError,
} from '../protection/files';
import { extractFileContent } from '../protection/adapters/submissions';
import { ContentFilterError } from '../middleware/contentFilter';
import { inspectContent } from '../protection/runtime';
import { isBinaryBuffer } from '../skills/binary';

export const MAX_FILTERABLE_TEXT_BYTES: number = 15 * 1024 * 1024;

export interface UploadPolicyFile {
  readonly originalname?: string;
  readonly mimetype?: string;
  readonly path?: string;
  readonly size?: number;
}

export interface UploadContentPolicyInput {
  readonly filters?: FiltersConfig;
  readonly file?: UploadPolicyFile;
  readonly endpoint?: string;
  readonly toolResource?: string;
  readonly fileConfig: FileConfig;
  readonly ocrConfigured: boolean;
  readonly ragConfigured: boolean;
  readonly rawFileMode?: 'materialize' | 'opaque';
  readonly readFile?: (path: string) => Promise<Buffer>;
}

/** Applies upload policy before any provider, parser, or persistence work starts. */
export async function assertUploadContentAllowed(input: UploadContentPolicyInput): Promise<void> {
  if (!hasActiveFilePolicy(input.filters)) {
    return;
  }
  const inspectContentField = hasActiveFileFieldPolicy(input.filters, ['content']);
  const inspectExtractedText = hasActiveFileFieldPolicy(input.filters, ['extracted_text']);
  const inspectTranscript = hasActiveFileFieldPolicy(input.filters, ['transcript']);
  const mimeType = input.file?.mimetype;
  const canInspectExtractedTextAfterProcessing =
    inspectExtractedText && typeof mimeType === 'string'
      ? canInspectUploadExtractedTextAfterProcessing({
          endpoint: input.endpoint,
          toolResource: input.toolResource,
          mimeType,
          fileConfig: input.fileConfig,
          ocrConfigured: input.ocrConfigured,
          ragConfigured: input.ragConfigured,
        })
      : false;

  if (inspectTranscript && typeof mimeType === 'string') {
    const shouldTranscribe =
      input.fileConfig.checkType?.(mimeType, input.fileConfig.stt?.supportedMimeTypes ?? []) ??
      false;
    const blockedTranscriptField = getBlockedUploadTranscriptField({
      filters: input.filters,
      endpoint: input.endpoint,
      toolResource: input.toolResource,
      mimeType,
      sttSupported: shouldTranscribe,
    });
    if (blockedTranscriptField != null) {
      throw new UninspectableFileError(blockedTranscriptField);
    }
  }

  const submittedFile: {
    name?: string;
    content?: string;
    extractedText?: string;
  } = { name: input.file?.originalname };
  if (inspectContentField || inspectExtractedText) {
    const blockedField = getBlockedUninspectableFileField(input.filters, [
      'content',
      'extracted_text',
    ]);
    const deferExtractedTextFailClose =
      blockedField === 'extracted_text' && canInspectExtractedTextAfterProcessing;
    const path = input.file?.path;
    if (input.rawFileMode === 'opaque' || typeof path !== 'string') {
      if (blockedField != null && !deferExtractedTextFailClose) {
        throw new UninspectableFileError(blockedField);
      }
    } else if ((input.file?.size ?? 0) > MAX_FILTERABLE_TEXT_BYTES) {
      if (blockedField != null && isTextualFileMimeType(mimeType)) {
        throw new ContentFilterInputTooLargeError(
          inspectContentField ? 'content' : 'extracted_text',
        );
      }
      if (blockedField != null && !deferExtractedTextFailClose) {
        throw new UninspectableFileError(blockedField);
      }
    } else {
      const buffer = await (input.readFile ?? readFile)(path);
      if (isBinaryBuffer(buffer)) {
        if (blockedField != null && !deferExtractedTextFailClose) {
          throw new UninspectableFileError(blockedField);
        }
      } else {
        const text = buffer.toString('utf8');
        if (inspectContentField) {
          submittedFile.content = text;
        }
        if (inspectExtractedText) {
          submittedFile.extractedText = text;
        }
      }
    }
  }

  const finding = inspectContent(extractFileContent(submittedFile), { filters: input.filters });
  if (finding != null) {
    throw new ContentFilterError(finding);
  }
}
