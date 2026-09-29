import {
  EToolResources,
  FILE_FILTER_FIELDS,
  documentParserMimeTypes,
  hasActivePiiFields,
  hasActivePiiPatterns,
  isAssistantsEndpoint,
  isPermissiveMimeConfig,
} from 'librechat-data-provider';
import type { FileConfig, FileFilterField, FiltersConfig } from 'librechat-data-provider';
import type { ContentTraversalLimitReason } from './adapters/nested';
import type { LocatorTraversalReporter } from './diagnostics';
import {
  ContentTraversalLimitError,
  escapeJsonPointer,
  getBoundedOwnEnumerableEntries,
  isDataUri,
  isLikelyEncodedPayload,
} from './adapters/nested';

type UninspectablePolicy = 'allow' | 'block';

type FilePiiConfig = NonNullable<FiltersConfig['files']>['pii'] & {
  readonly uninspectable?: UninspectablePolicy;
};

export interface UninspectableFileBlockResponse {
  readonly error: 'content_filter_uninspectable';
  readonly message: string;
  readonly source: 'file';
  readonly field: FileFilterField;
}

export interface ContentFilterInputTooLargeResponse {
  readonly error: 'content_filter_input_too_large';
  readonly message: string;
  readonly source: 'file';
  readonly field: 'content' | 'extracted_text';
}

interface PendingOpaqueValue {
  readonly value: unknown;
  readonly path: string;
  readonly depth: number;
}

interface MutableUnknownDictionary {
  [key: string]: unknown;
}

export interface CanonicalFileInspectionFile {
  readonly file_id?: string;
  readonly filename?: string;
  readonly filepath?: string;
  readonly uri?: string;
  readonly url?: string;
  readonly preview?: string;
  readonly type?: string;
  readonly source?: string;
  /** Unified uploads persist their extracted text alongside the backing storage
   *  source, so delivery path carries the provenance `source: 'text'` used to. */
  readonly llmDeliveryPath?: string | null;
  readonly content?: string | null;
  readonly extractedText?: string | null;
  readonly text?: string | null;
  readonly transcript?: string | null;
}

export interface CanonicalFileInspectionCoverage {
  readonly content?: string;
  readonly extractedText?: string;
  readonly transcript?: string;
  /** The canonical transcript came from the persisted `text` fallback. */
  readonly textProvidesTranscript: boolean;
  /** `null` means the MIME is absent or malformed, so strict transcript
   * policy must fail closed instead of assuming the file is non-audio. */
  readonly transcriptApplicable: boolean | null;
}

export interface CanonicalFileInspectionUser {
  readonly id?: string;
  readonly tenantId?: string | null;
}

export type GetCanonicalFilesForInspection = (
  filter: {
    file_id: { $in: string[] };
    user: string;
    tenantId?: string | null;
  },
  sort: object,
  select: object,
) => Promise<CanonicalFileInspectionFile[] | null | undefined>;

export interface CanonicalFileReferenceInspectionInput<T> {
  readonly messageCount?: number;
  readonly onTraversalFailure?: LocatorTraversalReporter;
  readonly filters?: FiltersConfig;
  readonly input: T;
  readonly user?: CanonicalFileInspectionUser;
  /**
   * Server-derived runtime rows whose extraction fields belong to the exact
   * model-bound generation. Never populate this from request or resumable-job
   * metadata: a matching file_id alone is not an extraction attestation.
   */
  readonly trustedLiveFiles?: readonly CanonicalFileInspectionFile[];
  readonly getFiles: GetCanonicalFilesForInspection;
}

export interface CanonicalFileReferenceInspection<T> {
  readonly sanitizedInput: T;
  readonly hydratedFiles: CanonicalFileInspectionFile[];
  readonly hydratedFilters?: FiltersConfig;
}

const MAX_OPAQUE_DEPTH = 24;
const MAX_OPAQUE_NODES = 4096;
const CONTENT_FIELDS = ['content'] as const;
const AUDIO_FIELDS = ['content', 'transcript'] as const;
const DERIVED_FILE_FIELDS = ['content', 'extracted_text', 'transcript'] as const;
const DERIVED_FILE_FIELD_SET = new Set<FileFilterField>(DERIVED_FILE_FIELDS);
const TEXTUAL_APPLICATION_MIME_TYPES = new Set([
  'application/json',
  'application/javascript',
  'application/sql',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
]);
const AUDIO_APPLICATION_MIME_TYPES = new Set(['application/ogg']);

function normalizeMimeType(mimeType: unknown): string {
  return typeof mimeType === 'string' ? mimeType.split(';', 1)[0].trim().toLowerCase() : '';
}

/**
 * Classifies whether a MIME type can carry audio that requires transcript
 * inspection. `null` preserves fail-close behavior for missing or malformed
 * MIME metadata instead of treating an unknown file as safely non-audio.
 */
function getNormalizedTranscriptApplicability(normalized: string): boolean | null {
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(normalized)) {
    return null;
  }
  return normalized.startsWith('audio/') || AUDIO_APPLICATION_MIME_TYPES.has(normalized);
}

export function getTranscriptApplicability(mimeType: unknown): boolean | null {
  return getNormalizedTranscriptApplicability(normalizeMimeType(mimeType));
}

export function isTextualFileMimeType(mimeType: unknown): boolean {
  const normalized = normalizeMimeType(mimeType);
  return normalized.startsWith('text/') || TEXTUAL_APPLICATION_MIME_TYPES.has(normalized);
}

function captureOpaqueArrayLength(value: readonly unknown[]): number {
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new ContentTraversalLimitError();
  }
  return length;
}

