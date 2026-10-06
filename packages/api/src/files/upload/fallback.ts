import { logger } from '@librechat/data-schemas';
import { selectBuiltInTextPlan } from 'librechat-data-provider';
import type {
  FiltersConfig,
  UploadReading,
  TextDerivation,
  BuiltInTextPlan,
  EndpointFileConfig,
  TDefaultLLMDeliveryPath,
} from 'librechat-data-provider';
import type { ProtectionFinding } from '~/protection/types';
import {
  extractInspectableFileText,
  getFileExtractionLogDetails,
  MAX_STORED_EXTRACTED_TEXT_BYTES,
} from '~/files/extract';
import { hasActiveFileFieldPolicy, UninspectableFileError } from '~/protection/files';
import { extractFileContent } from '~/protection/adapters/submissions';
import { ZipBombError } from '~/files/documents/zipSafety';
import { parseDocument } from '~/files/documents/crud';
import { inspectContent } from '~/protection/runtime';
import { parseTextNative } from '~/files/text';

export const UPLOAD_FALLBACK_TEXT_PLANS = {
  documentParser: 'document_parser',
  nativeText: 'native_text',
} as const satisfies Record<string, BuiltInTextPlan>;

export type UploadFallbackTextPlan = BuiltInTextPlan;

export interface UploadFallbackTextRoute {
  /** The route the upload resolved to. */
  deliveryPath: TDefaultLLMDeliveryPath;
  /** Whether the user chose the destination, by tool resource or the legacy chooser. */
  destinationChosen: boolean;
  /** Whether the upload attaches to a message; an agent's own tool files never reach a prompt. */
  isMessageAttachment: boolean;
  mimeType: string;
  /** The upload endpoint's file config, which opts in through `textFallbackWithoutTools`. */
  endpointConfig?: Pick<EndpointFileConfig, 'textFallbackWithoutTools'>;
  /** The upload's reading decision; an upload left to Run Code reads no text now. */
  reading?: Pick<UploadReading, 'codePreferred'>;
  /** The marker the upload's text acquisition returned, when it kept the original without text. */
  textDerivation?: TextDerivation;
}

interface ExtractedText {
  readonly text?: string | null;
}

/** The built-in readers fallback text comes from. */
export interface UploadFallbackTextExtractors {
  parseDocument: (params: { file: Express.Multer.File }) => Promise<ExtractedText>;
  parseTextNative: (file: Express.Multer.File) => Promise<ExtractedText>;
}

/** Why a built-in extractor produced no text a file can keep. */
export type ExtractionFailureReason = Extract<
  NonNullable<TextDerivation['reason']>,
  'empty' | 'parser' | 'too_large' | 'expansion_limit'
>;

/**
 * Why bounded extraction kept no text: the extractor failed, a file policy refused its text, or
 * the system could not serve the read (`unavailable`), which says nothing about the file.
 */
export type BoundedTextFailure =
  | ExtractionFailureReason
  | 'policy'
  | 'uninspectable'
  | 'unavailable';

/**
 * Text within every cap, or why there is none: `error` is set when extraction threw, and
 * `finding` is the content policy's finding when it refused the text.
 */
export type BoundedText =
  | { text: string }
  | { failure: 'policy'; finding: ProtectionFinding }
  | { failure: Exclude<BoundedTextFailure, 'policy'>; error?: unknown };

const builtInExtractors: UploadFallbackTextExtractors = { parseDocument, parseTextNative };

/** Fragments of the built-in extractors' plain error messages, mapped to stable reasons. */
const EXTRACTION_FAILURE_MESSAGES: ReadonlyArray<readonly [string, ExtractionFailureReason]> = [
  ['No text found in document', 'empty'],
  ['Unable to extract text from', 'empty'],
  ['MB document parser limit', 'too_large'],
  ['MB storage limit', 'too_large'],
  ['MB decompressed limit', 'expansion_limit'],
];

/** The stable reason a built-in extractor failed with, or undefined for an unrecognized error. */
export function matchExtractionFailure(error: unknown): ExtractionFailureReason | undefined {
  if (error instanceof ZipBombError) {
    return 'expansion_limit';
  }
  const message = error instanceof Error ? error.message : '';
  return EXTRACTION_FAILURE_MESSAGES.find(([fragment]) => message.includes(fragment))?.[1];
}

interface SystemErrorShape {
  code?: string;
  errno?: number;
  syscall?: string;
}

/** POSIX error names (`ENOSPC`, `EIO`, `EBUSY`, `EMFILE`, `EAGAIN`...), never Node's `ERR_*` codes. */
const SYSTEM_ERROR_CODE = /^E[A-Z0-9]+$/;

/**
 * Whether the error is the operating system refusing a read, such as a full disk, a busy or
 * locked file, or descriptor exhaustion, rather than anything the file's content caused. These
 * clear up, so a later read may succeed. An `errno` alone is not enough: zlib reports a corrupt
 * archive with one (`Z_DATA_ERROR`), so it counts only with the system call that failed.
 */
export function isSystemError(error: unknown): boolean {
  if (typeof error !== 'object' || error == null) {
    return false;
  }
  const { code, errno, syscall }: SystemErrorShape = error;
  return (
    (typeof code === 'string' && SYSTEM_ERROR_CODE.test(code)) ||
    (typeof errno === 'number' && typeof syscall === 'string')
  );
}

