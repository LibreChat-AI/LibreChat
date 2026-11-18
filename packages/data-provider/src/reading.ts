import type { TurnDeliveryFile } from './resolve-llm-delivery-path';
import type { TDefaultLLMDeliveryPath } from './file-config';
import { excelMimeTypes } from './file-config';
import { FileSources } from './types/files';

/** A reader the automatic policy can give an attachment to on a turn. */
export type ReaderKind = 'provider' | 'text' | 'search' | 'code';

/** The automatic reading categories; images, audio and video stay on their classic route. */
export type ReadingCategory = 'tabular' | 'document';

/** Why a reader was passed over. Stable log and notice codes. */
export type SkipReason =
  | 'code_unavailable'
  | 'native_unsupported'
  | 'native_capacity'
  | 'native_rejected'
  | 'aggregate_overflow'
  | 'text_exceeds'
  | 'text_unavailable'
  | 'search_unavailable';

/** Why a file kept its classic route, named after the eligibility gate that kept it. */
export type ClassicReason =
  | 'classic_policy'
  | 'legacy_record'
  | 'explicit_destination'
  | 'unmarked_record'
  | 'not_message_attachment'
  | 'text_only_record'
  | 'configured_route'
  | 'consumers_unknown'
  | 'no_file_tools'
  | 'media_category';

export type ReadingReason =
  | ClassicReason
  | 'code_preferred'
  | 'code_selected'
  | 'native_supported'
  | 'text_fits'
  | 'search_selected'
  | SkipReason
  | 'no_reader';

export type CodeEligibility =
  | 'eligible'
  | 'no_run_code'
  | 'incompatible'
  | 'text_only_record'
  | 'unstreamable'
  | 'declined';

export interface ReaderSkip {
  reader: ReaderKind;
  reason: SkipReason;
}

/** One attachment's reading on one turn. Recomputed from its inputs and never stored. */
export interface FileReading {
  /** Turn-copy value; always inside the stored vocabulary. */
  path: TDefaultLLMDeliveryPath | undefined;
  /** What classic routing answers for the same inputs (inspection view, diagnostics). */
  classicPath: TDefaultLLMDeliveryPath | undefined;
  automatic: boolean;
  reader: ReaderKind | 'unavailable' | 'unresolved';
  /**
   * The skip that best explains the reading, or the selected reader's own reason when nothing was
   * skipped. A limit the file hit outranks a reader that is merely missing; among missing readers
   * the category's preferred one names the reason.
   */
  reason: ReadingReason;
  skipped: ReadonlyArray<ReaderSkip>;
  code: CodeEligibility;
  category: ReadingCategory | 'media';
  /** The reader is text, but the text must first be derived from the retained original. */
  needsText: boolean;
}

/** Plain-data verdicts the host supplies for one file on this request. */
export interface ReadingEvidence {
  /** Whether the encoder would emit this type for the provider, and within its size limit. */
  native?: 'fits' | 'capacity' | 'unsupported';
  /** The encoder rejected the file in skip mode on this request. */
  rejected?: 'capacity' | 'integrity' | 'unsupported';
  /** Judged only when the record carries text. */
  text?: 'fits' | 'exceeds';
  /** Direct content did not fit the request's first-fit allocation. */
  overflow?: true;
  /** Text derivation failed on this request. */
  textFailed?: true;
  /** Final pass only: whether File Search will actually receive the file. */
  search?: 'reachable' | 'unreachable';
}

/** The turn's evidence seam: synchronous, memoized, and side-effect free for the decision. */
export interface TurnReadingInputs {
  judge(file: TurnDeliveryFile): ReadingEvidence;
  canDerive: boolean;
}

/** The built-in extractors text can be derived with, without a RAG or OCR call. */
export type BuiltInTextPlan = 'document_parser' | 'native_text';

/** How the text a reader may need was obtained; written only under the automatic policy. */
export interface TextDerivation {
  outcome: 'deferred' | 'complete' | 'failed';
  extractor?: BuiltInTextPlan | 'configured';
  reason?:
    | 'too_large'
    | 'expansion_limit'
    | 'parser'
    | 'empty'
    | 'no_extractor'
    | 'extractor_unavailable'
    | 'original_missing';
  at?: number;
}

/** Each category's reader order: the tabular row, and the document rows judged by capability. */
export const READING_ORDER: Readonly<Record<ReadingCategory, readonly ReaderKind[]>> = {
  tabular: ['code', 'provider', 'text', 'search'],
  document: ['provider', 'text', 'search', 'code'],
};