function snapshotCanonicalFiles(
  candidate: readonly (CanonicalFileInspectionFile | null | undefined)[] | null | undefined,
): Array<CanonicalFileInspectionFile | null | undefined> {
  if (candidate == null) {
    return [];
  }
  let isArray: boolean;
  try {
    isArray = Array.isArray(candidate);
  } catch {
    throw new ContentTraversalLimitError();
  }
  if (!isArray) {
    throw new ContentTraversalLimitError();
  }
  const length = captureOpaqueArrayLength(candidate);
  if (length > MAX_OPAQUE_NODES) {
    throw new ContentTraversalLimitError();
  }
  const files: Array<CanonicalFileInspectionFile | null | undefined> = [];
  try {
    for (let index = 0; index < length; index++) {
      files.push(candidate[index]);
    }
  } catch {
    throw new ContentTraversalLimitError();
  }
  return files;
}

function getFilePii(filters: FiltersConfig | undefined): FilePiiConfig | undefined {
  return filters?.files?.pii as FilePiiConfig | undefined;
}

/**
 * A file policy needs canonical file hydration only when it can inspect text
 * patterns or fail closed for one of the derived content surfaces.
 */
export function hasActiveFilePolicy(filters: FiltersConfig | undefined): boolean {
  const pii = getFilePii(filters);
  if (hasActivePiiPatterns(pii)) {
    return true;
  }
  return (
    pii?.uninspectable === 'block' &&
    DERIVED_FILE_FIELDS.some((field) => pii.fields == null || pii.fields.includes(field))
  );
}

/** Whether a file policy can enforce on at least one requested field. */
export function hasActiveFileFieldPolicy(
  filters: FiltersConfig | undefined,
  candidates: readonly FileFilterField[],
): boolean {
  const pii = getFilePii(filters);
  if (!hasActivePiiFields(pii, candidates)) {
    return (
      pii?.uninspectable === 'block' &&
      candidates.some(
        (field) =>
          DERIVED_FILE_FIELD_SET.has(field) && (pii.fields == null || pii.fields.includes(field)),
      )
    );
  }
  return true;
}

export function isFileFilterFieldEnabled(
  filters: FiltersConfig | undefined,
  field: FileFilterField,
): boolean {
  const pii = getFilePii(filters);
  return pii != null && (pii.fields == null || pii.fields.includes(field));
}

export function getBlockedUninspectableFileField(
  filters: FiltersConfig | undefined,
  fields: readonly FileFilterField[],
): FileFilterField | null {
  const pii = getFilePii(filters);
  if (pii?.uninspectable !== 'block') {
    return null;
  }
  for (const field of fields) {
    if (pii.fields == null || pii.fields.includes(field)) {
      return field;
    }
  }
  return null;
}

function isAgentContextUpload(input: {
  readonly endpoint?: string;
  readonly toolResource?: string;
}): boolean {
  return !isAssistantsEndpoint(input.endpoint) && input.toolResource === EToolResources.context;
}

/** Whether a context upload has a downstream STT step that can inspect its transcript. */
export function canInspectUploadTranscriptAfterProcessing(input: {
  readonly endpoint?: string;
  readonly toolResource?: string;
  readonly mimeType?: string;
  readonly sttSupported: boolean;
}): boolean {
  return (
    getTranscriptApplicability(input.mimeType) === true &&
    input.sttSupported &&
    isAgentContextUpload(input)
  );
}

/** Resolves upload-time transcript fail-close after accounting for downstream STT. */
export function getBlockedUploadTranscriptField(input: {
  readonly filters?: FiltersConfig;
  readonly endpoint?: string;
  readonly toolResource?: string;
  readonly mimeType?: string;
  readonly sttSupported: boolean;
}): FileFilterField | null {
  if (!hasActiveFileFieldPolicy(input.filters, ['transcript'])) {
    return null;
  }
  const transcriptApplicable = getTranscriptApplicability(input.mimeType);
  if (transcriptApplicable === false) {
    return null;
  }
  if (transcriptApplicable === true && input.sttSupported && isAgentContextUpload(input)) {
    return null;
  }
  return getBlockedUninspectableFileField(input.filters, ['transcript']);
}

export const UPLOAD_EXTRACTED_TEXT_PLANS = {
  configuredOCR: 'configured_ocr',
  configuredRAG: 'configured_rag',
  documentParser: 'document_parser',
} as const;

export type UploadExtractedTextPlan =
  (typeof UPLOAD_EXTRACTED_TEXT_PLANS)[keyof typeof UPLOAD_EXTRACTED_TEXT_PLANS];

interface UploadExtractedTextPlanInput {
  readonly endpoint?: string;
  readonly toolResource?: string;
  readonly mimeType: string;
  readonly fileConfig: FileConfig;
  readonly ocrConfigured: boolean;
  readonly ragConfigured: boolean;
}

/**
 * Selects only extraction paths that produce meaningful derived text without
 * falling back to decoding arbitrary binary bytes as UTF-8.
 */
