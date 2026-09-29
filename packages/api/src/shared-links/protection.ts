import { TextDecoder } from 'node:util';
import {
  hasActivePiiPatterns,
  type FileFilterField,
  type FiltersConfig,
  type MessageFilterPiiConfig,
  type UserSubmittedMessageFieldPath,
} from 'librechat-data-provider';
import type {
  CanonicalFileInspectionUser,
  GetCanonicalFilesForInspection,
} from '../protection/files';
import type { JsonPointer, TextContentFragment } from '../protection/types';
import type { FileContentInput } from '../protection/adapters/submissions';
import type { LocatorTraversalReporter } from '../protection/diagnostics';
import type { ConversationImportMessage } from '../imports';
import {
  CONTENT_TRAVERSAL_MAX_DEPTH,
  CONTENT_TRAVERSAL_MAX_NODES,
  ContentTraversalLimitError,
  escapeJsonPointer,
  getBoundedOwnEnumerableEntries,
  isDataUri,
  isLikelyEncodedPayload,
  isContentTraversalProtected,
} from '../protection/adapters/nested';
import {
  getBlockedUninspectableFileField,
  hasActiveFilePolicy,
  UninspectableFileError,
} from '../protection/files';
import {
  extractFileContent,
  extractStoredMessageContent,
} from '../protection/adapters/submissions';
import { assertModelBoundContent } from '../middleware/modelBoundContent';
import { getUserSubmittedPathState } from '../protection/provenance';
import { assertConversationImportContentAllowed } from '../imports';
import { ContentFilterError } from '../middleware/contentFilter';
import { aggregateAuditFindings } from '../protection/audit';
import { inspectContent } from '../protection/runtime';

export interface SerializedSharedFile extends FileContentInput {
  readonly preview?: string;
  readonly [key: string]: unknown;
}

interface SerializedSharedMessagePart {
  readonly type?: string;
  readonly audio_url?: string | SerializedSharedFile | null;
  readonly data?: unknown;
  readonly document?: Readonly<Record<string, unknown>> | null;
  readonly document_url?: string | SerializedSharedFile | null;
  readonly file?: SerializedSharedFile | null;
  readonly fileData?: SerializedSharedFile | null;
  readonly file_data?: unknown;
  readonly file_id?: string;
  readonly fileUri?: string;
  readonly file_uri?: string;
  readonly filename?: string;
  readonly image_file?: SerializedSharedFile | null;
  readonly image_url?: string | SerializedSharedFile | null;
  readonly inlineData?: SerializedSharedFile | null;
  readonly input_audio?: SerializedSharedFile | null;
  readonly source?: string | Readonly<Record<string, unknown>> | null;
  readonly video_url?: string | SerializedSharedFile | null;
  readonly files?: readonly (SerializedSharedFile | null | undefined)[];
  readonly [key: string]: unknown;
}

export interface SerializedSharedMessage {
  readonly isCreatedByUser?: boolean;
  readonly isUserSubmitted?: boolean;
  readonly userSubmittedPaths?: readonly string[];
  readonly userSubmittedMessageFieldPaths?: readonly UserSubmittedMessageFieldPath[];
  readonly role?: string;
  readonly iconURL?: string;
  readonly finish_reason?: string;
  readonly manualSkills?: readonly (string | null | undefined)[];
  readonly alwaysAppliedSkills?: readonly (string | null | undefined)[];
  readonly files?: readonly (SerializedSharedFile | null | undefined)[];
  readonly attachments?: readonly (SerializedSharedFile | null | undefined)[];
  readonly content?: readonly (SerializedSharedMessagePart | null | undefined)[];
}

export interface SharedFileMetadataPolicyInput {
  readonly filters?: FiltersConfig;
  readonly messages: readonly SerializedSharedMessage[];
  readonly shareId?: string;
  /** Creation/update preflights use `false` because their file objects have
   * not yet been projected onto share-scoped locators; canonical file policy
   * is enforced separately on that exact durable snapshot. */
  readonly includeFiles?: boolean;
}

export type ShareContentPreflightMessage = ConversationImportMessage & SerializedSharedMessage;

export interface ShareContentPreflightInput {
  readonly title?: string;
  readonly messages: readonly ShareContentPreflightMessage[];
  readonly shareId?: string;
}

export interface ShareContentPreflightOptions {
  readonly onTraversalFailure?: LocatorTraversalReporter;
  readonly legacyPii?: MessageFilterPiiConfig | null;
  readonly snapshotFiles?: boolean;
  readonly user?: CanonicalFileInspectionUser;
  readonly getFiles?: GetCanonicalFilesForInspection;
  readonly sharedFileMetadata?: boolean;
  readonly sharedFileMetadataFiles?: boolean;
}

export type ShareContentPreflight = (input: ShareContentPreflightInput) => Promise<void>;

function omitUnsharedMessageFiles(
  messages: readonly ShareContentPreflightMessage[],
): ShareContentPreflightMessage[] {
  return messages.map(({ files: _files, attachments: _attachments, ...message }) => ({
    ...message,
    ...(Array.isArray(message.content)
      ? {
          content: message.content.map((part) => {
            if (part?.type !== 'steer' || part.files === undefined) {
              return part;
            }
            const { files: _partFiles, ...rest } = part;
            return rest;
          }),
        }
      : {}),
  }));
}

/** Builds the exact read/publish preflight shared by every shared-link route. */
export function createShareContentPreflight(
  filters: FiltersConfig | null | undefined,
  options: ShareContentPreflightOptions = {},
): ShareContentPreflight | undefined {
  const legacyPii = options.legacyPii ?? undefined;
  if (filters == null && legacyPii == null) {
    return undefined;
  }

  const inspectSharedContent = async ({
    title,
    messages,
    shareId,
  }: ShareContentPreflightInput): Promise<void> => {
    const inspectSharedFileMetadata = options.sharedFileMetadata === true;
    const inspectSharedFiles =
      inspectSharedFileMetadata && options.sharedFileMetadataFiles !== false;
    const omitFilesFromSnapshot = options.snapshotFiles === false || inspectSharedFiles;
    const omitFilesFromMetadata = options.snapshotFiles === false;
    const messagesWithoutUnsharedFiles = omitFilesFromSnapshot
      ? omitUnsharedMessageFiles(messages)
      : messages;
    const snapshotMessages = omitFilesFromSnapshot ? messagesWithoutUnsharedFiles : messages;

    await assertConversationImportContentAllowed(
      filters,
      { conversations: [{ title }], messages: snapshotMessages },
      {
        legacyPii,
        user: options.user,
        getFiles: options.getFiles,
        onTraversalFailure: options.onTraversalFailure,
      },
    );
    if (!inspectSharedFileMetadata) {
      return;
    }
    assertSharedFileMetadataAllowed({
      filters: filters ?? undefined,
      messages: omitFilesFromMetadata ? messagesWithoutUnsharedFiles : messages,
      shareId,
      ...(options.sharedFileMetadataFiles === false && { includeFiles: false }),
    });
  };

  return (input) => aggregateAuditFindings(() => inspectSharedContent(input));
}

