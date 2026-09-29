import { isProxy } from 'node:util/types';
import { StreamLimitExceededError } from '@librechat/agents';
import {
  FILE_FILTER_FIELDS,
  HITL_MESSAGE_FILTER_FIELDS,
  hasActivePiiFields,
  hasActivePiiPatterns,
} from 'librechat-data-provider';
import type {
  FiltersConfig,
  MessageFilterPiiConfig,
  UserSubmittedMessageFieldPath,
} from 'librechat-data-provider';
import type {
  AgentContentInput,
  AssistantActionContentInput,
  AssistantContentInput,
  FileContentInput,
  MemoryContentInput,
  SkillContentInput,
  StoredMessageContentInput,
} from '../protection/adapters/submissions';
import type {
  ContentTraversalScope,
  VisitNestedStringsBudget,
} from '../protection/adapters/nested';
import type { JsonPointer, TextContentFragment } from '../protection/types';
import type { ExternalChatMessage } from '../protection/adapters/messages';
import type { LocatorTraversalReporter } from '../protection/diagnostics';
import type { ConfiguredContentInspector } from '../protection/runtime';
import type { CanonicalFileInspectionFile } from '../protection/files';
import {
  CONTENT_TRAVERSAL_MAX_DEPTH,
  CONTENT_TRAVERSAL_MAX_NODES,
  CONTENT_MATERIALIZATION_MAX_CHARACTERS,
  getBoundedOwnEnumerableEntries,
  getContentTraversalFragments,
  getContentTraversalScopes,
  isContentTraversalProtected,
  isContentTraversalLimitError,
  isNestedMessageTraversalProtected,
  reserveContentMaterialization,
} from '../protection/adapters/nested';
import {
  allowHydratedFileReferences,
  assertHydratedFileInspectable,
  hasActiveFilePolicy,
  getBlockedOpaqueFileField,
  getBlockedUninspectableFileField,
  omitResolvedCanonicalFileLocators,
  UninspectableFileError,
} from '../protection/files';
import {
  extractAgentContent,
  extractAssistantActionContent,
  extractAssistantContent,
  extractFileContent,
  extractMemoryContent,
  extractSkillContent,
  extractStoredMessageContent,
} from '../protection/adapters/submissions';
import {
  MAX_USER_SUBMITTED_PATHS,
  getCapturedUserSubmittedPathMetadata,
  getSafeUserSubmittedPathSegments,
  getUserSubmittedMessageFieldPathState,
  getUserSubmittedPathState,
} from '../protection/provenance';
import { extractMessageContent, snapshotExternalMessages } from '../protection/adapters/messages';
import { ContentTraversalLimitError } from '../protection/adapters/nested';
import { ContentFilterError, isContentFilterError } from './contentFilter';
import { createConfiguredContentInspector } from '../protection/runtime';
import { aggregateAuditFindingsSync } from '../protection/audit';

export type ModelBoundProviderAttribution = 'user' | 'model' | 'tool' | 'synthetic';

export interface ModelBoundProviderProvenancePart {
  readonly attribution: ModelBoundProviderAttribution;
  readonly sourceMessageId?: string;
  readonly sourceContentPartIndices?: readonly number[];
}

export interface ModelBoundProviderProvenance {
  readonly version: 1;
  readonly parts: readonly ModelBoundProviderProvenancePart[];
}

export type ModelBoundProviderMessage = ExternalChatMessage &
  Omit<StoredMessageContentInput, 'content'> & {
    readonly id?: string;
    readonly messageId?: string;
    readonly text?: string;
    readonly additional_kwargs?: {
      readonly injected?: boolean;
      readonly isMeta?: boolean;
      readonly source?: string;
      readonly sourceMessageId?: string;
      readonly sourceMessageIds?: readonly string[];
      readonly provenance?: ModelBoundProviderProvenance;
    };
    readonly _getType?: () => string;
  };

type ModelBoundMessage = ExternalChatMessage & {
  readonly _getType?: () => string;
};

type StoredModelBoundMessage = StoredMessageContentInput & {
  readonly id?: string;
  readonly messageId?: string;
  readonly isCreatedByUser?: boolean;
  readonly isUserSubmitted?: boolean;
  readonly userSubmittedPaths?: readonly string[];
  readonly userSubmittedMessageFieldPaths?: readonly UserSubmittedMessageFieldPath[];
};

type SnapshottedModelBoundProviderMessage = ModelBoundProviderMessage &
  Pick<
    StoredModelBoundMessage,
    'isCreatedByUser' | 'isUserSubmitted' | 'userSubmittedPaths' | 'userSubmittedMessageFieldPaths'
  >;

type ModelBoundCanonicalFile = FileContentInput & CanonicalFileInspectionFile;

type ModelBoundPolicyError =
  | ContentFilterError
  | ContentTraversalLimitError
  | UninspectableFileError;

const LEGACY_ARTIFACT_PROJECTION_MARKER =
  'Tool response is included in the next message as a Human message';
const PROVIDER_PROVENANCE_ATTRIBUTIONS = new Set<ModelBoundProviderAttribution>([
  'user',
  'model',
  'tool',
  'synthetic',
]);
const LEGACY_SYNTHETIC_PROVIDER_SOURCES = new Set(['handoff', 'hook', 'skill', 'system']);
const MAX_PROVIDER_PROVENANCE_PARTS = 256;
const MAX_PROVIDER_SOURCE_PART_INDICES = 256;
const MAX_PROVIDER_PROVENANCE_INDEX_REFS = 4_096;
const MAX_PROVIDER_SOURCE_MESSAGE_IDS = 256;
const MAX_PROVIDER_SOURCE_MESSAGE_ID_LENGTH = 512;
const MAX_PROVIDER_SOURCE_CONTENT_PART_INDEX = 4_095;
const MAX_PROVIDER_PROJECTION_WORK = 4_096;
const MAX_PROVIDER_PROVENANCE_PARSE_WORK =
  MAX_PROVIDER_PROVENANCE_INDEX_REFS + MAX_PROVIDER_PROVENANCE_PARTS;
const MAX_PROVIDER_STORED_STATE_WORK =
  MAX_PROVIDER_PROJECTION_WORK + MAX_PROVIDER_PROVENANCE_PARTS * 2;
/** One root plus bounded structural bookkeeping for every valid provider part. */
const MAX_MODEL_BOUND_NESTED_TRAVERSAL_WORK = CONTENT_TRAVERSAL_MAX_NODES * 2;

function getProviderPartSnapshotTraversalScopes(
  providerRoles: readonly (string | undefined)[],
): ContentTraversalScope[] {
  const scopes: ContentTraversalScope[] = [
    { source: 'message', fields: ['content_part', 'attachment_reference'] },
    { source: 'assembled_context', fields: ['assembled_context'] },
    { source: 'file', fields: ['name', 'uri', 'content', 'extracted_text', 'transcript'] },
    { source: 'tool_argument', fields: ['name', 'arguments', 'output'] },
  ];
  if (providerRoles.some((role) => role === 'system' || role === 'developer')) {
    scopes.push({ source: 'agent_instruction', fields: ['instructions'] });
  }
  return scopes;
}

interface ProviderProjectionWorkBudget {
  remaining: number;
  overflowed: boolean;
  parent?: ProviderProjectionWorkBudget;
}

interface ProviderProjectionWorkBudgets {
  readonly projection: ProviderProjectionWorkBudget;
  readonly providerContent: ProviderProjectionWorkBudget;
  readonly partSnapshot: ProviderProjectionWorkBudget;
  readonly fileScan: ProviderProjectionWorkBudget;
  readonly provenance: ProviderProjectionWorkBudget;
  readonly storedState: ProviderProjectionWorkBudget;
  readonly nestedTraversal: VisitNestedStringsBudget;
}

/**
 * JSON structure is bounded per message. Dynamic proxy arrays retain the
 * shared work ceiling; their reads can execute arbitrary code. Either budget
 * latches failures into the enclosing projection, including subsequent batches.
 */
function createMessageWorkBudget(
  parent: ProviderProjectionWorkBudget,
  candidate: unknown,
  remaining = MAX_PROVIDER_PROJECTION_WORK,
): ProviderProjectionWorkBudget {
  if (isProxy(candidate)) {
    return parent;
  }
  let overflowed = false;
  return {
    remaining,
    parent,
    get overflowed() {
      return overflowed;
    },
    set overflowed(value: boolean) {
      overflowed ||= value;
      if (value && this.parent != null) {
        this.parent.overflowed = true;
      }
    },
  };
}

function captureProviderArrayLength(candidate: readonly unknown[]): number {
  const length = candidate.length;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new ContentTraversalLimitError();
  }
  return length;
}

function consumeProviderProjectionWork(
  budget: ProviderProjectionWorkBudget,
  requested: number,
): boolean {
  if (!Number.isSafeInteger(requested) || requested < 0 || requested > budget.remaining) {
    budget.overflowed = true;
    return false;
  }
  budget.remaining -= requested;
  return true;
}

function markProviderProjectionWorkOverflow(budget: ProviderProjectionWorkBudget): void {
  budget.overflowed = true;
}

/**
 * Compatibility bridge for @librechat/agents 3.6.9. Its summarization,
 * fallback, and subagent recovery paths intentionally rethrow stream-safety
 * errors but recover from ordinary model callback errors. A provider-bound
 * policy rejection is likewise non-recoverable, so wrapping it in the one
 * fatal class understood by that SDK keeps every execution path fail-closed.
 * Remove this bridge once the SDK exposes a generic fatal callback error.
 */
class FatalModelBoundPolicyError extends StreamLimitExceededError {
  public readonly code: ModelBoundPolicyError['code'];
  public readonly statusCode: ModelBoundPolicyError['statusCode'];
  public readonly body: ModelBoundPolicyError['body'];
  public override readonly cause: ModelBoundPolicyError;

  constructor(error: ModelBoundPolicyError) {
    super({ kind: 'delta_events', limit: 0, observed: 0 });
    this.name = error.name;
    this.message = error.message;
    this.code = error.code;
    this.statusCode = error.statusCode;
    this.body = error.body;
    this.cause = error;
    Object.setPrototypeOf(this, FatalModelBoundPolicyError.prototype);
  }
}

export interface ModelBoundProviderContentInput {
  readonly onTraversalFailure?: LocatorTraversalReporter;
  readonly filters?: FiltersConfig;
  readonly legacyPii?: MessageFilterPiiConfig;
  readonly providerMessages: readonly ModelBoundProviderMessage[];
  readonly storedMessages?: readonly (StoredModelBoundMessage | null | undefined)[];
  readonly resolvedFiles?: readonly (ModelBoundCanonicalFile | null | undefined)[];
  /** Canonical files actually materialized for each persisted source row. */
  readonly fileIdsBySourceMessageId?: ReadonlyMap<string, readonly string[]>;
  /** A bounded upstream source/file projection was incomplete. */
  readonly sourceFileProjectionOverflowed?: boolean;
}

type ModelBoundFileReference = { readonly file_id?: string } | null | undefined;

export interface ModelBoundSourceFileInput {
  readonly messageFilesBySourceMessageId?: Readonly<
    Record<string, readonly ModelBoundFileReference[] | null | undefined>
  >;
  readonly sourceMessages?: readonly (
    | { readonly messageId?: string; readonly id?: string }
    | null
    | undefined
  )[];
  readonly steerFileIdsBySourceMessageId?: ReadonlyMap<
    string,
    readonly string[] | ReadonlySet<string>
  >;
  readonly replayHistoricalFiles: boolean;
  readonly historicalFiles?:
    | readonly (ModelBoundCanonicalFile | null | undefined)[]
    | ReadonlyMap<string, ModelBoundCanonicalFile | null | undefined>;
  readonly processedCurrentFiles?: readonly (ModelBoundCanonicalFile | null | undefined)[];
  readonly canonicalCurrentFiles?: readonly (ModelBoundCanonicalFile | null | undefined)[];
  readonly initiallyOverflowed?: boolean;
}

export interface ModelBoundSourceFileProjection {
  readonly fileIdsBySourceMessageId: ReadonlyMap<string, readonly string[]>;
  readonly resolvedFiles: readonly ModelBoundCanonicalFile[];
  readonly overflowed: boolean;
}

export interface ModelBoundHistoricalFileIdState {
  readonly fileIds: string[];
  readonly overflowed: boolean;
}

/** Collects every provider-supported persisted file locator for owner hydration. */
export function collectModelBoundHistoricalFileIdState(
  messages: readonly (StoredMessageContentInput | null | undefined)[],
): ModelBoundHistoricalFileIdState {
  const fileIds = new Set<string>();
  const budget: ProviderProjectionWorkBudget = {
    remaining: MAX_PROVIDER_PROJECTION_WORK,
    overflowed: false,
  };
  const appendFileId = (candidate: unknown): boolean => {
    if (!consumeProviderProjectionWork(budget, 1)) {
      return false;
    }
    if (typeof candidate !== 'string') {
      return true;
    }
    const fileId = candidate.trim();
    if (fileId.length > 0) {
      fileIds.add(fileId);
    }
    return true;
  };
  const appendReference = (reference: ModelBoundFileReference): boolean =>
    appendFileId(reference?.file_id);
  const appendReferences = (
    references: readonly ModelBoundFileReference[] | null | undefined,
  ): void => {
    try {
      if (!Array.isArray(references)) {
        return;
      }
      const referenceCount = captureProviderArrayLength(references);
      let index = 0;
      for (; index < referenceCount; index++) {
        if (!appendReference(references[index])) {
          break;
        }
      }
      if (index < referenceCount) {
        markProviderProjectionWorkOverflow(budget);
      }
    } catch {
      markProviderProjectionWorkOverflow(budget);
    }
  };
  let messageCount = 0;
  try {
    const messageLength = captureProviderArrayLength(messages);
    messageCount = Math.min(messageLength, MAX_PROVIDER_PROJECTION_WORK);
    if (messageLength > messageCount) {
      markProviderProjectionWorkOverflow(budget);
    }
  } catch {
    return { fileIds: [], overflowed: true };
  }
  let messageIndex = 0;
  for (; messageIndex < messageCount && budget.remaining > 0; messageIndex++) {
    try {
      const message = messages[messageIndex];
      if (message == null) {
        continue;
      }
      appendReferences(message.files);
      appendReferences(message.attachments);
      const contentCandidate = message.content;
      if (!Array.isArray(contentCandidate)) {
        continue;
      }
      const contentCount = captureProviderArrayLength(contentCandidate);
      const contentBudget = createMessageWorkBudget(budget, contentCandidate);
      let contentIndex = 0;
      for (; contentIndex < contentCount; contentIndex++) {
        if (!consumeProviderProjectionWork(contentBudget, 1)) {
          break;
        }
        const part = contentCandidate[contentIndex];
        if (part == null) {
          continue;
        }
        appendReferences(part.files);
        const imageFile = part.image_file;
        if (imageFile != null) {
          appendReference(imageFile);
        }
        const file = part.file;
        if (file != null) {
          appendReference(file);
        }
        const directFileId = part.file_id;
        if (typeof directFileId === 'string') {
          appendFileId(directFileId);
        }
      }
      if (contentIndex < contentCount) {
        markProviderProjectionWorkOverflow(budget);
      }
    } catch {
      markProviderProjectionWorkOverflow(budget);
    }
  }
  if (messageIndex < messageCount) {
    markProviderProjectionWorkOverflow(budget);
  }
  return { fileIds: [...fileIds], overflowed: budget.overflowed };
}

/** Backward-compatible ID-only view for callers that do not enforce model-bound content. */
export function collectModelBoundHistoricalFileIds(
  messages: readonly (StoredMessageContentInput | null | undefined)[],
): string[] {
  return collectModelBoundHistoricalFileIdState(messages).fileIds;
}

/**
 * Builds the security-sensitive provider source/file association in typed
 * backend code. Legacy clients supply runtime state only; this helper owns
 * source normalization, deduplication, replay selection, and canonical-row
 * precedence for the final model-bound guard.
 */