export function getUploadExtractedTextPlan(
  input: UploadExtractedTextPlanInput,
): UploadExtractedTextPlan | null {
  if (!isAgentContextUpload(input)) {
    return null;
  }
  const checkType = input.fileConfig.checkType;
  if (
    checkType != null &&
    input.ocrConfigured &&
    checkType(input.mimeType, input.fileConfig.ocr?.supportedMimeTypes ?? [])
  ) {
    return UPLOAD_EXTRACTED_TEXT_PLANS.configuredOCR;
  }
  /* Ahead of the parser gate: an explicitly narrowed text list names types the built-in
   * parser does not handle, and processing sends those to RAG with native fallback off
   * and inspects what comes back. Judging them by the parser's list alone would
   * fail-close an upload that does have an extraction step. */
  if (
    checkType != null &&
    input.ragConfigured &&
    !isPermissiveMimeConfig(input.fileConfig.text?.supportedMimeTypes) &&
    checkType(input.mimeType, input.fileConfig.text?.supportedMimeTypes ?? [])
  ) {
    return UPLOAD_EXTRACTED_TEXT_PLANS.configuredRAG;
  }
  const isDocumentParserEligible = documentParserMimeTypes.some((mimePattern) =>
    mimePattern.test(input.mimeType),
  );
  if (!isDocumentParserEligible) {
    return null;
  }
  return UPLOAD_EXTRACTED_TEXT_PLANS.documentParser;
}

/** Whether a context upload has a downstream extraction step that can inspect derived text. */
export function canInspectUploadExtractedTextAfterProcessing(
  input: UploadExtractedTextPlanInput,
): boolean {
  return getUploadExtractedTextPlan(input) != null;
}

/**
 * Skill bundle text cannot be safely skipped when the skill policy selects
 * `file_text`, even if the independent file policy is absent or explicitly in
 * compatibility mode. The returned file field preserves the existing
 * uninspectable response contract used by file upload and runtime paths.
 */
export function getBlockedUninspectableSkillFileField(
  filters: FiltersConfig | undefined,
  fileFields: readonly FileFilterField[] = ['content', 'extracted_text'],
): FileFilterField | null {
  const blockedFileField = getBlockedUninspectableFileField(filters, fileFields);
  if (blockedFileField != null) {
    return blockedFileField;
  }
  const skillPii = filters?.skills?.pii;
  if (
    hasActivePiiPatterns(skillPii) &&
    skillPii?.action !== 'audit' &&
    (skillPii?.fields == null || skillPii.fields.includes('file_text'))
  ) {
    return 'content';
  }
  return null;
}

export function contentFilterUninspectableResponse(
  field: FileFilterField,
): UninspectableFileBlockResponse {
  return {
    error: 'content_filter_uninspectable',
    message: 'Submitted file content could not be inspected before processing.',
    source: 'file',
    field,
  };
}

export class UninspectableFileError extends Error {
  public readonly code = 'content_filter_uninspectable';
  public readonly statusCode = 400;
  public readonly body: UninspectableFileBlockResponse;

  constructor(field: FileFilterField) {
    const body = contentFilterUninspectableResponse(field);
    super(body.message);
    this.name = 'UninspectableFileError';
    this.body = body;
    Object.setPrototypeOf(this, UninspectableFileError.prototype);
  }
}

export class ContentFilterInputTooLargeError extends Error {
  public readonly code = 'content_filter_input_too_large';
  public readonly statusCode = 413;
  public readonly body: ContentFilterInputTooLargeResponse;

  constructor(field: ContentFilterInputTooLargeResponse['field']) {
    const body: ContentFilterInputTooLargeResponse = {
      error: 'content_filter_input_too_large',
      message: 'Text file exceeds the 15 MB content inspection limit.',
      source: 'file',
      field,
    };
    super(body.message);
    this.name = 'ContentFilterInputTooLargeError';
    this.body = body;
    Object.setPrototypeOf(this, ContentFilterInputTooLargeError.prototype);
  }
}

function hasSubmittedPayload(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.length > 0;
  }
  if (value == null || typeof value !== 'object') {
    return false;
  }
  try {
    if (Array.isArray(value) && captureOpaqueArrayLength(value) > 0) {
      return true;
    }
  } catch {
    return true;
  }
  const boundedEntries = getBoundedOwnEnumerableEntries(value, 32);
  return (
    !boundedEntries.complete ||
    boundedEntries.entries.some(
      ([key, entryValue]) =>
        ['data', 'file_data', 'filedata', 'file_id', 'file_uri', 'fileuri', 'uri', 'url'].includes(
          key.toLowerCase(),
        ) &&
        typeof entryValue === 'string' &&
        entryValue.length > 0,
    )
  );
}

function getObjectType(entries: readonly [string, unknown][]): string {
  const type = entries.find(([key]) => key.toLowerCase() === 'type')?.[1];
  return typeof type === 'string' ? type.toLowerCase() : '';
}

function getObjectMimeType(entries: readonly [string, unknown][]): string {
  const explicitMimeType = entries.find(
    ([key]) => key.toLowerCase() === 'mimetype' || key.toLowerCase() === 'mime_type',
  )?.[1];
  const mimeType =
    explicitMimeType ??
    entries.find(
      ([key, entryValue]) =>
        key.toLowerCase() === 'type' && typeof entryValue === 'string' && entryValue.includes('/'),
    )?.[1];
  return typeof mimeType === 'string' ? mimeType.split(';', 1)[0].trim().toLowerCase() : '';
}

function getMediaFields(parentType: string, parentMimeType: string): readonly FileFilterField[] {
  if (parentType.includes('audio') || parentMimeType.startsWith('audio/')) {
    return AUDIO_FIELDS;
  }
  if (
    parentType.includes('image') ||
    parentType.includes('video') ||
    parentMimeType.startsWith('image/') ||
    parentMimeType.startsWith('video/')
  ) {
    return CONTENT_FIELDS;
  }
  return DERIVED_FILE_FIELDS;
}

function hasBoundedNonEmptyString(values: readonly unknown[]): boolean {
  try {
    const valueLength = captureOpaqueArrayLength(values);
    const inspectedLength = Math.min(valueLength, MAX_OPAQUE_NODES);
    for (let index = 0; index < inspectedLength; index++) {
      const value = values[index];
      if (typeof value === 'string' && value.length > 0) {
        return true;
      }
    }
    return inspectedLength < valueLength;
  } catch {
    return true;
  }
}