const SERIALIZED_LOCATOR_KEYS = [
  'uri',
  'filepath',
  'url',
  'preview',
  'fileUri',
  'file_uri',
  'document_url',
] as const;
const URI_LIKE_KEYS = new Set([
  'filepath',
  'fileuri',
  'file_uri',
  'document_url',
  'href',
  'link',
  'preview',
  'uri',
  'url',
]);
const MAX_DECODED_TEXT_BYTES = 256 * 1024;
const MAX_BASE64_TEXT_CHARS = Math.ceil((MAX_DECODED_TEXT_BYTES * 4) / 3) + 4;
const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/;
const TEXTUAL_APPLICATION_MIME_TYPES = new Set([
  'application/graphql',
  'application/javascript',
  'application/json',
  'application/sql',
  'application/x-httpd-php',
  'application/x-javascript',
  'application/x-sh',
  'application/x-sql',
  'application/x-www-form-urlencoded',
  'application/x-yaml',
  'application/xml',
  'application/yaml',
]);
const ALL_DERIVED_FILE_FIELDS = [
  'content',
  'extracted_text',
  'transcript',
] as const satisfies readonly FileFilterField[];
const FILE_CONTENT_PART_TYPES = new Set([
  'audio',
  'audio_url',
  'document',
  'document_url',
  'file',
  'image',
  'image_file',
  'image_url',
  'input_audio',
  'input_file',
  'input_image',
  'input_video',
  'media',
  'video',
  'video_url',
]);
const FILE_CONTENT_PART_KEYS = [
  'audio_url',
  'document',
  'document_url',
  'file',
  'fileData',
  'file_data',
  'file_id',
  'fileUri',
  'file_uri',
  'image_file',
  'image_url',
  'inlineData',
  'input_audio',
  'video_url',
] as const;
const TOP_LEVEL_FILE_CONTENT_KEYS = [
  'bytes',
  'content',
  'data',
  'document_url',
  'extractedText',
  'file_data',
  'file_id',
  'fileUri',
  'file_uri',
  'filename',
  'filepath',
  'name',
  'originalname',
  'preview',
  'text',
  'transcript',
  'uri',
  'url',
] as const;
const TOP_LEVEL_FILE_CONTEXT_KEYS = [
  'format',
  'media_type',
  'mime_type',
  'mimeType',
  'type',
] as const;

type StandardSerializedScalarShape = 'date' | 'number' | 'string';

const STANDARD_SERIALIZED_FILE_SHAPES = new Map<string, StandardSerializedScalarShape>([
  ['agentId', 'string'],
  ['bytes', 'number'],
  ['content', 'string'],
  ['conversationId', 'string'],
  ['createdAt', 'date'],
  ['expiresAt', 'date'],
  ['extractedText', 'string'],
  ['document_url', 'string'],
  ['file_id', 'string'],
  ['fileUri', 'string'],
  ['file_uri', 'string'],
  ['filename', 'string'],
  ['filepath', 'string'],
  ['height', 'number'],
  ['id', 'string'],
  ['messageId', 'string'],
  ['name', 'string'],
  ['originalname', 'string'],
  ['preview', 'string'],
  ['previewError', 'string'],
  ['previewRevision', 'string'],
  ['source', 'string'],
  ['status', 'string'],
  ['text', 'string'],
  ['textFormat', 'string'],
  ['toolCallId', 'string'],
  ['tool_call_id', 'string'],
  ['transcript', 'string'],
  ['type', 'string'],
  ['updatedAt', 'date'],
  ['uri', 'string'],
  ['url', 'string'],
  ['width', 'number'],
]);

const FILE_FIELD_BY_STANDARD_KEY = new Map<string, FileFilterField>([
  ['content', 'content'],
  ['document_url', 'uri'],
  ['extractedText', 'extracted_text'],
  ['filename', 'name'],
  ['fileUri', 'uri'],
  ['file_uri', 'uri'],
  ['filepath', 'uri'],
  ['name', 'name'],
  ['originalname', 'name'],
  ['preview', 'uri'],
  ['text', 'extracted_text'],
  ['transcript', 'transcript'],
  ['uri', 'uri'],
  ['url', 'uri'],
]);
const MESSAGE_ATTACHMENT_STANDARD_KEYS = new Set([
  'file_id',
  'filename',
  'filepath',
  'id',
  'name',
  'originalname',
  'preview',
  'uri',
  'url',
]);

type SerializedFileLocation = 'attachment' | 'file';

interface CollectedSerializedFile {
  readonly file: SerializedSharedFile;
  readonly location: SerializedFileLocation;
  readonly path: JsonPointer;
  readonly userSubmitted: boolean;
}

function isSubmittedPath(path: string, submittedPaths: readonly string[]): boolean {
  return submittedPaths.some(
    (submittedPath) =>
      submittedPath === path ||
      path.startsWith(`${submittedPath}/`) ||
      submittedPath.startsWith(`${path}/`),
  );
}

function isSharedAssistantMessage(message: SerializedSharedMessage): boolean {
  return message.isCreatedByUser === false || message.role === 'assistant' || message.role === 'ai';
}

function hasSerializedFileContentPartType(
  part: SerializedSharedMessagePart | null | undefined,
): boolean {
  return typeof part?.type === 'string' && FILE_CONTENT_PART_TYPES.has(part.type.toLowerCase());
}

function getSerializedFileContentPart(
  part: SerializedSharedMessagePart | null | undefined,
): SerializedSharedFile | null {
  if (part == null || typeof part !== 'object') {
    return null;
  }
  const recognizedType = hasSerializedFileContentPartType(part);
  const hasFileCarrier = FILE_CONTENT_PART_KEYS.some((key) =>
    Object.prototype.hasOwnProperty.call(part, key),
  );
  if (!recognizedType && !hasFileCarrier) {
    return null;
  }
  const payloadKeys = TOP_LEVEL_FILE_CONTENT_KEYS.filter(
    (key) =>
      Object.prototype.hasOwnProperty.call(part, key) &&
      (key !== 'file_data' || getSerializedFileObject(part.file_data) == null) &&
      (key !== 'document_url' || getSerializedFileObject(part.document_url) == null),
  );
  if (payloadKeys.length === 0) {
    return null;
  }
  const projection: Record<string, unknown> = {};
  for (const key of [...TOP_LEVEL_FILE_CONTEXT_KEYS, ...payloadKeys]) {
    if (Object.prototype.hasOwnProperty.call(part, key)) {
      projection[key] = part[key];
    }
  }
  return projection as SerializedSharedFile;
}