/**
 * The stable reason a built-in extractor failed with. A failure the extractor names keeps its
 * reason, a system error is `unavailable`, and anything else unrecognized is a parser error.
 */
export function classifyExtractionFailure(error: unknown): ExtractionFailureReason | 'unavailable' {
  return matchExtractionFailure(error) ?? (isSystemError(error) ? 'unavailable' : 'parser');
}

/** Whether the upload's text is left to a turn, which derives it from the stored original. */
const isUploadTextDeferred = ({
  reading,
  textDerivation,
}: Pick<UploadFallbackTextRoute, 'reading' | 'textDerivation'>): boolean =>
  reading?.codePreferred === true || textDerivation != null;

/**
 * Which built-in extractor stores text for an upload left to tools, or `null` when none runs.
 *
 * Where the endpoint enables `textFallbackWithoutTools`, a turn that runs no tool able to read a
 * `none`-routed file delivers this text instead (`resolveTurnLLMDeliveryPath`). Only an inferred
 * route on a message attachment qualifies: a turn never re-resolves a destination the user chose,
 * and files kept on an agent's tool resources never reach a prompt. A file filed
 * under a tool that reads it still gets text, because a later turn may run without that tool: a
 * handoff agent, or the same agent after its tools or grants change. Only built-in extractors
 * run, so a file meant for a tool never costs a RAG or OCR call. A deferred upload runs none.
 */
export function getUploadFallbackTextPlan(
  route: UploadFallbackTextRoute,
): UploadFallbackTextPlan | null {
  if (
    route.endpointConfig?.textFallbackWithoutTools !== true ||
    route.deliveryPath !== 'none' ||
    route.destinationChosen ||
    !route.isMessageAttachment ||
    isUploadTextDeferred(route)
  ) {
    return null;
  }
  return selectBuiltInTextPlan(route.mimeType);
}

/**
 * Reads a file with one built-in extractor and keeps its text only within every cap: non-empty,
 * within the stored-text limit, and clear of any `extracted_text` content policy. Extraction runs
 * under the policy's fail-close, so text a blocking policy cannot inspect is refused. Never
 * throws: upload fallback and turn-time derivation share these caps and each decides what a
 * failure means for its file.
 */
export async function extractBoundedText({
  file,
  filters,
  plan,
  extractors = builtInExtractors,
}: {
  file: Express.Multer.File;
  filters?: FiltersConfig;
  plan: UploadFallbackTextPlan;
  extractors?: UploadFallbackTextExtractors;
}): Promise<BoundedText> {
  try {
    const result = await extractInspectableFileText({
      filters,
      extract: () =>
        plan === UPLOAD_FALLBACK_TEXT_PLANS.documentParser
          ? extractors.parseDocument({ file })
          : extractors.parseTextNative(file),
    });
    const text = result?.text;
    if (typeof text !== 'string' || text.trim().length === 0) {
      return { failure: 'empty' };
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_STORED_EXTRACTED_TEXT_BYTES) {
      return { failure: 'too_large' };
    }
    if (filters == null || !hasActiveFileFieldPolicy(filters, ['extracted_text'])) {
      return { text };
    }
    const finding = inspectContent(extractFileContent({ extractedText: text }), { filters });
    return finding == null ? { text } : { failure: 'policy', finding };
  } catch (error) {
    const failure =
      error instanceof UninspectableFileError ? 'uninspectable' : classifyExtractionFailure(error);
    return { failure, error };
  }
}

/** The warning a failure without a thrown error logs; an empty result logs nothing. */
const FALLBACK_SKIP_REASONS: Partial<Record<BoundedTextFailure, string>> = {
  too_large: 'extracted text exceeds the storage limit',
  policy: 'extracted text matched a content policy',
};

/**
 * Text a turn without a reading tool can fall back to for this upload, when one applies.
 *
 * Reads the upload before storage can move it, with the extractor its plan names. Best effort by
 * design: an extractor failure, text a policy cannot inspect, an overrun of the storage cap, or a
 * content finding leaves the upload without fallback text rather than refusing a file whose
 * primary reader is a tool. Text that is delivered later is inspected again as model-bound
 * content.
 */
export async function resolveUploadFallbackText({
  file,
  fileId,
  filters,
  extractors = builtInExtractors,
  ...route
}: Omit<UploadFallbackTextRoute, 'mimeType'> & {
  file: Express.Multer.File;
  fileId: string;
  filters?: FiltersConfig;
  extractors?: UploadFallbackTextExtractors;
}): Promise<string | undefined> {
  const plan = getUploadFallbackTextPlan({ ...route, mimeType: file.mimetype });
  if (plan == null) {
    return undefined;
  }
  const skip = (reason: string, error?: unknown): undefined => {
    const { fileLabel, errorMetadata } = getFileExtractionLogDetails({
      filters,
      filename: file.originalname,
      fileId,
      error,
    });
    logger.warn(
      `[resolveUploadFallbackText] No fallback text for ${fileLabel}: ${reason}`,
      errorMetadata,
    );
    return undefined;
  };
  const result = await extractBoundedText({ file, filters, plan, extractors });
  if ('text' in result) {
    return result.text;
  }
  if ('error' in result) {
    return skip('extraction failed', result.error);
  }
  const reason = FALLBACK_SKIP_REASONS[result.failure];
  return reason == null ? undefined : skip(reason);
}