function isRemoteUri(value: string): boolean {
  return /^https?:\/\//i.test(value.trimStart());
}

function getDataUriFields(value: string): readonly FileFilterField[] {
  return value.trimStart().slice(5).toLowerCase().startsWith('audio/')
    ? AUDIO_FIELDS
    : CONTENT_FIELDS;
}

function getOpaqueFields(
  key: string,
  value: unknown,
  path: string,
  parentType: string,
  parentMimeType: string,
): readonly FileFilterField[] | null {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === 'file_ids' || normalizedKey === 'vector_store_ids') {
    try {
      if (Array.isArray(value) && hasBoundedNonEmptyString(value)) {
        return DERIVED_FILE_FIELDS;
      }
    } catch {
      return DERIVED_FILE_FIELDS;
    }
  }
  if (normalizedKey === 'file_id' && typeof value === 'string' && value.length > 0) {
    const pathLower = path.toLowerCase();
    if (
      parentType.includes('image') ||
      parentType.includes('video') ||
      pathLower.includes('/image_file/')
    ) {
      return CONTENT_FIELDS;
    }
    if (parentType.includes('audio')) {
      return AUDIO_FIELDS;
    }
    return DERIVED_FILE_FIELDS;
  }
  if (
    (normalizedKey === 'file_data' || normalizedKey === 'filedata') &&
    hasSubmittedPayload(value)
  ) {
    try {
      if (value != null && typeof value === 'object' && !Array.isArray(value)) {
        const payloadEntries = getBoundedOwnEnumerableEntries(value, 32);
        if (payloadEntries.complete) {
          return getMediaFields(
            getObjectType(payloadEntries.entries),
            getObjectMimeType(payloadEntries.entries),
          );
        }
      }
    } catch {
      return DERIVED_FILE_FIELDS;
    }
    return DERIVED_FILE_FIELDS;
  }
  if (normalizedKey === 'document_url' && hasSubmittedPayload(value)) {
    return DERIVED_FILE_FIELDS;
  }
  if (normalizedKey === 'input_audio' && hasSubmittedPayload(value)) {
    return AUDIO_FIELDS;
  }
  if (
    (normalizedKey === 'image_url' || normalizedKey === 'video_url') &&
    hasSubmittedPayload(value)
  ) {
    return CONTENT_FIELDS;
  }
  if (normalizedKey === 'audio_url' && hasSubmittedPayload(value)) {
    return AUDIO_FIELDS;
  }
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  if (isDataUri(value)) {
    return getDataUriFields(value);
  }

  const pathLower = path.toLowerCase();
  if (normalizedKey === 'data') {
    if (parentType === 'media') {
      return getMediaFields(parentType, parentMimeType);
    }
    if (parentType.includes('audio') || pathLower.includes('/input_audio/')) {
      return AUDIO_FIELDS;
    }
    if (
      parentType.includes('base64') ||
      parentType.includes('document') ||
      parentType.includes('file')
    ) {
      return DERIVED_FILE_FIELDS;
    }
    if (
      parentType.includes('image') ||
      parentType.includes('video') ||
      pathLower.includes('/image_url/') ||
      pathLower.includes('/video_url/')
    ) {
      return CONTENT_FIELDS;
    }
    if (isLikelyEncodedPayload(value, key, { type: parentType })) {
      return DERIVED_FILE_FIELDS;
    }
  }
  if (
    normalizedKey === 'fileuri' ||
    normalizedKey === 'file_uri' ||
    normalizedKey === 'document_url'
  ) {
    return getMediaFields(parentType, parentMimeType);
  }
  if (
    (normalizedKey === 'uri' || normalizedKey === 'filepath' || normalizedKey === 'preview') &&
    (isRemoteUri(value) ||
      pathLower.includes('/attachments/') ||
      pathLower.includes('/files/') ||
      pathLower.includes('/image_file/'))
  ) {
    if (pathLower.includes('/image_file/')) {
      return CONTENT_FIELDS;
    }
    return DERIVED_FILE_FIELDS;
  }
  if (
    normalizedKey === 'url' &&
    (isRemoteUri(value) ||
      pathLower.includes('/attachments/') ||
      pathLower.includes('/files/') ||
      pathLower.includes('/image_file/'))
  ) {
    if (parentType.includes('audio') || pathLower.includes('/audio_url/')) {
      return AUDIO_FIELDS;
    }
    if (
      parentType.includes('image') ||
      parentType.includes('video') ||
      parentType === 'url' ||
      pathLower.includes('/image_url/') ||
      pathLower.includes('/video_url/')
    ) {
      return parentType === 'url' ? DERIVED_FILE_FIELDS : CONTENT_FIELDS;
    }
    if (
      parentType.includes('file') ||
      parentType.includes('document') ||
      pathLower.includes('/attachments/') ||
      pathLower.includes('/files/')
    ) {
      return DERIVED_FILE_FIELDS;
    }
  }
  return null;
}

/**
 * Live runtime rows can carry extraction results that have not reached the
 * durable file record yet. They may supplement an owner-resolved row, but
 * never define its identity or canonical locators.
 */