function getSerializedFileObject(value: unknown): SerializedSharedFile | null {
  return value != null && typeof value === 'object' ? (value as SerializedSharedFile) : null;
}

function isEntireMessageSubmitted(
  message: SerializedSharedMessage,
  filters: FiltersConfig | undefined,
  submittedPaths: ReturnType<typeof getUserSubmittedPathState>,
): boolean {
  if (message.isCreatedByUser === true || message.isUserSubmitted === true) {
    return true;
  }
  if (submittedPaths.overflowed) {
    return true;
  }
  if (typeof message.isUserSubmitted === 'boolean' || submittedPaths.paths.length > 0) {
    return false;
  }
  if (message.isCreatedByUser == null) {
    return true;
  }
  return (
    isSharedAssistantMessage(message) &&
    filters?.messages?.unattributedAssistantContent === 'inspect'
  );
}

function collectSerializedFiles(
  messages: readonly SerializedSharedMessage[],
  filters: FiltersConfig | undefined,
): CollectedSerializedFile[] {
  const files: CollectedSerializedFile[] = [];
  const appendFile = (
    file: SerializedSharedFile | null | undefined,
    location: SerializedFileLocation,
    path: JsonPointer,
    localPath: JsonPointer,
    entireMessageSubmitted: boolean,
    submittedPaths: readonly string[],
  ) => {
    if (file == null) {
      return;
    }
    files.push({
      file,
      location,
      path,
      userSubmitted: entireMessageSubmitted || isSubmittedPath(localPath, submittedPaths),
    });
  };
  const append = (
    values: readonly (SerializedSharedFile | null | undefined)[] | undefined,
    location: SerializedFileLocation,
    path: JsonPointer,
    localPath: JsonPointer,
    entireMessageSubmitted: boolean,
    submittedPaths: readonly string[],
  ) => {
    let index = 0;
    for (const file of values ?? []) {
      if (file != null) {
        appendFile(
          file,
          location,
          `${path}/${index}` as JsonPointer,
          `${localPath}/${index}` as JsonPointer,
          entireMessageSubmitted,
          submittedPaths,
        );
      }
      index++;
    }
  };

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    const submittedPathState = getUserSubmittedPathState(message, { scope: 'shared_message' });
    const submittedPaths = submittedPathState.paths;
    const entireMessageSubmitted = isEntireMessageSubmitted(message, filters, submittedPathState);
    append(
      message.files,
      'file',
      `/messages/${messageIndex}/files`,
      '/files',
      entireMessageSubmitted,
      submittedPaths,
    );
    append(
      message.attachments,
      'attachment',
      `/messages/${messageIndex}/attachments`,
      '/attachments',
      entireMessageSubmitted,
      submittedPaths,
    );
    for (let partIndex = 0; partIndex < (message.content?.length ?? 0); partIndex++) {
      const part = message.content?.[partIndex];
      const partPath = `/messages/${messageIndex}/content/${partIndex}` as JsonPointer;
      const partLocalPath = `/content/${partIndex}` as JsonPointer;
      const partIsSubmitted = entireMessageSubmitted || part?.type === 'steer';
      appendFile(
        getSerializedFileContentPart(part),
        'file',
        partPath,
        partLocalPath,
        partIsSubmitted,
        submittedPaths,
      );
      append(
        part?.files,
        'file',
        `${partPath}/files` as JsonPointer,
        `${partLocalPath}/files` as JsonPointer,
        partIsSubmitted,
        submittedPaths,
      );
      for (const [key, file] of [
        ['file', part?.file],
        ['fileData', part?.fileData],
        ['file_data', part?.file_data],
        ['image_file', part?.image_file],
        ['inlineData', part?.inlineData],
        ['input_audio', part?.input_audio],
        ['document', part?.document],
      ] as const) {
        appendFile(
          getSerializedFileObject(file),
          'file',
          `${partPath}/${key}` as JsonPointer,
          `${partLocalPath}/${key}` as JsonPointer,
          partIsSubmitted,
          submittedPaths,
        );
      }
      for (const [key, locator] of [
        ['audio_url', part?.audio_url],
        ['document_url', part?.document_url],
        ['image_url', part?.image_url],
        ['video_url', part?.video_url],
      ] as const) {
        appendFile(
          typeof locator === 'string' ? { url: locator } : locator,
          'file',
          `${partPath}/${key}` as JsonPointer,
          `${partLocalPath}/${key}` as JsonPointer,
          partIsSubmitted,
          submittedPaths,
        );
      }
      const source = hasSerializedFileContentPartType(part) ? part?.source : undefined;
      appendFile(
        getSerializedFileObject(source),
        'file',
        `${partPath}/source` as JsonPointer,
        `${partLocalPath}/source` as JsonPointer,
        partIsSubmitted,
        submittedPaths,
      );
    }
  }
  return files;
}

