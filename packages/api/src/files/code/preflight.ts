import { hasActivePiiPatterns } from 'librechat-data-provider';
import type { FileFilterField, FiltersConfig } from 'librechat-data-provider';
import type { FileContentInput } from '../../protection/adapters/submissions';
import {
  UninspectableFileError,
  assertHydratedFileInspectable,
  getBlockedUninspectableFileField,
} from '../../protection/files';
import { extractFileContent } from '../../protection/adapters/submissions';
import { ContentFilterError } from '../../middleware/contentFilter';
import { inspectContent } from '../../protection/runtime';

const GENERATED_FILE_CONTENT_FIELDS = [
  'content',
  'extracted_text',
  'transcript',
] as const satisfies readonly FileFilterField[];

export const CODE_OUTPUT_PREFLIGHT_MAX_COUNT: number = 10;
export const CODE_OUTPUT_PREFLIGHT_MAX_BYTES: number = 64 * 1024 * 1024;

export interface CodeOutputArtifactFile extends FileContentInput {
  readonly id: string;
  readonly name: string;
  readonly storage_session_id?: string;
  readonly inherited?: boolean;
}

export interface CodeOutputArtifact {
  readonly session_id?: string;
  readonly files?: readonly CodeOutputArtifactFile[];
}

export interface PreparedCodeOutput {
  readonly buffer: Buffer;
  readonly extractedTextComplete?: boolean;
  readonly file: FileContentInput;
}

export interface PreparedCodeOutputEntry {
  readonly file: CodeOutputArtifactFile;
  readonly sessionId?: string;
  readonly preparedBuffer?: Buffer;
  /** Skip a second download and use the existing code-output URL fallback. */
  readonly downloadFallback?: boolean;
}

export interface CodeOutputPreflightLimits {
  readonly fileLimit: number;
  readonly fileSizeLimit: number;
  readonly totalSizeLimit: number;
}

export interface PrepareCodeOutputInput {
  readonly file: CodeOutputArtifactFile;
  readonly sessionId?: string;
  readonly maxBytes: number;
  readonly inspectContent: boolean;
}

export interface PreflightCodeOutputBatchInput {
  readonly filters?: FiltersConfig;
  readonly artifact?: CodeOutputArtifact | null;
  readonly limits: CodeOutputPreflightLimits;
  readonly prepare: (input: PrepareCodeOutputInput) => Promise<PreparedCodeOutput>;
  /** Reports an artifact whose bytes could not be fetched for inspection.
   *  The batch degrades that entry to the download fallback and the turn
   *  still succeeds, so this callback is the only trace the failure leaves;
   *  it carries the cause so the reason is not lost with it. `index` is the
   *  position within the batch, not within the artifact's own file list —
   *  inherited files and files past the configured count never enter it. */
  readonly onInspectionUnavailable?: (index: number, cause: unknown) => void;
}

function throwIfContentBlocked(
  filters: FiltersConfig | undefined,
  fragments: Parameters<typeof inspectContent>[0],
): void {
  const finding = inspectContent(fragments, { filters });
  if (finding != null) {
    throw new ContentFilterError(finding);
  }
}

function getSelectedContentFields(filters: FiltersConfig | undefined): FileFilterField[] {
  const pii = filters?.files?.pii;
  if (pii == null) {
    return [];
  }
  return GENERATED_FILE_CONTENT_FIELDS.filter(
    (field) => pii.fields == null || pii.fields.includes(field),
  );
}

function normalizedPreparedMimeType(prepared: PreparedCodeOutput): string {
  if (typeof prepared.file.type !== 'string') {
    return '';
  }
  return prepared.file.type.split(';', 1)[0].trim().toLowerCase();
}

function getConfiguredCountLimit(configured: number, fallback: number): number {
  if (!Number.isFinite(configured) || configured < 0) {
    return fallback;
  }
  return configured;
}

/**
 * LibreChat file-size configuration uses zero to mean unlimited. Generated
 * output inspection preserves that contract while still applying its
 * process-wide safety ceiling.
 */
export function getBoundedCodeOutputByteLimit(
  configured: number | null | undefined,
  hardLimit: number = CODE_OUTPUT_PREFLIGHT_MAX_BYTES,
): number {
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) {
    return hardLimit;
  }
  return Math.min(configured, hardLimit);
}

/**
 * Prepares an all-or-nothing inspection batch. No persistence callback is
 * accepted here by design: callers cannot write one artifact before every
 * active content check has passed.
 */