function mergeOwnerResolvedFileMetadata(
  resolvedFile: CanonicalFileInspectionFile,
  liveFile: CanonicalFileInspectionFile,
): CanonicalFileInspectionFile {
  return {
    ...resolvedFile,
    ...(Object.prototype.hasOwnProperty.call(liveFile, 'content') && {
      content: liveFile.content,
    }),
    ...(Object.prototype.hasOwnProperty.call(liveFile, 'extractedText') && {
      extractedText: liveFile.extractedText,
    }),
    ...(Object.prototype.hasOwnProperty.call(liveFile, 'text') && {
      text: liveFile.text,
    }),
    ...(Object.prototype.hasOwnProperty.call(liveFile, 'transcript') && {
      transcript: liveFile.transcript,
    }),
  };
}

/**
 * Returns the first configured file field whose submitted content is opaque.
 * Detection is skipped unless fail-close is enabled.
 */
export function getBlockedOpaqueFileField(
  filters: FiltersConfig | undefined,
  input: unknown,
): FileFilterField | null {
  if (getFilePii(filters)?.uninspectable !== 'block') {
    return null;
  }

  const pending: PendingOpaqueValue[] = [{ value: input, path: '', depth: 0 }];
  const seen = new WeakSet<object>();
  let visitedNodes = 0;
  let traversalTruncated = false;

  while (pending.length > 0 && visitedNodes < MAX_OPAQUE_NODES) {
    const current = pending.pop();
    if (current == null) {
      continue;
    }
    if (current.depth > MAX_OPAQUE_DEPTH) {
      traversalTruncated = true;
      continue;
    }
    visitedNodes++;

    if (typeof current.value === 'string') {
      if (isDataUri(current.value)) {
        const blockedField = getBlockedUninspectableFileField(
          filters,
          getDataUriFields(current.value),
        );
        if (blockedField != null) {
          return blockedField;
        }
      }
      continue;
    }
    if (current.value == null || typeof current.value !== 'object') {
      continue;
    }
    if (seen.has(current.value)) {
      continue;
    }
    seen.add(current.value);

    let currentIsArray: boolean;
    try {
      currentIsArray = Array.isArray(current.value);
    } catch {
      traversalTruncated = true;
      continue;
    }
    if (currentIsArray) {
      const arrayValue = current.value as readonly unknown[];
      let arrayLength: number;
      try {
        arrayLength = captureOpaqueArrayLength(arrayValue);
      } catch {
        traversalTruncated = true;
        continue;
      }
      if (current.depth >= MAX_OPAQUE_DEPTH && arrayLength > 0) {
        traversalTruncated = true;
        continue;
      }
      const availableNodes = Math.max(0, MAX_OPAQUE_NODES - visitedNodes - pending.length);
      const scheduledNodes = Math.min(arrayLength, availableNodes);
      if (scheduledNodes < arrayLength) {
        traversalTruncated = true;
      }
      try {
        for (let index = scheduledNodes - 1; index >= 0; index--) {
          pending.push({
            value: arrayValue[index],
            path: `${current.path}/${index}`,
            depth: current.depth + 1,
          });
        }
      } catch {
        traversalTruncated = true;
      }
      continue;
    }

    const availableNodes = Math.max(0, MAX_OPAQUE_NODES - visitedNodes - pending.length);
    const boundedEntries = getBoundedOwnEnumerableEntries(current.value, availableNodes);
    const entries = boundedEntries.entries;
    if (!boundedEntries.complete) {
      traversalTruncated = true;
    }
    if (current.depth >= MAX_OPAQUE_DEPTH && entries.length > 0) {
      traversalTruncated = true;
      continue;
    }
    const parentType = getObjectType(entries);
    const parentMimeType = getObjectMimeType(entries);
    for (let index = entries.length - 1; index >= 0; index--) {
      const [key, value] = entries[index];
      const path = `${current.path}/${escapeJsonPointer(key)}`;
      const fields = getOpaqueFields(key, value, path, parentType, parentMimeType);
      if (fields != null) {
        const blockedField = getBlockedUninspectableFileField(filters, fields);
        if (blockedField != null) {
          return blockedField;
        }
      }
      pending.push({ value, path, depth: current.depth + 1 });
    }
  }

  if (pending.length > 0 || traversalTruncated) {
    return getBlockedUninspectableFileField(filters, DERIVED_FILE_FIELDS);
  }
  return null;
}

interface CanonicalReferenceTraversal {
  readonly fileIds: Set<string>;
  readonly incomplete: boolean;
  readonly fileRelevantIncomplete: boolean;
}

function isLikelyFileReferenceContainer(key: string): boolean {
  return /(?:file|attach|document|audio|image|video|media|resource)/i.test(key);
}

