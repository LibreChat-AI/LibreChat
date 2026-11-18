import { logger } from '@librechat/data-schemas';
import {
  EToolResources,
  decideUploadReading,
  selectBuiltInTextPlan,
} from 'librechat-data-provider';
import type {
  FiltersConfig,
  UploadReading,
  TextDerivation,
  UploadReadingInput,
} from 'librechat-data-provider';
import {
  hasActiveFilePolicy,
  UninspectableFileError,
  ContentFilterInputTooLargeError,
  getBlockedUninspectableFileField,
} from '~/protection/files';
import { assertExtractedTextInspectable, MAX_STORED_EXTRACTED_TEXT_BYTES } from '~/files/extract';
import { UnsupportedProviderAudioError } from '~/files/upload/errors';
import { isAbortError, getSafeErrorMetadata } from '~/utils/errors';
import { matchExtractionFailure } from '~/files/upload/fallback';
import { ContentFilterError } from '~/middleware/contentFilter';

/** An upload's reading decision, with the type it was decided for. */
export interface ResolvedUploadReading extends UploadReading {
  mimeType: string;
}

export type ResolveUploadReadingInput = Omit<
  UploadReadingInput,
  'extractionRequiredForInspection' | 'codePossible'
> & {
  filters?: FiltersConfig;
  /** Asked only when the decision depends on whether Run Code can read the file. */
  resolveCodePossible: () => Promise<boolean>;
};

/**
 * Decides how an upload is read before anything is extracted. Code preference is off where the
 * upload preflight defers an extracted-text fail-close to the context route, because there the
 * extraction is the inspection; Run Code availability is resolved only when the decision needs it.
 */
export async function resolveUploadReading({
  filters,
  resolveCodePossible,
  ...input
}: ResolveUploadReadingInput): Promise<ResolvedUploadReading> {
  const extractionRequiredForInspection =
    hasActiveFilePolicy(filters) &&
    getBlockedUninspectableFileField(filters, ['content', 'extracted_text']) === 'extracted_text';
  const routing: UploadReadingInput = { ...input, extractionRequiredForInspection };
  const first = decideUploadReading(routing);
  if (!first.needsCodeAvailability) {
    return { ...first, mimeType: input.mimeType };
  }
  const codePossible = await resolveCodePossible();
  return { ...decideUploadReading({ ...routing, codePossible }), mimeType: input.mimeType };
}

export interface UploadCodePossibleParams {
  /**
   * The saved agent's tools, already narrowed by capability and role grants: the same list the
   * upload is filed against. Undefined when no agent record backs the upload.
   */
  agentTools?: string[];
  checkCodeCapability: () => Promise<boolean>;
  getRunCodeGrant: () => Promise<boolean | undefined>;
}

/**
 * Whether Run Code can read the upload: a saved agent whose narrowed tools include it, or, with no
 * saved agent, the capability enabled and the role's grant not denied.
 */
export async function resolveUploadCodePossible({
  agentTools,
  checkCodeCapability,
  getRunCodeGrant,
}: UploadCodePossibleParams): Promise<boolean> {
  if (agentTools != null) {
    return agentTools.includes(EToolResources.execute_code);
  }
  const [enabled, grant] = await Promise.all([checkCodeCapability(), getRunCodeGrant()]);
  return enabled && grant !== false;
}

/**
 * Files a deferred upload under the reader that will use it: `execute_code` first, since upload
 * filing takes the first compatible tool.
 */
export function orderToolsForReading(
  reading: Pick<UploadReading, 'codePreferred'>,
  tools?: string[],
): string[] | undefined {
  if (!reading.codePreferred || tools?.includes(EToolResources.execute_code) !== true) {
    return tools;
  }
  return [
    EToolResources.execute_code,
    ...tools.filter((tool) => tool !== EToolResources.execute_code),
  ];
}

/** Text the context route acquired, before it is inspected and stored. */
export interface AcquiredUploadText {
  text: string;
  isTranscript?: boolean;
}

/** The upload keeps its original as plain storage without text, and records why. */
export interface UploadTextMarker {
  textDerivation: TextDerivation;
  /** The route the kept original takes: no reader gets text from it at upload. */
  path: 'none';
}

/** Why a configured extraction step could not run for an upload. */
export type ExtractorUnavailableReason = Extract<
  TextDerivation['reason'],
  'no_extractor' | 'extractor_unavailable'
>;

/**
 * A configured extraction step the upload needed is off or absent, such as OCR without its
 * capability, or a type the text route does not parse. It rejects the upload where failure
 * rejects it; where the original is kept, a built-in extractor may derive the text later.
 */
export class ExtractorUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: ExtractorUnavailableReason,
  ) {
    super(message);
    this.name = 'ExtractorUnavailableError';
    Object.setPrototypeOf(this, ExtractorUnavailableError.prototype);
  }
}

const isHardUploadFailure = (error: unknown): boolean =>
  error instanceof UninspectableFileError ||
  error instanceof ContentFilterError ||
  error instanceof ContentFilterInputTooLargeError ||
  error instanceof UnsupportedProviderAudioError ||
  isAbortError(error);