export function projectModelBoundSourceFiles(
  input: ModelBoundSourceFileInput,
): ModelBoundSourceFileProjection {
  const fileIdsBySourceMessageId = new Map<string, Set<string>>();
  let overflowed = input.initiallyOverflowed === true;
  let remainingAssociations = MAX_PROVIDER_PROJECTION_WORK;
  const appendFileId = (sourceMessageId: unknown, candidate: unknown): boolean => {
    if (remainingAssociations <= 0) {
      overflowed = true;
      return false;
    }
    remainingAssociations--;
    if (typeof sourceMessageId !== 'string') {
      return true;
    }
    const normalizedSourceId = sourceMessageId.trim();
    if (
      normalizedSourceId.length === 0 ||
      normalizedSourceId.length > MAX_PROVIDER_SOURCE_MESSAGE_ID_LENGTH
    ) {
      return true;
    }
    let rawFileId: unknown;
    if (typeof candidate === 'string') {
      rawFileId = candidate;
    } else if (candidate != null && typeof candidate === 'object') {
      rawFileId = (candidate as ModelBoundFileReference)?.file_id;
    }
    if (typeof rawFileId !== 'string') {
      return true;
    }
    const fileId = rawFileId.trim();
    if (fileId.length === 0) {
      return true;
    }
    const fileIds = fileIdsBySourceMessageId.get(normalizedSourceId) ?? new Set<string>();
    fileIds.add(fileId);
    fileIdsBySourceMessageId.set(normalizedSourceId, fileIds);
    return true;
  };
  const appendFileIdArray = (sourceMessageId: unknown, candidate: unknown): void => {
    try {
      if (!Array.isArray(candidate)) {
        if (candidate != null) {
          overflowed = true;
        }
        return;
      }
      const candidateLength = captureProviderArrayLength(candidate);
      let index = 0;
      for (; index < candidateLength; index++) {
        if (remainingAssociations <= 0) {
          overflowed = true;
          break;
        }
        if (!appendFileId(sourceMessageId, candidate[index])) {
          break;
        }
      }
      if (index < candidateLength) {
        overflowed = true;
      }
    } catch {
      overflowed = true;
    }
  };
  const appendSteerFileIds = (sourceMessageId: unknown, candidate: unknown): void => {
    try {
      if (Array.isArray(candidate)) {
        appendFileIdArray(sourceMessageId, candidate);
        return;
      }
      if (!(candidate instanceof Set)) {
        if (candidate != null) {
          overflowed = true;
        }
        return;
      }
      const values = Set.prototype.values.call(candidate) as IterableIterator<string>;
      while (remainingAssociations > 0) {
        const next = values.next();
        if (next.done) {
          return;
        }
        appendFileId(sourceMessageId, next.value);
      }
      if (!values.next().done) {
        overflowed = true;
      }
    } catch {
      overflowed = true;
    }
  };
  const appendSourceMessageFiles = (
    messageFiles: Readonly<Record<string, readonly ModelBoundFileReference[] | null | undefined>>,
    sourceMessageId: unknown,
  ): void => {
    if (
      typeof sourceMessageId === 'string' &&
      Object.prototype.hasOwnProperty.call(messageFiles, sourceMessageId)
    ) {
      appendFileIdArray(sourceMessageId, messageFiles[sourceMessageId]);
    }
  };

  try {
    const messageFiles = input.messageFilesBySourceMessageId;
    if (messageFiles != null) {
      const sourceMessages = input.sourceMessages;
      if (!Array.isArray(sourceMessages)) {
        overflowed = true;
      } else {
        const sourceMessageLength = captureProviderArrayLength(sourceMessages);
        const sourceMessageCount = Math.min(sourceMessageLength, MAX_PROVIDER_PROJECTION_WORK);
        if (sourceMessageLength > sourceMessageCount) {
          overflowed = true;
        }
        for (let index = 0; index < sourceMessageCount; index++) {
          const message = sourceMessages[index];
          if (message == null) {
            continue;
          }
          const messageId = message.messageId;
          const id = message.id;
          appendSourceMessageFiles(messageFiles, messageId);
          if (id !== messageId) {
            appendSourceMessageFiles(messageFiles, id);
          }
        }
      }
    }
  } catch {
    overflowed = true;
  }
  try {
    const steerFiles = input.steerFileIdsBySourceMessageId;
    if (steerFiles != null) {
      if (!(steerFiles instanceof Map)) {
        overflowed = true;
      } else {
        const entries = Map.prototype.entries.call(steerFiles) as IterableIterator<
          [string, readonly string[] | ReadonlySet<string>]
        >;
        let entryCount = 0;
        while (entryCount < MAX_PROVIDER_PROJECTION_WORK) {
          const next = entries.next();
          if (next.done) {
            break;
          }
          entryCount++;
          appendSteerFileIds(next.value[0], next.value[1]);
        }
        if (entryCount === MAX_PROVIDER_PROJECTION_WORK && !entries.next().done) {
          overflowed = true;
        }
      }
    }
  } catch {
    overflowed = true;
  }

  const resolvedFilesById = new Map<string, ModelBoundCanonicalFile>();
  let remainingResolvedFiles = MAX_PROVIDER_PROJECTION_WORK;
  const appendResolvedFile = (file: unknown): boolean => {
    if (remainingResolvedFiles <= 0) {
      overflowed = true;
      return false;
    }
    remainingResolvedFiles--;
    if (file == null || typeof file !== 'object') {
      return true;
    }
    const candidate = file as ModelBoundCanonicalFile;
    const rawFileId = candidate.file_id;
    if (typeof rawFileId !== 'string') {
      return true;
    }
    const fileId = rawFileId.trim();
    if (fileId.length > 0) {
      resolvedFilesById.set(fileId, candidate);
    }
    return true;
  };
  const appendResolvedFiles = (candidate: unknown): void => {
    try {
      if (candidate == null) {
        return;
      }
      if (Array.isArray(candidate)) {
        const fileLength = captureProviderArrayLength(candidate);
        let index = 0;
        for (; index < fileLength; index++) {
          if (remainingResolvedFiles <= 0) {
            overflowed = true;
            break;
          }
          if (!appendResolvedFile(candidate[index])) {
            break;
          }
        }
        if (index < fileLength) {
          overflowed = true;
        }
        return;
      }
      if (!(candidate instanceof Map)) {
        overflowed = true;
        return;
      }
      const values = Map.prototype.values.call(candidate) as IterableIterator<
        ModelBoundCanonicalFile | null | undefined
      >;
      while (remainingResolvedFiles > 0) {
        const next = values.next();
        if (next.done) {
          return;
        }
        appendResolvedFile(next.value);
      }
      if (!values.next().done) {
        overflowed = true;
      }
    } catch {
      overflowed = true;
    }
  };
  if (input.replayHistoricalFiles) {
    appendResolvedFiles(input.historicalFiles);
  }
  appendResolvedFiles(input.processedCurrentFiles);
  /** Canonical current rows come last so OCR/extraction coverage survives
   * provider encoding that intentionally reduces transport metadata. */
  appendResolvedFiles(input.canonicalCurrentFiles);

  const projectedFileIds = new Map<string, string[]>();
  for (const [sourceMessageId, fileIds] of fileIdsBySourceMessageId) {
    projectedFileIds.set(sourceMessageId, [...fileIds]);
  }
  return {
    fileIdsBySourceMessageId: projectedFileIds,
    resolvedFiles: [...resolvedFilesById.values()],
    overflowed,
  };
}

export interface ModelBoundChatModelCallback {
  readonly name: 'librechat-model-bound-content-filter';
  readonly raiseError: true;
  readonly awaitHandlers: true;
  readonly handleChatModelStart: (
    llm: object | undefined,
    messageBatches: readonly (readonly ModelBoundProviderMessage[])[],
  ) => void;
}