function getCanonicalFileReferenceIds(input: unknown): CanonicalReferenceTraversal {
  if (input == null || typeof input !== 'object') {
    return { fileIds: new Set(), incomplete: false, fileRelevantIncomplete: false };
  }

  const fileIds = new Set<string>();
  const pending: Array<{ value: object; depth: number; fileRelevant: boolean }> = [
    { value: input, depth: 0, fileRelevant: false },
  ];
  const seen = new WeakSet<object>();
  let visited = 0;
  let incomplete = false;
  let fileRelevantIncomplete = false;
  const markIncomplete = (fileRelevant: boolean): void => {
    incomplete = true;
    if (fileRelevant) {
      fileRelevantIncomplete = true;
    }
  };

  while (pending.length > 0 && visited < MAX_OPAQUE_NODES) {
    const current = pending.pop();
    if (current == null || seen.has(current.value)) {
      continue;
    }
    if (current.depth > MAX_OPAQUE_DEPTH) {
      markIncomplete(current.fileRelevant);
      continue;
    }
    seen.add(current.value);
    visited++;

    const availableNodes = Math.max(0, MAX_OPAQUE_NODES - visited - pending.length);
    const boundedEntries = getBoundedOwnEnumerableEntries(current.value, availableNodes);
    const entries = boundedEntries.entries;
    if (!boundedEntries.complete) {
      markIncomplete(current.fileRelevant || current.depth === 0);
    }

    const ordinaryChildren: object[] = [];
    const fileChildren: object[] = [];
    for (const [key, value] of entries) {
      if (key === 'file_id' && typeof value === 'string' && value.length > 0) {
        if (fileIds.size < MAX_OPAQUE_NODES || fileIds.has(value)) {
          fileIds.add(value);
        } else {
          markIncomplete(true);
        }
      } else if (key === 'file_ids') {
        let valueIsArray: boolean;
        try {
          valueIsArray = Array.isArray(value);
        } catch {
          markIncomplete(true);
          continue;
        }
        if (valueIsArray) {
          const fileIdValues = value as readonly unknown[];
          let fileIdCount: number;
          try {
            fileIdCount = captureOpaqueArrayLength(fileIdValues);
          } catch {
            markIncomplete(true);
            continue;
          }
          const remainingIds = Math.max(0, MAX_OPAQUE_NODES - fileIds.size);
          const inspectedIdCount = Math.min(fileIdCount, remainingIds + 1);
          for (let index = 0; index < inspectedIdCount; index++) {
            let fileId: unknown;
            try {
              fileId = fileIdValues[index];
            } catch {
              markIncomplete(true);
              break;
            }
            if (typeof fileId === 'string' && fileId.length > 0) {
              if (fileIds.size < MAX_OPAQUE_NODES || fileIds.has(fileId)) {
                fileIds.add(fileId);
              } else {
                markIncomplete(true);
                break;
              }
            }
          }
          if (inspectedIdCount < fileIdCount) {
            markIncomplete(true);
          }
          continue;
        }
      }
      if (value != null && typeof value === 'object') {
        (current.fileRelevant || isLikelyFileReferenceContainer(key)
          ? fileChildren
          : ordinaryChildren
        ).push(value);
      }
    }
    for (const value of ordinaryChildren) {
      pending.push({ value, depth: current.depth + 1, fileRelevant: false });
    }
    for (const value of fileChildren) {
      pending.push({ value, depth: current.depth + 1, fileRelevant: true });
    }
  }

  const pendingFileReference = pending.some(({ fileRelevant }) => fileRelevant);
  return {
    fileIds,
    incomplete: incomplete || pending.length > 0,
    fileRelevantIncomplete: fileRelevantIncomplete || pendingFileReference,
  };
}

function getActivePatternFileField(filters: FiltersConfig | undefined): FileFilterField | null {
  const pii = getFilePii(filters);
  if (!hasActivePiiPatterns(pii) || pii?.action === 'audit') {
    return null;
  }
  return pii?.fields?.[0] ?? (pii?.fields == null ? FILE_FILTER_FIELDS[0] : null);
}

function getRequiredOpaqueFileField(
  filters: FiltersConfig | undefined,
): 'content' | 'extracted_text' | 'transcript' | null {
  const pii = getFilePii(filters);
  if (pii?.uninspectable !== 'block') {
    return null;
  }
  return (
    (['content', 'extracted_text', 'transcript'] as const).find(
      (field) => pii.fields == null || pii.fields.includes(field),
    ) ?? null
  );
}

function getNormalizedMimeType(file: CanonicalFileInspectionFile): string {
  return normalizeMimeType(file.type);
}

function getNonBlankInspectionText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function getCanonicalFileInspectionCoverage(
  file: CanonicalFileInspectionFile,
): CanonicalFileInspectionCoverage {
  const mimeType = getNormalizedMimeType(file);
  const transcriptApplicable = getNormalizedTranscriptApplicability(mimeType);
  const isAudio = transcriptApplicable === true;
  const isTextual = mimeType.startsWith('text/') || TEXTUAL_APPLICATION_MIME_TYPES.has(mimeType);
  const hasExtractedTextProvenance =
    (typeof file.source === 'string' && file.source.toLowerCase() === 'text') ||
    file.llmDeliveryPath === 'text';
  const text = getNonBlankInspectionText(file.text);
  const content = typeof file.content === 'string' ? file.content : undefined;
  const extractedText = getNonBlankInspectionText(file.extractedText);
  const transcript = getNonBlankInspectionText(file.transcript);
  const transcriptFallback = hasExtractedTextProvenance && isAudio ? text : undefined;

  return {
    content: content ?? (hasExtractedTextProvenance && isTextual ? text : undefined),
    extractedText: extractedText ?? text,
    transcript: transcript ?? transcriptFallback,
    textProvidesTranscript: transcript == null && transcriptFallback != null,
    transcriptApplicable,
  };
}

function getMissingInspectableFileField(
  filters: FiltersConfig | undefined,
  file: CanonicalFileInspectionFile,
): 'content' | 'extracted_text' | 'transcript' | null {
  const pii = getFilePii(filters);
  if (pii?.uninspectable !== 'block') {
    return null;
  }
  const coverage = getCanonicalFileInspectionCoverage(file);
  const enabled = (field: FileFilterField) => pii.fields == null || pii.fields.includes(field);
  if (enabled('content') && coverage.content == null) {
    return 'content';
  }
  if (enabled('extracted_text') && coverage.extractedText == null) {
    return 'extracted_text';
  }
  if (
    enabled('transcript') &&
    coverage.transcriptApplicable !== false &&
    coverage.transcript == null
  ) {
    return 'transcript';
  }
  return null;
}

export function assertHydratedFileInspectable(
  filters: FiltersConfig | undefined,
  file: CanonicalFileInspectionFile,
): void {
  const missingField = getMissingInspectableFileField(filters, file);
  if (missingField != null) {
    throw new UninspectableFileError(missingField);
  }
}