function extractSharedMessageMetadataFragments(
  messages: readonly SerializedSharedMessage[],
  filters: FiltersConfig | undefined,
): TextContentFragment[] {
  const fragments: TextContentFragment[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    const submittedPathState = getUserSubmittedPathState(message, { scope: 'shared_message' });
    const submittedPaths = submittedPathState.paths;
    /** Shared response-only metadata predates message provenance markers and
     *  can be authored by users or reusable configuration even on assistant
     *  rows, so retain the existing conservative default for unmarked fields. */
    const legacyMetadataIsUnattributed =
      message.isUserSubmitted == null &&
      submittedPathState.paths.length === 0 &&
      !submittedPathState.overflowed;
    const isSubmitted = (path: string) =>
      isEntireMessageSubmitted(message, filters, submittedPathState) ||
      legacyMetadataIsUnattributed ||
      isSubmittedPath(path, submittedPaths);
    const appendMessageValue = (
      value: unknown,
      key: 'iconURL' | 'finish_reason',
      field: 'attachment_reference' | 'content_part',
      format: 'plain' | 'uri',
    ) => {
      if (typeof value !== 'string' || value.length === 0 || !isSubmitted(`/${key}`)) {
        return;
      }
      fragments.push({
        id: `shared-message.${messageIndex}.${key}`,
        path: `/messages/${messageIndex}/${key}` as JsonPointer,
        text: value,
        source: 'message',
        field,
        format,
        treatment: 'inspect_only',
        provenance: 'user',
      });
    };
    const appendSkills = (
      values: readonly (string | null | undefined)[] | undefined,
      key: 'manualSkills' | 'alwaysAppliedSkills',
    ) => {
      for (let index = 0; index < (values?.length ?? 0); index++) {
        const value = values?.[index];
        const localPath = `/${key}/${index}`;
        if (typeof value !== 'string' || value.length === 0 || !isSubmitted(localPath)) {
          continue;
        }
        fragments.push({
          id: `shared-message.${messageIndex}.${key}.${index}`,
          path: `/messages/${messageIndex}${localPath}` as JsonPointer,
          text: value,
          source: 'skill',
          field: 'name',
          format: 'plain',
          treatment: 'inspect_only',
          provenance: 'user',
        });
      }
    };

    appendMessageValue(message.iconURL, 'iconURL', 'attachment_reference', 'uri');
    appendMessageValue(message.finish_reason, 'finish_reason', 'content_part', 'plain');
    appendSkills(message.manualSkills, 'manualSkills');
    appendSkills(message.alwaysAppliedSkills, 'alwaysAppliedSkills');
  }
  return fragments;
}

function isToolAttachment(file: SerializedSharedFile): boolean {
  if (
    (typeof file.toolCallId === 'string' && file.toolCallId.length > 0) ||
    (typeof file.tool_call_id === 'string' && file.tool_call_id.length > 0) ||
    (Object.prototype.hasOwnProperty.call(file, 'toolCallId') && file.toolCallId != null) ||
    (Object.prototype.hasOwnProperty.call(file, 'tool_call_id') && file.tool_call_id != null)
  ) {
    return true;
  }
  return (
    typeof file.type === 'string' &&
    file.type.length > 0 &&
    Object.prototype.hasOwnProperty.call(file, file.type)
  );
}

type NestedSerializedPayloadTarget = 'attachment' | 'file' | 'tool';

type NestedPayloadClassification =
  | {
      readonly source: 'file';
      readonly field: FileFilterField;
      readonly provenance: 'user';
    }
  | {
      readonly source: 'message';
      readonly field: 'attachment_reference';
      readonly provenance: 'user';
    }
  | {
      readonly source: 'tool_argument';
      readonly field: 'output';
      readonly provenance: 'tool';
    };

interface SharedPayloadInspectionState {
  readonly fragments: TextContentFragment[];
  readonly inspectedEncodedProperties: WeakMap<object, Set<string>>;
  readonly uninspectableFileFields: FileFilterField[];
  readonly traversalClassifications: NestedPayloadClassification[];
  nextFragmentId: number;
  hasInspectableEncodedValues: boolean;
}

interface PendingNestedValue {
  readonly value: unknown;
  readonly path: JsonPointer;
  readonly key: string;
  readonly parent: object;
  readonly depth: number;
  readonly classifications: readonly NestedPayloadClassification[];
}

interface DecodedEncodedText {
  readonly status: 'decoded';
  readonly text: string;
  readonly fields: readonly FileFilterField[];
}

interface UninspectableEncodedText {
  readonly status: 'uninspectable';
  readonly fields: readonly FileFilterField[];
}

interface NotEncodedText {
  readonly status: 'not_encoded';
}

type EncodedTextResult = DecodedEncodedText | UninspectableEncodedText | NotEncodedText;

interface UnknownDictionary {
  readonly [key: string]: unknown;
}

interface MutableDictionary {
  [key: string]: unknown;
}

function hasExpectedStandardScalarShape(key: string, value: unknown): boolean {
  const shape = STANDARD_SERIALIZED_FILE_SHAPES.get(key);
  if (shape == null) {
    return false;
  }
  if (value == null) {
    return true;
  }
  if (shape === 'string') {
    return typeof value === 'string';
  }
  if (shape === 'number') {
    return typeof value === 'number';
  }
  return typeof value === 'string' || typeof value === 'number' || value instanceof Date;
}

function getNestedTarget(file: CollectedSerializedFile): NestedSerializedPayloadTarget {
  if (file.location === 'file') {
    return 'file';
  }
  if (file.userSubmitted) {
    return 'attachment';
  }
  return isToolAttachment(file.file) ? 'tool' : 'file';
}

function getNestedClassification(
  target: NestedSerializedPayloadTarget,
  rootKey: string,
): NestedPayloadClassification {
  if (target === 'tool') {
    return { source: 'tool_argument', field: 'output', provenance: 'tool' };
  }
  if (target === 'attachment') {
    return { source: 'message', field: 'attachment_reference', provenance: 'user' };
  }
  return {
    source: 'file',
    field: FILE_FIELD_BY_STANDARD_KEY.get(rootKey) ?? 'content',
    provenance: 'user',
  };
}