export async function preflightCodeOutputBatch(
  input: PreflightCodeOutputBatchInput,
): Promise<PreparedCodeOutputEntry[]> {
  const selectedFields = getSelectedContentFields(input.filters);
  const pii = input.filters?.files?.pii;
  const inspectionActive =
    selectedFields.length > 0 && (hasActivePiiPatterns(pii) || pii?.uninspectable === 'block');

  const resourceField = selectedFields[0] ?? 'content';
  const configuredMaxCount = getConfiguredCountLimit(
    Math.floor(input.limits.fileLimit),
    CODE_OUTPUT_PREFLIGHT_MAX_COUNT,
  );
  const maxBytes = getBoundedCodeOutputByteLimit(input.limits.totalSizeLimit);
  const fileSizeLimit = getBoundedCodeOutputByteLimit(input.limits.fileSizeLimit, maxBytes);
  const entries: PreparedCodeOutputEntry[] = [];
  let configuredCountExceeded = false;
  for (const file of input.artifact?.files ?? []) {
    if (file.inherited === true) {
      continue;
    }
    if (entries.length >= configuredMaxCount) {
      configuredCountExceeded = true;
      break;
    }
    if (inspectionActive && entries.length >= CODE_OUTPUT_PREFLIGHT_MAX_COUNT) {
      throw new UninspectableFileError(resourceField);
    }
    throwIfContentBlocked(input.filters, extractFileContent(file));
    entries.push({
      file,
      sessionId: file.storage_session_id ?? input.artifact?.session_id,
    });
  }
  const inspectionCountExceeded = entries.length > CODE_OUTPUT_PREFLIGHT_MAX_COUNT;
  if (configuredCountExceeded || inspectionCountExceeded) {
    if (inspectionActive) {
      throw new UninspectableFileError(resourceField);
    }
    return entries.map((entry) => ({ ...entry, downloadFallback: true }));
  }

  let inspectedBytes = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const remainingBytes = maxBytes - inspectedBytes;
    const transportBytes = Math.min(remainingBytes, fileSizeLimit);
    if (!Number.isFinite(transportBytes) || transportBytes <= 0) {
      if (inspectionActive) {
        throw new UninspectableFileError(resourceField);
      }
      entries[index] = { ...entry, downloadFallback: true };
      continue;
    }

    let prepared: PreparedCodeOutput;
    try {
      prepared = await input.prepare({
        file: entry.file,
        sessionId: entry.sessionId,
        maxBytes: transportBytes,
        inspectContent: inspectionActive,
      });
    } catch (error) {
      inspectedBytes += transportBytes;
      if (inspectionActive) {
        const blockedField = getBlockedUninspectableFileField(input.filters, selectedFields);
        if (blockedField != null) {
          throw new UninspectableFileError(blockedField);
        }
      }
      input.onInspectionUnavailable?.(index, error);
      entries[index] = { ...entry, downloadFallback: true };
      continue;
    }

    const preparedBytes = prepared.buffer.length;
    if (
      !Number.isFinite(preparedBytes) ||
      preparedBytes < 0 ||
      preparedBytes > transportBytes ||
      preparedBytes > remainingBytes
    ) {
      if (inspectionActive) {
        throw new UninspectableFileError(resourceField);
      }
      entries[index] = { ...entry, downloadFallback: true };
      inspectedBytes += transportBytes;
      continue;
    }

    inspectedBytes += preparedBytes;
    entries[index] = { ...entry, preparedBuffer: prepared.buffer };
    if (!inspectionActive) {
      continue;
    }

    const mimeType = normalizedPreparedMimeType(prepared);
    const transcriptUnknown =
      selectedFields.includes('transcript') &&
      (!mimeType || mimeType === 'application/octet-stream');
    if (
      transcriptUnknown &&
      getBlockedUninspectableFileField(input.filters, ['transcript']) != null
    ) {
      throw new UninspectableFileError('transcript');
    }

    const inspectionFile = { ...entry.file, ...prepared.file };
    const incompleteExtractedTextField =
      prepared.extractedTextComplete === true
        ? null
        : getBlockedUninspectableFileField(input.filters, ['extracted_text']);
    if (incompleteExtractedTextField != null) {
      throw new UninspectableFileError(incompleteExtractedTextField);
    }
    assertHydratedFileInspectable(input.filters, inspectionFile);
    throwIfContentBlocked(input.filters, extractFileContent(inspectionFile));
  }
  return entries;
}
