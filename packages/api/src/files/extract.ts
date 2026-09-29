import { megabyte } from 'librechat-data-provider';
import type { FiltersConfig } from 'librechat-data-provider';
import {
  getBlockedUninspectableFileField,
  hasActiveFilePolicy,
  UninspectableFileError,
} from '~/protection/files';
import { getSafeErrorMetadata } from '~/utils/errors';

/**
 * The most extracted text a file document can hold. MongoDB refuses a document past 16 MiB and
 * the text shares it with the file's other fields, so this bounds storage rather than policy:
 * what reaches a model is governed by `fileContextCharLimit` and `fileTokenLimit`.
 */
export const MAX_STORED_EXTRACTED_TEXT_BYTES: number = 15 * megabyte;

interface ExtractedFileText {
  readonly text?: string | null;
}

function isInspectableText(text: string | null | undefined): text is string {
  return typeof text === 'string' && text.trim().length > 0;
}

/** Keeps submitted filenames and provider/parser details out of protected extraction logs. */
export function getFileExtractionLogDetails(input: {
  readonly filters?: FiltersConfig;
  readonly filename: string;
  readonly fileId: string;
  readonly error: unknown;
}): {
  readonly contentProtected: boolean;
  readonly fileLabel: string;
  readonly errorMetadata: unknown;
} {
  const contentProtected = hasActiveFilePolicy(input.filters);
  if (!contentProtected) {
    return {
      contentProtected,
      fileLabel: `"${input.filename}"`,
      errorMetadata: input.error,
    };
  }
  return {
    contentProtected,
    fileLabel: `file_id=${input.fileId}`,
    errorMetadata: getSafeErrorMetadata(input.error),
  };
}

/** Requires a produced value when strict extracted-text coverage is configured. */
export function assertExtractedTextInspectable(input: {
  readonly filters?: FiltersConfig;
  readonly text?: string | null;
}): void {
  const blockedField = getBlockedUninspectableFileField(input.filters, ['extracted_text']);
  if (blockedField != null && !isInspectableText(input.text)) {
    throw new UninspectableFileError(blockedField);
  }
}

/** Converts extraction failures and empty results into the stable fail-close policy error. */
export async function extractInspectableFileText<T extends ExtractedFileText>(input: {
  readonly filters?: FiltersConfig;
  readonly extract: () => Promise<T | null | undefined>;
}): Promise<T | null | undefined> {
  const blockedField = getBlockedUninspectableFileField(input.filters, ['extracted_text']);
  try {
    const result = await input.extract();
    if (blockedField != null && !isInspectableText(result?.text)) {
      throw new UninspectableFileError(blockedField);
    }
    return result;
  } catch (error) {
    if (blockedField == null || error instanceof UninspectableFileError) {
      throw error;
    }
    throw new UninspectableFileError(blockedField);
  }
}