function getDistinctClassifications(
  classifications: readonly NestedPayloadClassification[],
): NestedPayloadClassification[] {
  const result: NestedPayloadClassification[] = [];
  const seen = new Set<string>();
  for (const classification of classifications) {
    const key = `${classification.source}:${classification.field}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(classification);
  }
  return result;
}

function getNestedClassifications(
  target: NestedSerializedPayloadTarget,
  rootKey: string,
  includeMessageClassification: boolean,
): NestedPayloadClassification[] {
  const classifications: NestedPayloadClassification[] = [getNestedClassification(target, rootKey)];
  const fileField = FILE_FIELD_BY_STANDARD_KEY.get(rootKey);
  if (fileField != null) {
    classifications.push({ source: 'file', field: fileField, provenance: 'user' });
  }
  if (includeMessageClassification && MESSAGE_ATTACHMENT_STANDARD_KEYS.has(rootKey)) {
    classifications.push({
      source: 'message',
      field: 'attachment_reference',
      provenance: 'user',
    });
  }
  return getDistinctClassifications(classifications);
}

function isClassificationActive(
  filters: FiltersConfig | undefined,
  classification: NestedPayloadClassification,
): boolean {
  if (classification.source === 'tool_argument') {
    const pii = filters?.toolArguments?.pii;
    return hasActivePiiPatterns(pii) && (pii?.fields == null || pii.fields.includes('output'));
  }
  if (classification.source === 'message') {
    const pii = filters?.messages?.pii;
    return (
      hasActivePiiPatterns(pii) &&
      (pii?.fields == null || pii.fields.includes('attachment_reference'))
    );
  }
  const pii = filters?.files?.pii;
  return (
    hasActivePiiPatterns(pii) && (pii?.fields == null || pii.fields.includes(classification.field))
  );
}

function isFilePatternFieldActive(
  filters: FiltersConfig | undefined,
  field: FileFilterField,
): boolean {
  const pii = filters?.files?.pii;
  return hasActivePiiPatterns(pii) && (pii?.fields == null || pii.fields.includes(field));
}

function hasEncodedFilePolicy(filters: FiltersConfig | undefined): boolean {
  return ALL_DERIVED_FILE_FIELDS.some(
    (field) =>
      isFilePatternFieldActive(filters, field) ||
      getBlockedUninspectableFileField(filters, [field]) != null,
  );
}

function hasSerializedFilePolicy(filters: FiltersConfig | undefined): boolean {
  const messagePii = filters?.messages?.pii;
  const toolPii = filters?.toolArguments?.pii;
  return (
    hasActiveFilePolicy(filters) ||
    (hasActivePiiPatterns(messagePii) &&
      (messagePii?.fields == null || messagePii.fields.includes('attachment_reference'))) ||
    (hasActivePiiPatterns(toolPii) &&
      (toolPii?.fields == null || toolPii.fields.includes('output')))
  );
}

function appendClassifiedFragment(
  state: SharedPayloadInspectionState,
  classification: NestedPayloadClassification,
  text: string,
  path: JsonPointer,
  format: TextContentFragment['format'] = 'plain',
): void {
  if (text.length === 0) {
    return;
  }
  state.fragments.push({
    id: `shared-file.serialized.${state.nextFragmentId++}`,
    path,
    text,
    source: classification.source,
    field: classification.field,
    format,
    treatment: 'inspect_only',
    provenance: classification.provenance,
  } as TextContentFragment);
}

function appendDecodedFileFragments(
  state: SharedPayloadInspectionState,
  filters: FiltersConfig | undefined,
  text: string,
  path: JsonPointer,
  fields: readonly FileFilterField[],
): void {
  for (const field of fields) {
    if (!isFilePatternFieldActive(filters, field)) {
      continue;
    }
    state.fragments.push({
      id: `shared-file.encoded.${state.nextFragmentId++}`,
      path,
      text,
      source: 'file',
      field,
      format: 'plain',
      treatment: 'inspect_only',
      provenance: 'user',
    });
  }
}

function rememberInspectableEncodedProperty(
  state: SharedPayloadInspectionState,
  parent: object,
  key: string,
): void {
  const keys = state.inspectedEncodedProperties.get(parent) ?? new Set<string>();
  keys.add(key);
  state.inspectedEncodedProperties.set(parent, keys);
  state.hasInspectableEncodedValues = true;
}

function rememberUninspectableFields(
  state: SharedPayloadInspectionState,
  fields: readonly FileFilterField[],
): void {
  for (const field of fields) {
    if (!state.uninspectableFileFields.includes(field)) {
      state.uninspectableFileFields.push(field);
    }
  }
}

function isOpaqueSerializedBytes(key: string, value: unknown): boolean {
  return key.toLowerCase() === 'bytes' && value != null && typeof value === 'object';
}

function getNormalizedMimeType(parent: object | undefined): string {
  if (parent == null) {
    return '';
  }
  try {
    for (const key of ['mimeType', 'mime_type', 'media_type', 'type'] as const) {
      const value = (parent as UnknownDictionary)[key];
      if (typeof value === 'string' && value.includes('/')) {
        return value.split(';', 1)[0].trim().toLowerCase();
      }
    }
  } catch {
    return '';
  }
  return '';
}

function getNormalizedParentType(parent: object | undefined): string {
  if (parent == null) {
    return '';
  }
  try {
    const value = (parent as UnknownDictionary).type;
    return typeof value === 'string' ? value.toLowerCase() : '';
  } catch {
    return '';
  }
}

function isTextualMimeType(mimeType: string): boolean {
  return (
    mimeType.length === 0 ||
    mimeType.startsWith('text/') ||
    mimeType.endsWith('+json') ||
    mimeType.endsWith('+xml') ||
    TEXTUAL_APPLICATION_MIME_TYPES.has(mimeType)
  );
}

function getEncodedFileFields(
  key: string,
  parent: object | undefined,
  mimeType: string,
  dataUri: boolean,
): readonly FileFilterField[] {
  const parentType = getNormalizedParentType(parent);
  if (mimeType.startsWith('audio/') || parentType.includes('audio')) {
    return ['content', 'transcript'];
  }
  if (
    mimeType.startsWith('image/') ||
    mimeType.startsWith('video/') ||
    parentType.includes('image') ||
    parentType.includes('video')
  ) {
    return ['content'];
  }
  if (dataUri) {
    return ['content'];
  }
  if (
    key.toLowerCase() === 'file_data' ||
    key.toLowerCase() === 'filedata' ||
    parentType.includes('base64') ||
    parentType.includes('document') ||
    parentType.includes('file')
  ) {
    return ALL_DERIVED_FILE_FIELDS;
  }
  return ['content'];
}

function decodeUtf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function isProbablyText(text: string): boolean {
  if (text.length === 0) {
    return true;
  }
  let disallowedControls = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      disallowedControls++;
    }
  }
  return disallowedControls === 0 || disallowedControls / text.length <= 0.01;
}

function decodeStrictBase64(value: string): Buffer | null {
  if (value.length > MAX_BASE64_TEXT_CHARS) {
    return null;
  }
  const normalized = value.replace(/\s/g, '');
  if (
    normalized.length > MAX_BASE64_TEXT_CHARS ||
    normalized.length % 4 === 1 ||
    !BASE64_TEXT.test(normalized)
  ) {
    return null;
  }
  try {
    const buffer = Buffer.from(normalized, 'base64');
    if (buffer.length > MAX_DECODED_TEXT_BYTES) {
      return null;
    }
    const expected = normalized.replace(/=+$/u, '');
    const actual = buffer.toString('base64').replace(/=+$/u, '');
    return expected === actual ? buffer : null;
  } catch {
    return null;
  }
}

function decodeBoundedPercentText(value: string): string | null {
  if (value.length > MAX_BASE64_TEXT_CHARS) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(value);
    return Buffer.byteLength(decoded, 'utf8') <= MAX_DECODED_TEXT_BYTES ? decoded : null;
  } catch {
    return null;
  }
}

function decodeEncodedText(
  value: string,
  key: string,
  parent: object | undefined,
): EncodedTextResult {
  if (isDataUri(value)) {
    const normalized = value.trimStart();
    const commaIndex = normalized.indexOf(',');
    const fallbackFields = ['content'] as const;
    if (commaIndex < 5 || commaIndex > 1024) {
      return { status: 'uninspectable', fields: fallbackFields };
    }
    const metadata = normalized.slice(5, commaIndex);
    const segments = metadata.split(';');
    const mimeType = (segments[0] || 'text/plain').trim().toLowerCase();
    const fields = getEncodedFileFields(key, parent, mimeType, true);
    if (mimeType.length > 0 && !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(mimeType)) {
      return { status: 'uninspectable', fields };
    }
    const isBase64 = segments.slice(1).some((segment) => segment.trim().toLowerCase() === 'base64');
    const payload = normalized.slice(commaIndex + 1);
    if (!isTextualMimeType(mimeType)) {
      return { status: 'uninspectable', fields };
    }
    if (isBase64) {
      const buffer = decodeStrictBase64(payload);
      if (buffer == null) {
        return { status: 'uninspectable', fields };
      }
      const text = decodeUtf8(buffer);
      return text == null
        ? { status: 'uninspectable', fields }
        : { status: 'decoded', text, fields };
    }
    const text = decodeBoundedPercentText(payload);
    return text == null ? { status: 'uninspectable', fields } : { status: 'decoded', text, fields };
  }

  const mimeType = getNormalizedMimeType(parent);
  if (
    !isLikelyEncodedPayload(value, key, parent) &&
    !(key.toLowerCase() === 'data' && mimeType.length > 0)
  ) {
    return { status: 'not_encoded' };
  }
  const fields = getEncodedFileFields(key, parent, mimeType, false);
  const buffer = decodeStrictBase64(value);
  if (buffer == null) {
    return { status: 'uninspectable', fields };
  }
  const text = decodeUtf8(buffer);
  if (
    text == null ||
    (mimeType.length > 0 ? !isTextualMimeType(mimeType) : !isProbablyText(text))
  ) {
    return { status: 'uninspectable', fields };
  }
  return { status: 'decoded', text, fields };
}

function inspectSerializedString(
  state: SharedPayloadInspectionState,
  filters: FiltersConfig | undefined,
  value: string,
  path: JsonPointer,
  key: string,
  parent: object,
  classification: NestedPayloadClassification,
  emitRaw: boolean,
): void {
  const classificationActive = isClassificationActive(filters, classification);
  if (emitRaw && classificationActive) {
    appendClassifiedFragment(
      state,
      classification,
      value,
      path,
      URI_LIKE_KEYS.has(key.toLowerCase()) || isDataUri(value) ? 'uri' : 'plain',
    );
  }

  const encoded = decodeEncodedText(value, key, parent);
  if (encoded.status === 'decoded') {
    if (classificationActive) {
      appendClassifiedFragment(state, classification, encoded.text, path);
    }
    appendDecodedFileFragments(state, filters, encoded.text, path, encoded.fields);
    rememberInspectableEncodedProperty(state, parent, key);
    return;
  }
  if (encoded.status === 'uninspectable') {
    rememberUninspectableFields(state, encoded.fields);
    return;
  }

  if (!URI_LIKE_KEYS.has(key.toLowerCase()) || !value.includes('%')) {
    return;
  }
  const decodedUri = decodeBoundedPercentText(value);
  if (decodedUri == null) {
    rememberUninspectableFields(state, ['content']);
    return;
  }
  if (classificationActive && decodedUri !== value) {
    appendClassifiedFragment(state, classification, decodedUri, path, 'uri');
  }
}

function getTraversalClassificationScope(
  filters: FiltersConfig | undefined,
  classification: NestedPayloadClassification,
): NestedPayloadClassification | null {
  if (isClassificationActive(filters, classification)) {
    return classification;
  }
  const fileField = ALL_DERIVED_FILE_FIELDS.find(
    (field) =>
      isFilePatternFieldActive(filters, field) ||
      getBlockedUninspectableFileField(filters, [field]) != null,
  );
  if (fileField == null) {
    return null;
  }
  return { source: 'file', field: fileField, provenance: 'user' };
}

function rememberTraversalClassification(
  state: SharedPayloadInspectionState,
  filters: FiltersConfig | undefined,
  classification: NestedPayloadClassification,
): void {
  const scope = getTraversalClassificationScope(filters, classification);
  if (scope != null) {
    state.traversalClassifications.push(scope);
  }
}

function extractNestedSerializedPayloadFragments(
  collectedFiles: readonly CollectedSerializedFile[],
  filters: FiltersConfig | undefined,
  state: SharedPayloadInspectionState,
): void {
  const inspectEncodedFiles = hasEncodedFilePolicy(filters);
  for (let index = 0; index < collectedFiles.length; index++) {
    const collectedFile = collectedFiles[index];
    const { file, path } = collectedFile;
    const target = getNestedTarget(collectedFile);
    const boundedEntries = getBoundedOwnEnumerableEntries(file, CONTENT_TRAVERSAL_MAX_NODES);
    const entries = boundedEntries.entries;
    if (!boundedEntries.complete) {
      rememberTraversalClassification(state, filters, getNestedClassification(target, 'content'));
    }

    const pending: PendingNestedValue[] = [];
    const seen = new WeakSet<object>();
    let visitedNodes = 0;

    for (const [key, value] of entries) {
      const classifications = getNestedClassifications(target, key, collectedFile.userSubmitted);
      const activeClassifications = classifications.filter((classification) =>
        isClassificationActive(filters, classification),
      );
      const inspectionClassifications =
        activeClassifications.length > 0 ? activeClassifications : [classifications[0]];
      if (isOpaqueSerializedBytes(key, value)) {
        rememberUninspectableFields(state, ALL_DERIVED_FILE_FIELDS);
        continue;
      }
      if (hasExpectedStandardScalarShape(key, value)) {
        if (typeof value === 'string') {
          if (SERIALIZED_LOCATOR_KEYS.includes(key as (typeof SERIALIZED_LOCATOR_KEYS)[number])) {
            continue;
          } else if (activeClassifications.length > 0) {
            for (const classification of activeClassifications) {
              inspectSerializedString(
                state,
                filters,
                value,
                `${path}/${escapeJsonPointer(key)}` as JsonPointer,
                key,
                file,
                classification,
                true,
              );
            }
          } else if (
            (activeClassifications.length > 0 || inspectEncodedFiles) &&
            (isDataUri(value) || isLikelyEncodedPayload(value, key, file))
          ) {
            for (const classification of inspectionClassifications) {
              inspectSerializedString(
                state,
                filters,
                value,
                `${path}/${escapeJsonPointer(key)}` as JsonPointer,
                key,
                file,
                classification,
                true,
              );
            }
          }
        }
        continue;
      }
      if (activeClassifications.length === 0 && !inspectEncodedFiles) {
        continue;
      }
      const keyPath = `${path}/$serialized/${escapeJsonPointer(key)}` as JsonPointer;
      if (key.length > 0) {
        for (const classification of activeClassifications) {
          appendClassifiedFragment(state, classification, key, keyPath);
        }
      }
      pending.push({
        value,
        path: keyPath,
        key,
        parent: file,
        depth: 0,
        classifications: inspectionClassifications,
      });
    }

    while (pending.length > 0 && visitedNodes < CONTENT_TRAVERSAL_MAX_NODES) {
      const current = pending.pop();
      if (current == null) {
        continue;
      }
      if (current.depth > CONTENT_TRAVERSAL_MAX_DEPTH) {
        for (const classification of current.classifications) {
          rememberTraversalClassification(state, filters, classification);
        }
        continue;
      }
      visitedNodes++;

      if (typeof current.value === 'string') {
        for (const classification of current.classifications) {
          inspectSerializedString(
            state,
            filters,
            current.value,
            current.path,
            current.key,
            current.parent,
            classification,
            true,
          );
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

      const availableNodes = Math.max(
        0,
        CONTENT_TRAVERSAL_MAX_NODES - visitedNodes - pending.length,
      );
      const boundedNestedEntries = getBoundedOwnEnumerableEntries(current.value, availableNodes);
      const nestedEntries = boundedNestedEntries.entries;
      if (!boundedNestedEntries.complete) {
        for (const classification of current.classifications) {
          rememberTraversalClassification(state, filters, classification);
        }
      }
      if (
        current.depth >= CONTENT_TRAVERSAL_MAX_DEPTH &&
        (nestedEntries.length > 0 || !boundedNestedEntries.complete)
      ) {
        for (const classification of current.classifications) {
          rememberTraversalClassification(state, filters, classification);
        }
        continue;
      }
      const scheduledNodes = nestedEntries.length;
      for (let nestedIndex = 0; nestedIndex < scheduledNodes; nestedIndex++) {
        const [key] = nestedEntries[nestedIndex];
        if (key.length > 0) {
          for (const classification of current.classifications) {
            if (isClassificationActive(filters, classification)) {
              appendClassifiedFragment(
                state,
                classification,
                key,
                `${current.path}/${escapeJsonPointer(key)}` as JsonPointer,
              );
            }
          }
        }
      }
      for (let nestedIndex = scheduledNodes - 1; nestedIndex >= 0; nestedIndex--) {
        const [key, value] = nestedEntries[nestedIndex];
        if (isOpaqueSerializedBytes(key, value)) {
          rememberUninspectableFields(state, ALL_DERIVED_FILE_FIELDS);
          continue;
        }
        pending.push({
          value,
          path: `${current.path}/${escapeJsonPointer(key)}` as JsonPointer,
          key,
          parent: current.value,
          depth: current.depth + 1,
          classifications: current.classifications,
        });
      }
    }

    if (pending.length > 0) {
      for (const pendingValue of pending) {
        for (const classification of pendingValue.classifications) {
          rememberTraversalClassification(state, filters, classification);
        }
      }
    }
  }
}

function projectPolicyMetadata(
  files: readonly SerializedSharedFile[],
  shareId: string | undefined,
): SerializedSharedFile[] {
  return files.map((file) => {
    const metadata = { ...file };
    const fileId = metadata.file_id;
    if (typeof fileId !== 'string' || typeof shareId !== 'string') {
      return metadata;
    }
    const sharedFileRoute = `/api/share/${shareId}/files/${encodeURIComponent(fileId)}`;
    const hasSharedFileRoute = SERIALIZED_LOCATOR_KEYS.some(
      (key) => metadata[key] === sharedFileRoute,
    );
    if (!hasSharedFileRoute) {
      return metadata;
    }
    delete metadata.file_id;
    for (const key of SERIALIZED_LOCATOR_KEYS) {
      if (metadata[key] === sharedFileRoute) {
        delete metadata[key];
      }
    }
    return metadata;
  });
}

function extractLocatorAliasFragments(
  collectedFiles: readonly CollectedSerializedFile[],
  filters: FiltersConfig | undefined,
  state: SharedPayloadInspectionState,
): void {
  for (let index = 0; index < collectedFiles.length; index++) {
    const collectedFile = collectedFiles[index];
    const file = collectedFile.file;
    const targetClassification = getNestedClassification(getNestedTarget(collectedFile), 'uri');
    for (const key of SERIALIZED_LOCATOR_KEYS) {
      const value = file[key];
      if (typeof value !== 'string' || value.length === 0) {
        continue;
      }
      const path = `${collectedFile.path}/${key}` as JsonPointer;
      const messageClassification = {
        source: 'message',
        field: 'attachment_reference',
        provenance: 'user',
      } as const;
      const fileClassification = {
        source: 'file',
        field: 'uri',
        provenance: 'user',
      } as const;
      if (collectedFile.userSubmitted && isClassificationActive(filters, messageClassification)) {
        appendClassifiedFragment(state, messageClassification, value, path, 'uri');
      }
      if (isClassificationActive(filters, fileClassification)) {
        appendClassifiedFragment(state, fileClassification, value, path, 'uri');
      }
      if (
        targetClassification.source === 'tool_argument' &&
        isClassificationActive(filters, targetClassification)
      ) {
        appendClassifiedFragment(state, targetClassification, value, path, 'uri');
      }

      inspectSerializedString(state, filters, value, path, key, file, targetClassification, false);
      if (isDataUri(value) || !value.includes('%')) {
        continue;
      }
      const decodedUri = decodeBoundedPercentText(value);
      if (decodedUri == null || decodedUri === value) {
        continue;
      }
      if (collectedFile.userSubmitted && isClassificationActive(filters, messageClassification)) {
        appendClassifiedFragment(state, messageClassification, decodedUri, path, 'uri');
      }
      if (isClassificationActive(filters, fileClassification)) {
        appendClassifiedFragment(state, fileClassification, decodedUri, path, 'uri');
      }
    }
  }
}

function projectOpaqueLocatorAliases(
  files: readonly SerializedSharedFile[],
): SerializedSharedFile[] {
  return files.map((file) => {
    const aliases = SERIALIZED_LOCATOR_KEYS.flatMap((key) => {
      const value = file[key];
      return typeof value === 'string' && value.length > 0 ? [{ uri: value }] : [];
    });
    return aliases.length > 0 ? { ...file, serializedLocatorAliases: { files: aliases } } : file;
  });
}

function toTraversalScope(classification: NestedPayloadClassification) {
  if (classification.source === 'tool_argument') {
    return { source: 'tool_argument' as const, fields: ['output'] as const };
  }
  if (classification.source === 'message') {
    return {
      source: 'message' as const,
      fields: ['attachment_reference'] as const,
    };
  }
  return {
    source: 'file' as const,
    fields: [classification.field] as readonly FileFilterField[],
  };
}

function getDistinctTraversalClassifications(
  classifications: readonly NestedPayloadClassification[],
): NestedPayloadClassification[] {
  const distinct: NestedPayloadClassification[] = [];
  const seen = new Set<string>();
  for (const classification of classifications) {
    const key = `${classification.source}:${classification.field}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    distinct.push(classification);
  }
  return distinct;
}