export interface InitialModelBoundAdmissionCallback {
  readonly name: 'librechat-initial-model-bound-admission';
  readonly raiseError: true;
  readonly awaitHandlers: true;
  readonly handleChatModelStart: (
    llm: object | undefined,
    messageBatches: readonly (readonly ModelBoundProviderMessage[])[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
  ) => void;
  readonly handleChainStart: (
    chain: object | undefined,
    inputs: unknown,
    runId: string,
    /** CallbackManager dispatches parentRunId here at runtime even though
     * BaseCallbackHandlerMethodsClass's published declaration labels this
     * position runType. Keep this signature aligned with manager dispatch. */
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runType?: string,
    runName?: string,
    extra?: Record<string, unknown>,
  ) => void;
  readonly handleLLMEnd: (output: unknown, runId: string) => void;
  readonly handleLLMError: (error: unknown, runId: string) => void;
  readonly handleChainEnd: (outputs: unknown, runId: string) => void;
  readonly handleChainError: (error: unknown, runId: string) => void;
}

export interface InitialModelBoundAdmission {
  readonly agentIds: readonly string[];
  readonly isActive: () => boolean;
  readonly onAllowed: () => void;
}

export interface ModelBoundContentInput {
  readonly onTraversalFailure?: LocatorTraversalReporter;
  readonly filters?: FiltersConfig;
  readonly legacyPii?: MessageFilterPiiConfig;
  /** Fresh API input: every role is caller-submitted. */
  readonly submittedMessages?: readonly ModelBoundMessage[];
  /** Persisted chat history: user rows plus structured tool fragments are re-inspected. */
  readonly storedMessages?: readonly StoredModelBoundMessage[];
  readonly agents?: readonly (AgentContentInput | null | undefined)[];
  readonly assistants?: readonly (AssistantContentInput | null | undefined)[];
  readonly actions?: readonly (AssistantActionContentInput | null | undefined)[];
  readonly skills?: readonly (SkillContentInput | null | undefined)[];
  readonly memories?: readonly (MemoryContentInput | string | null | undefined)[];
  readonly files?: readonly (FileContentInput | string | null | undefined)[];
  /**
   * Owner-scoped canonical file rows that authorize durable file locators in
   * stored messages. The rows are inspected before their IDs are omitted from
   * the fail-close traversal copy.
   */
  readonly resolvedFiles?: readonly (ModelBoundCanonicalFile | null | undefined)[];
  /** Internal fail-closed provenance errors evaluated after files and findings. */
  readonly deferredTraversalErrors?: readonly ContentTraversalLimitError[];
  /** Internal aggregate nested-work budget shared by one provider callback invocation. */
  readonly traversalBudget?: VisitNestedStringsBudget;
}

/**
 * Whether a policy can inspect content at a model/provider boundary.
 * Management-only sources and attribution behavior do not activate this gate.
 */
export function hasModelBoundContentProtection(
  filters: FiltersConfig | null | undefined,
  legacyPii?: MessageFilterPiiConfig | null,
): boolean {
  return (
    hasActivePiiPatterns(legacyPii) ||
    hasActivePiiPatterns(filters?.messages?.pii) ||
    hasActivePiiPatterns(filters?.agentInstructions?.pii) ||
    hasActivePiiPatterns(filters?.conversationStarters?.pii) ||
    hasActivePiiPatterns(filters?.skills?.pii) ||
    hasActivePiiPatterns(filters?.memories?.pii) ||
    hasActiveFilePolicy(filters ?? undefined) ||
    hasActivePiiPatterns(filters?.toolArguments?.pii) ||
    hasActivePiiPatterns(filters?.modelParameters?.pii) ||
    hasActivePiiPatterns(filters?.actionMetadata?.pii)
  );
}

function normalizeRole(message: {
  readonly role?: string;
  readonly _getType?: () => string;
}): string | undefined {
  const rawRole = message.role ?? message._getType?.();
  switch (rawRole) {
    case 'human':
      return 'user';
    case 'ai':
      return 'assistant';
    default:
      return rawRole;
  }
}

function assertInspectableFileInput(filters: FiltersConfig | undefined, input: unknown): void {
  const field = getBlockedOpaqueFileField(filters, input);
  if (field != null) {
    throw new UninspectableFileError(field);
  }
}

type RuntimeAgentFileContainer = AgentContentInput & {
  readonly attachments?: readonly (FileContentInput | null | undefined)[];
  readonly requestAttachments?: readonly (FileContentInput | null | undefined)[];
  readonly agentContextAttachments?: readonly (FileContentInput | null | undefined)[];
  readonly tool_resources?: Readonly<
    Record<
      string,
      | {
          readonly files?: readonly (FileContentInput | null | undefined)[];
        }
      | null
      | undefined
    >
  >;
};

function getHydratedAgentFiles(
  agent: AgentContentInput | null | undefined,
): ModelBoundCanonicalFile[] {
  if (agent == null) {
    return [];
  }
  const runtimeAgent = agent as RuntimeAgentFileContainer;
  const files: ModelBoundCanonicalFile[] = [];
  const append = (values: readonly (FileContentInput | null | undefined)[] | undefined) => {
    for (const file of values ?? []) {
      if (file != null) {
        files.push(file);
      }
    }
  };
  append(runtimeAgent.attachments);
  append(runtimeAgent.requestAttachments);
  append(runtimeAgent.agentContextAttachments);
  for (const resource of Object.values(runtimeAgent.tool_resources ?? {})) {
    append(resource?.files);
  }
  return files;
}

function isFragmentWithinPath(fragment: TextContentFragment, path: JsonPointer): boolean {
  return fragment.path === path || fragment.path.startsWith(`${path}/`);
}

function isFragmentWithinSubmittedPaths(
  fragment: TextContentFragment,
  submittedPaths: ReadonlySet<string>,
): boolean {
  let candidate = fragment.path as string;
  while (candidate.length > 0) {
    if (submittedPaths.has(candidate)) {
      return true;
    }
    const separator = candidate.lastIndexOf('/');
    if (separator <= 0) {
      return false;
    }
    candidate = candidate.slice(0, separator);
  }
  return false;
}

function asUserSubmittedMessageFragment(
  fragment: Extract<TextContentFragment, { source: 'tool_argument' }>,
): Extract<TextContentFragment, { source: 'message' }> {
  return {
    ...fragment,
    id: `${fragment.id}.user-submitted-message`,
    source: 'message',
    field: 'content_part',
    treatment: 'inspect_only',
  };
}

function getExactUserSubmittedMessageFragments(
  fragments: readonly TextContentFragment[],
  entries: readonly UserSubmittedMessageFieldPath[],
): Array<Extract<TextContentFragment, { source: 'message' }>> {
  const exact: Array<Extract<TextContentFragment, { source: 'message' }>> = [];
  const seen = new Set<string>();
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex];
    const path = entry.path as JsonPointer;
    for (const fragment of fragments) {
      if (
        (fragment.source !== 'message' && fragment.source !== 'tool_argument') ||
        !isFragmentWithinPath(fragment, path)
      ) {
        continue;
      }
      const key = `${entry.field}:${fragment.path}:${fragment.text}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      exact.push({
        ...fragment,
        id: `${fragment.id}.user-submitted-${entry.field}.${entryIndex}`,
        source: 'message',
        field: entry.field,
        treatment: 'inspect_only',
        provenance: 'user',
      });
    }
  }
  return exact;
}

/**
 * Rebuilds the model-equivalent aggregate from user-authored leaves only.
 * The stored adapter's aggregate spans the whole message, so using it for a
 * mixed assistant row would either include model prose or miss leaf-level
 * provenance marks rooted below `/content`.
 */
function createUserSubmittedAssembledContext(
  text: readonly string[],
  materializationBudget: VisitNestedStringsBudget,
): {
  readonly fragment?: Extract<TextContentFragment, { source: 'assembled_context' }>;
  readonly overflowed: boolean;
} {
  if (text.length === 0) {
    return { overflowed: false };
  }
  let materializedCharacters = 0;
  for (const value of text) {
    materializedCharacters += value.length;
    if (!Number.isSafeInteger(materializedCharacters)) {
      return { overflowed: true };
    }
  }
  if (
    text.length > 1 &&
    !reserveContentMaterialization(materializationBudget, materializedCharacters)
  ) {
    return { overflowed: true };
  }
  return {
    fragment: {
      id: 'stored-message.user-submitted-assembled',
      path: '/$assembled/user-submitted',
      text: text.length === 1 ? text[0] : text.join(''),
      source: 'assembled_context',
      field: 'assembled_context',
      format: 'plain',
      treatment: 'inspect_only',
      provenance: 'user',
    },
    overflowed: false,
  };
}

/**
 * Builds a sparse object containing only marked fields while retaining their
 * original keys and ancestry. File fail-close checks need that shape to
 * distinguish, for example, a submitted `file_id` from unrelated model data.
 */
function projectUserSubmittedPaths(
  message: StoredModelBoundMessage,
  paths: readonly JsonPointer[],
): Record<string, unknown> | undefined {
  const projection = Object.create(null) as Record<string, unknown>;
  let projected = false;

  for (const path of paths) {
    const segments = getSafeUserSubmittedPathSegments(path);
    if (segments == null) {
      continue;
    }

    let source: unknown = message;
    for (const segment of segments) {
      if (
        source == null ||
        typeof source !== 'object' ||
        !Object.prototype.hasOwnProperty.call(source, segment)
      ) {
        source = undefined;
        break;
      }
      source = (source as Record<string, unknown>)[segment];
    }
    if (source === undefined) {
      continue;
    }

    let target: Record<string, unknown> | unknown[] = projection;
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      if (index === segments.length - 1) {
        (target as Record<string, unknown>)[segment] = source;
        projected = true;
        break;
      }
      const nextSegment = segments[index + 1];
      const existing = (target as Record<string, unknown>)[segment];
      if (existing == null || typeof existing !== 'object') {
        (target as Record<string, unknown>)[segment] = /^\d+$/.test(nextSegment)
          ? []
          : Object.create(null);
      }
      target = (target as Record<string, unknown>)[segment] as Record<string, unknown> | unknown[];
    }
  }

  return projected ? projection : undefined;
}

function extractExactUserSubmittedMessageFragments(
  message: StoredModelBoundMessage,
  entries: readonly UserSubmittedMessageFieldPath[],
  traversalBudget?: VisitNestedStringsBudget,
): {
  fragments: Array<Extract<TextContentFragment, { source: 'message' }>>;
  traversalError: ContentTraversalLimitError | null;
} {
  const projectedMessage = projectUserSubmittedPaths(
    message,
    entries.map((entry) => entry.path as JsonPointer),
  );
  if (projectedMessage == null) {
    return { fragments: [], traversalError: null };
  }
  let projectedFragments: readonly TextContentFragment[];
  let traversalError: ContentTraversalLimitError | null = null;
  try {
    projectedFragments = extractStoredMessageContent(projectedMessage, traversalBudget);
  } catch (error) {
    if (!isContentTraversalLimitError(error)) {
      throw error;
    }
    traversalError = error;
    projectedFragments = getContentTraversalFragments(error);
  }
  return {
    fragments: getExactUserSubmittedMessageFragments(projectedFragments, entries),
    traversalError,
  };
}

function appendSourceMessageId(sourceIds: Set<string>, candidate: string | undefined): void {
  if (typeof candidate !== 'string') {
    return;
  }
  const normalized = candidate.trim();
  if (normalized.length > 0) {
    sourceIds.add(normalized);
  }
}

interface ModelBoundProviderProvenanceState {
  readonly orderedContributions?: OrderedProviderSourceContributions;
  readonly invalid: boolean;
}

interface LegacyProviderLineage {
  readonly sourceIds: ReadonlySet<string>;
  readonly hasPluralLineage: boolean;
  readonly invalid: boolean;
}

interface ProviderSourceContribution {
  readonly attribution: ModelBoundProviderAttribution;
  readonly sourceMessageId: string;
  readonly selectedContentPartIndices?: ReadonlySet<number>;
}

interface OrderedProviderSourceContributions {
  readonly contributions: readonly ProviderSourceContribution[];
  readonly hasUserAttribution: boolean;
  readonly hasToolAttribution: boolean;
}

function normalizeProviderSourceMessageId(candidate: unknown): string | undefined {
  if (typeof candidate !== 'string') {
    return undefined;
  }
  const sourceMessageId = candidate.trim();
  if (
    sourceMessageId.length === 0 ||
    sourceMessageId.length > MAX_PROVIDER_SOURCE_MESSAGE_ID_LENGTH
  ) {
    return undefined;
  }
  return sourceMessageId;
}

function getProviderMessageProvenanceState(
  message: ModelBoundProviderMessage,
  parentBudget: ProviderProjectionWorkBudget,
): ModelBoundProviderProvenanceState {
  const candidate: unknown = message.additional_kwargs?.provenance;
  if (candidate == null) {
    return { invalid: false };
  }
  if (typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { invalid: true };
  }
  const value = candidate as { readonly version?: unknown; readonly parts?: unknown };
  const version = value.version;
  const candidateParts = value.parts;
  if (version !== 1 || !Array.isArray(candidateParts)) {
    return { invalid: true };
  }
  const budget = createMessageWorkBudget(
    parentBudget,
    candidateParts,
    MAX_PROVIDER_PROVENANCE_PARSE_WORK,
  );
  let candidatePartCount: number;
  try {
    candidatePartCount = captureProviderArrayLength(candidateParts);
  } catch {
    markProviderProjectionWorkOverflow(budget);
    return { invalid: true };
  }
  if (candidatePartCount === 0 || candidatePartCount > MAX_PROVIDER_PROVENANCE_PARTS) {
    return { invalid: true };
  }

  const contributions: Array<{
    attribution: ModelBoundProviderAttribution;
    sourceMessageId: string;
    selectedContentPartIndices?: Set<number>;
  }> = [];
  let hasUserAttribution = false;
  let hasToolAttribution = false;
  let totalIndexRefs = 0;
  for (let partIndex = 0; partIndex < candidatePartCount; partIndex++) {
    if (!consumeProviderProjectionWork(budget, 1)) {
      return { invalid: true };
    }
    const candidatePart = candidateParts[partIndex];
    if (
      candidatePart == null ||
      typeof candidatePart !== 'object' ||
      Array.isArray(candidatePart)
    ) {
      return { invalid: true };
    }
    const part = candidatePart as {
      readonly attribution?: unknown;
      readonly sourceMessageId?: unknown;
      readonly sourceContentPartIndices?: unknown;
    };
    const attribution = part.attribution;
    const candidateSourceMessageId = part.sourceMessageId;
    const candidateSourceContentPartIndices = part.sourceContentPartIndices;
    if (
      typeof attribution !== 'string' ||
      !PROVIDER_PROVENANCE_ATTRIBUTIONS.has(attribution as ModelBoundProviderAttribution)
    ) {
      return { invalid: true };
    }
    let sourceMessageId: string | undefined;
    if (candidateSourceMessageId !== undefined) {
      sourceMessageId = normalizeProviderSourceMessageId(candidateSourceMessageId);
      if (sourceMessageId == null) {
        return { invalid: true };
      }
    }
    let sourceContentPartIndices: Set<number> | undefined;
    if (candidateSourceContentPartIndices !== undefined) {
      if (!Array.isArray(candidateSourceContentPartIndices)) {
        return { invalid: true };
      }
      let candidateIndexCount: number;
      try {
        candidateIndexCount = captureProviderArrayLength(candidateSourceContentPartIndices);
      } catch {
        markProviderProjectionWorkOverflow(budget);
        return { invalid: true };
      }
      if (candidateIndexCount === 0 || candidateIndexCount > MAX_PROVIDER_SOURCE_PART_INDICES) {
        return { invalid: true };
      }
      totalIndexRefs += candidateIndexCount;
      if (totalIndexRefs > MAX_PROVIDER_PROVENANCE_INDEX_REFS) {
        return { invalid: true };
      }
      if (
        !consumeProviderProjectionWork(
          isProxy(candidateSourceContentPartIndices) ? parentBudget : budget,
          candidateIndexCount,
        )
      ) {
        return { invalid: true };
      }
      sourceContentPartIndices = new Set<number>();
      for (let indexPosition = 0; indexPosition < candidateIndexCount; indexPosition++) {
        const index = candidateSourceContentPartIndices[indexPosition];
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index > MAX_PROVIDER_SOURCE_CONTENT_PART_INDEX
        ) {
          return { invalid: true };
        }
        sourceContentPartIndices.add(index);
      }
    }
    const normalizedAttribution = attribution as ModelBoundProviderAttribution;
    hasUserAttribution ||= normalizedAttribution === 'user';
    hasToolAttribution ||= normalizedAttribution === 'tool';
    if (sourceMessageId == null) {
      continue;
    }
    const existing = contributions[contributions.length - 1];
    if (
      existing == null ||
      existing.attribution !== normalizedAttribution ||
      existing.sourceMessageId !== sourceMessageId
    ) {
      contributions.push({
        attribution: normalizedAttribution,
        sourceMessageId,
        ...(sourceContentPartIndices != null && {
          selectedContentPartIndices: sourceContentPartIndices,
        }),
      });
      continue;
    }
    if (existing.selectedContentPartIndices == null) {
      continue;
    }
    if (sourceContentPartIndices == null) {
      delete existing.selectedContentPartIndices;
      continue;
    }
    for (const index of sourceContentPartIndices) {
      existing.selectedContentPartIndices.add(index);
    }
  }
  return {
    orderedContributions: { contributions, hasUserAttribution, hasToolAttribution },
    invalid: false,
  };
}

function getLegacyProviderLineage(
  message: ModelBoundProviderMessage,
  parentBudget: ProviderProjectionWorkBudget,
): LegacyProviderLineage {
  const sourceIds = new Set<string>();
  let invalid = false;
  let hasPluralLineage = false;
  const pluralCandidate: unknown = message.additional_kwargs?.sourceMessageIds;
  const budget = createMessageWorkBudget(
    parentBudget,
    pluralCandidate,
    MAX_PROVIDER_PROVENANCE_PARSE_WORK,
  );
  if (pluralCandidate != null) {
    if (!Array.isArray(pluralCandidate)) {
      invalid = true;
    } else {
      let sourceMessageIdCount: number;
      try {
        sourceMessageIdCount = captureProviderArrayLength(pluralCandidate);
      } catch {
        markProviderProjectionWorkOverflow(budget);
        invalid = true;
        sourceMessageIdCount = 0;
      }
      if (sourceMessageIdCount > MAX_PROVIDER_SOURCE_MESSAGE_IDS) {
        invalid = true;
      } else {
        hasPluralLineage = sourceMessageIdCount > 0;
        for (let index = 0; index < sourceMessageIdCount; index++) {
          if (!consumeProviderProjectionWork(budget, 1)) {
            invalid = true;
            break;
          }
          const candidate = pluralCandidate[index];
          const sourceMessageId = normalizeProviderSourceMessageId(candidate);
          if (sourceMessageId == null) {
            invalid = true;
            continue;
          }
          sourceIds.add(sourceMessageId);
        }
      }
    }
  }
  const appendCandidate = (candidate: unknown): void => {
    if (candidate == null) {
      return;
    }
    if (!consumeProviderProjectionWork(budget, 1)) {
      invalid = true;
      return;
    }
    const sourceMessageId = normalizeProviderSourceMessageId(candidate);
    if (sourceMessageId == null) {
      invalid = true;
      return;
    }
    sourceIds.add(sourceMessageId);
  };
  appendCandidate(message.additional_kwargs?.sourceMessageId);
  appendCandidate(message.messageId);
  appendCandidate(message.id);
  return { sourceIds, hasPluralLineage, invalid };
}

function isLegacyArtifactProjectionMarker(content: unknown): boolean {
  if (content === LEGACY_ARTIFACT_PROJECTION_MARKER) {
    return true;
  }
  if (!Array.isArray(content) || content.length !== 1) {
    return false;
  }
  const part = content[0];
  if (part == null || typeof part !== 'object') {
    return false;
  }
  const value = part as { readonly text?: unknown; readonly content?: unknown };
  return (
    value.text === LEGACY_ARTIFACT_PROJECTION_MARKER ||
    value.content === LEGACY_ARTIFACT_PROJECTION_MARKER
  );
}

/** @librechat/agents 3.6.9 projects artifact-bearing ToolMessages into an
 * untyped terminal HumanMessage. Recognize only that generated adjacency and
 * exact marker; ordinary untyped HumanMessages must retain user attribution. */
function isLegacyArtifactProjectionHuman(
  messages: readonly ModelBoundProviderMessage[],
  roles: readonly (string | undefined)[],
  contents: readonly unknown[],
  index: number,
  provenanceState: ModelBoundProviderProvenanceState,
  legacyLineage: LegacyProviderLineage,
): boolean {
  const message = messages[index];
  if (
    message == null ||
    index !== messages.length - 1 ||
    provenanceState.orderedContributions != null ||
    provenanceState.invalid ||
    roles[index] !== 'user' ||
    legacyLineage.invalid ||
    message.additional_kwargs?.sourceMessageId != null ||
    message.additional_kwargs?.sourceMessageIds != null ||
    message.messageId != null
  ) {
    return false;
  }
  const metadata = message.additional_kwargs;
  if (metadata?.isMeta === true || metadata?.injected === true || metadata?.source != null) {
    return false;
  }
  for (let previousIndex = index - 1; previousIndex >= 0; previousIndex--) {
    if (roles[previousIndex] !== 'tool') {
      break;
    }
    if (isLegacyArtifactProjectionMarker(contents[previousIndex])) {
      return true;
    }
  }
  return false;
}

function getLegacyCoalescedCanonicalScopes(
  filters: FiltersConfig | undefined,
): ContentTraversalScope[] {
  const scopes: ContentTraversalScope[] = [];
  const messagePii = filters?.messages?.pii;
  const selectedHitlFields = HITL_MESSAGE_FILTER_FIELDS.filter(
    (field) => messagePii?.fields == null || messagePii.fields.includes(field),
  );
  if (selectedHitlFields.length > 0 && hasActivePiiFields(messagePii, selectedHitlFields)) {
    scopes.push({
      source: 'message',
      fields: selectedHitlFields,
    });
  }

  const filePii = filters?.files?.pii;
  const selectedFileFields = FILE_FILTER_FIELDS.filter(
    (field) => filePii?.fields == null || filePii.fields.includes(field),
  );
  if (
    selectedFileFields.length > 0 &&
    (hasActivePiiFields(filePii, selectedFileFields) ||
      getBlockedUninspectableFileField(filters, selectedFileFields) != null)
  ) {
    scopes.push({ source: 'file', fields: selectedFileFields });
  }
  return scopes;
}

function getLegacyCoalescedLineageError(
  input: ModelBoundProviderContentInput,
  providerRole: string | undefined,
  matchedStoredMessages: ReadonlySet<StoredModelBoundMessage>,
  provenanceState: ModelBoundProviderProvenanceState,
  legacyLineage: LegacyProviderLineage,
): ContentTraversalLimitError | null {
  if (provenanceState.orderedContributions != null) {
    return null;
  }
  const hasInvalidLineage = provenanceState.invalid || legacyLineage.invalid;
  const hasAmbiguousLegacyCoalescing =
    providerRole === 'user' && !legacyLineage.hasPluralLineage && matchedStoredMessages.size >= 2;
  if (!hasInvalidLineage && !hasAmbiguousLegacyCoalescing) {
    return null;
  }
  const scopes = getLegacyCoalescedCanonicalScopes(input.filters);
  if (scopes.length > 0) {
    return new ContentTraversalLimitError([], scopes);
  }
  return null;
}

function getStoredMessageIds(message: StoredModelBoundMessage): Set<string> {
  const messageIds = new Set<string>();
  appendSourceMessageId(messageIds, message.messageId);
  appendSourceMessageId(messageIds, message.id);
  return messageIds;
}

function appendReferencedFileIds(
  fileIds: Set<string>,
  references: readonly ({ readonly file_id?: string } | null | undefined)[] | null | undefined,
  budget: ProviderProjectionWorkBudget,
): void {
  try {
    if (!Array.isArray(references)) {
      return;
    }
    const referenceCount = captureProviderArrayLength(references);
    let index = 0;
    for (; index < referenceCount; index++) {
      if (!appendReferencedFileId(fileIds, references[index], budget)) {
        break;
      }
    }
    if (index < referenceCount) {
      markProviderProjectionWorkOverflow(budget);
    }
  } catch {
    markProviderProjectionWorkOverflow(budget);
  }
}

function appendReferencedFileId(
  fileIds: Set<string>,
  reference: { readonly file_id?: string } | null | undefined,
  budget: ProviderProjectionWorkBudget,
): boolean {
  return appendFileIdCandidate(fileIds, reference?.file_id, budget);
}

function appendFileIdCandidate(
  fileIds: Set<string>,
  candidate: unknown,
  budget: ProviderProjectionWorkBudget,
): boolean {
  if (!consumeProviderProjectionWork(budget, 1)) {
    return false;
  }
  if (typeof candidate !== 'string') {
    return true;
  }
  const fileId = candidate.trim();
  if (fileId.length > 0) {
    fileIds.add(fileId);
  }
  return true;
}

function appendPartFileIds(
  fileIds: Set<string>,
  part: NonNullable<NonNullable<StoredMessageContentInput['content']>[number]>,
  budget: ProviderProjectionWorkBudget,
) {
  try {
    appendReferencedFileIds(fileIds, part.files, budget);
    const imageFile = part.image_file;
    if (imageFile != null) {
      appendReferencedFileId(fileIds, imageFile, budget);
    }
    const file = part.file;
    if (file != null) {
      appendReferencedFileId(fileIds, file, budget);
    }
    const directFileId = part.file_id;
    if (typeof directFileId === 'string') {
      appendFileIdCandidate(fileIds, directFileId, budget);
    }
  } catch {
    markProviderProjectionWorkOverflow(budget);
  }
}

function appendStoredMessageFileIds(
  fileIds: Set<string>,
  message: StoredModelBoundMessage,
  filters: FiltersConfig | undefined,
  budget: ProviderProjectionWorkBudget,
): void {
  const submittedPathState = getUserSubmittedPathState(message);
  const role = normalizeRole(message);
  const isEntireMessageUserSubmitted =
    message.isCreatedByUser === true ||
    message.isUserSubmitted === true ||
    (role === 'user' && message.isCreatedByUser !== false && message.isUserSubmitted !== false) ||
    role === 'tool' ||
    submittedPathState.overflowed ||
    (filters?.messages?.unattributedAssistantContent === 'inspect' &&
      typeof message.isUserSubmitted !== 'boolean' &&
      submittedPathState.paths.length === 0 &&
      (message.isCreatedByUser === false || role === 'assistant'));
  if (isEntireMessageUserSubmitted) {
    appendReferencedFileIds(fileIds, message.files, budget);
  }
  const submittedFilePartIndices = new Set<number>();
  for (const path of submittedPathState.paths) {
    const segments = getSafeUserSubmittedPathSegments(path);
    if (
      segments?.[0] !== 'content' ||
      !/^\d+$/.test(segments[1] ?? '') ||
      (segments.length > 2 && !['file', 'file_id', 'files', 'image_file'].includes(segments[2]))
    ) {
      continue;
    }
    submittedFilePartIndices.add(Number(segments[1]));
  }
  try {
    const contentCandidate = message.content;
    if (!Array.isArray(contentCandidate)) {
      return;
    }
    const contentCount = captureProviderArrayLength(contentCandidate);
    const contentBudget = createMessageWorkBudget(budget, contentCandidate);
    let index = 0;
    for (; index < contentCount; index++) {
      if (!consumeProviderProjectionWork(contentBudget, 1)) {
        break;
      }
      const part = contentCandidate[index];
      if (part == null) {
        continue;
      }
      if (isEntireMessageUserSubmitted || submittedFilePartIndices.has(index)) {
        appendPartFileIds(fileIds, part, budget);
      }
    }
    if (index < contentCount) {
      markProviderProjectionWorkOverflow(budget);
    }
  } catch {
    markProviderProjectionWorkOverflow(budget);
  }
}

type ProviderExactAttribution = 'user' | 'tool' | 'non_user';

const MODEL_BOUND_CONTENT_PART_KEYS = [
  'type',
  'text',
  'think',
  'original',
  'updated',
  'steer',
  'error',
  'image_url',
  'video_url',
  'input_audio',
  'image_file',
  'file',
  'files',
  'file_id',
  'filename',
  'content',
  'tool_call',
  'data',
  'url',
  'source_type',
  'source',
  'document',
  'payload',
] as const;
const MODEL_BOUND_FILE_PART_KEYS = new Set(['file', 'files', 'image_file', 'file_id']);

interface ModelBoundPartSnapshotContext {
  readonly budget: ProviderProjectionWorkBudget;
  readonly seen: WeakMap<object, unknown>;
}

function snapshotModelBoundPartArray(
  candidate: readonly unknown[],
  context: ModelBoundPartSnapshotContext,
  snapshotItem: (value: unknown) => unknown,
): readonly unknown[] {
  const existing = context.seen.get(candidate);
  if (existing != null) {
    return existing as readonly unknown[];
  }
  const snapshot: unknown[] = [];
  context.seen.set(candidate, snapshot);
  try {
    if (isProxy(candidate)) {
      markProviderProjectionWorkOverflow(context.budget);
      return snapshot;
    }
    const length = captureProviderArrayLength(candidate);
    let index = 0;
    for (; index < length; index++) {
      if (!consumeProviderProjectionWork(context.budget, 1)) {
        break;
      }
      snapshot.push(snapshotItem(candidate[index]));
    }
    if (index < length) {
      markProviderProjectionWorkOverflow(context.budget);
    }
  } catch {
    markProviderProjectionWorkOverflow(context.budget);
  }
  return snapshot;
}

function snapshotModelBoundPartObject(
  candidate: object,
  knownKeys: readonly string[],
  context: ModelBoundPartSnapshotContext,
  snapshotValue: (key: string, value: unknown) => unknown,
  omittedKeys: ReadonlySet<string> = new Set(),
): Readonly<Record<string, unknown>> {
  const existing = context.seen.get(candidate);
  if (existing != null) {
    return existing as Readonly<Record<string, unknown>>;
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  context.seen.set(candidate, snapshot);
  const seenKeys = new Set<string>();
  let candidateIsProxy = false;
  try {
    candidateIsProxy = isProxy(candidate);
  } catch {
    markProviderProjectionWorkOverflow(context.budget);
    return snapshot;
  }
  if (candidateIsProxy) {
    markProviderProjectionWorkOverflow(context.budget);
  } else {
    const entryLimit = knownKeys.length + context.budget.remaining;
    const boundedEntries = getBoundedOwnEnumerableEntries(candidate, entryLimit);
    for (const [key, value] of boundedEntries.entries) {
      seenKeys.add(key);
      if (omittedKeys.has(key)) {
        continue;
      }
      if (!knownKeys.includes(key)) {
        if (!consumeProviderProjectionWork(context.budget, 1)) {
          break;
        }
      }
      snapshot[key] = snapshotValue(key, value);
    }
    if (!boundedEntries.complete) {
      markProviderProjectionWorkOverflow(context.budget);
    }
  }
  for (const key of knownKeys) {
    if (seenKeys.has(key) || omittedKeys.has(key)) {
      continue;
    }
    try {
      if (Object.prototype.hasOwnProperty.call(candidate, key)) {
        snapshot[key] = snapshotValue(key, (candidate as Record<string, unknown>)[key]);
      }
    } catch {
      markProviderProjectionWorkOverflow(context.budget);
    }
  }
  return snapshot;
}

function snapshotGenericModelBoundPartValue(
  value: unknown,
  context: ModelBoundPartSnapshotContext,
  depth = 0,
): unknown {
  if (value == null || typeof value !== 'object') {
    return value;
  }
  if (depth > CONTENT_TRAVERSAL_MAX_DEPTH) {
    markProviderProjectionWorkOverflow(context.budget);
    return undefined;
  }
  let valueIsArray = false;
  try {
    valueIsArray = Array.isArray(value);
  } catch {
    markProviderProjectionWorkOverflow(context.budget);
    return undefined;
  }
  if (valueIsArray) {
    return snapshotModelBoundPartArray(value as readonly unknown[], context, (item) =>
      snapshotGenericModelBoundPartValue(item, context, depth + 1),
    );
  }
  return snapshotModelBoundPartObject(value, [], context, (_key, child) =>
    snapshotGenericModelBoundPartValue(child, context, depth + 1),
  );
}

function snapshotPartWrapper(
  value: unknown,
  keys: readonly string[],
  context: ModelBoundPartSnapshotContext,
  snapshotValue: (key: string, child: unknown) => unknown = (_key, child) =>
    snapshotGenericModelBoundPartValue(child, context),
): unknown {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  return snapshotModelBoundPartObject(value, keys, context, snapshotValue);
}

function snapshotModelBoundPartProperty(
  key: string,
  value: unknown,
  context: ModelBoundPartSnapshotContext,
): unknown {
  switch (key) {
    case 'content':
      // Stabilize nested children for both extraction and later opaque-file checks.
      // The submissions adapter still owns the shared nested traversal accounting.
      return Array.isArray(value)
        ? snapshotModelBoundPartArray(value, context, (child) =>
            snapshotGenericModelBoundPartValue(child, context),
          )
        : snapshotGenericModelBoundPartValue(value, context);
    case 'text':
    case 'think':
      return snapshotPartWrapper(value, ['value'], context);
    case 'image_url':
      return snapshotPartWrapper(value, ['url', 'detail'], context);
    case 'video_url':
      return snapshotPartWrapper(value, ['url'], context);
    case 'input_audio':
      return snapshotPartWrapper(value, ['data', 'format'], context);
    case 'image_file':
      return snapshotPartWrapper(value, ['file_id', 'filename'], context);
    case 'file':
      return snapshotPartWrapper(
        value,
        [
          'file_id',
          'file_data',
          'name',
          'filename',
          'originalname',
          'filepath',
          'uri',
          'url',
          'preview',
        ],
        context,
      );
    case 'files':
      return Array.isArray(value)
        ? snapshotModelBoundPartArray(value, context, (file) =>
            snapshotPartWrapper(
              file,
              [
                'file_id',
                'file_data',
                'name',
                'filename',
                'originalname',
                'filepath',
                'uri',
                'url',
                'preview',
              ],
              context,
            ),
          )
        : value;
    case 'source':
      return snapshotPartWrapper(value, ['type', 'data', 'url'], context);
    case 'tool_call':
      return snapshotPartWrapper(
        value,
        ['name', 'args', 'arguments', 'output', 'function', 'code_interpreter'],
        context,
        (toolKey, child) => {
          if (toolKey === 'function') {
            return snapshotPartWrapper(child, ['name', 'arguments', 'output'], context);
          }
          if (toolKey === 'code_interpreter') {
            return snapshotPartWrapper(child, ['input', 'outputs'], context);
          }
          return snapshotGenericModelBoundPartValue(child, context);
        },
      );
    default:
      return snapshotGenericModelBoundPartValue(value, context);
  }
}

function snapshotModelBoundContentPart(
  part: unknown,
  budget: ProviderProjectionWorkBudget,
  options: { readonly omitFileReferences?: boolean } = {},
): unknown {
  if (part == null || typeof part !== 'object') {
    return part;
  }
  const context: ModelBoundPartSnapshotContext = {
    budget,
    seen: new WeakMap<object, unknown>(),
  };
  const snapshot = snapshotModelBoundPartObject(
    part,
    MODEL_BOUND_CONTENT_PART_KEYS,
    context,
    (key, value) => snapshotModelBoundPartProperty(key, value, context),
    options.omitFileReferences === true ? MODEL_BOUND_FILE_PART_KEYS : undefined,
  ) as Record<string, unknown>;
  return snapshot;
}

function cloneSnapshottedContentPartWithTextType(
  part: object,
  budget: ProviderProjectionWorkBudget,
): Readonly<Record<string, unknown>> {
  const snapshot = Object.create(null) as Record<string, unknown>;
  const boundedEntries = getBoundedOwnEnumerableEntries(
    part,
    MODEL_BOUND_CONTENT_PART_KEYS.length + MAX_PROVIDER_PROJECTION_WORK,
  );
  for (const [key, value] of boundedEntries.entries) {
    snapshot[key] = value;
  }
  if (!boundedEntries.complete) {
    markProviderProjectionWorkOverflow(budget);
  }
  snapshot.type = 'text';
  return snapshot;
}

function cloneSnapshottedContentPartWithoutFileReferences(
  part: unknown,
  budget: ProviderProjectionWorkBudget,
): unknown {
  if (part == null || typeof part !== 'object') {
    return part;
  }
  try {
    if (isProxy(part)) {
      markProviderProjectionWorkOverflow(budget);
      return undefined;
    }
  } catch {
    markProviderProjectionWorkOverflow(budget);
    return undefined;
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  const boundedEntries = getBoundedOwnEnumerableEntries(
    part,
    MODEL_BOUND_CONTENT_PART_KEYS.length + MAX_PROVIDER_PROJECTION_WORK,
  );
  for (const [key, value] of boundedEntries.entries) {
    if (!MODEL_BOUND_FILE_PART_KEYS.has(key)) {
      snapshot[key] = value;
    }
  }
  if (!boundedEntries.complete) {
    markProviderProjectionWorkOverflow(budget);
  }
  return snapshot;
}

function snapshotProviderMessageEnvelope(
  message: ModelBoundProviderMessage,
  budget: ProviderProjectionWorkBudget,
): SnapshottedModelBoundProviderMessage {
  const read = <Value>(getter: () => Value): Value | undefined => {
    try {
      return getter();
    } catch {
      markProviderProjectionWorkOverflow(budget);
      return undefined;
    }
  };
  const additionalKwargs = read(() => message.additional_kwargs);
  const additionalKwargsSnapshot =
    additionalKwargs == null
      ? undefined
      : {
          injected: read(() => additionalKwargs.injected),
          isMeta: read(() => additionalKwargs.isMeta),
          source: read(() => additionalKwargs.source),
          sourceMessageId: read(() => additionalKwargs.sourceMessageId),
          sourceMessageIds: read(() => additionalKwargs.sourceMessageIds),
          provenance: read(() => additionalKwargs.provenance),
        };
  const extendedMessage = message as ModelBoundProviderMessage & StoredModelBoundMessage;
  return {
    id: read(() => message.id),
    messageId: read(() => message.messageId),
    role: read(() => normalizeRole(message)),
    name: read(() => message.name),
    sender: read(() => extendedMessage.sender),
    text: read(() => message.text),
    summary: read(() => extendedMessage.summary),
    quotes: read(() => extendedMessage.quotes),
    content: read(() => message.content),
    tool_calls: read(() => message.tool_calls),
    files: read(() => extendedMessage.files),
    attachments: read(() => extendedMessage.attachments),
    original: read(() => extendedMessage.original),
    updated: read(() => extendedMessage.updated),
    feedback: read(() => extendedMessage.feedback),
    isCreatedByUser: read(() => extendedMessage.isCreatedByUser),
    isUserSubmitted: read(() => extendedMessage.isUserSubmitted),
    userSubmittedPaths: read(() => extendedMessage.userSubmittedPaths),
    userSubmittedMessageFieldPaths: read(() => extendedMessage.userSubmittedMessageFieldPaths),
    additional_kwargs: additionalKwargsSnapshot,
  };
}

function snapshotProviderMessageContent(
  message: ModelBoundProviderMessage,
  parentBudget: ProviderProjectionWorkBudget,
  parentPartSnapshotBudget: ProviderProjectionWorkBudget,
): unknown {
  const budget = createMessageWorkBudget(parentBudget, message.content);
  const partSnapshotBudget = createMessageWorkBudget(parentPartSnapshotBudget, message.content);
  try {
    const messageContent = message.content;
    const messageText = messageContent == null ? message.text : undefined;
    const candidate = messageContent ?? messageText;
    if (!Array.isArray(candidate)) {
      return candidate;
    }
    const candidateLength = captureProviderArrayLength(candidate);
    const content: unknown[] = [];
    let index = 0;
    for (; index < candidateLength; index++) {
      if (!consumeProviderProjectionWork(budget, 1)) {
        break;
      }
      content.push(snapshotModelBoundContentPart(candidate[index], partSnapshotBudget));
    }
    if (index < candidateLength) {
      markProviderProjectionWorkOverflow(budget);
    }
    return content;
  } catch {
    markProviderProjectionWorkOverflow(budget);
    return undefined;
  }
}

function projectProviderMessage(
  message: SnapshottedModelBoundProviderMessage,
  attribution: ProviderExactAttribution | undefined,
  capturedProviderContent: unknown,
  providerRole: string | undefined,
  partSnapshotBudget: ProviderProjectionWorkBudget,
): StoredModelBoundMessage {
  const role = attribution === 'tool' ? 'tool' : providerRole;
  const providerSource = message.additional_kwargs?.source;
  const isSyntheticContext =
    message.additional_kwargs?.isMeta === true ||
    (typeof providerSource === 'string' && LEGACY_SYNTHETIC_PROVIDER_SOURCES.has(providerSource)) ||
    (message.additional_kwargs?.injected === true && providerSource !== 'steer');
  const isUser =
    attribution === 'user' || (attribution == null && role === 'user' && !isSyntheticContext);
  const rawProviderContent = capturedProviderContent;
  let providerContent = rawProviderContent;
  if ((attribution === 'non_user' || attribution === 'tool') && Array.isArray(rawProviderContent)) {
    let projectedContent: unknown[] | undefined;
    const contentLength = rawProviderContent.length;
    for (let index = 0; index < contentLength; index++) {
      const part = rawProviderContent[index];
      if (part == null || typeof part !== 'object' || part.type !== 'steer') {
        if (projectedContent != null) {
          projectedContent.push(part);
        }
        continue;
      }
      if (projectedContent == null) {
        projectedContent = rawProviderContent.slice(0, index);
      }
      projectedContent.push(cloneSnapshottedContentPartWithTextType(part, partSnapshotBudget));
    }
    providerContent = projectedContent ?? rawProviderContent;
  }
  const projectedContentFields: {
    content?: StoredModelBoundMessage['content'];
    text?: string;
  } = {};
  if (typeof providerContent === 'string') {
    projectedContentFields.text = providerContent;
  } else if (Array.isArray(providerContent)) {
    projectedContentFields.content = providerContent as StoredModelBoundMessage['content'];
  }
  return {
    id: message.id,
    messageId: message.messageId,
    role,
    name: message.name,
    sender: message.sender,
    summary: message.summary,
    quotes: message.quotes,
    tool_calls: message.tool_calls,
    files: message.files,
    attachments: message.attachments,
    original: message.original,
    updated: message.updated,
    feedback: message.feedback,
    userSubmittedPaths: message.userSubmittedPaths,
    userSubmittedMessageFieldPaths: message.userSubmittedMessageFieldPaths,
    isCreatedByUser: isUser,
    isUserSubmitted: isUser,
    ...projectedContentFields,
  };
}

function projectStoredMessageForProvider(
  message: StoredModelBoundMessage,
  parentBudget: ProviderProjectionWorkBudget,
  partSnapshotBudget: ProviderProjectionWorkBudget,
  selectedContentPartIndices?: ReadonlySet<number>,
  attribution?: Extract<ProviderExactAttribution, 'user' | 'tool'>,
  capturedContentParts?: Map<number, unknown>,
  capturedContentLength?: number,
  submittedPathsSnapshot?: readonly string[],
  submittedFieldPathsSnapshot?: readonly UserSubmittedMessageFieldPath[],
): StoredModelBoundMessage {
  const budget = createMessageWorkBudget(parentBudget, message.content);
  const messageContentCandidate = message.content;
  const storedText = message.text;
  const rawFieldPathCandidate = message.userSubmittedMessageFieldPaths;
  const rawPathCandidate = message.userSubmittedPaths;
  const pathCandidate = submittedPathsSnapshot ?? rawPathCandidate;
  const fieldPathCandidate = submittedFieldPathsSnapshot ?? rawFieldPathCandidate;
  const providerMessage: StoredModelBoundMessage = {
    id: message.id,
    messageId: message.messageId,
    role: message.role,
    isCreatedByUser: message.isCreatedByUser,
    isUserSubmitted: message.isUserSubmitted,
    ...(messageContentCandidate == null &&
    storedText != null &&
    (selectedContentPartIndices == null || selectedContentPartIndices.has(0))
      ? { text: storedText }
      : {}),
    ...(attribution === 'user' && {
      isCreatedByUser: true,
      isUserSubmitted: true,
    }),
    ...(attribution === 'tool' && {
      role: 'tool',
      isCreatedByUser: false,
      isUserSubmitted: false,
    }),
  };
  let hasArrayContent = false;
  let messageContentLength = 0;
  let messageContent: NonNullable<StoredMessageContentInput['content']> | undefined;
  try {
    hasArrayContent = Array.isArray(messageContentCandidate);
    if (hasArrayContent) {
      messageContent = messageContentCandidate as NonNullable<StoredMessageContentInput['content']>;
      messageContentLength = capturedContentLength ?? captureProviderArrayLength(messageContent);
      if (!Number.isSafeInteger(messageContentLength) || messageContentLength < 0) {
        throw new TypeError('invalid captured stored content length');
      }
    } else {
      consumeProviderProjectionWork(budget, 1);
    }
  } catch {
    markProviderProjectionWorkOverflow(budget);
    return providerMessage;
  }
  const projectPart = (
    part: NonNullable<StoredMessageContentInput['content']>[number],
  ): NonNullable<StoredMessageContentInput['content']>[number] => {
    return cloneSnapshottedContentPartWithoutFileReferences(
      part,
      partSnapshotBudget,
    ) as NonNullable<StoredMessageContentInput['content']>[number];
  };
  const compactIndexBySourceIndex = new Map<number, number>();
  const content: Array<NonNullable<StoredMessageContentInput['content']>[number]> = [];
  const readContentPart = (
    index: number,
  ): NonNullable<StoredMessageContentInput['content']>[number] => {
    if (capturedContentParts?.has(index) === true) {
      return capturedContentParts.get(index) as NonNullable<
        StoredMessageContentInput['content']
      >[number];
    }
    const rawPart = messageContent?.[index] as NonNullable<
      StoredMessageContentInput['content']
    >[number];
    const part = snapshotModelBoundContentPart(rawPart, partSnapshotBudget);
    capturedContentParts?.set(index, part);
    return part as NonNullable<StoredMessageContentInput['content']>[number];
  };
  if (hasArrayContent && selectedContentPartIndices == null) {
    let index = 0;
    try {
      for (; index < messageContentLength; index++) {
        if (!consumeProviderProjectionWork(budget, 1)) {
          break;
        }
        compactIndexBySourceIndex.set(index, content.length);
        content.push(projectPart(readContentPart(index)));
      }
    } catch {
      markProviderProjectionWorkOverflow(budget);
    }
    if (index < messageContentLength) {
      markProviderProjectionWorkOverflow(budget);
    }
  } else if (hasArrayContent && selectedContentPartIndices != null) {
    const selectedIndices = [...selectedContentPartIndices]
      .filter((index) => Number.isSafeInteger(index) && index >= 0 && index < messageContentLength)
      .sort((left, right) => left - right);
    for (const sourceIndex of selectedIndices) {
      if (!consumeProviderProjectionWork(budget, 1)) {
        break;
      }
      try {
        const part = readContentPart(sourceIndex);
        if (part == null) {
          continue;
        }
        compactIndexBySourceIndex.set(sourceIndex, content.length);
        content.push(projectPart(part));
      } catch {
        markProviderProjectionWorkOverflow(budget);
        break;
      }
    }
  }
  const remapSelectedPath = (value: unknown): JsonPointer | undefined => {
    if (typeof value !== 'string' || !value.startsWith('/')) {
      return undefined;
    }
    const segments = getSafeUserSubmittedPathSegments(value as JsonPointer);
    const encodedIndex = segments?.[1];
    if (
      segments?.[0] !== 'content' ||
      encodedIndex == null ||
      !/^\d+$/.test(encodedIndex) ||
      String(Number(encodedIndex)) !== encodedIndex
    ) {
      return undefined;
    }
    const compactIndex = compactIndexBySourceIndex.get(Number(encodedIndex));
    if (compactIndex == null) {
      return undefined;
    }
    const sourcePrefix = `/content/${encodedIndex}`;
    return `/content/${compactIndex}${value.slice(sourcePrefix.length)}` as JsonPointer;
  };
  const userSubmittedPaths: JsonPointer[] = [];
  const userSubmittedMessageFieldPaths: UserSubmittedMessageFieldPath[] = [];
  try {
    if (pathCandidate != null && !Array.isArray(pathCandidate)) {
      markProviderProjectionWorkOverflow(budget);
    } else if (Array.isArray(pathCandidate)) {
      const pathLength = captureProviderArrayLength(pathCandidate);
      const pathCount = Math.min(pathLength, MAX_PROVIDER_PROVENANCE_PARTS);
      let index = 0;
      for (; index < pathCount; index++) {
        if (!consumeProviderProjectionWork(budget, 1)) {
          break;
        }
        const candidate = pathCandidate[index];
        if (selectedContentPartIndices == null) {
          if (typeof candidate === 'string') {
            userSubmittedPaths.push(candidate as JsonPointer);
          }
        } else {
          const path = remapSelectedPath(candidate);
          if (path != null) {
            userSubmittedPaths.push(path);
          }
        }
      }
      if (index < pathLength || pathLength > pathCount) {
        markProviderProjectionWorkOverflow(budget);
      }
    }
    if (fieldPathCandidate != null && !Array.isArray(fieldPathCandidate)) {
      markProviderProjectionWorkOverflow(budget);
    } else if (Array.isArray(fieldPathCandidate)) {
      const fieldPathLength = captureProviderArrayLength(fieldPathCandidate);
      const fieldPathCount = Math.min(fieldPathLength, MAX_PROVIDER_PROVENANCE_PARTS);
      let index = 0;
      for (; index < fieldPathCount; index++) {
        if (!consumeProviderProjectionWork(budget, 1)) {
          break;
        }
        const entry = fieldPathCandidate[index];
        if (selectedContentPartIndices == null) {
          if (entry != null && typeof entry === 'object') {
            userSubmittedMessageFieldPaths.push(entry);
          }
        } else {
          const path = remapSelectedPath(entry?.path);
          if (path != null) {
            userSubmittedMessageFieldPaths.push({ field: entry.field, path });
          }
        }
      }
      if (index < fieldPathLength || fieldPathLength > fieldPathCount) {
        markProviderProjectionWorkOverflow(budget);
      }
    }
  } catch {
    markProviderProjectionWorkOverflow(budget);
  }
  return {
    ...providerMessage,
    userSubmittedPaths,
    userSubmittedMessageFieldPaths,
    ...(hasArrayContent && { content }),
  };
}

interface StoredProviderContributionState {
  readonly isCanonicalUserContribution: boolean;
}

interface CachedStoredProviderState {
  readonly provenanceBudget: ProviderProjectionWorkBudget;
  readonly messageSnapshot: StoredModelBoundMessage;
  readonly contentLength?: number;
  readonly contentParts: Map<number, unknown>;
  readonly partSnapshotBudget: ProviderProjectionWorkBudget;
  readonly explicitSubmittedPathState: ReturnType<typeof getUserSubmittedPathState>;
  readonly submittedMessageFieldState: ReturnType<typeof getUserSubmittedMessageFieldPathState>;
  explicitSubmittedPaths?: ReadonlySet<string>;
  wholeSubmittedPathState?: ReturnType<typeof getUserSubmittedPathState>;
  submittedContentPartIndices?: ReadonlySet<number>;
  submittedFieldContentPartIndices?: ReadonlySet<number>;
  wholeRawFileIds?: ReadonlySet<string>;
}

function readCachedStoredContentPart(
  cachedState: CachedStoredProviderState,
  index: number,
  budget: ProviderProjectionWorkBudget,
): unknown {
  if (
    cachedState.contentLength == null ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= cachedState.contentLength
  ) {
    return undefined;
  }
  if (cachedState.contentParts.has(index)) {
    return cachedState.contentParts.get(index);
  }
  try {
    const content = cachedState.messageSnapshot.content;
    if (!Array.isArray(content)) {
      markProviderProjectionWorkOverflow(budget);
      return undefined;
    }
    const part = snapshotModelBoundContentPart(content[index], cachedState.partSnapshotBudget);
    cachedState.contentParts.set(index, part);
    return part;
  } catch {
    markProviderProjectionWorkOverflow(budget);
    return undefined;
  }
}

function getProviderContentSelectionKey(
  selectedContentPartIndices: ReadonlySet<number> | undefined,
): string {
  return selectedContentPartIndices == null
    ? '*'
    : [...selectedContentPartIndices].sort((left, right) => left - right).join(',');
}

function markUniqueStoredSelection(
  selections: WeakMap<StoredModelBoundMessage, Set<string>>,
  message: StoredModelBoundMessage,
  key: string,
): boolean {
  const messageSelections = selections.get(message);
  if (messageSelections?.has(key) === true) {
    return false;
  }
  if (messageSelections == null) {
    selections.set(message, new Set([key]));
  } else {
    messageSelections.add(key);
  }
  return true;
}

function getStoredSubmittedPathState(
  selectedContentPartIndices: ReadonlySet<number> | undefined,
  cachedState: CachedStoredProviderState,
  budget: ProviderProjectionWorkBudget,
): ReturnType<typeof getUserSubmittedPathState> {
  if (selectedContentPartIndices != null) {
    return cachedState.explicitSubmittedPathState;
  }
  if (cachedState.wholeSubmittedPathState == null) {
    const semanticBudget = createMessageWorkBudget(budget, cachedState.messageSnapshot.content);
    const semanticState = getUserSubmittedPathState(cachedState.messageSnapshot, {
      includeExplicitPaths: false,
      budget: semanticBudget,
      capturedContent: cachedState.messageSnapshot.content,
      hasCapturedContent: true,
      capturedContentLength: cachedState.contentLength,
      capturedContentParts: cachedState.contentParts,
    });
    if (semanticState.overflowed) {
      markProviderProjectionWorkOverflow(budget);
    }
    const paths: JsonPointer[] = [];
    const seen = new Set<string>();
    let overflowed = cachedState.explicitSubmittedPathState.overflowed || semanticState.overflowed;
    for (const state of [cachedState.explicitSubmittedPathState, semanticState]) {
      for (const path of state.paths) {
        if (seen.has(path)) {
          continue;
        }
        seen.add(path);
        if (seen.size > MAX_USER_SUBMITTED_PATHS) {
          overflowed = true;
          break;
        }
        paths.push(path);
      }
    }
    cachedState.wholeSubmittedPathState = { paths, overflowed };
  }
  return cachedState.wholeSubmittedPathState;
}

function getSubmittedContentPartIndices(
  paths: readonly { readonly path?: string }[] | readonly string[],
): ReadonlySet<number> {
  const indices = new Set<number>();
  for (let index = 0; index < paths.length; index++) {
    const candidate = paths[index];
    const path = typeof candidate === 'string' ? candidate : candidate.path;
    if (typeof path !== 'string' || !path.startsWith('/')) {
      continue;
    }
    const segments = getSafeUserSubmittedPathSegments(path as JsonPointer);
    const encodedIndex = segments?.[1];
    if (
      segments?.[0] === 'content' &&
      encodedIndex != null &&
      /^\d+$/.test(encodedIndex) &&
      String(Number(encodedIndex)) === encodedIndex
    ) {
      indices.add(Number(encodedIndex));
    }
  }
  return indices;
}

function selectedPartsIntersect(
  selectedContentPartIndices: ReadonlySet<number> | undefined,
  submittedContentPartIndices: ReadonlySet<number>,
): boolean {
  if (selectedContentPartIndices == null) {
    return submittedContentPartIndices.size > 0;
  }
  for (const index of selectedContentPartIndices) {
    if (submittedContentPartIndices.has(index)) {
      return true;
    }
  }
  return false;
}

function getStoredProviderContributionState(
  selectedContentPartIndices: ReadonlySet<number> | undefined,
  cachedState: CachedStoredProviderState,
  budget: ProviderProjectionWorkBudget,
): StoredProviderContributionState {
  const submittedPathState = getStoredSubmittedPathState(
    selectedContentPartIndices,
    cachedState,
    budget,
  );
  let hasSelectedMaterial = selectedContentPartIndices == null;
  let hasSelectedSemanticPath = false;
  if (!hasSelectedMaterial && cachedState.contentLength != null) {
    const selectionBudget = createMessageWorkBudget(budget, cachedState.messageSnapshot.content);
    for (const index of selectedContentPartIndices ?? []) {
      if (!consumeProviderProjectionWork(selectionBudget, 1)) {
        break;
      }
      const part = readCachedStoredContentPart(cachedState, index, budget);
      if (part != null) {
        hasSelectedMaterial = true;
        hasSelectedSemanticPath ||=
          typeof part === 'object' &&
          Object.prototype.hasOwnProperty.call(part, 'type') &&
          (part as { readonly type?: unknown }).type === 'steer';
      }
    }
  }
  cachedState.submittedContentPartIndices ??= getSubmittedContentPartIndices(
    submittedPathState.paths,
  );
  cachedState.submittedFieldContentPartIndices ??= getSubmittedContentPartIndices(
    cachedState.submittedMessageFieldState.entries,
  );
  const hasSelectedSubmittedPath =
    selectedContentPartIndices == null
      ? submittedPathState.paths.length > 0
      : hasSelectedSemanticPath ||
        selectedPartsIntersect(selectedContentPartIndices, cachedState.submittedContentPartIndices);
  const hasSelectedSubmittedField =
    selectedContentPartIndices == null
      ? cachedState.submittedMessageFieldState.entries.length > 0
      : selectedPartsIntersect(
          selectedContentPartIndices,
          cachedState.submittedFieldContentPartIndices,
        );
  const hasSubmittedCanonicalProvenance =
    hasSelectedSubmittedPath ||
    hasSelectedSubmittedField ||
    (hasSelectedMaterial && submittedPathState.overflowed);
  const storedRole = normalizeRole(cachedState.messageSnapshot);
  const isStoredUserSource =
    hasSelectedMaterial &&
    (cachedState.messageSnapshot.isCreatedByUser === true ||
      cachedState.messageSnapshot.isUserSubmitted === true ||
      storedRole === 'user');
  return {
    isCanonicalUserContribution: isStoredUserSource || hasSubmittedCanonicalProvenance,
  };
}

function getSelectedRawStoredMessageFileIds(
  selectedContentPartIndices: ReadonlySet<number> | undefined,
  cachedState: CachedStoredProviderState,
  budget: ProviderProjectionWorkBudget,
): ReadonlySet<string> {
  if (selectedContentPartIndices == null) {
    if (cachedState.wholeRawFileIds != null) {
      return cachedState.wholeRawFileIds;
    }
    const fileIds = new Set<string>();
    const wasOverflowed = budget.overflowed;
    try {
      appendReferencedFileIds(fileIds, cachedState.messageSnapshot.files, budget);
      if (cachedState.contentLength != null) {
        const contentLength = cachedState.contentLength;
        const contentCount = Math.min(contentLength, MAX_PROVIDER_PROJECTION_WORK);
        const contentBudget = createMessageWorkBudget(budget, cachedState.messageSnapshot.content);
        for (let index = 0; index < contentCount; index++) {
          if (!consumeProviderProjectionWork(contentBudget, 1)) {
            break;
          }
          const part = readCachedStoredContentPart(cachedState, index, budget);
          if (part != null) {
            appendPartFileIds(
              fileIds,
              part as NonNullable<NonNullable<StoredMessageContentInput['content']>[number]>,
              budget,
            );
          }
        }
        if (contentLength > contentCount) {
          markProviderProjectionWorkOverflow(budget);
        }
      }
    } catch {
      markProviderProjectionWorkOverflow(budget);
    }
    if (!wasOverflowed && !budget.overflowed) {
      cachedState.wholeRawFileIds = fileIds;
    }
    return fileIds;
  }
  const fileIds = new Set<string>();
  try {
    if (cachedState.contentLength == null) {
      return fileIds;
    }
    const selectionBudget = createMessageWorkBudget(budget, cachedState.messageSnapshot.content);
    for (const index of selectedContentPartIndices) {
      if (!consumeProviderProjectionWork(selectionBudget, 1)) {
        break;
      }
      const part = readCachedStoredContentPart(cachedState, index, budget);
      if (part != null) {
        appendPartFileIds(
          fileIds,
          part as NonNullable<NonNullable<StoredMessageContentInput['content']>[number]>,
          budget,
        );
      }
    }
  } catch {
    markProviderProjectionWorkOverflow(budget);
  }
  return fileIds;
}

function appendMaterializedSelectedFileIds(
  target: Set<string>,
  materializedFileIds: readonly string[] | undefined,
  rawSelectedFileIds: ReadonlySet<string>,
  budget: ProviderProjectionWorkBudget,
): void {
  try {
    if (!Array.isArray(materializedFileIds)) {
      return;
    }
    const candidateCount = captureProviderArrayLength(materializedFileIds);
    let index = 0;
    for (; index < candidateCount; index++) {
      if (!consumeProviderProjectionWork(budget, 1)) {
        break;
      }
      const candidate = materializedFileIds[index];
      if (typeof candidate !== 'string') {
        continue;
      }
      const fileId = candidate.trim();
      if (fileId.length > 0 && rawSelectedFileIds.has(fileId)) {
        target.add(fileId);
      }
    }
    if (index < candidateCount) {
      markProviderProjectionWorkOverflow(budget);
    }
  } catch {
    markProviderProjectionWorkOverflow(budget);
  }
}

function appendLegacyMaterializedFileIds(
  target: Set<string>,
  materializedFileIds: readonly string[] | undefined,
  budget: ProviderProjectionWorkBudget,
): void {
  try {
    if (!Array.isArray(materializedFileIds)) {
      return;
    }
    const candidateCount = captureProviderArrayLength(materializedFileIds);
    let index = 0;
    for (; index < candidateCount; index++) {
      if (!consumeProviderProjectionWork(budget, 1)) {
        break;
      }
      const fileId = materializedFileIds[index];
      if (typeof fileId === 'string' && fileId.length > 0) {
        target.add(fileId);
      }
    }
    if (index < candidateCount) {
      markProviderProjectionWorkOverflow(budget);
    }
  } catch {
    markProviderProjectionWorkOverflow(budget);
  }
}

interface ModelBoundProviderContentIndex {
  readonly storedMessagesById: ReadonlyMap<string, StoredModelBoundMessage>;
  readonly resolvedFilesById: ReadonlyMap<string, ModelBoundCanonicalFile>;
  readonly storedStateByMessage: WeakMap<StoredModelBoundMessage, CachedStoredProviderState>;
  readonly overflowed: boolean;
}

function getCachedStoredProviderState(
  index: ModelBoundProviderContentIndex,
  message: StoredModelBoundMessage,
  parentBudget: ProviderProjectionWorkBudget,
  parentPartSnapshotBudget: ProviderProjectionWorkBudget,
): CachedStoredProviderState {
  const cached = index.storedStateByMessage.get(message);
  if (cached != null) {
    /** Cached snapshots outlive a model invocation; attach failures to the current budgets. */
    cached.provenanceBudget.parent = parentBudget;
    if (cached.provenanceBudget.overflowed) {
      markProviderProjectionWorkOverflow(parentBudget);
    }
    cached.partSnapshotBudget.parent = parentPartSnapshotBudget;
    if (cached.partSnapshotBudget.overflowed) {
      markProviderProjectionWorkOverflow(parentPartSnapshotBudget);
    }
    return cached;
  }
  const budget = createMessageWorkBudget(parentBudget, undefined, MAX_PROVIDER_STORED_STATE_WORK);
  const partSnapshotBudget = createMessageWorkBudget(parentPartSnapshotBudget, undefined);
  let messageSnapshot: StoredModelBoundMessage = {};
  try {
    messageSnapshot = {
      id: message.id,
      messageId: message.messageId,
      role: message.role,
      name: message.name,
      sender: message.sender,
      text: message.text,
      summary: message.summary,
      quotes: message.quotes,
      content: message.content,
      tool_calls: message.tool_calls,
      files: message.files,
      attachments: message.attachments,
      original: message.original,
      updated: message.updated,
      feedback: message.feedback,
      isCreatedByUser: message.isCreatedByUser,
      isUserSubmitted: message.isUserSubmitted,
      userSubmittedPaths: message.userSubmittedPaths,
      userSubmittedMessageFieldPaths: message.userSubmittedMessageFieldPaths,
    };
  } catch {
    markProviderProjectionWorkOverflow(budget);
  }
  let contentLength: number | undefined;
  try {
    if (Array.isArray(messageSnapshot.content)) {
      contentLength = captureProviderArrayLength(messageSnapshot.content);
    }
  } catch {
    markProviderProjectionWorkOverflow(budget);
    contentLength = -1;
  }
  const contentParts = new Map<number, unknown>();
  const pathBudget =
    isProxy(messageSnapshot.userSubmittedPaths) ||
    isProxy(messageSnapshot.userSubmittedMessageFieldPaths)
      ? parentBudget
      : budget;
  const provenanceOptions = {
    budget: pathBudget,
    capturedContent: messageSnapshot.content,
    hasCapturedContent: true,
    capturedContentLength: contentLength,
    capturedContentParts: contentParts,
    captureContentPart: (part: unknown) => snapshotModelBoundContentPart(part, partSnapshotBudget),
  };
  const explicitSubmittedPathState = getUserSubmittedPathState(messageSnapshot, {
    ...provenanceOptions,
    includeSemanticContent: false,
  });
  const submittedMessageFieldState = getUserSubmittedMessageFieldPathState(
    messageSnapshot,
    provenanceOptions,
  );
  if (explicitSubmittedPathState.overflowed || pathBudget.overflowed) {
    markProviderProjectionWorkOverflow(budget);
  }
  const state: CachedStoredProviderState = {
    provenanceBudget: budget,
    messageSnapshot,
    contentLength,
    contentParts,
    partSnapshotBudget,
    explicitSubmittedPathState,
    submittedMessageFieldState,
  };
  index.storedStateByMessage.set(message, state);
  return state;
}

function getExplicitStoredSubmittedPaths(
  cachedState: CachedStoredProviderState,
): ReadonlySet<string> {
  if (cachedState.explicitSubmittedPaths != null) {
    return cachedState.explicitSubmittedPaths;
  }
  const explicitSubmittedPaths = new Set<string>(cachedState.explicitSubmittedPathState.paths);
  cachedState.explicitSubmittedPaths = explicitSubmittedPaths;
  return explicitSubmittedPaths;
}

function createModelBoundProviderContentIndex(
  input: Pick<ModelBoundProviderContentInput, 'storedMessages' | 'resolvedFiles'>,
  initiallyOverflowed = false,
): ModelBoundProviderContentIndex {
  const storedMessagesById = new Map<string, StoredModelBoundMessage>();
  let overflowed = initiallyOverflowed;
  try {
    const storedMessages = input.storedMessages;
    if (Array.isArray(storedMessages)) {
      const storedMessageLength = captureProviderArrayLength(storedMessages);
      const storedMessageCount = Math.min(storedMessageLength, MAX_PROVIDER_PROJECTION_WORK);
      overflowed ||= storedMessageLength > storedMessageCount;
      for (let index = 0; index < storedMessageCount; index++) {
        const message = storedMessages[index];
        if (message == null) {
          continue;
        }
        for (const messageId of getStoredMessageIds(message)) {
          storedMessagesById.set(messageId, message);
        }
      }
    }
  } catch {
    overflowed = true;
  }
  const resolvedFilesById = new Map<string, ModelBoundCanonicalFile>();
  try {
    const resolvedFiles = input.resolvedFiles;
    if (Array.isArray(resolvedFiles)) {
      const resolvedFileLength = captureProviderArrayLength(resolvedFiles);
      const resolvedFileCount = Math.min(resolvedFileLength, MAX_PROVIDER_PROJECTION_WORK);
      overflowed ||= resolvedFileLength > resolvedFileCount;
      for (let index = 0; index < resolvedFileCount; index++) {
        const file = resolvedFiles[index];
        if (typeof file?.file_id === 'string' && file.file_id.length > 0) {
          resolvedFilesById.set(file.file_id, file);
        }
      }
    }
  } catch {
    overflowed = true;
  }
  return {
    storedMessagesById,
    resolvedFilesById,
    storedStateByMessage: new WeakMap(),
    overflowed,
  };
}

function createProviderProjectionWorkBudgets(
  index: ModelBoundProviderContentIndex,
): ProviderProjectionWorkBudgets {
  return {
    projection: {
      remaining: MAX_PROVIDER_PROJECTION_WORK,
      overflowed: index.overflowed,
    },
    providerContent: {
      remaining: MAX_PROVIDER_PROJECTION_WORK,
      overflowed: index.overflowed,
    },
    partSnapshot: {
      remaining: MAX_PROVIDER_PROJECTION_WORK,
      overflowed: index.overflowed,
    },
    fileScan: {
      remaining: MAX_PROVIDER_PROJECTION_WORK,
      overflowed: index.overflowed,
    },
    provenance: {
      remaining: MAX_PROVIDER_PROVENANCE_PARSE_WORK,
      overflowed: false,
    },
    storedState: {
      remaining: MAX_PROVIDER_STORED_STATE_WORK,
      overflowed: false,
    },
    nestedTraversal: {
      visitedNodes: 0,
      maxNodes: MAX_MODEL_BOUND_NESTED_TRAVERSAL_WORK,
    },
  };
}

function projectModelBoundProviderContent(
  input: ModelBoundProviderContentInput,
  index: ModelBoundProviderContentIndex,
  workBudgets = createProviderProjectionWorkBudgets(index),
): {
  storedMessages: StoredModelBoundMessage[];
  resolvedFiles: ModelBoundCanonicalFile[];
  deferredTraversalErrors: ContentTraversalLimitError[];
} {
  const selectedMessages: StoredModelBoundMessage[] = [];
  const selectedStoredMessages = new Set<StoredModelBoundMessage>();
  const selectedFileIds = new Set<string>();
  const deferredTraversalErrors: ContentTraversalLimitError[] = [];
  const projectionBudget = workBudgets.projection;
  const providerContentBudget = workBudgets.providerContent;
  const partSnapshotBudget = workBudgets.partSnapshot;
  const fileScanBudget = workBudgets.fileScan;
  const provenanceBudget = workBudgets.provenance;
  const storedStateBudget = workBudgets.storedState;
  const exactCanonicalSelections = new WeakMap<StoredModelBoundMessage, Set<string>>();
  const exactFileSelections = new WeakMap<StoredModelBoundMessage, Set<string>>();
  const exactContributionStates = new WeakMap<
    StoredModelBoundMessage,
    Map<string, StoredProviderContributionState>
  >();
  const reportedExactFieldOverflows = new WeakSet<StoredModelBoundMessage>();
  const legacyFileSourceIds = new Set<string>();
  const appendExactFieldOverflow = (
    message: StoredModelBoundMessage,
    cachedState: CachedStoredProviderState,
  ): void => {
    if (
      !cachedState.submittedMessageFieldState.overflowed ||
      reportedExactFieldOverflows.has(message)
    ) {
      return;
    }
    reportedExactFieldOverflows.add(message);
    deferredTraversalErrors.push(
      new ContentTraversalLimitError(
        [],
        [{ source: 'message', fields: [...HITL_MESSAGE_FILTER_FIELDS] }],
      ),
    );
  };
  const selectLegacyStoredMessage = (
    message: StoredModelBoundMessage,
    cachedState: CachedStoredProviderState,
  ): void => {
    if (selectedStoredMessages.has(message)) {
      return;
    }
    selectedStoredMessages.add(message);
    appendExactFieldOverflow(message, cachedState);
    selectedMessages.push(
      projectStoredMessageForProvider(
        cachedState.messageSnapshot,
        projectionBudget,
        cachedState.partSnapshotBudget,
        undefined,
        undefined,
        cachedState.contentParts,
        cachedState.contentLength,
        cachedState.wholeSubmittedPathState?.paths ?? cachedState.explicitSubmittedPathState.paths,
        cachedState.submittedMessageFieldState.entries,
      ),
    );
  };
  const providerMessages: SnapshottedModelBoundProviderMessage[] = [];
  const providerRoles: Array<string | undefined> = [];
  const providerContents: unknown[] = [];
  try {
    const providerMessageLength = captureProviderArrayLength(input.providerMessages);
    const providerMessageCount = Math.min(providerMessageLength, MAX_PROVIDER_PROJECTION_WORK);
    if (providerMessageLength > providerMessageCount) {
      markProviderProjectionWorkOverflow(projectionBudget);
    }
    for (let index = 0; index < providerMessageCount; index++) {
      const providerMessage = snapshotProviderMessageEnvelope(
        input.providerMessages[index],
        providerContentBudget,
      );
      providerMessages.push(providerMessage);
      providerRoles.push(providerMessage.role);
      providerContents.push(
        snapshotProviderMessageContent(providerMessage, providerContentBudget, partSnapshotBudget),
      );
    }
  } catch {
    markProviderProjectionWorkOverflow(projectionBudget);
  }
  for (let providerIndex = 0; providerIndex < providerMessages.length; providerIndex++) {
    const providerMessage = providerMessages[providerIndex];
    const capturedProviderContent = providerContents[providerIndex];
    const providerRole = providerRoles[providerIndex];
    const provenanceState = getProviderMessageProvenanceState(providerMessage, provenanceBudget);
    let exactHasUserAttribution = false;
    let exactHasToolAttribution = false;

    if (provenanceState.orderedContributions != null) {
      const orderedContributions = provenanceState.orderedContributions;
      exactHasUserAttribution = orderedContributions.hasUserAttribution;
      exactHasToolAttribution = orderedContributions.hasToolAttribution;
      for (const contribution of orderedContributions.contributions) {
        const storedMessage = index.storedMessagesById.get(contribution.sourceMessageId);
        if (storedMessage == null) {
          continue;
        }
        const contentSelectionKey = getProviderContentSelectionKey(
          contribution.selectedContentPartIndices,
        );
        const cachedState = getCachedStoredProviderState(
          index,
          storedMessage,
          storedStateBudget,
          partSnapshotBudget,
        );
        appendExactFieldOverflow(storedMessage, cachedState);
        let contributionState = exactContributionStates
          .get(storedMessage)
          ?.get(contentSelectionKey);
        if (contributionState == null) {
          contributionState = getStoredProviderContributionState(
            contribution.selectedContentPartIndices,
            cachedState,
            storedStateBudget,
          );
          const storedContributionStates = exactContributionStates.get(storedMessage);
          if (storedContributionStates == null) {
            exactContributionStates.set(
              storedMessage,
              new Map([[contentSelectionKey, contributionState]]),
            );
          } else {
            storedContributionStates.set(contentSelectionKey, contributionState);
          }
        }
        exactHasUserAttribution ||= contributionState.isCanonicalUserContribution;
        const needsCanonicalProvenance =
          contribution.attribution === 'user' ||
          contribution.attribution === 'tool' ||
          contributionState.isCanonicalUserContribution ||
          (input.filters?.messages?.unattributedAssistantContent === 'inspect' &&
            providerRole === 'assistant');
        if (needsCanonicalProvenance) {
          const exactAttribution =
            contribution.attribution === 'user' || contribution.attribution === 'tool'
              ? contribution.attribution
              : undefined;
          const selectionKey = `${exactAttribution ?? 'canonical'}:${contentSelectionKey}`;
          if (markUniqueStoredSelection(exactCanonicalSelections, storedMessage, selectionKey)) {
            selectedMessages.push(
              projectStoredMessageForProvider(
                cachedState.messageSnapshot,
                projectionBudget,
                cachedState.partSnapshotBudget,
                contribution.selectedContentPartIndices,
                exactAttribution,
                cachedState.contentParts,
                cachedState.contentLength,
                cachedState.explicitSubmittedPathState.paths,
                cachedState.submittedMessageFieldState.entries,
              ),
            );
          }
        }
        if (
          contribution.attribution === 'user' ||
          contribution.attribution === 'tool' ||
          contributionState.isCanonicalUserContribution
        ) {
          const fileSelectionKey = contentSelectionKey;
          if (markUniqueStoredSelection(exactFileSelections, storedMessage, fileSelectionKey)) {
            appendMaterializedSelectedFileIds(
              selectedFileIds,
              input.fileIdsBySourceMessageId?.get(contribution.sourceMessageId),
              getSelectedRawStoredMessageFileIds(
                contribution.selectedContentPartIndices,
                cachedState,
                fileScanBudget,
              ),
              fileScanBudget,
            );
          }
        }
      }
    } else {
      const legacyLineage = getLegacyProviderLineage(providerMessage, provenanceBudget);
      const matchedStoredMessages = new Set<StoredModelBoundMessage>();
      let hasSubmittedCanonicalSource = false;
      for (const sourceId of legacyLineage.sourceIds) {
        const storedMessage = index.storedMessagesById.get(sourceId);
        if (storedMessage == null) {
          continue;
        }
        matchedStoredMessages.add(storedMessage);
        const cachedState = getCachedStoredProviderState(
          index,
          storedMessage,
          storedStateBudget,
          partSnapshotBudget,
        );
        appendExactFieldOverflow(storedMessage, cachedState);
        const submittedPathState = getStoredSubmittedPathState(
          undefined,
          cachedState,
          storedStateBudget,
        );
        const storedRole = normalizeRole(cachedState.messageSnapshot);
        const isStoredUserSource =
          cachedState.messageSnapshot.isCreatedByUser === true ||
          cachedState.messageSnapshot.isUserSubmitted === true ||
          storedRole === 'user';
        const explicitPathMetadata = getCapturedUserSubmittedPathMetadata(
          cachedState.explicitSubmittedPathState,
        );
        const hasStoredSubmittedProvenance =
          submittedPathState.overflowed ||
          submittedPathState.paths.some(
            (path) =>
              getExplicitStoredSubmittedPaths(cachedState).has(path) &&
              !explicitPathMetadata.steerPaths.has(path),
          ) ||
          cachedState.submittedMessageFieldState.entries.length > 0;
        hasSubmittedCanonicalSource ||= isStoredUserSource || hasStoredSubmittedProvenance;
        const needsCanonicalProvenance =
          isStoredUserSource ||
          hasStoredSubmittedProvenance ||
          providerRole === 'user' ||
          (input.filters?.messages?.unattributedAssistantContent === 'inspect' &&
            providerRole === 'assistant');
        if (needsCanonicalProvenance) {
          selectLegacyStoredMessage(storedMessage, cachedState);
        }
        if (isStoredUserSource || hasStoredSubmittedProvenance || providerRole === 'user') {
          if (!legacyFileSourceIds.has(sourceId)) {
            legacyFileSourceIds.add(sourceId);
            appendLegacyMaterializedFileIds(
              selectedFileIds,
              input.fileIdsBySourceMessageId?.get(sourceId),
              fileScanBudget,
            );
          }
        }
      }

      const lineageError = getLegacyCoalescedLineageError(
        input,
        providerRole,
        matchedStoredMessages,
        provenanceState,
        legacyLineage,
      );
      if (lineageError != null) {
        deferredTraversalErrors.push(lineageError);
      }

      if (provenanceState.invalid) {
        for (const attribution of ['user', 'tool'] as const) {
          const projectedMessage = projectProviderMessage(
            providerMessage,
            attribution,
            capturedProviderContent,
            providerRole,
            partSnapshotBudget,
          );
          selectedMessages.push(projectedMessage);
          appendStoredMessageFileIds(
            selectedFileIds,
            projectedMessage,
            input.filters,
            fileScanBudget,
          );
        }
        continue;
      }

      const isLegacyArtifactHuman = isLegacyArtifactProjectionHuman(
        providerMessages,
        providerRoles,
        providerContents,
        providerIndex,
        provenanceState,
        legacyLineage,
      );
      let projectedMessage = projectProviderMessage(
        providerMessage,
        isLegacyArtifactHuman ? 'tool' : undefined,
        capturedProviderContent,
        providerRole,
        partSnapshotBudget,
      );
      if (
        !isLegacyArtifactHuman &&
        (providerRole === 'user' || providerRole === 'assistant') &&
        hasSubmittedCanonicalSource
      ) {
        projectedMessage = {
          ...projectedMessage,
          isCreatedByUser: true,
          isUserSubmitted: true,
        };
      }
      selectedMessages.push(projectedMessage);
      appendStoredMessageFileIds(selectedFileIds, projectedMessage, input.filters, fileScanBudget);
      continue;
    }

    /** Typed provenance is authoritative for attribution and source selection.
     * Cross-boundary payloads are inspected under every applicable external
     * source, while all-model/synthetic Human projections remain non-user. */
    const exactAttributions: ProviderExactAttribution[] = [];
    if (exactHasUserAttribution) {
      exactAttributions.push('user');
    }
    if (exactHasToolAttribution) {
      exactAttributions.push('tool');
    }
    if (exactAttributions.length === 0) {
      exactAttributions.push('non_user');
    }
    for (const attribution of exactAttributions) {
      const projectedMessage = projectProviderMessage(
        providerMessage,
        attribution,
        capturedProviderContent,
        providerRole,
        partSnapshotBudget,
      );
      selectedMessages.push(projectedMessage);
      appendStoredMessageFileIds(selectedFileIds, projectedMessage, input.filters, fileScanBudget);
    }
  }

  const resolvedFiles: ModelBoundCanonicalFile[] = [];
  for (const fileId of selectedFileIds) {
    const file = index.resolvedFilesById.get(fileId);
    if (file != null) {
      resolvedFiles.push(file);
    }
  }
  if (selectedFileIds.size > 0) {
    selectedMessages.push({
      role: 'user',
      isCreatedByUser: true,
      isUserSubmitted: true,
      files: [...selectedFileIds].map((file_id) => ({ file_id })),
    });
  }
  if (
    projectionBudget.overflowed ||
    providerContentBudget.overflowed ||
    fileScanBudget.overflowed ||
    provenanceBudget.overflowed ||
    storedStateBudget.overflowed
  ) {
    deferredTraversalErrors.push(new ContentTraversalLimitError());
  }
  if (partSnapshotBudget.overflowed) {
    deferredTraversalErrors.push(
      new ContentTraversalLimitError([], getProviderPartSnapshotTraversalScopes(providerRoles)),
    );
  }
  return { storedMessages: selectedMessages, resolvedFiles, deferredTraversalErrors };
}

function assertIndexedModelBoundProviderContent(
  input: ModelBoundProviderContentInput,
  index: ModelBoundProviderContentIndex,
  workBudgets?: ProviderProjectionWorkBudgets,
): void {
  if (!hasModelBoundContentProtection(input.filters, input.legacyPii)) {
    return;
  }
  const resolvedWorkBudgets = workBudgets ?? createProviderProjectionWorkBudgets(index);
  const projection = projectModelBoundProviderContent(input, index, resolvedWorkBudgets);
  assertModelBoundContent({
    onTraversalFailure: input.onTraversalFailure,
    filters: input.filters,
    legacyPii: input.legacyPii,
    storedMessages: projection.storedMessages,
    resolvedFiles: projection.resolvedFiles,
    deferredTraversalErrors: projection.deferredTraversalErrors,
    traversalBudget: resolvedWorkBudgets.nestedTraversal,
  });
}

/** Inspects the exact provider selection while retaining persisted provenance. */
export function assertModelBoundProviderContent(input: ModelBoundProviderContentInput): void {
  assertIndexedModelBoundProviderContent(
    input,
    createModelBoundProviderContentIndex(input, input.sourceFileProjectionOverflowed === true),
  );
}

function snapshotBoundedProviderArray<T>(candidate: readonly T[] | undefined): {
  readonly values: T[];
  readonly overflowed: boolean;
} {
  const values: T[] = [];
  try {
    if (!Array.isArray(candidate)) {
      return { values, overflowed: candidate != null };
    }
    const candidateCount = captureProviderArrayLength(candidate);
    const boundedCandidateCount = Math.min(candidateCount, MAX_PROVIDER_PROJECTION_WORK);
    for (let index = 0; index < boundedCandidateCount; index++) {
      values.push(candidate[index]);
    }
    return { values, overflowed: candidateCount > boundedCandidateCount };
  } catch {
    return { values, overflowed: true };
  }
}

function snapshotBoundedSourceFileIds(
  candidate: ReadonlyMap<string, readonly string[]> | undefined,
): { readonly values: Map<string, string[]>; readonly overflowed: boolean } {
  const values = new Map<string, string[]>();
  let overflowed = false;
  let remaining = MAX_PROVIDER_PROJECTION_WORK;
  try {
    if (candidate == null) {
      return { values, overflowed };
    }
    if (!(candidate instanceof Map)) {
      return { values, overflowed: true };
    }
    const entries = Map.prototype.entries.call(candidate) as IterableIterator<
      [string, readonly string[]]
    >;
    let entryCount = 0;
    while (entryCount < MAX_PROVIDER_PROJECTION_WORK) {
      const next = entries.next();
      if (next.done) {
        break;
      }
      const [sourceMessageId, fileIds] = next.value;
      entryCount++;
      if (!Array.isArray(fileIds)) {
        overflowed = true;
        continue;
      }
      const fileIdCount = captureProviderArrayLength(fileIds);
      const boundedFileIdCount = Math.min(fileIdCount, remaining);
      const copiedFileIds: string[] = [];
      for (let index = 0; index < boundedFileIdCount; index++) {
        copiedFileIds.push(fileIds[index]);
      }
      values.set(sourceMessageId, copiedFileIds);
      remaining -= boundedFileIdCount;
      if (fileIdCount > boundedFileIdCount) {
        overflowed = true;
      }
    }
    if (entryCount === MAX_PROVIDER_PROJECTION_WORK && !entries.next().done) {
      overflowed = true;
    }
  } catch {
    overflowed = true;
  }
  return { values, overflowed };
}

/** Creates a run-stable callback shared by root, summary, and subagent model clients. */
export function createModelBoundChatModelCallback(
  input: Omit<ModelBoundProviderContentInput, 'providerMessages'>,
  options: { readonly onContentRejected?: (error: unknown) => void } = {},
): ModelBoundChatModelCallback {
  const storedMessageSnapshot = snapshotBoundedProviderArray(input.storedMessages);
  const resolvedFileSnapshot = snapshotBoundedProviderArray(input.resolvedFiles);
  const sourceFileIdSnapshot = snapshotBoundedSourceFileIds(input.fileIdsBySourceMessageId);
  const stableInput = {
    onTraversalFailure: input.onTraversalFailure,
    filters: input.filters,
    legacyPii: input.legacyPii,
    storedMessages: storedMessageSnapshot.values,
    resolvedFiles: resolvedFileSnapshot.values,
    fileIdsBySourceMessageId: sourceFileIdSnapshot.values,
  };
  const index = createModelBoundProviderContentIndex(
    stableInput,
    storedMessageSnapshot.overflowed ||
      resolvedFileSnapshot.overflowed ||
      sourceFileIdSnapshot.overflowed ||
      input.sourceFileProjectionOverflowed === true,
  );
  const callback: ModelBoundChatModelCallback = Object.freeze({
    name: 'librechat-model-bound-content-filter',
    raiseError: true,
    awaitHandlers: true,
    handleChatModelStart: (
      _llm: object | undefined,
      messageBatches: readonly (readonly ModelBoundProviderMessage[])[],
    ) => {
      let messageBatchCount = 0;
      let messageBatchesOverflowed = false;
      try {
        if (!Array.isArray(messageBatches)) {
          throw new TypeError('provider message batches must be an array');
        }
        const messageBatchLength = captureProviderArrayLength(messageBatches);
        messageBatchCount = Math.min(messageBatchLength, MAX_PROVIDER_PROJECTION_WORK);
        messageBatchesOverflowed = messageBatchLength > messageBatchCount;
      } catch {
        const error = new ContentTraversalLimitError();
        options.onContentRejected?.(error);
        throw new FatalModelBoundPolicyError(error);
      }
      const workBudgets = createProviderProjectionWorkBudgets(index);
      let remainingProviderMessages = MAX_PROVIDER_PROJECTION_WORK;
      for (let batchIndex = 0; batchIndex < messageBatchCount; batchIndex++) {
        try {
          const providerMessageCandidate = messageBatches[batchIndex];
          if (!Array.isArray(providerMessageCandidate)) {
            throw new ContentTraversalLimitError();
          }
          const providerMessageLength = captureProviderArrayLength(providerMessageCandidate);
          const providerMessageCount = Math.min(providerMessageLength, remainingProviderMessages);
          const providerMessages: ModelBoundProviderMessage[] = [];
          for (let index = 0; index < providerMessageCount; index++) {
            providerMessages.push(providerMessageCandidate[index]);
          }
          remainingProviderMessages -= providerMessageCount;
          assertIndexedModelBoundProviderContent(
            {
              ...stableInput,
              providerMessages,
            },
            index,
            workBudgets,
          );
          if (providerMessageCount < providerMessageLength) {
            throw new ContentTraversalLimitError();
          }
        } catch (error) {
          if (error instanceof FatalModelBoundPolicyError) {
            throw error;
          }
          const policyError = isContentFilterError(error)
            ? error
            : new ContentTraversalLimitError();
          options.onContentRejected?.(policyError);
          throw new FatalModelBoundPolicyError(policyError);
        }
      }
      if (messageBatchesOverflowed) {
        const error = new ContentTraversalLimitError();
        options.onContentRejected?.(error);
        throw new FatalModelBoundPolicyError(error);
      }
    },
  });
  return callback;
}

/**
 * Holds a deferred parent write until every top-level starting agent clears
 * its first exact provider boundary and the corresponding model-node chain
 * completes. This callback belongs on the root RunnableConfig only: intrinsic
 * model callbacks intentionally propagate into subagents, whose reused agent
 * IDs must never satisfy a parent graph's admission barrier.
 */
export function createInitialModelBoundAdmissionCallback(
  admission: InitialModelBoundAdmission,
): InitialModelBoundAdmissionCallback {
  const pendingAgentIds = new Set(
    admission.agentIds
      .filter((agentId): agentId is string => typeof agentId === 'string')
      .map((agentId) => agentId.trim())
      .filter((agentId) => agentId.length > 0),
  );
  const chainParents = new Map<string, string>();
  const agentNodeRuns = new Map<string, string>();
  const modelRuns = new Map<string, string>();
  const successfulAgentNodeRuns = new Set<string>();
  let allowed = false;
  const isEligibleRootModel = (
    metadata: Record<string, unknown> | undefined,
  ): metadata is Record<string, unknown> & { agentId: string } => {
    if (metadata?.summarization === true || typeof metadata?.agentId !== 'string') {
      return false;
    }
    const agentId = metadata.agentId.trim();
    return pendingAgentIds.has(agentId) && metadata.langgraph_node === `agent=${agentId}`;
  };
  const findAgentNodeRun = (parentRunId: string, agentId: string): string | undefined => {
    const visited = new Set<string>();
    let currentRunId: string | undefined = parentRunId;
    while (currentRunId != null && !visited.has(currentRunId)) {
      visited.add(currentRunId);
      if (agentNodeRuns.get(currentRunId) === agentId) {
        return currentRunId;
      }
      currentRunId = chainParents.get(currentRunId);
    }
    return undefined;
  };
  const clearAgentNodeRun = (agentNodeRunId: string): void => {
    agentNodeRuns.delete(agentNodeRunId);
    successfulAgentNodeRuns.delete(agentNodeRunId);
    chainParents.delete(agentNodeRunId);
    for (const [modelRunId, nodeRunId] of modelRuns) {
      if (nodeRunId === agentNodeRunId) {
        modelRuns.delete(modelRunId);
      }
    }
  };

  const callback: InitialModelBoundAdmissionCallback = {
    name: 'librechat-initial-model-bound-admission',
    raiseError: true,
    awaitHandlers: true,
    handleChainStart: (_chain, _inputs, runId, parentRunId, _tags, metadata, _runType, runName) => {
      if (typeof parentRunId === 'string') {
        chainParents.set(runId, parentRunId);
      }
      const nodeName = metadata?.langgraph_node;
      if (typeof nodeName !== 'string' || !nodeName.startsWith('agent=') || runName !== nodeName) {
        return;
      }
      const agentId = nodeName.slice('agent='.length).trim();
      if (pendingAgentIds.has(agentId)) {
        agentNodeRuns.set(runId, agentId);
      }
    },
    handleChatModelStart: (
      _llm,
      _messageBatches,
      runId,
      parentRunId,
      _extraParams,
      _tags,
      metadata,
    ) => {
      if (allowed || !admission.isActive() || !isEligibleRootModel(metadata)) {
        return;
      }
      if (typeof runId !== 'string' || typeof parentRunId !== 'string') {
        return;
      }
      const agentNodeRunId = findAgentNodeRun(parentRunId, metadata.agentId.trim());
      if (agentNodeRunId != null) {
        modelRuns.set(runId, agentNodeRunId);
      }
    },
    handleLLMEnd: (_output, runId) => {
      const agentNodeRunId = modelRuns.get(runId);
      if (agentNodeRunId == null) {
        return;
      }
      modelRuns.delete(runId);
      successfulAgentNodeRuns.add(agentNodeRunId);
    },
    handleLLMError: (_error, runId) => {
      modelRuns.delete(runId);
    },
    handleChainEnd: (outputs, runId) => {
      chainParents.delete(runId);
      const agentId = agentNodeRuns.get(runId);
      const modelNodeOutput =
        outputs != null && typeof outputs === 'object'
          ? (outputs as { messages?: unknown; summarizationRequest?: unknown })
          : undefined;
      const hasCompletedModelResult =
        Array.isArray(modelNodeOutput?.messages) &&
        modelNodeOutput.messages.length > 0 &&
        modelNodeOutput.summarizationRequest == null;
      const hasSuccessfulAttempt = successfulAgentNodeRuns.has(runId);
      if (agentId != null) {
        clearAgentNodeRun(runId);
      }
      if (
        agentId == null ||
        !hasSuccessfulAttempt ||
        !hasCompletedModelResult ||
        allowed ||
        !admission.isActive() ||
        !pendingAgentIds.delete(agentId)
      ) {
        return;
      }
      if (pendingAgentIds.size === 0) {
        allowed = true;
        admission.onAllowed();
      }
    },
    handleChainError: (_error, runId) => {
      chainParents.delete(runId);
      if (agentNodeRuns.has(runId)) {
        clearAgentNodeRun(runId);
      }
    },
  };
  return Object.freeze(callback);
}

/**
 * Re-inspects the final model-bound representation. This makes a newly
 * enabled or tightened policy apply to persisted messages and reusable
 * agent/skill/memory/file context, not only to the request that created it.
 */
export function assertModelBoundContent(input: ModelBoundContentInput): void {
  const inspector = createConfiguredContentInspector({
    filters: input.filters,
    legacyPii: input.legacyPii,
  });
  if (inspector?.hasAuditRules !== true) {
    inspectModelBoundContent(input, inspector);
    return;
  }
  aggregateAuditFindingsSync(() => inspectModelBoundContent(input, inspector));
}

function inspectModelBoundContent(
  input: ModelBoundContentInput,
  inspector: ConfiguredContentInspector | null,
): void {
  const hasFileFailClose =
    getBlockedUninspectableFileField(input.filters, FILE_FILTER_FIELDS) != null;
  if (inspector == null && !hasFileFailClose) {
    return;
  }
  const inspectionSession = inspector?.createSession();
  const shouldContinueAfterFinding = inspectionSession?.hasAuditRules === true;
  let finding: ReturnType<NonNullable<typeof inspectionSession>['inspect']> = null;
  const inspectFragments = (fragments: Iterable<TextContentFragment>): void => {
    if (finding == null || shouldContinueAfterFinding) {
      const nextFinding = inspectionSession?.inspect(fragments) ?? null;
      finding ??= nextFinding;
    }
  };
  const inspectFragment = (fragment: TextContentFragment): void => {
    if (finding == null || shouldContinueAfterFinding) {
      const nextFinding = inspectionSession?.inspectFragment(fragment) ?? null;
      finding ??= nextFinding;
    }
  };
  const traversalErrors: ContentTraversalLimitError[] = [
    ...(input.deferredTraversalErrors ?? []),
  ].filter((error) => {
    // Unscoped errors come from pre-existing fail-closed projection limits.
    // New part-snapshot errors describe exactly what they could not capture,
    // so only those use the selected-policy gate.
    if (getContentTraversalScopes(error).length === 0) {
      return true;
    }
    return isContentTraversalProtected({
      error,
      filters: input.filters,
      legacyPii: input.legacyPii,
    });
  });
  const storedMessageTraversalBudget = input.traversalBudget ?? {
    visitedNodes: 0,
    maxNodes: MAX_MODEL_BOUND_NESTED_TRAVERSAL_WORK,
  };
  const appendExtractedContent = (extract: () => readonly TextContentFragment[]) => {
    try {
      inspectFragments(extract());
    } catch (error) {
      if (!isContentTraversalLimitError(error)) {
        throw error;
      }
      inspectFragments(getContentTraversalFragments(error));
      if (
        isContentTraversalProtected({
          error,
          filters: input.filters,
          legacyPii: input.legacyPii,
        })
      ) {
        traversalErrors.push(error);
      }
    }
  };
  const resolvedFilesById = new Map<string, ModelBoundCanonicalFile>();
  const appendFile = (
    file: FileContentInput | string | null | undefined,
  ): ModelBoundCanonicalFile | undefined => {
    if (file == null) {
      return undefined;
    }
    const isHydratedCanonicalFile =
      typeof file === 'object' &&
      typeof (file as { file_id?: unknown }).file_id === 'string' &&
      (file as { file_id: string }).file_id.length > 0;
    if (isHydratedCanonicalFile) {
      assertHydratedFileInspectable(input.filters, file);
      assertInspectableFileInput(allowHydratedFileReferences(input.filters), file);
    } else {
      assertInspectableFileInput(input.filters, file);
    }
    inspectFragments(
      extractFileContent(typeof file === 'string' ? { content: file, text: file } : file),
    );
    return isHydratedCanonicalFile ? (file as ModelBoundCanonicalFile) : undefined;
  };
  for (const file of input.resolvedFiles ?? []) {
    const resolvedFile = appendFile(file);
    if (resolvedFile?.file_id != null) {
      resolvedFilesById.set(resolvedFile.file_id, resolvedFile);
    }
  }
  if (input.submittedMessages != null) {
    const preparedSubmittedMessages = snapshotExternalMessages(
      input.submittedMessages,
      storedMessageTraversalBudget,
    );
    assertInspectableFileInput(input.filters, preparedSubmittedMessages.messages);
    const appendSubmittedTraversalError = (error: ContentTraversalLimitError): void => {
      const hasExplicitScopes = getContentTraversalScopes(error).length > 0;
      const isProtected = isContentTraversalProtected({
        error,
        filters: input.filters,
        legacyPii: input.legacyPii,
        roles: preparedSubmittedMessages.roles,
      });
      if (
        isProtected &&
        (hasExplicitScopes ||
          isNestedMessageTraversalProtected({
            filters: input.filters,
            legacyPii: input.legacyPii,
            roles: preparedSubmittedMessages.roles,
          }))
      ) {
        traversalErrors.push(error);
      }
    };
    try {
      for (const fragment of extractMessageContent(preparedSubmittedMessages)) {
        inspectFragment(fragment);
      }
    } catch (error) {
      if (!isContentTraversalLimitError(error)) {
        throw error;
      }
      inspectFragments(getContentTraversalFragments(error));
      appendSubmittedTraversalError(error);
    }
  }
  let aggregateStoredTraversalErrorAdded = false;
  const appendStoredTraversalError = (error: ContentTraversalLimitError): void => {
    if (
      storedMessageTraversalBudget.visitedNodes >=
        (storedMessageTraversalBudget.maxNodes ?? CONTENT_TRAVERSAL_MAX_NODES) ||
      (storedMessageTraversalBudget.materializedCharacters ?? 0) >=
        (storedMessageTraversalBudget.maxMaterializedCharacters ??
          CONTENT_MATERIALIZATION_MAX_CHARACTERS)
    ) {
      if (aggregateStoredTraversalErrorAdded) {
        return;
      }
      aggregateStoredTraversalErrorAdded = true;
    }
    traversalErrors.push(error);
  };
  for (const message of input.storedMessages ?? []) {
    /** Structural limits belong to the message; assembled-text allocations remain request-wide. */
    const messageTraversalBudget: VisitNestedStringsBudget = {
      visitedNodes: 0,
      maxNodes: MAX_MODEL_BOUND_NESTED_TRAVERSAL_WORK,
      get materializedCharacters() {
        return storedMessageTraversalBudget.materializedCharacters;
      },
      set materializedCharacters(value: number | undefined) {
        storedMessageTraversalBudget.materializedCharacters = value;
      },
      maxMaterializedCharacters: storedMessageTraversalBudget.maxMaterializedCharacters,
    };
    const submittedPathState = getUserSubmittedPathState(message);
    const submittedMessageFieldState = getUserSubmittedMessageFieldPathState(message);
    const semanticUserSubmittedPaths = submittedMessageFieldState.entries.map(
      (entry) => entry.path as JsonPointer,
    );
    const effectiveUserSubmittedPaths = [
      ...new Set([...submittedPathState.paths, ...semanticUserSubmittedPaths]),
    ];
    const isUnattributedAssistant =
      input.filters?.messages?.unattributedAssistantContent === 'inspect' &&
      typeof message.isUserSubmitted !== 'boolean' &&
      effectiveUserSubmittedPaths.length === 0 &&
      (message.isCreatedByUser === false || normalizeRole(message) === 'assistant');
    const isEntireMessageUserSubmitted =
      message?.isCreatedByUser === true ||
      message?.isUserSubmitted === true ||
      submittedPathState.overflowed ||
      isUnattributedAssistant;
    let messageFragments: readonly TextContentFragment[];
    let traversalError: ContentTraversalLimitError | null = null;
    try {
      messageFragments = extractStoredMessageContent(message, messageTraversalBudget);
    } catch (error) {
      if (!isContentTraversalLimitError(error)) {
        throw error;
      }
      traversalError = error;
      messageFragments = getContentTraversalFragments(error);
    }
    const exactMessageFields = [
      ...new Set(submittedMessageFieldState.entries.map((entry) => entry.field)),
    ];
    const shouldInspectExactMessageFields =
      hasActivePiiPatterns(input.legacyPii) ||
      hasActivePiiFields(input.filters?.messages?.pii, exactMessageFields);
    let exactMessageFragments: Array<Extract<TextContentFragment, { source: 'message' }>> = [];
    let exactMessageTraversalError: ContentTraversalLimitError | null = null;
    if (shouldInspectExactMessageFields) {
      if (traversalError == null) {
        exactMessageFragments = getExactUserSubmittedMessageFragments(
          messageFragments,
          submittedMessageFieldState.entries,
        );
      } else {
        const exactMessageInspection = extractExactUserSubmittedMessageFragments(
          message,
          submittedMessageFieldState.entries,
          messageTraversalBudget,
        );
        exactMessageFragments = exactMessageInspection.fragments;
        exactMessageTraversalError = exactMessageInspection.traversalError;
      }
    }
    if (exactMessageTraversalError != null && shouldInspectExactMessageFields) {
      appendStoredTraversalError(
        new ContentTraversalLimitError([], [{ source: 'message', fields: exactMessageFields }]),
      );
    }
    if (
      submittedMessageFieldState.overflowed &&
      (hasActivePiiPatterns(input.legacyPii) ||
        hasActivePiiFields(input.filters?.messages?.pii, HITL_MESSAGE_FILTER_FIELDS))
    ) {
      traversalErrors.push(
        new ContentTraversalLimitError(
          [],
          [{ source: 'message', fields: [...HITL_MESSAGE_FILTER_FIELDS] }],
        ),
      );
    }
    if (!isEntireMessageUserSubmitted) {
      const userSubmittedPaths = submittedPathState.paths;
      const projectedMessage = projectUserSubmittedPaths(message, effectiveUserSubmittedPaths);
      if (projectedMessage != null) {
        assertInspectableFileInput(
          input.filters,
          omitResolvedCanonicalFileLocators(projectedMessage, resolvedFilesById, {
            messageCount: input.storedMessages?.length ?? 0,
            onTraversalFailure: input.onTraversalFailure,
          }),
        );
      }
      /** Legacy unmarked assistant rows are treated as model-generated by
       *  default. Strict attribution can inspect an otherwise unattributed
       *  assistant row as submitted content. Structured tool calls/results
       *  remain externally sourced model-bound content. Explicit paths and
       *  semantic steer parts identify user-authored fragments in mixed rows. */
      if (finding == null || shouldContinueAfterFinding) {
        const submittedPathSet = new Set<string>(userSubmittedPaths);
        for (const fragment of messageFragments) {
          if (fragment.source === 'tool_argument') {
            inspectFragment(fragment);
            if (finding != null && !shouldContinueAfterFinding) {
              break;
            }
          }
        }
        if (finding == null || shouldContinueAfterFinding) {
          const submittedToolOutputs: Array<
            Extract<TextContentFragment, { source: 'tool_argument' }>
          > = [];
          const assembledText: string[] = [];
          for (const fragment of messageFragments) {
            if (!isFragmentWithinSubmittedPaths(fragment, submittedPathSet)) {
              continue;
            }
            if (fragment.source !== 'tool_argument') {
              inspectFragment(fragment);
              if (finding != null && !shouldContinueAfterFinding) {
                break;
              }
            }
            if (
              fragment.source === 'message' &&
              (fragment.field === 'text' || fragment.field === 'content_part')
            ) {
              assembledText.push(fragment.text);
            } else if (fragment.source === 'tool_argument' && fragment.field === 'output') {
              submittedToolOutputs.push(fragment);
              assembledText.push(fragment.text);
            }
          }
          if (finding == null || shouldContinueAfterFinding) {
            for (const fragment of submittedToolOutputs) {
              inspectFragment(asUserSubmittedMessageFragment(fragment));
              if (finding != null && !shouldContinueAfterFinding) {
                break;
              }
            }
          }
          if (finding == null || shouldContinueAfterFinding) {
            inspectFragments(exactMessageFragments);
          }
          if (
            (finding == null || shouldContinueAfterFinding) &&
            (hasActivePiiPatterns(input.legacyPii) ||
              hasActivePiiFields(input.filters?.messages?.pii, ['assembled_context']))
          ) {
            const userSubmittedAssembledContext = createUserSubmittedAssembledContext(
              assembledText,
              messageTraversalBudget,
            );
            if (userSubmittedAssembledContext.fragment != null) {
              inspectFragment(userSubmittedAssembledContext.fragment);
            }
            if (userSubmittedAssembledContext.overflowed) {
              appendStoredTraversalError(
                new ContentTraversalLimitError(
                  [],
                  [{ source: 'assembled_context', fields: ['assembled_context'] }],
                ),
              );
            }
          }
        }
      }
      if (traversalError != null) {
        let traversalFilters = input.filters;
        if (userSubmittedPaths.length === 0 && traversalFilters != null) {
          traversalFilters = { ...traversalFilters, messages: undefined };
        }
        if (
          isContentTraversalProtected({
            error: traversalError,
            filters: traversalFilters,
            legacyPii: userSubmittedPaths.length > 0 ? input.legacyPii : undefined,
            roles: userSubmittedPaths.length > 0 ? ['user'] : [message.role],
          })
        ) {
          appendStoredTraversalError(traversalError);
        }
      }
      continue;
    }
    assertInspectableFileInput(
      input.filters,
      omitResolvedCanonicalFileLocators(message, resolvedFilesById, {
        messageCount: input.storedMessages?.length ?? 0,
        onTraversalFailure: input.onTraversalFailure,
      }),
    );
    inspectFragments(messageFragments);
    inspectFragments(exactMessageFragments);
    if (
      traversalError != null &&
      isContentTraversalProtected({
        error: traversalError,
        filters: input.filters,
        legacyPii: input.legacyPii,
        roles: [message.role ?? 'user'],
      })
    ) {
      appendStoredTraversalError(traversalError);
    }
  }
  for (const agent of input.agents ?? []) {
    const agentFilesById = new Map<string, ModelBoundCanonicalFile>();
    for (const file of getHydratedAgentFiles(agent)) {
      const resolvedFile = appendFile(file);
      if (resolvedFile?.file_id != null) {
        agentFilesById.set(resolvedFile.file_id, resolvedFile);
      }
    }
    assertInspectableFileInput(
      input.filters,
      omitResolvedCanonicalFileLocators(agent, agentFilesById, {
        onTraversalFailure: input.onTraversalFailure,
        messageCount: input.storedMessages?.length ?? 0,
      }),
    );
    appendExtractedContent(() => extractAgentContent(agent));
  }
  for (const assistant of input.assistants ?? []) {
    assertInspectableFileInput(input.filters, assistant);
    appendExtractedContent(() => extractAssistantContent(assistant));
  }
  for (const action of input.actions ?? []) {
    appendExtractedContent(() => extractAssistantActionContent(action));
  }
  for (const skill of input.skills ?? []) {
    appendExtractedContent(() => extractSkillContent(skill));
  }
  for (const memory of input.memories ?? []) {
    inspectFragments(extractMemoryContent(typeof memory === 'string' ? { value: memory } : memory));
  }
  for (const file of input.files ?? []) {
    appendFile(file);
  }

  if (finding != null) {
    throw new ContentFilterError(finding);
  }
  if (traversalErrors.length > 0) {
    throw traversalErrors[0];
  }
}