/**
 * Where a walk continues after a reader fails for this reason. Reasons not listed continue the
 * current queue: the category order, or the list a previous failure switched to. A direct reader
 * is never retried after a capacity or encode-time failure, and text follows a native capacity
 * failure only after File Search, and only when it genuinely fits.
 */
export const AFTER_FAILURE: Readonly<
  Record<ReadingCategory, Partial<Record<SkipReason, readonly ReaderKind[]>>>
> = {
  tabular: {
    native_capacity: ['search', 'text'],
    aggregate_overflow: ['search'],
    text_exceeds: ['search'],
    native_rejected: ['search'],
  },
  document: {
    native_capacity: ['search', 'code', 'text'],
    aggregate_overflow: ['search', 'code'],
    text_exceeds: ['search', 'code'],
    native_rejected: ['search', 'code'],
  },
};

export const READER_PATH: Readonly<Record<ReaderKind, TDefaultLLMDeliveryPath>> = {
  provider: 'provider',
  text: 'text',
  search: 'none',
  code: 'none',
};

/** Sources whose original can be streamed back from storage, so a tool or extractor can read it. */
export const ORIGINAL_BACKED_SOURCES: ReadonlySet<string> = new Set<string>([
  FileSources.local,
  FileSources.s3,
  FileSources.cloudfront,
  FileSources.azure_blob,
  FileSources.firebase,
]);

/**
 * A missing source reads as the schema default, `local`, as the encoders and agent file binding
 * read it. The provision service refuses a missing source today, so it must coerce the same way
 * when it adopts this set.
 */
export const isOriginalBacked = (file: Pick<TurnDeliveryFile, 'source'>): boolean =>
  ORIGINAL_BACKED_SOURCES.has(file.source ?? FileSources.local);

/** A record that holds only extracted text, with no original behind it. */
export const isTextOnlyRecord = (file: Pick<TurnDeliveryFile, 'source'>): boolean =>
  file.source === FileSources.text;

/** Classification only; admission stays with `supportedMimeTypes`. */
const TABULAR_PATTERNS: readonly RegExp[] = [
  excelMimeTypes,
  /^application\/vnd\.oasis\.opendocument\.spreadsheet$/,
  /^(text|application)\/csv$/,
  /^text\/tab-separated-values$/,
  /^application\/(x-parquet|vnd\.apache\.parquet)$/,
];

const MEDIA_MIME_PATTERN = /^(image|audio|video)\//;

export function categorizeForReading(mimeType: string): ReadingCategory | 'media' {
  const type = mimeType.split(';', 1)[0].trim().toLowerCase();
  if (MEDIA_MIME_PATTERN.test(type)) {
    return 'media';
  }
  return TABULAR_PATTERNS.some((pattern) => pattern.test(type)) ? 'tabular' : 'document';
}

export interface DirectContentEntry {
  fileId: string;
  /** Whether the file counts toward the attachment count limit. */
  counts: boolean;
  bytes: number;
  textChars: number;
}

/** A missing or zero limit leaves that dimension unlimited. */
export interface DirectContentLimits {
  count?: number;
  bytes?: number;
  textChars?: number;
}

type DirectContentUsage = Required<DirectContentLimits>;

const chargeDirectContent = (
  usage: DirectContentUsage,
  entry: DirectContentEntry,
): DirectContentUsage => ({
  count: usage.count + (entry.counts ? 1 : 0),
  bytes: usage.bytes + entry.bytes,
  textChars: usage.textChars + entry.textChars,
});

const withinLimit = (value: number, limit?: number): boolean => !limit || value <= limit;

/**
 * First-fit allocation of direct model content in the given (stable) candidate order, after
 * charging `committed`. Returns the ids that do not fit, which must take another reader.
 */
export function allocateDirectContent(
  committed: readonly DirectContentEntry[],
  candidates: readonly DirectContentEntry[],
  limits: DirectContentLimits,
): ReadonlySet<string> {
  const fits = (usage: DirectContentUsage): boolean =>
    withinLimit(usage.count, limits.count) &&
    withinLimit(usage.bytes, limits.bytes) &&
    withinLimit(usage.textChars, limits.textChars);
  const overflow = new Set<string>();
  let used = committed.reduce(chargeDirectContent, { count: 0, bytes: 0, textChars: 0 });
  for (const entry of candidates) {
    const next = chargeDirectContent(used, entry);
    if (fits(next)) {
      used = next;
      continue;
    }
    overflow.add(entry.fileId);
  }
  return overflow;
}