function sanitizeInspectableEncodedValues(
  value: unknown,
  state: SharedPayloadInspectionState,
  depth = 0,
  traversal?: {
    readonly seen: WeakMap<object, unknown>;
    visitedNodes: number;
  },
): unknown {
  if (value == null || typeof value !== 'object' || value instanceof Date) {
    return value;
  }
  if (depth > CONTENT_TRAVERSAL_MAX_DEPTH) {
    throw new ContentTraversalLimitError([], [{ source: 'file', fields: ['content'] }]);
  }
  const budget = traversal ?? { seen: new WeakMap<object, unknown>(), visitedNodes: 0 };
  if (budget.visitedNodes >= CONTENT_TRAVERSAL_MAX_NODES) {
    throw new ContentTraversalLimitError([], [{ source: 'file', fields: ['content'] }]);
  }
  const seenValue = budget.seen.get(value);
  if (seenValue !== undefined) {
    return seenValue;
  }
  budget.visitedNodes++;

  const boundedEntries = getBoundedOwnEnumerableEntries(
    value,
    CONTENT_TRAVERSAL_MAX_NODES - budget.visitedNodes,
  );
  if (!boundedEntries.complete) {
    throw new ContentTraversalLimitError([], [{ source: 'file', fields: ['content'] }]);
  }
  const entries = boundedEntries.entries;

  const clone: MutableDictionary | unknown[] = Array.isArray(value) ? [] : {};
  budget.seen.set(value, clone);
  const inspectedKeys = state.inspectedEncodedProperties.get(value);
  for (const [key, child] of entries) {
    const arrayIndex =
      Array.isArray(clone) && /^(0|[1-9]\d*)$/u.test(key) ? Number.parseInt(key, 10) : null;
    if (inspectedKeys?.has(key) === true) {
      if (arrayIndex != null && Array.isArray(clone)) {
        clone[arrayIndex] = null;
      }
      continue;
    }
    const sanitized = sanitizeInspectableEncodedValues(child, state, depth + 1, budget);
    if (arrayIndex != null && Array.isArray(clone)) {
      clone[arrayIndex] = sanitized;
    } else {
      (clone as MutableDictionary)[key] = sanitized;
    }
  }
  return clone;
}