function omitResolvedFileLocators(
  value: unknown,
  resolvedFilesById: ReadonlyMap<string, CanonicalFileInspectionFile>,
  depth = 0,
  state?: {
    readonly seen: WeakMap<object, unknown>;
    visited: number;
  },
): unknown {
  if (value == null || typeof value !== 'object') {
    return value;
  }
  const traversal = state ?? { seen: new WeakMap<object, unknown>(), visited: 0 };
  const fail = (reason: ContentTraversalLimitReason): ContentTraversalLimitError =>
    new ContentTraversalLimitError([], [], {
      operation: 'omit_resolved_file_locators',
      reason,
      visitedNodes: traversal.visited,
      depth,
    });
  try {
    if (depth > MAX_OPAQUE_DEPTH) {
      throw fail('max_depth');
    }
    if (traversal.visited >= MAX_OPAQUE_NODES) {
      throw fail('max_nodes');
    }
    const seenValue = traversal.seen.get(value);
    if (seenValue !== undefined) {
      return seenValue;
    }
    traversal.visited++;

    const valueIsArray = Array.isArray(value);
    if (valueIsArray) {
      const arrayValue = value as readonly unknown[];
      const arrayLength = captureOpaqueArrayLength(arrayValue);
      const remainingNodes = MAX_OPAQUE_NODES - traversal.visited;
      if (arrayLength > remainingNodes) {
        throw fail('array_length');
      }
      const cloned: unknown[] = [];
      traversal.seen.set(value, cloned);
      for (let index = 0; index < arrayLength; index++) {
        cloned.push(
          omitResolvedFileLocators(arrayValue[index], resolvedFilesById, depth + 1, traversal),
        );
      }
      return cloned;
    }

    const remainingNodes = MAX_OPAQUE_NODES - traversal.visited;
    const boundedEntries = getBoundedOwnEnumerableEntries(value, remainingNodes);
    if (!boundedEntries.complete) {
      throw fail(boundedEntries.reason ?? 'object_entries');
    }
    const entries = boundedEntries.entries;

    const cloned = Object.create(null) as MutableUnknownDictionary;
    traversal.seen.set(value, cloned);
    const fileId = entries.find(([key]) => key === 'file_id')?.[1];
    const resolvedFile = typeof fileId === 'string' ? resolvedFilesById.get(fileId) : undefined;
    const matchesResolvedLocator = (locator: unknown): boolean => {
      if (typeof locator !== 'string' || resolvedFile == null) {
        return false;
      }
      return (
        resolvedFile.filepath === locator ||
        resolvedFile.uri === locator ||
        resolvedFile.url === locator ||
        resolvedFile.preview === locator
      );
    };

    for (const [key, child] of entries) {
      if (resolvedFile != null && key === 'file_id') {
        continue;
      }
      if (
        resolvedFile != null &&
        (key === 'uri' || key === 'url' || key === 'filepath' || key === 'preview') &&
        matchesResolvedLocator(child)
      ) {
        continue;
      }
      const childIsArray = Array.isArray(child);
      if (key === 'file_ids' && childIsArray) {
        const childFileIds = child as readonly unknown[];
        const childFileIdCount = captureOpaqueArrayLength(childFileIds);
        if (childFileIdCount > MAX_OPAQUE_NODES - traversal.visited) {
          throw fail('array_length');
        }
        const unresolvedFileIds: unknown[] = [];
        for (let index = 0; index < childFileIdCount; index++) {
          const childFileId = childFileIds[index];
          if (typeof childFileId !== 'string' || !resolvedFilesById.has(childFileId)) {
            unresolvedFileIds.push(childFileId);
          }
        }
        if (unresolvedFileIds.length > 0) {
          cloned[key] = unresolvedFileIds;
        }
        continue;
      }
      cloned[key] = omitResolvedFileLocators(child, resolvedFilesById, depth + 1, traversal);
    }
    return cloned;
  } catch (error) {
    if (error instanceof ContentTraversalLimitError && error.diagnostics != null) {
      throw error;
    }
    throw fail(error instanceof ContentTraversalLimitError ? 'array_length' : 'reflection_error');
  }
}

export function omitResolvedCanonicalFileLocators<T>(
  input: T,
  resolvedFilesById: ReadonlyMap<string, CanonicalFileInspectionFile>,
  context: {
    readonly messageCount?: number;
    readonly onTraversalFailure?: LocatorTraversalReporter;
  } = {},
): T {
  if (resolvedFilesById.size === 0) {
    return input;
  }
  try {
    return omitResolvedFileLocators(input, resolvedFilesById) as T;
  } catch (error) {
    if (error instanceof ContentTraversalLimitError && error.diagnostics != null) {
      context.onTraversalFailure?.({
        ...error.diagnostics,
        messageCount: context.messageCount ?? 0,
        resolvedFileCount: resolvedFilesById.size,
      });
    }
    throw error;
  }
}

export function allowHydratedFileReferences(
  filters: FiltersConfig | undefined,
): FiltersConfig | undefined {
  if (getFilePii(filters)?.uninspectable !== 'block') {
    return filters;
  }
  return {
    ...filters,
    files: {
      ...filters?.files,
      pii: {
        ...filters?.files?.pii,
        uninspectable: 'allow',
      },
    },
  };
}

/**
 * Resolves durable LibreChat file references against the authenticated owner
 * before fail-close checks run. Only locators backed by an owner-scoped file
 * row are removed from the inspection copy; unresolved IDs and unrelated
 * opaque payloads remain visible to `getBlockedOpaqueFileField`.
 */