/**
 * The marker an extraction failure leaves. A failure a built-in step names (a parser limit, empty
 * text, the zip guard) is `failed`, as is a type the deployment's text allowlist excludes: a
 * later turn must not parse what the administrator kept out of text. An unavailable configured
 * step, or an error nothing recognizes and that may be a passing outage, is `deferred` where a
 * built-in extractor can derive the text on a later turn, and `failed` where none can.
 */
function markExtractionFailure(mimeType: string, error: unknown): TextDerivation {
  const at = Date.now();
  const plan = selectBuiltInTextPlan(mimeType);
  if (error instanceof ExtractorUnavailableError) {
    return plan == null || error.reason === 'no_extractor'
      ? { outcome: 'failed', extractor: 'configured', reason: error.reason, at }
      : { outcome: 'deferred', extractor: 'configured', reason: 'extractor_unavailable', at };
  }
  const recognized = matchExtractionFailure(error);
  if (recognized != null) {
    return { outcome: 'failed', extractor: plan ?? 'configured', reason: recognized, at };
  }
  return plan == null
    ? { outcome: 'failed', extractor: 'configured', reason: 'parser', at }
    : { outcome: 'deferred', reason: 'parser', at };
}

function checkAcquiredText({ text }: AcquiredUploadText): TextDerivation['reason'] | undefined {
  if (text.trim().length === 0) {
    return 'empty';
  }
  return Buffer.byteLength(text, 'utf8') > MAX_STORED_EXTRACTED_TEXT_BYTES
    ? 'too_large'
    : undefined;
}

/** Logs the error behind a kept original as safe metadata, never the filename or text. */
function logExtractionError(fileId: string, marker: TextDerivation, error: unknown): void {
  logger.warn(
    `[uploadReading] file_id=${fileId} extraction=${marker.outcome} failure=${marker.reason}`,
    getSafeErrorMetadata(error),
  );
}

/**
 * Runs the context route's text acquisition. Where the reading keeps the original on failure, an
 * extraction failure, empty text or text past the storage cap returns a marker and the `none`
 * route instead of throwing, and logs any error behind it (see {@link markExtractionFailure}).
 * Content policy, inspection, audio and abort errors still reject, and text a blocking policy
 * cannot inspect fails closed before it can count as empty. Everywhere else the acquisition's
 * result or error passes through unchanged.
 */
export async function acquireUploadText<T extends AcquiredUploadText>({
  reading,
  acquire,
  fileId,
  filters,
}: {
  reading: Pick<ResolvedUploadReading, 'keepOriginalOnExtractionFailure' | 'mimeType'>;
  acquire: () => Promise<T>;
  fileId: string;
  filters?: FiltersConfig;
}): Promise<T | UploadTextMarker> {
  if (!reading.keepOriginalOnExtractionFailure) {
    return acquire();
  }
  let acquired: T;
  try {
    acquired = await acquire();
  } catch (error) {
    if (isHardUploadFailure(error)) {
      throw error;
    }
    const textDerivation = markExtractionFailure(reading.mimeType, error);
    logExtractionError(fileId, textDerivation, error);
    return { textDerivation, path: 'none' };
  }
  if (acquired.isTranscript !== true) {
    assertExtractedTextInspectable({ filters, text: acquired.text });
  }
  const reason = checkAcquiredText(acquired);
  if (reason == null) {
    return acquired;
  }
  const textDerivation: TextDerivation = {
    outcome: 'failed',
    extractor: selectBuiltInTextPlan(reading.mimeType) ?? 'configured',
    reason,
    at: Date.now(),
  };
  return { textDerivation, path: 'none' };
}

/**
 * The `textDerivation` an upload's record stores: the marker its text acquisition returned, or a
 * deferred marker for an upload left to Run Code that a built-in extractor can read. Nothing under
 * the classic policy.
 */
export function getUploadReadingMetadata(
  reading: Pick<UploadReading, 'policy' | 'deferredMarker'>,
  marker?: TextDerivation,
): { textDerivation?: TextDerivation } {
  if (reading.policy !== 'automatic') {
    return {};
  }
  if (marker != null) {
    return { textDerivation: marker };
  }
  return reading.deferredMarker ? { textDerivation: { outcome: 'deferred', at: Date.now() } } : {};
}

function describeExtraction(reading: UploadReading, marker?: TextDerivation): string {
  if (marker != null) {
    return [
      `extraction=${marker.outcome}`,
      ...(marker.reason != null ? [`failure=${marker.reason}`] : []),
      'kept=original',
    ].join(' ');
  }
  if (reading.codePreferred) {
    return `extraction=${reading.deferredMarker ? 'deferred' : 'none'}`;
  }
  return `extraction=${reading.path === 'text' ? 'eager' : 'none'}`;
}

/**
 * Logs how the automatic policy read one upload. Carries the file id and codes only, never the
 * filename or text. Silent under the classic policy.
 */
export function logUploadReading(
  fileId: string,
  reading: UploadReading,
  marker?: TextDerivation,
): void {
  if (reading.policy !== 'automatic') {
    return;
  }
  const line = [
    `[uploadReading] file_id=${fileId}`,
    `policy=${reading.policy}`,
    `category=${reading.category}`,
    `path=${reading.path}`,
    `reason=${reading.reason}`,
    describeExtraction(reading, marker),
  ].join(' ');
  if (marker?.outcome === 'failed') {
    logger.info(line);
    return;
  }
  logger.debug(line);
}