/**
 * Reapplies current policy to metadata serialized by a public share. Pattern
 * inspection covers user-submitted message metadata and every returned file
 * reference, while fail-close ignores only server-issued shared-file locators.
 */
export function assertSharedFileMetadataAllowed({
  filters,
  messages,
  shareId,
  includeFiles = true,
}: SharedFileMetadataPolicyInput): void {
  if (filters == null) {
    return;
  }
  const messageMetadataFragments = extractSharedMessageMetadataFragments(messages, filters);
  const collectedFiles =
    includeFiles && hasSerializedFilePolicy(filters)
      ? collectSerializedFiles(messages, filters)
      : [];
  if (collectedFiles.length === 0 && messageMetadataFragments.length === 0) {
    return;
  }
  const files = collectedFiles.map(({ file }) => file);

  const attachmentFragments = extractStoredMessageContent({
    files: collectedFiles.filter(({ userSubmitted }) => userSubmitted).map(({ file }) => file),
  }).filter(
    (fragment) => fragment.source === 'message' && fragment.field === 'attachment_reference',
  );
  const fileFragments = files.flatMap((file) => extractFileContent(file));
  const payloadInspection: SharedPayloadInspectionState = {
    fragments: [],
    inspectedEncodedProperties: new WeakMap<object, Set<string>>(),
    uninspectableFileFields: [],
    traversalClassifications: [],
    nextFragmentId: 0,
    hasInspectableEncodedValues: false,
  };
  extractLocatorAliasFragments(collectedFiles, filters, payloadInspection);
  extractNestedSerializedPayloadFragments(collectedFiles, filters, payloadInspection);
  const finding = inspectContent(
    [
      ...messageMetadataFragments,
      ...attachmentFragments,
      ...fileFragments,
      ...payloadInspection.fragments,
    ],
    { filters },
  );
  if (finding != null) {
    throw new ContentFilterError(finding);
  }
  const traversalClassifications = getDistinctTraversalClassifications(
    payloadInspection.traversalClassifications,
  );
  if (traversalClassifications.length > 0) {
    const traversalError = new ContentTraversalLimitError(
      [],
      traversalClassifications.map(toTraversalScope),
    );
    if (isContentTraversalProtected({ error: traversalError, filters })) {
      throw traversalError;
    }
  }
  for (const field of payloadInspection.uninspectableFileFields) {
    const blockedField = getBlockedUninspectableFileField(filters, [field]);
    if (blockedField != null) {
      throw new UninspectableFileError(blockedField);
    }
  }

  if (files.length === 0) {
    return;
  }
  const hasFileFailClose =
    getBlockedUninspectableFileField(filters, ALL_DERIVED_FILE_FIELDS) != null;
  const policyFiles =
    hasFileFailClose && payloadInspection.hasInspectableEncodedValues
      ? (files.map((file) =>
          sanitizeInspectableEncodedValues(file, payloadInspection),
        ) as SerializedSharedFile[])
      : files;
  assertModelBoundContent({
    filters,
    files: projectOpaqueLocatorAliases(projectPolicyMetadata(policyFiles, shareId)),
  });
}