export async function resolveCanonicalFileReferences<T>(
  input: CanonicalFileReferenceInspectionInput<T>,
): Promise<CanonicalFileReferenceInspection<T>> {
  return resolveCanonicalReferences(
    input,
    () => getCanonicalFileReferenceIds(input.input),
    (files) => omitResolvedCanonicalFileLocators(input.input, files, input),
  );
}

/** Shares one owner-scoped lookup across independently bounded inspection units. */
export async function resolveCanonicalFileReferenceUnits<T>(
  input: CanonicalFileReferenceInspectionInput<readonly T[]>,
): Promise<CanonicalFileReferenceInspection<readonly T[]>> {
  const messages = input.input;
  const context = { ...input, messageCount: 0 };
  let messageCount = 0;
  return resolveCanonicalReferences(
    context,
    () => {
      messageCount = captureOpaqueArrayLength(messages);
      context.messageCount = input.messageCount ?? messageCount;
      const fileIds = new Set<string>();
      let incomplete = false;
      let fileRelevantIncomplete = false;
      for (let index = 0; index < messageCount; index++) {
        const references = getCanonicalFileReferenceIds(messages[index]);
        incomplete ||= references.incomplete;
        fileRelevantIncomplete ||= references.fileRelevantIncomplete;
        for (const fileId of references.fileIds) {
          if (fileIds.size >= MAX_OPAQUE_NODES && !fileIds.has(fileId)) {
            throw new ContentTraversalLimitError();
          }
          fileIds.add(fileId);
        }
      }
      return { fileIds, incomplete, fileRelevantIncomplete };
    },
    (files) => {
      const sanitized: T[] = [];
      for (let index = 0; index < messageCount; index++) {
        sanitized.push(omitResolvedCanonicalFileLocators(messages[index], files, context));
      }
      return sanitized;
    },
  );
}

async function resolveCanonicalReferences<T>(
  input: CanonicalFileReferenceInspectionInput<T>,
  collectReferences: () => CanonicalReferenceTraversal,
  sanitize: (files: ReadonlyMap<string, CanonicalFileInspectionFile>) => T,
): Promise<CanonicalFileReferenceInspection<T>> {
  const filters = input.filters;
  if (!hasActiveFilePolicy(filters)) {
    return {
      sanitizedInput: input.input,
      hydratedFiles: [],
      hydratedFilters: filters,
    };
  }

  const trustedLiveFiles = snapshotCanonicalFiles(input.trustedLiveFiles);

  const references = collectReferences();
  if (references.incomplete) {
    const blockedField = getRequiredOpaqueFileField(filters);
    if (blockedField != null) {
      throw new UninspectableFileError(blockedField);
    }
  }
  if (references.fileRelevantIncomplete) {
    const patternField = getActivePatternFileField(filters);
    if (patternField != null) {
      throw new UninspectableFileError(patternField);
    }
  }

  const currentById = new Map<string, CanonicalFileInspectionFile>();
  const ownerId = input.user?.id;
  if (references.fileIds.size > 0 && ownerId) {
    const filter = {
      file_id: { $in: [...references.fileIds] },
      user: ownerId,
      ...(input.user?.tenantId != null && { tenantId: input.user.tenantId }),
    };
    try {
      const currentFiles = snapshotCanonicalFiles(await input.getFiles(filter, {}, {}));
      for (let index = 0; index < currentFiles.length; index++) {
        const file = currentFiles[index];
        if (
          typeof file?.file_id === 'string' &&
          file.file_id.length > 0 &&
          references.fileIds.has(file.file_id)
        ) {
          currentById.set(file.file_id, file);
        }
      }
    } catch {
      // An unavailable lookup is indistinguishable from an unresolved opaque
      // reference under fail-close. Compatibility mode leaves it unresolved.
    }
  }

  for (let index = 0; index < trustedLiveFiles.length; index++) {
    const file = trustedLiveFiles[index];
    if (typeof file?.file_id !== 'string' || file.file_id.length === 0) {
      continue;
    }
    const resolvedFile = currentById.get(file.file_id);
    if (resolvedFile != null) {
      currentById.set(file.file_id, mergeOwnerResolvedFileMetadata(resolvedFile, file));
    }
  }

  const requiredOpaqueField = getRequiredOpaqueFileField(filters);
  if (requiredOpaqueField != null) {
    for (const fileId of references.fileIds) {
      if (!currentById.has(fileId)) {
        throw new UninspectableFileError(requiredOpaqueField);
      }
    }
  }

  const unassociatedLiveFiles = trustedLiveFiles.filter(
    (file): file is CanonicalFileInspectionFile =>
      file != null && (typeof file.file_id !== 'string' || file.file_id.length === 0),
  );
  const hydratedFiles: CanonicalFileInspectionFile[] = [
    ...currentById.values(),
    ...unassociatedLiveFiles,
  ];
  for (const file of hydratedFiles) {
    assertHydratedFileInspectable(filters, file);
  }

  let sanitizedInput = input.input;
  if (currentById.size > 0) {
    try {
      sanitizedInput = sanitize(currentById);
    } catch (error) {
      if (!(error instanceof ContentTraversalLimitError)) {
        throw error;
      }
      /**
       * Canonical hydration is supplemental for pattern-only name/URI policy.
       * If an unrelated oversized subtree prevents cloning the whole request,
       * keep the original projection and inspect the owner-resolved rows
       * separately. Derived-content fail-close was handled above.
       */
    }
  }

  return {
    sanitizedInput,
    hydratedFiles,
    hydratedFilters: allowHydratedFileReferences(filters),
  };
}
