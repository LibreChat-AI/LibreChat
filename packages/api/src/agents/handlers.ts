import yaml from 'js-yaml';
import { Types } from 'mongoose';
import { GraphEvents, Constants, ToolEndHandler } from '@librechat/agents';
import {
  logger,
  normalizeSkillFrontmatterKeys,
  deriveStructuredFrontmatterFields,
} from '@librechat/data-schemas';
import {
  AGENT_BACKGROUND_COMPLETION_RESULT_MAX_CHARS_DEFAULT,
  CODE_ENVIRONMENT_READ_FILE_DEFAULT_LINES,
  CODE_ENVIRONMENT_READ_FILE_HARD_MAX_LINES,
  hasActivePiiFields,
  hasActivePiiPatterns,
  hasToolCallErrorPrefix,
} from 'librechat-data-provider';
import type {
  LCTool,
  FileRefs,
  EventHandler,
  LCToolRegistry,
  InjectedMessage,
  ToolCallRequest,
  ToolExecuteResult,
  ToolExecuteBatchRequest,
  SubagentTaskConfig,
  SubagentExecutionContext,
  CallerCapabilityProjectionSnapshot,
  StreamEventData,
  ToolEndCallback as SdkToolEndCallback,
} from '@librechat/agents';
import type {
  BackgroundToolResultClaim,
  DeleteSkillResult,
  ValidationIssue,
} from '@librechat/data-schemas';
import type { CodeEnvRef, CodeWorkspaceOperation, PtcToolCallEvent } from 'librechat-data-provider';
import type { StructuredToolInterface } from '@librechat/agents/langchain/tools';
import type { CodeEnvFile, CodeSessionContext } from '@librechat/agents';
import type {
  WorkspaceAdmissionOptions,
  WorkspaceEditResult,
  WorkspaceTextEdit,
  WorkspacePreviewEditResult,
  WorkspaceListResult,
  WorkspaceReadResult,
  WorkspaceSearchResult,
  WorkspaceWriteResult,
} from '~/code/workspace';
import type {
  BackgroundToolDeadClaimRecovery,
  BackgroundToolWakeupAdmission,
  BackgroundToolWakeupRegistration,
  PendingBackgroundCompletionControls,
} from './backgroundCompletion';
import type { ScheduleMCPExecution } from '~/schedules/authorization/execution';
import type { SkillFileRecord, PrimeSkillFilesResult } from './skillFiles';
import type { InterruptibleToolBatchRequest } from './steering/tools';
import type { ArtifactDeliveryFailure } from '~/files/code';
import type { BackgroundToolResultState } from './harvest';
import type { SandboxTextReader } from '~/files/code/text';
import type { WorkspaceEditMatching } from '~/code/edits';
import type { CodeExecutionContext } from './execution';
import type { TextContentFragment } from '~/protection';
import type { RunFileSession } from './files/session';
import type { ServerRequest } from '~/types';
import type { TextEdit } from './edits';
import {
  backgroundTaskRegistry,
  runCheckBackgroundTask,
  getBackgroundTaskSnapshot,
  claimBackgroundArtifact,
  restoreBackgroundArtifact,
  getBackgroundCodeDelivery,
  isBackgroundRequested,
  hasRunInBackgroundArg,
  stripRunInBackgroundArg,
  buildBackgroundHandleContent,
  buildBackgroundCapacityContent,
  stripBackgroundFromToolDefinitions,
  withBackgroundTaskTimeout,
  BACKGROUND_STATUS_ATTACHMENT_TYPE,
  CHECK_BACKGROUND_TASK_NAME,
  RUN_IN_BACKGROUND_ARG,
} from './background';
import {
  contentFilterUninspectableResponse,
  extractFileContent,
  extractSkillContent,
  extractToolArgumentContent,
  hasActiveFileFieldPolicy,
  getContentTraversalFragments,
  getBlockedUninspectableFileField,
  inspectContent,
  isContentTraversalLimitError,
  isContentTraversalProtected,
} from '~/protection';
import {
  CREATE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  HOST_FILE_AUTHORING_ARTIFACT_KEY,
  LIST_WORKSPACE_FILES_TOOL_NAME,
  SEARCH_WORKSPACE_TOOL_NAME,
  isCodeFileToolName,
  isCodeSessionToolName,
  isFileResourceToolName,
} from './tools';
import {
  resolveAttachedWorkspaceReadFileLines,
  WorkspaceToolHttpError,
  resolveAttachedWorkspaceAdmissionOptions,
  WORKSPACE_EDIT_MAX_COUNT,
  WORKSPACE_WRITE_MAX_BYTES,
} from '~/code/workspace';
import {
  noteToolApprovalDispatch,
  bindToolApprovalInvocation,
  finishToolApprovalDispatch,
  getToolApprovalExecutionScope,
} from '~/tools/approval';
import {
  BACKGROUND_TASK_ABORT_GRACE_MS,
  BACKGROUND_TASK_SHUTDOWN_MESSAGE,
  BACKGROUND_TOOL_PRODUCER_HEARTBEAT_MS,
} from './backgroundCompletion';
import {
  createCodeApiRateLimitBudget,
  isAbortError,
  logAxiosError,
  truncateMiddle,
  runOutsideTracing,
  getSafeErrorMetadata,
} from '~/utils';
import {
  isAttachedWorkspaceBashTool,
  resolveAttachedWorkspaceQueueWaitMs,
  resolveAttachedWorkspaceRequestTimeoutMs,
} from '~/code/command';
import {
  ContentFilterError,
  contentFilterModelBoundBlockResponse,
  isContentFilterError,
} from '~/middleware/contentFilter';
import {
  hasIntentArg,
  stripIntentArg,
  stripIntentLabelsFromToolDefinitions,
  INTENT_ARG,
} from './intent';
import { editConflictExcerptText, formatEditConflict, parseEditConflict } from '~/code/edits';
import { buildSkillPrimeMessage, isSkillFilePath, SKILL_FILE_PREFIX } from './skills';
import { resolveCallerCapabilityProjectionSnapshot } from './callerCapabilities';
import { SteerToolInterrupt, interruptedToolResult } from './steering/tools';
import { BACKGROUND_TOOL_INVOCATION_CONFIG_KEY } from './invocation';
import { mergeCodeFilesIntoContext } from './codeFilesSession';
import { toolValidationFeedback } from './validationFeedback';
import { explainWorkspacePathRejection } from '~/code/paths';
import { createSkillContentDigest } from './compatibility';
import { isMissingSandboxPathError } from '~/files/code';
import { applyHostTextEdits } from './files/processing';
import { deleteSkillWithRetry } from '~/skills/cleanup';
import { resolveDownloadPath } from '~/storage/path';
import { parseFrontmatter } from '../skills/import';
import { HostEditError } from './files/matching';
import { cleanCodeToolOutput } from './cleanup';
import { primeSkillFiles } from './skillFiles';
import { instrumentPtcToolMap } from './ptc';
import { markSandboxReady } from './prewarm';
import { normalizeEditArgs } from './edits';

export interface ToolEndCallbackData {
  /** The executed call's arguments. The stream-consumer tool-end path cannot
   * reconstruct these, so the execution handler — which owns both halves —
   * must supply them for consumers that fence on the input (the event-actor
   * action recorder validates its declared argument subset against this). */
  input?: unknown;
  /** True when this callback delivers the harvested completion of a
   * previously dispatched background task on a poll turn. `output.name` then
   * reports the ORIGINAL tool for artifact attribution while `input` carries
   * the poll call's arguments — consumers that fence on execution identity
   * (the event-actor action recorder) must ignore these deliveries, or a
   * name-only expected action could be impersonated by work another turn
   * dispatched. */
  backgroundDelivery?: boolean;
  /** True when the tool executed successfully but its returned content was
   * withheld by post-execution output policy. `output.content` is blank and
   * no artifact rides the callback — this delivery exists solely so
   * execution-identity consumers (the event-actor action recorder) can prove
   * the side effect occurred; a retry of an "actionless" turn would otherwise
   * repeat an external action whose output was merely filtered. */
  outputFiltered?: boolean;
  output: {
    name: string;
    tool_call_id: string;
    content: string | unknown;
    artifact?: unknown;
  };
}

export interface EventActorDetachedActionLifecycle {
  reserve(input: {
    toolName: string;
    toolCallId: string;
    turnId: string;
    arguments: unknown;
  }): Promise<
    | { status: 'ignored' }
    | { status: 'conflict'; error?: string }
    | {
        status: 'terminal';
        taskId: string;
        idempotencyKey: string;
        outcome: 'succeeded' | 'failed' | 'cancelled';
        result?: string;
        error?: string;
      }
    | {
        status: 'reserved' | 'replay';
        taskId: string;
        idempotencyKey: string;
      }
  >;
  markRunning(input: { taskId: string; idempotencyKey: string }): Promise<boolean>;
  settle(input: {
    taskId: string;
    idempotencyKey: string;
    status: 'succeeded' | 'failed' | 'cancelled';
    result?: unknown;
    error?: string;
  }): Promise<boolean>;
  wake(input: { taskId: string; idempotencyKey: string }): Promise<void>;
}

export interface ToolEndCallbackMetadata {
  /** SDK-authored lineage for artifacts generated inside a child execution. */
  executionContext?: SubagentExecutionContext;
  run_id?: string;
  thread_id?: string;
  [key: string]: unknown;
}

/** Projects the graph-owned agent and step identifiers onto persisted tool attachments. */
export function getAttachmentOwnership(metadata?: ToolEndCallbackMetadata): {
  agentId?: string;
  stepId?: string;
} {
  const agentId = metadata?.executingAgentId ?? metadata?.agentId ?? metadata?.agent_id;
  const stepId = metadata?.stepId;
  return {
    ...(typeof agentId === 'string' && agentId.length > 0 ? { agentId } : {}),
    ...(typeof stepId === 'string' && stepId.length > 0 ? { stepId } : {}),
  };
}

export type ToolEndCallback = (
  data: ToolEndCallbackData,
  metadata: ToolEndCallbackMetadata,
) => Promise<void>;

/**
 * Preserve the SDK's event-handler contract while attaching the graph-owned
 * step identity to legacy artifact callbacks. `toolCallStepIds` is populated
 * by ToolNode for the actual provider tool call; this wrapper never invents a
 * fallback identity.
 */
export function createOwnedToolEndHandler(
  callback: SdkToolEndCallback,
  loggerArg: typeof logger = logger,
): EventHandler {
  const toolEndHandler = new ToolEndHandler(callback, loggerArg);
  return {
    handle: async (event, data: StreamEventData, metadata, graph) => {
      const output = data?.output;
      const toolCallId =
        typeof output === 'object' && output != null
          ? (output as { tool_call_id?: unknown }).tool_call_id
          : undefined;
      const stepId =
        typeof toolCallId === 'string' ? graph?.toolCallStepIds?.get(toolCallId) : undefined;
      const ownedMetadata =
        typeof stepId === 'string' && stepId.length > 0
          ? { ...(metadata ?? {}), stepId }
          : metadata;
      return toolEndHandler.handle(event, data, ownedMetadata, graph);
    },
  };
}

export interface ToolExecuteOptions {
  /** Host-captured authority ceiling, never runnable/model metadata. */
  scheduledMCPExecution?: Pick<ScheduleMCPExecution, 'enrolled' | 'identity'>;
  /**
   * Host-owned signal for the foreground run. This is authoritative across
   * graph reconstruction (including approval resume); the SDK event signal is
   * composed with it below so circuit-breaker cancellation is preserved too.
   */
  runSignal?: AbortSignal;
  /** Run id owned by `runSignal`; detached child runs carry a different id. */
  foregroundRunId?: string;
  /** Loads tools by name, using agentId to look up agent-specific context */
  loadTools: (
    toolNames: string[],
    agentId?: string,
    /** Immutable run configuration available before deferred tools connect. */
    configurable?: Record<string, unknown>,
    /** SDK-owned live caller capability projection for this agent context. */
    callerCapabilityProjection?: CallerCapabilityProjectionSnapshot,
    /** Effective cancellation signal for this tool-execute batch. */
    signal?: AbortSignal,
    /** SDK-authored lineage; never derive child identity from saved agent IDs. */
    executionContext?: SubagentExecutionContext,
  ) => Promise<{
    loadedTools: StructuredToolInterface[];
    /** Additional configurable properties to merge (e.g., userMCPAuthMap) */
    configurable?: Record<string, unknown>;
  }>;
  /** Trusted detached-subagent task scope for polling and parent controls. */
  subagentTasks?: SubagentTaskConfig;
  /** Shared-file grants and tool contexts scoped to the executing run instance. */
  runFiles?: Pick<RunFileSession, 'isActive' | 'prepareTools' | 'withCodeExecution'>;
  /** Trusted deployment gate for cooperative ordinary-tool cancellation. */
  ordinaryToolCancellation?: boolean;
  /** Deployment-configured cap for terminal output copied into durable receipts. */
  backgroundCompletionResultMaxChars?: number;
  /** Callback to process tool artifacts (code output files, file citations, etc.) */
  toolEndCallback?: ToolEndCallback;
  /** Run steps whose call resolved to the attached-workspace `bash_tool`
   *  instance; the step-completed handler consumes them to stamp `executor`. */
  attachedCommandStepIds?: Set<string>;
  /** Durable internal-completion adapter, present only for an Event Actor invocation. */
  eventActorDetachedAction?: EventActorDetachedActionLifecycle;
  /** Called once per batch before tool execution to lazily provision files to tool
   *  environments. Resolves to the code-env refs it uploaded, which the caller folds
   *  into this batch's code-session context. */
  provisionFiles?: (
    toolNames: string[],
    agentId?: string,
    signal?: AbortSignal,
    executionContext?: SubagentExecutionContext,
  ) => Promise<CodeEnvFile[] | void>;
  /**
   * Persists a backgrounded code-execution result onto the dispatch turn once
   * the detached call settles: downloads/persists generated files, patches the
   * original tool-call part's `output`, and appends the attachments to the
   * dispatch turn's message row. Returns the persisted attachments so the poll
   * turn can re-emit them on its live stream. With `reapply: true` it only
   * re-applies the (idempotent) row patch using the provided attachments — no
   * file processing — to heal a full-row save that reverted the anchor.
   */
  persistBackgroundCodeResult?: (params: {
    toolName: string;
    toolCallId: string;
    stepId?: string;
    messageId?: string;
    conversationId?: string;
    agentId?: string;
    dispatchedAt?: number;
    output?: string;
    artifact?: unknown;
    codeExecutionContext?: CodeExecutionContext;
    attachments?: unknown[];
    reapply?: boolean;
    backgroundTask?: BackgroundToolResultState;
    resolveBackgroundTask?: () => BackgroundToolResultState;
    onFilesPersisted?: (attachments: unknown[]) => void;
  }) => Promise<{ attachments?: unknown[]; deliveryReady?: boolean } | null>;
  /** Shared ordinary-tool completion lifecycle. The delivery is registered
   * before invoke; settlement is persisted onto the original response row. */
  backgroundToolCompletion?: {
    preregister?: (
      registration: BackgroundToolWakeupRegistration,
    ) => Promise<BackgroundToolWakeupAdmission | false>;
    persist: (params: {
      toolName: string;
      toolCallId: string;
      stepId?: string;
      messageId?: string;
      conversationId?: string;
      agentId?: string;
      output?: string;
      backgroundTask: BackgroundToolResultState;
      resolveBackgroundTask?: () => BackgroundToolResultState;
    }) => Promise<boolean>;
    claim: (params: {
      userId: string;
      conversationId: string;
      messageId?: string;
      taskId: string;
      agentId?: string;
      kind: 'manual';
      claimId: string;
      generationId?: string;
      allowUnfinished?: boolean;
    }) => Promise<BackgroundToolResultClaim>;
    recoverDeadClaim?: BackgroundToolDeadClaimRecovery;
    /** Durable view of undelivered completions, so a status check counts results
     * dispatched in earlier turns, on other replicas, or before a restart. */
    pending?: PendingBackgroundCompletionControls;
  };
  /** Emits an `attachment` SSE event on the current request's live stream. */
  emitAttachment?: (attachment: unknown) => void;
  /**
   * Emits an `on_ptc_tool_call` SSE event for one inner tool invocation made
   * by a programmatic tool-calling program. Absent on transports that don't
   * carry the LibreChat step stream (Open Responses), which simply skips the
   * instrumentation.
   */
  emitPtcProgress?: (event: PtcToolCallEvent) => void;
  /**
   * Loads a skill by name with ACL constraint (returns full body for injection).
   *
   * `options.preferModelInvocable` (Phase 6): on a same-name collision,
   * prefer the newest `disableModelInvocation !== true` doc. Avoids a
   * newer disabled duplicate shadowing the cataloged model-invocable
   * skill the model actually targeted; falls back to newest match so
   * the explicit-rejection gate can still fire in the disabled-only case.
   */
  getSkillByName?: (
    name: string,
    accessibleIds: Types.ObjectId[],
    options?: { preferUserInvocable?: boolean; preferModelInvocable?: boolean },
  ) => Promise<{
    body: string;
    name: string;
    description?: string;
    frontmatter?: Record<string, unknown>;
    _id: Types.ObjectId;
    /** Monotonic counter on the skill record. Threaded into
     *  `codeEnvRef.version` so codeapi's sessionKey scopes the cache
     *  per-revision; bumping the version on edit invalidates the
     *  prior cache entry. */
    version: number;
    fileCount: number;
    source?: 'inline' | 'github' | 'notion' | 'deployment';
    /** True for deployment-directory skills that are loaded in memory. */
    deployment?: boolean;
    /**
     * Set when the skill author opted out of model invocation. The handler
     * rejects the call and returns an instructive error so the model knows
     * it can't reach the skill via the `skill` tool — manual `$` invocation
     * is still allowed and goes through `resolveManualSkills` instead.
     */
    disableModelInvocation?: boolean;
  } | null>;
  /** Captures a successfully resolved model-invoked Skill for durable continuation context. */
  onSkillResolved?: (
    skill: {
      id: string;
      name: string;
      version: number;
      contentDigest: string;
    },
    context: { agentId?: string },
  ) => void;
  /**
   * Loads a skill by name when the current user is the author. This is a
   * narrow recovery path for freshly-authored skills whose runtime catalog
   * snapshot has not caught up yet; normal skill resolution still goes
   * through `accessibleSkillIds`.
   */
  getAuthorSkillByName?: (params: { req: ServerRequest; name: string }) => Promise<{
    body: string;
    name: string;
    description?: string;
    frontmatter?: Record<string, unknown>;
    _id: Types.ObjectId;
    version: number;
    fileCount: number;
    source?: 'inline' | 'github' | 'notion' | 'deployment';
    disableModelInvocation?: boolean;
  } | null>;
  /** Creates a skill from a tool-authored SKILL.md body. */
  createSkill?: (data: {
    name: string;
    description: string;
    body: string;
    frontmatter?: Record<string, unknown>;
    author: Types.ObjectId;
    authorName: string;
    alwaysApply?: boolean;
    tenantId?: string;
  }) => Promise<{
    skill: {
      _id: Types.ObjectId;
      name: string;
      body: string;
      version: number;
    };
    warnings: ValidationIssue[];
  }>;
  /** Updates a skill body and derived metadata from a tool-authored SKILL.md body. */
  updateSkill?: (params: {
    id: string;
    expectedVersion: number;
    update: {
      body?: string;
      description?: string;
      frontmatter?: Record<string, unknown>;
      alwaysApply?: boolean;
    };
  }) => Promise<
    | {
        status: 'updated';
        skill: { _id: Types.ObjectId; name: string; body: string; version: number };
        warnings: ValidationIssue[];
      }
    | { status: 'conflict'; current: { _id: Types.ObjectId; name: string; version: number } }
    | { status: 'not_found' }
  >;
  /** Checks role-level skill creation permission for the current user. */
  canCreateSkill?: (params: { req: ServerRequest }) => Promise<boolean>;
  /** Checks resource-level edit permission for an existing skill. */
  canEditSkill?: (params: {
    req: ServerRequest;
    skillId: Types.ObjectId | string;
  }) => Promise<boolean>;
  /** Grants SKILL_OWNER to the current user after a tool-created skill is inserted. */
  grantSkillOwner?: (params: {
    req: ServerRequest;
    skillId: Types.ObjectId | string;
  }) => Promise<void>;
  /** Deletes a freshly-created skill if owner-permission setup fails. */
  deleteSkill?: (id: string) => Promise<DeleteSkillResult>;
  /** Saves or replaces a bundled skill file in configured storage and metadata. */
  saveSkillFileContent?: (params: {
    req: ServerRequest;
    skillId: Types.ObjectId | string;
    relativePath: string;
    content: string;
    mimeType: string;
    expectedFileId?: string;
    createOnly: boolean;
  }) => Promise<{
    bytes: number;
    relativePath: string;
  }>;
  /** Lists files bundled with a skill (for code env priming) */
  listSkillFiles?: (skillId: Types.ObjectId | string) => Promise<SkillFileRecord[]>;
  /** Storage strategy resolver for skill file streaming */
  getStrategyFunctions?: (source: string) => {
    getDownloadStream?: (req: ServerRequest, filepath: string) => Promise<NodeJS.ReadableStream>;
    [key: string]: unknown;
  };
  /** Batch uploads files to the code execution environment. `kind`/`id`/
   *  `version?` carry the resource identity codeapi uses to derive the
   *  sessionKey for the batch's storage bucket. */
  batchUploadCodeEnvFiles?: (params: {
    req: ServerRequest;
    files: Array<{ stream: NodeJS.ReadableStream; filename: string }>;
    kind: 'skill' | 'agent' | 'user';
    id: string;
    version?: number;
    read_only?: boolean;
    codeApiBaseUrl?: string;
    executionProfile?: CodeExecutionContext['executionProfile'];
    bridgeWorkerId?: string;
    signal?: AbortSignal;
  }) => Promise<{
    storage_session_id: string;
    files: Array<{ fileId: string; filename: string }>;
  }>;
  /** Checks if a code env file is still active. Returns lastModified or null. */
  getSessionInfo?: (
    ref: CodeEnvRef,
    req?: ServerRequest,
    route?: {
      baseUrl?: string;
      executionProfile?: CodeExecutionContext['executionProfile'];
      bridgeWorkerId?: string;
    },
  ) => Promise<string | null>;
  /** 23-hour freshness check */
  checkIfActive?: (dateString: string) => boolean;
  /** Persists `codeEnvRef` on skill files after upload */
  updateSkillFileCodeEnvIds?: (
    updates: Array<{
      skillId: Types.ObjectId | string;
      relativePath: string;
      codeEnvRef: CodeEnvRef;
    }>,
  ) => Promise<void>;
  /** Loads a skill file by path (for read_file tool) */
  getSkillFileByPath?: (
    skillId: Types.ObjectId | string,
    relativePath: string,
  ) => Promise<{
    file_id?: string;
    content?: string;
    isBinary?: boolean;
    mimeType: string;
    bytes: number;
    filepath: string;
    source: string;
    relativePath: string;
  } | null>;
  /** Updates cached content on a skill file (lazy caching after first read) */
  updateSkillFileContent?: (
    skillId: Types.ObjectId | string,
    relativePath: string,
    update: { content?: string; isBinary?: boolean },
    expectedFileId?: string,
  ) => Promise<void>;
  /** Reads a bounded text range from an attached worker's logical workspace. */
  readWorkspaceFile?: (params: {
    file_path: string;
    workspace_id: string;
    workspace_instance_id?: string;
    linked_worktrees?: boolean;
    start_line: number;
    max_lines: number;
    codeApiBaseUrl: string;
    executionProfile: CodeExecutionContext['executionProfile'];
    bridgeWorkerId?: string;
    req?: ServerRequest;
    signal?: AbortSignal;
    maxQueueWaitMs?: number;
    maxRequestTimeoutMs?: number;
    maxRunTimeoutMs?: number;
    admission?: WorkspaceAdmissionOptions['admission'];
    deadlineAtMs?: number;
  }) => Promise<WorkspaceReadResult>;
  /** Searches literal text within an attached worker's logical workspace. */
  searchWorkspace?: (params: {
    query: string;
    workspace_id: string;
    workspace_instance_id?: string;
    linked_worktrees?: boolean;
    path?: string;
    max_results: number;
    codeApiBaseUrl: string;
    executionProfile: CodeExecutionContext['executionProfile'];
    bridgeWorkerId?: string;
    req?: ServerRequest;
    signal?: AbortSignal;
    maxQueueWaitMs?: number;
    maxRequestTimeoutMs?: number;
    maxRunTimeoutMs?: number;
    admission?: WorkspaceAdmissionOptions['admission'];
    deadlineAtMs?: number;
  }) => Promise<WorkspaceSearchResult>;
  /** Lists relative file paths within an attached worker's logical workspace. */
  listWorkspaceFiles?: (params: {
    workspace_id: string;
    workspace_instance_id?: string;
    linked_worktrees?: boolean;
    path?: string;
    after_path?: string;
    max_results: number;
    codeApiBaseUrl: string;
    executionProfile: CodeExecutionContext['executionProfile'];
    bridgeWorkerId?: string;
    req?: ServerRequest;
    signal?: AbortSignal;
    maxQueueWaitMs?: number;
    maxRequestTimeoutMs?: number;
    maxRunTimeoutMs?: number;
    admission?: WorkspaceAdmissionOptions['admission'];
    deadlineAtMs?: number;
  }) => Promise<WorkspaceListResult>;
  /** Writes a UTF-8 file within an attached worker's logical workspace. */
  writeWorkspaceFile?: (params: {
    file_path: string;
    content: string;
    overwrite: boolean;
    workspace_id: string;
    workspace_instance_id?: string;
    linked_worktrees?: boolean;
    codeApiBaseUrl: string;
    executionProfile: CodeExecutionContext['executionProfile'];
    bridgeWorkerId?: string;
    req?: ServerRequest;
    signal?: AbortSignal;
    maxQueueWaitMs?: number;
    maxRequestTimeoutMs?: number;
    maxRunTimeoutMs?: number;
    admission?: WorkspaceAdmissionOptions['admission'];
    deadlineAtMs?: number;
  }) => Promise<WorkspaceWriteResult>;
  /** Previews exact replacements without mutating an attached worker workspace. */
  previewWorkspaceEdit?: (params: {
    file_path: string;
    edits: WorkspaceTextEdit[];
    /** Sent only to workers that negotiated `tolerant_match`. */
    matching?: WorkspaceEditMatching;
    workspace_id: string;
    workspace_instance_id?: string;
    linked_worktrees?: boolean;
    codeApiBaseUrl: string;
    executionProfile: CodeExecutionContext['executionProfile'];
    bridgeWorkerId?: string;
    req?: ServerRequest;
    signal?: AbortSignal;
    maxQueueWaitMs?: number;
    maxRequestTimeoutMs?: number;
    maxRunTimeoutMs?: number;
    admission?: WorkspaceAdmissionOptions['admission'];
    deadlineAtMs?: number;
  }) => Promise<WorkspacePreviewEditResult>;
  /** Applies exact replacements atomically within an attached worker workspace. */
  editWorkspaceFile?: (params: {
    file_path: string;
    edits: WorkspaceTextEdit[];
    expected_base_sha256?: string;
    /** Sent only to workers that negotiated `tolerant_match`. */
    matching?: WorkspaceEditMatching;
    workspace_id: string;
    workspace_instance_id?: string;
    linked_worktrees?: boolean;
    codeApiBaseUrl: string;
    executionProfile: CodeExecutionContext['executionProfile'];
    bridgeWorkerId?: string;
    req?: ServerRequest;
    signal?: AbortSignal;
    maxQueueWaitMs?: number;
    maxRequestTimeoutMs?: number;
    maxRunTimeoutMs?: number;
    admission?: WorkspaceAdmissionOptions['admission'];
    deadlineAtMs?: number;
  }) => Promise<WorkspaceEditResult>;
  /** Bounded reads return complete text; omitted maxBytes retains the legacy stdout path. */
  readSandboxFile?: SandboxTextReader;
  /**
   * Reads a small image file out of the code-execution sandbox as base64 so
   * `read_file` can surface it to vision-capable models. The `readSandboxFile`
   * `cat` path round-trips stdout through codeapi's JSON transport, which
   * lossily replaces non-UTF-8 bytes and mangles image data — this reader
   * base64-encodes the bytes IN the sandbox (ASCII-safe over JSON) after an
   * in-sandbox size guard so an oversize image never crosses the wire.
   * Returns `null` when codeapi is unavailable; throws on transport / read
   * errors so the handler can fall back to an instructive message.
   */
  readSandboxImage?: (params: {
    file_path: string;
    session_id?: string;
    files?: SandboxFileRef[];
    /** @see readSandboxFile.runtime_session_hint */
    runtime_session_hint?: string;
    codeApiBaseUrl?: string;
    executionProfile?: CodeExecutionContext['executionProfile'];
    bridgeWorkerId?: string;
    executionRouteKey?: string;
    /** In-sandbox size cap; files larger than this return `tooLarge` without transferring bytes. */
    maxBytes?: number;
    req?: ServerRequest;
    signal?: AbortSignal;
  }) => Promise<
    | { base64: string; bytes: number }
    /** `size`: over `maxBytes`. `round_trips`: within the byte cap, but more
     *  windowed `/exec` reads than one call may spend on the Code API's
     *  per-user execution limiter. */
    | { tooLarge: true; reason?: 'size' | 'round_trips'; bytes: number; inlineCeiling?: number }
    | null
  >;
  /**
   * Writes a UTF-8 text file into the code-execution sandbox via the
   * sandbox `/exec` endpoint. Mirrors `readSandboxFile` session forwarding
   * so host-side file-authoring tools can operate in the same sandbox
   * session as `bash_tool` / `read_file`.
   */
  writeSandboxFile?: (params: {
    file_path: string;
    content: string;
    session_id?: string;
    files?: SandboxFileRef[];
    /** @see readSandboxFile.runtime_session_hint */
    runtime_session_hint?: string;
    codeApiBaseUrl?: string;
    executionProfile?: CodeExecutionContext['executionProfile'];
    req?: ServerRequest;
  }) => Promise<{
    stdout?: string;
    stderr?: string;
    session_id?: string;
    files?: SandboxFileRef[];
    artifact_delivery?: ArtifactDeliveryFailure;
  } | null>;
}

const MAX_READABLE_BYTES = 262_144;
const MAX_BINARY_BYTES = 5 * 1024 * 1024;

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) {
    return value;
  }
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString('utf8');
}

/**
 * Inline ceiling for images pulled out of the code-execution sandbox —
 * deliberately tighter than {@link MAX_BINARY_BYTES}, which governs the
 * skill-file path. The two differ because their transports differ: skill
 * files stream from storage, while sandbox bytes come back base64 over
 * `/exec` stdout, which the runner caps (`SANDBOX_OUTPUT_MAX_SIZE`). The
 * reader therefore windows the file, so cost scales in round-trips —
 * ~32 at this limit vs ~160 at 5MB. Nothing is lost by stopping here:
 * vision providers downsample to ~1.5-2k px regardless, so multi-MB
 * originals buy no fidelity, and anything larger degrades to the
 * `bash_tool` hint below.
 */
const MAX_SANDBOX_INLINE_IMAGE_BYTES = 1024 * 1024;
const MAX_CACHE_BYTES = 512 * 1024;
const MAX_AUTHORING_BYTES = 10 * 1024 * 1024;
const MAX_TOOL_ERROR_MESSAGE_CHARS = 12_000;
const MAX_TOOL_ERROR_STACK_CHARS = 4_000;
const SKILL_MD = 'SKILL.md';
const MAX_SKILL_AUTHORING_WARNINGS = 20;
const MAX_SKILL_WARNING_FIELD_CHARS = 120;
const MAX_SKILL_WARNING_CODE_CHARS = 64;
const MAX_SKILL_WARNING_MESSAGE_CHARS = 300;

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function getCodeExecutionContext(
  configurable: Record<string, unknown>,
): CodeExecutionContext | undefined {
  const context = configurable.codeExecutionContext;
  if (context == null || typeof context !== 'object') {
    return undefined;
  }
  const candidate = context as Partial<CodeExecutionContext>;
  if (
    typeof candidate.baseUrl !== 'string' ||
    typeof candidate.codeSessionKey !== 'string' ||
    (candidate.executionProfile !== 'default' && candidate.executionProfile !== 'stateful') ||
    typeof candidate.statefulSessions !== 'boolean'
  ) {
    return undefined;
  }
  return candidate as CodeExecutionContext;
}

function selectedWorkspaceId(
  context: CodeExecutionContext,
  operation: CodeWorkspaceOperation,
): string | undefined {
  const workspace = context.codeWorkspace;
  if (
    workspace == null ||
    workspace.environmentId !== context.environmentId ||
    !workspace.operations.includes(operation)
  ) {
    return undefined;
  }
  return workspace.workspaceId;
}

function unavailableWorkspaceOperation(
  tc: ToolCallRequest,
  operation: CodeWorkspaceOperation,
): ToolExecuteResult {
  return errorResult(
    tc,
    `The selected attached workspace is unavailable or does not permit ${operation}. Choose an available workspace and retry.`,
  );
}

function codeExecutionRequestParams(context?: CodeExecutionContext): {
  codeApiBaseUrl?: string;
  executionProfile?: CodeExecutionContext['executionProfile'];
  bridgeWorkerId?: string;
  executionRouteKey?: string;
  runtime_session_hint?: string;
} {
  if (!context) {
    return {};
  }
  return {
    codeApiBaseUrl: context.baseUrl,
    executionProfile: context.executionProfile,
    ...(context.executionRouteKey ? { executionRouteKey: context.executionRouteKey } : {}),
    ...(context.bridgeWorkerId ? { bridgeWorkerId: context.bridgeWorkerId } : {}),
    ...(context.runtimeSessionHint ? { runtime_session_hint: context.runtimeSessionHint } : {}),
  };
}

type ToolInputSchemaKind = {
  object: boolean;
  string: boolean;
};

function stringifyThrownValue(error: unknown): string {
  try {
    return String(error);
  } catch {
    return '[Thrown value could not be converted to string]';
  }
}

function getThrownValueMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (error != null && typeof error === 'object') {
    try {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string') {
        return message;
      }
      if (message != null) {
        return stringifyThrownValue(message);
      }
    } catch {
      // Fall through to whole-value stringification.
    }
  }

  return stringifyThrownValue(error);
}

function getSafeToolError(
  error: unknown,
  feedback?: string,
): {
  message: string;
  logContext: Record<string, unknown>;
} {
  const thrownMessage = feedback ?? getThrownValueMessage(error);
  /** File text an attached edit conflict quotes goes to the model only, never to the logs. */
  const rawMessage =
    !feedback && error instanceof AttachedEditRejectionError ? error.modelMessage : thrownMessage;
  const logMessage = truncateMiddle(thrownMessage, MAX_TOOL_ERROR_MESSAGE_CHARS);
  const message = truncateMiddle(rawMessage, MAX_TOOL_ERROR_MESSAGE_CHARS);
  const stack = !feedback && error instanceof Error && error.stack ? error.stack : undefined;

  return {
    message,
    logContext: {
      errorName: error instanceof Error ? error.name : typeof error,
      ...(error instanceof WorkspaceToolHttpError
        ? {
            upstreamStatus: error.upstreamStatus,
            upstreamBody: error.upstreamBody,
            upstreamBodyTruncated: error.upstreamBodyTruncated,
          }
        : {}),
      errorMessage: logMessage,
      messageLength: rawMessage.length,
      messageTruncated: message.length !== rawMessage.length,
      stack: stack ? truncateMiddle(stack, MAX_TOOL_ERROR_STACK_CHARS) : undefined,
    },
  };
}

function mergeSchemaKind(target: ToolInputSchemaKind, source: ToolInputSchemaKind): void {
  target.object ||= source.object;
  target.string ||= source.string;
}

function detectToolInputSchemaKind(schema: unknown): ToolInputSchemaKind {
  const kind: ToolInputSchemaKind = { object: false, string: false };

  if (!schema || typeof schema !== 'object') {
    return kind;
  }

  const jsonSchemaType = (schema as { type?: unknown }).type;
  if (jsonSchemaType === 'object') {
    kind.object = true;
  } else if (jsonSchemaType === 'string') {
    kind.string = true;
  } else if (Array.isArray(jsonSchemaType)) {
    kind.object = jsonSchemaType.includes('object');
    kind.string = jsonSchemaType.includes('string');
  }

  for (const compositeKey of ['anyOf', 'oneOf', 'allOf'] as const) {
    const options = (schema as Record<typeof compositeKey, unknown>)[compositeKey];
    if (Array.isArray(options)) {
      for (const option of options) {
        mergeSchemaKind(kind, detectToolInputSchemaKind(option));
      }
    }
  }

  const zodDef = (schema as { _def?: unknown })._def;
  if (!zodDef || typeof zodDef !== 'object') {
    return kind;
  }

  const zodType = (zodDef as { type?: unknown; typeName?: unknown }).type;
  const zodTypeName = (zodDef as { type?: unknown; typeName?: unknown }).typeName;

  if (zodType === 'object' || zodTypeName === 'ZodObject') {
    kind.object = true;
  } else if (zodType === 'string' || zodTypeName === 'ZodString') {
    kind.string = true;
  }

  const innerSchema =
    (zodDef as { innerType?: unknown; schema?: unknown }).innerType ??
    (zodDef as { schema?: unknown }).schema;
  if (innerSchema) {
    mergeSchemaKind(kind, detectToolInputSchemaKind(innerSchema));
  }

  const zodOptions = (zodDef as { options?: unknown }).options;
  if (Array.isArray(zodOptions)) {
    for (const option of zodOptions) {
      mergeSchemaKind(kind, detectToolInputSchemaKind(option));
    }
  }

  return kind;
}

function getToolInputSchemaKind(tool: StructuredToolInterface): ToolInputSchemaKind {
  const constructorName = (tool as { constructor?: { name?: string } }).constructor?.name;
  if (constructorName === 'DynamicTool') {
    return { object: false, string: true };
  }

  return detectToolInputSchemaKind((tool as { schema?: unknown }).schema);
}

function normalizeToolInvokeArgs(args: unknown, tool: StructuredToolInterface): unknown {
  const schemaKind = getToolInputSchemaKind(tool);

  if (typeof args !== 'string') {
    if (!schemaKind.string || schemaKind.object) {
      return args;
    }

    const inputValue = (args as { input?: unknown })?.input;
    return typeof inputValue === 'string' ? args : JSON.stringify(args);
  }

  if (!schemaKind.object || schemaKind.string) {
    return args;
  }

  const trimmed = args.trim();
  if (!trimmed.startsWith('{')) {
    return args;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return args;
  }

  return args;
}

function getValueShape(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function addLineNumbers(content: string, startLine = 1): string {
  const lines = content.split('\n');
  const w = String(startLine + lines.length - 1).length;
  return lines
    .map((line, index) => `${String(startLine + index).padStart(w, ' ')} | ${line}`)
    .join('\n');
}

type ReadFileRangeArguments = { start_line?: number; max_lines?: number };
type ReadFileRange = { startLine: number; maxLines: number };
const READ_FILE_RANGE_ERROR =
  'start_line must be positive and max_lines must be between 1 and 500.';

function resolveReadFileRange(
  args: ReadFileRangeArguments,
  defaultMaxLines = CODE_ENVIRONMENT_READ_FILE_DEFAULT_LINES,
): ReadFileRange | null {
  const startLine = args.start_line ?? 1;
  const maxLines = args.max_lines ?? defaultMaxLines;
  return Number.isSafeInteger(startLine) &&
    startLine >= 1 &&
    Number.isSafeInteger(maxLines) &&
    maxLines >= 1 &&
    maxLines <= CODE_ENVIRONMENT_READ_FILE_HARD_MAX_LINES
    ? { startLine, maxLines }
    : null;
}

/** Full local files are sliced once; a worker page is already offset and bounded. */
function formatReadFileText(
  content: string,
  path: string,
  range?: ReadFileRange,
  page?: { startLine: number; nextStartLine?: number },
): string {
  let payload = content;
  const startLine = page?.startLine ?? range?.startLine ?? 1;
  let nextStartLine = page?.nextStartLine;
  if (range != null && page == null) {
    let start = 0;
    for (let line = 1; line < range.startLine; line++) {
      const newline = content.indexOf('\n', start);
      if (newline < 0) return '';
      start = newline + 1;
    }
    if (start >= content.length) return '';
    let end = content.length;
    let cursor = start;
    for (let count = 1; count <= range.maxLines; count++) {
      const newline = content.indexOf('\n', cursor);
      if (newline < 0) break;
      if (count === range.maxLines || newline === content.length - 1) {
        end = newline;
        if (newline < content.length - 1) nextStartLine = startLine + count;
        break;
      }
      cursor = newline + 1;
    }
    payload = content.slice(start, end);
  }

  let locallyTruncated = false;
  let localNextStartLine: number | undefined;
  if ((range != null || page != null) && Buffer.byteLength(payload, 'utf8') > MAX_READABLE_BYTES) {
    payload = truncateUtf8(payload, MAX_READABLE_BYTES);
    locallyTruncated = true;
    const lastCompleteLine = payload.lastIndexOf('\n');
    if (lastCompleteLine >= 0) {
      payload = payload.slice(0, lastCompleteLine);
      localNextStartLine = startLine + payload.split('\n').length;
    }
  }
  let numbered = addLineNumbers(payload, startLine);
  if (locallyTruncated) {
    numbered +=
      localNextStartLine != null
        ? `\n\n[truncated at ${MAX_READABLE_BYTES} bytes; more content is available; call read_file again with path "${path}" and start_line ${localNextStartLine}]`
        : `\n\n[the line was truncated at ${MAX_READABLE_BYTES} bytes and cannot be paged by line]`;
  } else if (nextStartLine != null) {
    numbered += `\n\n[more content is available; call read_file again with path "${path}" and start_line ${nextStartLine}]`;
  }
  return numbered;
}

function localTextReadResult(
  tc: ToolCallRequest,
  path: string,
  content: string,
  header = '',
): ToolExecuteResult {
  const args = tc.args as ReadFileRangeArguments;
  const range =
    args.start_line === undefined && args.max_lines === undefined
      ? undefined
      : resolveReadFileRange(args);
  if (range === null) return errorResult(tc, READ_FILE_RANGE_ERROR);
  return successResult(tc, header + formatReadFileText(content, path, range));
}

type AuthoringSkill = NonNullable<
  Awaited<ReturnType<NonNullable<ToolExecuteOptions['getSkillByName']>>>
>;

type AuthoringResult = Promise<ToolExecuteResult>;

type ParsedSkillAuthoringPath = {
  skillName: string;
  relativePath: string;
  displayPath: string;
};

type LoadedSkillText =
  | { status: 'loaded'; content: string; bytes: number; fileId?: string }
  | { status: 'missing' }
  | { status: 'error'; message: string };

type ExistingSkillFile =
  | { status: 'present'; oldContent?: string; fileId?: string }
  | { status: 'missing' }
  | { status: 'error'; message: string };

type LoadedSandboxText = LoadedSkillText;

/**
 * A code-session file ref as it crosses the host boundary: the SDK's wire
 * shape (`kind` / `resource_id` / `version` / `inherited`) plus the legacy
 * per-file `session_id` older Code API responses carry, which
 * `getPreparedCodeOutputBuffer` still reads as a storage-session fallback.
 * Every field is load-bearing on the wire — `version` is required for
 * `kind: 'skill'` refs and `resource_id` names the resource that owns the
 * file's storage session — so refs must be carried whole, never rebuilt
 * from a subset.
 */
type SandboxFileRef = FileRefs[number] & { session_id?: string };

type SandboxSessionContext = {
  session_id?: string;
  files?: SandboxFileRef[];
};

const MIME_MAP: Readonly<Record<string, string>> = Object.freeze({
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.cjs': 'application/javascript',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.jsx': 'application/javascript',
  '.py': 'text/x-python',
  '.sh': 'application/x-sh',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.css': 'text/css',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.toml': 'text/toml',
  '.ini': 'text/ini',
  '.svg': 'image/svg+xml',
});

function errorResult(tc: ToolCallRequest, errorMessage: string): ToolExecuteResult {
  return {
    toolCallId: tc.id,
    status: 'error',
    content: '',
    errorMessage,
  };
}

function modelBoundContentFilterErrorMessage(
  finding: Parameters<typeof contentFilterModelBoundBlockResponse>[0],
): string {
  return JSON.stringify(contentFilterModelBoundBlockResponse(finding));
}

function contentFilterErrorResult(
  tc: ToolCallRequest,
  finding: Parameters<typeof contentFilterModelBoundBlockResponse>[0],
): ToolExecuteResult {
  return errorResult(tc, modelBoundContentFilterErrorMessage(finding));
}

function filteredContentResult(
  tc: ToolCallRequest,
  req: ServerRequest | undefined,
  fragments: Iterable<TextContentFragment>,
): ToolExecuteResult | null {
  const filters = req?.config?.filters;
  if (filters == null) {
    return null;
  }
  const finding = inspectContent(fragments, { filters });
  return finding == null ? null : contentFilterErrorResult(tc, finding);
}

function filteredToolArgumentsResult(
  tc: ToolCallRequest,
  req: ServerRequest | undefined,
  args: unknown,
): ToolExecuteResult | null {
  const pii = req?.config?.filters?.toolArguments?.pii;
  if (!hasActivePiiFields(pii, ['name', 'arguments'])) {
    return null;
  }
  const inspectName = pii?.fields == null || pii.fields.includes('name');
  const inspectArguments = pii?.fields == null || pii.fields.includes('arguments');
  try {
    return filteredContentResult(
      tc,
      req,
      extractToolArgumentContent({
        ...(inspectName && { name: tc.name }),
        ...(inspectArguments && { arguments: args }),
      }),
    );
  } catch (error) {
    if (!isContentTraversalLimitError(error)) {
      throw error;
    }
    const filtered = filteredContentResult(tc, req, getContentTraversalFragments(error));
    if (filtered != null) {
      return filtered;
    }
    return isContentTraversalProtected({ error, filters: req?.config?.filters })
      ? errorResult(tc, error.body.message)
      : null;
  }
}

/**
 * Inner tool names the `name` PII policy would block. `filteredToolArgumentsResult`
 * inspects `tc.name` for direct calls, but inner calls bypass it entirely — and
 * the trace event carries the name unconditionally, so without this the trace
 * becomes the disclosure path the policy exists to close. The eligible map holds
 * a handful of names, each inspected once per PTC call.
 */
function collectFilteredPtcToolNames(
  names: Iterable<string>,
  req: ServerRequest | undefined,
): ReadonlySet<string> | undefined {
  const filters = req?.config?.filters;
  if (filters == null || !hasActivePiiFields(filters.toolArguments?.pii, ['name'])) {
    return undefined;
  }
  const blocked = new Set<string>();
  for (const name of names) {
    try {
      if (inspectContent(extractToolArgumentContent({ name }), { filters }) != null) {
        blocked.add(name);
      }
    } catch {
      /* An un-inspectable name is treated as blocked: fail closed. */
      blocked.add(name);
    }
  }
  return blocked.size > 0 ? blocked : undefined;
}

function filteredToolOutputResult(
  tc: ToolCallRequest,
  req: ServerRequest | undefined,
  output: unknown,
): ToolExecuteResult | null {
  const pii = req?.config?.filters?.toolArguments?.pii;
  if (!hasActivePiiFields(pii, ['output'])) {
    return null;
  }
  try {
    return filteredContentResult(tc, req, extractToolArgumentContent({ name: tc.name, output }));
  } catch (error) {
    if (!isContentTraversalLimitError(error)) {
      throw error;
    }
    const filtered = filteredContentResult(tc, req, getContentTraversalFragments(error));
    if (filtered != null) {
      return filtered;
    }
    return isContentTraversalProtected({ error, filters: req?.config?.filters })
      ? errorResult(tc, error.body.message)
      : null;
  }
}

function filteredSkillResult(
  tc: ToolCallRequest,
  req: ServerRequest | undefined,
  input: Parameters<typeof extractSkillContent>[0],
): ToolExecuteResult | null {
  const pii = req?.config?.filters?.skills?.pii;
  if (!hasActivePiiPatterns(pii)) {
    return null;
  }
  const selectedFields = new Set<string>(pii?.fields ?? []);
  const selected = (field: string): boolean => pii?.fields == null || selectedFields.has(field);
  const projected = {
    ...(selected('name') && { name: input?.name }),
    ...(selected('display_title') && { displayTitle: input?.displayTitle }),
    ...(selected('description') && { description: input?.description }),
    ...(selected('category') && { category: input?.category }),
    ...(selected('instructions') && {
      body: input?.body,
      instructions: input?.instructions,
    }),
    ...(selected('imported_text') && { importedText: input?.importedText }),
    ...(selected('frontmatter') && { frontmatter: input?.frontmatter }),
    ...((selected('file_name') || selected('file_text')) && {
      files: input?.files?.map((file) => ({
        ...(selected('file_name') && { name: file?.name, filename: file?.filename }),
        ...(selected('file_text') && { text: file?.text, content: file?.content }),
      })),
    }),
  };
  return filteredContentResult(tc, req, extractSkillContent(projected));
}

function isFilteredSkillProjection(
  tc: ToolCallRequest,
  req: ServerRequest | undefined,
  input: Parameters<typeof extractSkillContent>[0],
): boolean {
  try {
    return filteredSkillResult(tc, req, input) != null;
  } catch (error) {
    if (isContentTraversalLimitError(error)) {
      return isContentTraversalProtected({ error, filters: req?.config?.filters });
    }
    throw error;
  }
}

function filteredFileNameResult(
  tc: ToolCallRequest,
  req: ServerRequest | undefined,
  filename: string,
): ToolExecuteResult | null {
  if (!hasActiveFileFieldPolicy(req?.config?.filters, ['name'])) {
    return null;
  }
  return filteredContentResult(tc, req, extractFileContent({ filename }));
}

function uninspectableFileResult(
  tc: ToolCallRequest,
  req: ServerRequest | undefined,
): ToolExecuteResult | null {
  const field = getBlockedUninspectableFileField(req?.config?.filters, [
    'content',
    'extracted_text',
  ]);
  return field == null ? null : errorResult(tc, contentFilterUninspectableResponse(field).message);
}

function filteredBinaryFileResult(
  tc: ToolCallRequest,
  req: ServerRequest | undefined,
  filename: string,
): ToolExecuteResult | null {
  return filteredFileNameResult(tc, req, filename) ?? uninspectableFileResult(tc, req);
}

function filteredFileResult(
  tc: ToolCallRequest,
  req: ServerRequest | undefined,
  filename: string,
  content: string,
): ToolExecuteResult | null {
  const filters = req?.config?.filters;
  if (!hasActiveFileFieldPolicy(filters, ['name', 'content', 'extracted_text'])) {
    return null;
  }
  const filteredName = filteredFileNameResult(tc, req, filename);
  if (filteredName != null) {
    return filteredName;
  }
  const inspectRawContent = hasActiveFileFieldPolicy(filters, ['content']);
  const inspectExtractedText = hasActiveFileFieldPolicy(filters, ['extracted_text']);
  if (!inspectRawContent && !inspectExtractedText) {
    return null;
  }
  if (looksBinary(content)) {
    return uninspectableFileResult(tc, req);
  }
  return filteredContentResult(
    tc,
    req,
    extractFileContent({
      ...(inspectRawContent && { content }),
      ...(inspectExtractedText && { extractedText: content }),
    }),
  );
}

function successResult(
  tc: ToolCallRequest,
  content: string,
  artifact?: unknown,
): ToolExecuteResult {
  const result: ToolExecuteResult = {
    toolCallId: tc.id,
    status: 'success',
    content,
  };
  if (artifact !== undefined) {
    result.artifact = artifact;
  }
  return result;
}

function surfaceSkillAuthoringWarnings(warnings: ValidationIssue[] | undefined): {
  contentSuffix: string;
  warnings: Array<ValidationIssue & { severity: 'warning' }>;
  warningCount: number;
} | null {
  if (!warnings?.length) {
    return null;
  }
  const surfaced = warnings.slice(0, MAX_SKILL_AUTHORING_WARNINGS).map((warning) => ({
    field: truncateMiddle(warning.field, MAX_SKILL_WARNING_FIELD_CHARS),
    code: truncateMiddle(warning.code, MAX_SKILL_WARNING_CODE_CHARS),
    message: truncateMiddle(warning.message, MAX_SKILL_WARNING_MESSAGE_CHARS),
    severity: 'warning' as const,
  }));
  const omitted = warnings.length - surfaced.length;
  const lines = surfaced.map(
    (warning) => `- ${warning.field} [${warning.code}]: ${warning.message}`,
  );
  if (omitted > 0) {
    lines.push(`- ${omitted} additional warning(s) omitted.`);
  }
  return {
    contentSuffix: `\n\nWarnings:\n${lines.join('\n')}`,
    warnings: surfaced,
    warningCount: warnings.length,
  };
}

function guessMimeType(filename: string): string {
  return MIME_MAP[lowercaseExtension(filename)] ?? 'application/octet-stream';
}

function isValidSkillName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function isValidSkillFileRelativePath(value: string): boolean {
  if (!value || value.length > 500) {
    return false;
  }
  if (value.startsWith('/') || value.startsWith('\\')) {
    return false;
  }
  if (!/^[a-zA-Z0-9._\-/]+$/.test(value)) {
    return false;
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return false;
  }
  return value !== SKILL_MD && segments[0] !== SKILL_MD;
}

function parseSkillAuthoringPath(filePath: string): ParsedSkillAuthoringPath | string {
  if (!filePath.startsWith(SKILL_FILE_PREFIX)) {
    return `Only skill file paths are supported. Use "skills/{skillName}/SKILL.md" or "skills/{skillName}/{path}".`;
  }

  const rest = filePath.slice(SKILL_FILE_PREFIX.length);
  const slashIdx = rest.indexOf('/');
  const skillName = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  const relativePath = slashIdx === -1 ? SKILL_MD : rest.slice(slashIdx + 1) || SKILL_MD;

  if (!isValidSkillName(skillName)) {
    return `Invalid skill name "${skillName}". Skill names must be kebab-case.`;
  }
  if (relativePath !== SKILL_MD && !isValidSkillFileRelativePath(relativePath)) {
    return (
      `Invalid skill file path "${relativePath}". ` +
      'Paths must be relative and cannot contain empty, "." or ".." segments.'
    );
  }

  return {
    skillName,
    relativePath,
    displayPath: `${SKILL_FILE_PREFIX}${skillName}/${relativePath}`,
  };
}

function deriveSkillDescription(body: string, skillName: string): string {
  const fallback = `Use this skill for ${skillName.replace(/-/g, ' ')}.`;
  const headingCandidates: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const withoutMarkdown = trimmed
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[*>-]\s+/, '')
      .trim();
    if (!withoutMarkdown) {
      continue;
    }
    if (/^#{1,6}\s+/.test(trimmed)) {
      headingCandidates.push(withoutMarkdown);
      continue;
    }
    return truncateMiddle(withoutMarkdown.replace(/\s+/g, ' '), 180);
  }
  const heading = headingCandidates[0];
  return heading ? truncateMiddle(heading.replace(/\s+/g, ' '), 180) : fallback;
}

function splitSkillFrontmatter(content: string):
  | {
      block: string;
      body: string;
    }
  | { error: string }
  | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('---')) {
    return null;
  }
  const afterOpening = trimmed.slice(3);
  const closingIdx = afterOpening.indexOf('\n---');
  if (closingIdx === -1) {
    return { error: `Invalid ${SKILL_MD} frontmatter: missing closing "---".` };
  }
  const afterClosing = afterOpening.slice(closingIdx + '\n---'.length);
  return {
    block: afterOpening.slice(0, closingIdx),
    body: afterClosing.startsWith('\n') ? afterClosing.slice(1) : afterClosing,
  };
}

function buildSkillMdContent(frontmatter: Record<string, unknown>, body: string): string {
  const dumped = yaml.dump(frontmatter, { lineWidth: -1 }).trimEnd();
  const normalizedBody = body.trimStart();
  return `---\n${dumped}\n---\n${normalizedBody}`;
}

function skillNameMismatchError(frontmatterName: string, skillName: string): string {
  return `${SKILL_MD} frontmatter name "${frontmatterName}" must match path skill name "${skillName}". edit_file cannot rename skills; keep the name unchanged or create a new skills/{newName}/SKILL.md.`;
}

function normalizeSkillMdContent(
  content: string,
  skillName: string,
): { status: 'success'; content: string } | { status: 'error'; error: string } {
  const split = splitSkillFrontmatter(content);
  if (split && 'error' in split) {
    return { status: 'error', error: split.error };
  }

  let normalizedContent = content;
  if (!split) {
    normalizedContent = buildSkillMdContent(
      {
        name: skillName,
        description: deriveSkillDescription(content, skillName),
      },
      content,
    );
  } else {
    const structured = parseStructuredSkillFrontmatter(content);
    if (structured.error) {
      return { status: 'error', error: structured.error };
    }
    const frontmatter = { ...(structured.frontmatter ?? {}) };
    const parsed = parseFrontmatter(content);
    const frontmatterName =
      typeof frontmatter.name === 'string' ? frontmatter.name : parsed.name || undefined;
    if (frontmatterName && frontmatterName !== skillName) {
      return {
        status: 'error',
        error: skillNameMismatchError(frontmatterName, skillName),
      };
    }
    frontmatter.name = skillName;
    const frontmatterDescription =
      typeof frontmatter.description === 'string'
        ? frontmatter.description
        : parsed.description || undefined;
    frontmatter.description =
      frontmatterDescription || deriveSkillDescription(split.body, skillName);
    normalizedContent = buildSkillMdContent(frontmatter, split.body);
  }

  const parsed = parseFrontmatter(normalizedContent);
  if (!parsed.name || !parsed.description) {
    return {
      status: 'error',
      error: `${SKILL_MD} must include YAML frontmatter with "name" and "description".`,
    };
  }
  if (parsed.name !== skillName) {
    return {
      status: 'error',
      error: skillNameMismatchError(parsed.name, skillName),
    };
  }
  if (parsed.invalidBooleans.length > 0) {
    return {
      status: 'error',
      error: parsed.invalidBooleans
        .map((key) => `"${key}" in ${SKILL_MD} frontmatter must be a boolean`)
        .join('; '),
    };
  }
  return { status: 'success', content: normalizedContent };
}

function extractSkillFrontmatterBlock(content: string): string | null {
  const split = splitSkillFrontmatter(content);
  if (!split || 'error' in split) {
    return null;
  }
  return split.block;
}

function parseStructuredSkillFrontmatter(
  content: string,
):
  | { frontmatter?: Record<string, unknown>; error?: undefined }
  | { frontmatter?: undefined; error: string } {
  const block = extractSkillFrontmatterBlock(content);
  if (block == null) {
    return {};
  }
  try {
    const parsed = yaml.load(block);
    if (parsed == null) {
      return { frontmatter: {} };
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: `${SKILL_MD} frontmatter must be a YAML mapping.` };
    }
    const normalized = normalizeSkillFrontmatterKeys(parsed as Record<string, unknown>);
    if ('error' in normalized) {
      return { error: `Invalid ${SKILL_MD} frontmatter: ${normalized.error}` };
    }
    return { frontmatter: normalized.frontmatter };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Invalid ${SKILL_MD} frontmatter: ${message}` };
  }
}

function parseSkillMdUpdate(content: string): {
  description: string;
  frontmatter?: Record<string, unknown>;
  alwaysApply?: boolean;
} {
  const parsed = parseFrontmatter(content);
  const structured = parseStructuredSkillFrontmatter(content);
  const structuredDescription =
    typeof structured.frontmatter?.description === 'string'
      ? structured.frontmatter.description
      : undefined;
  return {
    description: structuredDescription ?? parsed.description,
    ...(structured.frontmatter !== undefined ? { frontmatter: structured.frontmatter } : {}),
    ...(parsed.alwaysApply !== undefined ? { alwaysApply: parsed.alwaysApply } : {}),
  };
}

function getAuthorInfo(req: ServerRequest): {
  author: Types.ObjectId;
  authorName: string;
  tenantId?: string;
} | null {
  const user = req.user as
    | {
        id?: string;
        _id?: Types.ObjectId | string;
        name?: string;
        username?: string;
        tenantId?: string;
      }
    | undefined;
  if (!user?.id) {
    return null;
  }
  return {
    author: (user._id ?? user.id) as Types.ObjectId,
    authorName: user.name ?? user.username ?? 'Unknown',
    ...(user.tenantId ? { tenantId: user.tenantId } : {}),
  };
}

function formatRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}

function createUnifiedDiff(filePath: string, oldContent: string, newContent: string): string {
  if (oldContent === newContent) {
    return '';
  }

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (
    oldSuffix >= prefix &&
    newSuffix >= prefix &&
    oldLines[oldSuffix] === newLines[newSuffix]
  ) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }

  const contextStart = Math.max(0, prefix - 3);
  const oldContextEnd = Math.min(oldLines.length - 1, oldSuffix + 3);
  const newContextEnd = Math.min(newLines.length - 1, newSuffix + 3);
  const oldCount = oldContextEnd >= contextStart ? oldContextEnd - contextStart + 1 : 0;
  const newCount = newContextEnd >= contextStart ? newContextEnd - contextStart + 1 : 0;
  const lines = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${formatRange(contextStart + 1, oldCount)} +${formatRange(contextStart + 1, newCount)} @@`,
  ];

  for (let i = contextStart; i < prefix; i++) {
    lines.push(` ${oldLines[i]}`);
  }
  for (let i = prefix; i <= oldSuffix; i++) {
    lines.push(`-${oldLines[i]}`);
  }
  for (let i = prefix; i <= newSuffix; i++) {
    lines.push(`+${newLines[i]}`);
  }
  for (let i = oldSuffix + 1; i <= oldContextEnd; i++) {
    lines.push(` ${oldLines[i]}`);
  }

  return lines.join('\n');
}

/**
 * Extensions whose contents `read_file` must never serialize as text. `cat`
 * on a PNG inside the sandbox returns the raw bytes as stdout, JSON-encoded
 * by codeapi with lossy UTF-8 replacement and then line-numbered by us —
 * the result is a multi-KB blob of mojibake that pollutes the LLM context
 * and exposes the raw bytes anyway. Short-circuit before the network call.
 *
 * Image categories surface a "use the existing attachment" message because
 * the file was already attached to the conversation as part of the
 * code-execution artifact pipeline — re-attaching here would dup it.
 */
const BINARY_EXTENSIONS_NEVER_READABLE = new Set([
  // Raster images (already attached as artifacts by the code-execution
  // pipeline). `.svg` is intentionally NOT in this list — it's an XML
  // text format with no mojibake risk, and there are legitimate reasons
  // for the model to inspect or edit a generated SVG. The post-fetch
  // NUL-byte sniff still catches anything that turns out to be binary
  // despite a `.svg` extension.
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tiff',
  '.tif',
  '.ico',
  '.heic',
  '.heif',
  '.avif',
  // Documents (binary container formats)
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.potx',
  '.odt',
  '.ods',
  '.odp',
  // Archives
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.lz4',
  '.zst',
  // Audio / video
  '.mp3',
  '.wav',
  '.flac',
  '.ogg',
  '.m4a',
  '.aac',
  '.wma',
  '.mp4',
  '.mkv',
  '.mov',
  '.avi',
  '.webm',
  '.flv',
  '.m4v',
  // Executables / object files / native libs
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.o',
  '.obj',
  '.a',
  '.lib',
  '.bin',
  '.class',
  '.jar',
  // Other byte-soup formats
  '.parquet',
  '.bson',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.pyc',
  '.pyo',
  '.wasm',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
]);

const IMAGE_EXTENSIONS_FOR_HINT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tiff',
  '.tif',
  '.ico',
  '.heic',
  '.heif',
  '.avif',
]);

function lowercaseExtension(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (dot < 0 || dot < slash) return '';
  return filePath.slice(dot).toLowerCase();
}

/**
 * Builds the model-visible error returned when `read_file` is invoked on
 * a binary path. Phrasing is tuned for the LLM: states the fact (file is
 * binary, can't be read as text), points at the correct affordance for
 * each common case (image via bash bytes; bash for everything else), and
 * includes the path verbatim so the model can copy-paste into its next
 * call. Supported raster images take the inline-attachment path first (see
 * `handleSandboxImageRead`); this image branch is only reached when that
 * read is unavailable (codeapi off) or fails.
 */
function buildBinaryFileError(filePath: string, ext: string): string {
  if (IMAGE_EXTENSIONS_FOR_HINT.has(ext)) {
    return `"${filePath}" is an image file (${ext}) and cannot be read as text. To process it programmatically, use \`bash_tool\` (e.g. \`file ${filePath}\` for metadata, or \`python3 -c '...'\` to operate on the bytes).`;
  }
  return `"${filePath}" is a binary file (${ext}) and cannot be read as text by \`read_file\`. Use \`bash_tool\` to process it (e.g. \`file ${filePath}\` for metadata, or a runtime-appropriate command for the format).`;
}

/**
 * Sandbox file extensions `read_file` attempts to inline as visual content.
 * The extension only decides ROUTING (try the base64 image read vs the text
 * / bash path); the emitted MIME comes from the magic-byte sniff so the
 * declared type always matches the actual bytes. Scoped to the four raster
 * formats the providers accept in tool results (`IMAGE_MIMES`); other image
 * extensions (`.bmp`, `.tiff`, `.svg`, ...) stay on the text / bash path.
 */
const SANDBOX_IMAGE_EXTENSIONS = new Set<string>(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/**
 * Magic-byte sniff for the raster formats we inline. Preferred over the
 * extension so a mislabelled `.png` that is really a JPEG is declared with
 * the MIME the provider will actually validate the bytes against. Returns
 * `undefined` when the header matches none of the supported formats.
 */
function sniffImageMime(buffer: Buffer): string | undefined {
  if (buffer.length < 4) return undefined;
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return 'image/gif';
  }
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  return undefined;
}

/**
 * Cheap structural check that the image bytes are complete, not just that the
 * header sniffed valid — a truncated/interrupted write can keep a valid magic
 * prefix while the body is missing, which would then fail `saveBase64Image`
 * resizing or the next provider request instead of the intended bash-hint
 * fallback. Only png (fixed 8-byte IEND trailer) and webp (self-describing
 * RIFF size) have a false-positive-free end marker; jpeg/gif can legitimately
 * carry trailing metadata, so those stay at header-level sniffing rather than
 * risk rejecting a valid file.
 */
function isCompleteImage(buffer: Buffer, mime: string): boolean {
  if (mime === 'image/png') {
    if (buffer.length < 8) return false;
    const iend = buffer.subarray(buffer.length - 8);
    return (
      iend[0] === 0x49 &&
      iend[1] === 0x45 &&
      iend[2] === 0x4e &&
      iend[3] === 0x44 &&
      iend[4] === 0xae &&
      iend[5] === 0x42 &&
      iend[6] === 0x60 &&
      iend[7] === 0x82
    );
  }
  if (mime === 'image/webp') {
    if (buffer.length < 12) return false;
    return buffer.readUInt32LE(4) === buffer.length - 8;
  }
  return true;
}

/**
 * Builds the `read_file` success result for an image: a short text line the
 * model reads plus the `image_url` block in `artifact.content`. The SDK
 * folds `artifact.content` into what the model sees (Anthropic tool_result
 * or a trailing Human message for OpenAI/Google), and the host tool-end
 * callback saves the same data URL as a viewable attachment. Shared by the
 * skill-file and sandbox read paths so both surface images identically.
 */
function buildImageArtifactResult(
  toolCallId: string,
  displayPath: string,
  mimeType: string,
  bytes: number,
  base64: string,
): ToolExecuteResult {
  return {
    toolCallId,
    status: 'success',
    content: `Image: ${displayPath} (${bytes} bytes, ${mimeType})`,
    artifact: {
      content: [{ type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }],
    },
  };
}

/** True when bounded authored or fetched content contains a NUL byte. */
function looksBinary(content: string): boolean {
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 0) return true;
  }
  return false;
}

/**
 * Model-visible error for an image the sandbox could not hand back. The
 * read is a supported operation that FAILED, so the message must not reuse
 * the "images cannot be read as text" phrasing — that reads as a permanent
 * capability limit and stops the model from ever retrying. State the real
 * cause and the affordance that matches it: a rate-limited or truncated
 * read is worth retrying, a missing path is worth listing, and only a
 * genuine transport dead end falls back to `bash_tool`. Classification is
 * by message, matching how `isSandboxMissingFileError` already reads
 * sandbox failures; the rate-limit wording is the one `readSandboxImage`
 * throws when the Code API limiter turns a chunk away.
 */
function buildImageReadError(filePath: string, reason: string): string {
  const detail = reason.replace(/\.$/, '');
  if (isMissingSandboxPathError(reason)) {
    return `"${filePath}" was not found in the code-execution sandbox (${detail}). List the directory with \`bash_tool\` (e.g. \`ls /mnt/data\`) to find the correct path.`;
  }
  if (/rate limit/i.test(reason)) {
    return `Could not read image "${filePath}": ${detail}. Wait for the sandbox to accept requests again, then read it once more.`;
  }
  return `Could not read image "${filePath}" from the code-execution sandbox: ${detail}. Retry the read; if it keeps failing, inspect the file with \`bash_tool\` (e.g. \`file ${filePath}\`).`;
}

/**
 * Reads a sandbox image as a viewable artifact so `read_file` can hand the
 * bytes to vision-capable models instead of refusing them. Fetches the file
 * base64-encoded from the sandbox (`readSandboxImage`), verifies the decoded
 * length matches the size the sandbox reported (guards against codeapi
 * truncating a large `/exec` stdout into a corrupt image), sniffs the real
 * MIME, and returns the shared image-artifact result. Never throws: a
 * mislabeled or corrupt image degrades to the binary hint, while a failed
 * read reports what actually went wrong (see {@link buildImageReadError}).
 */
async function handleSandboxImageRead(
  tc: ToolCallRequest,
  filePath: string,
  ext: string,
  options: ToolExecuteOptions,
  req?: ServerRequest,
  codeExecutionContext?: CodeExecutionContext,
  onSuccess?: () => void,
  signal?: AbortSignal,
): Promise<ToolExecuteResult> {
  const filtered = filteredBinaryFileResult(tc, req, filePath);
  if (filtered != null) {
    return filtered;
  }

  const { readSandboxImage } = options;
  const binaryHint = (): ToolExecuteResult => ({
    toolCallId: tc.id,
    status: 'error',
    content: '',
    errorMessage: buildBinaryFileError(filePath, ext),
  });
  const readFailure = (reason: string): ToolExecuteResult => ({
    toolCallId: tc.id,
    status: 'error',
    content: '',
    errorMessage: buildImageReadError(filePath, reason),
  });
  if (!readSandboxImage) {
    return binaryHint();
  }

  const ctx = tc.codeSessionContext as SandboxSessionContext | undefined;
  let read:
    | { base64: string; bytes: number }
    | { tooLarge: true; reason?: 'size' | 'round_trips'; bytes: number; inlineCeiling?: number }
    | null;
  try {
    read = await readSandboxImage({
      file_path: filePath,
      session_id: ctx?.session_id,
      files: ctx?.files,
      maxBytes: MAX_SANDBOX_INLINE_IMAGE_BYTES,
      ...(signal ? { signal } : {}),
      ...codeExecutionRequestParams(codeExecutionContext),
      ...(req ? { req } : {}),
    });
  } catch (error) {
    const message = getThrownValueMessage(error);
    logger.warn(`[handleReadFileCall] Sandbox image read failed for "${filePath}": ${message}`);
    return readFailure(message);
  }

  if (!read) {
    return binaryHint();
  }
  if ('tooLarge' in read) {
    onSuccess?.();
    /* Name the size that would actually work: each window costs one sandbox
     * execution, so what can be inlined depends on the runner's stdout
     * budget, not only on the byte cap. Without a target the model can only
     * guess how far to downscale. */
    const ceiling =
      read.reason === 'round_trips' && read.inlineCeiling != null
        ? read.inlineCeiling
        : MAX_SANDBOX_INLINE_IMAGE_BYTES;
    const overBudget =
      read.reason === 'round_trips'
        ? `more than this sandbox can return inline (about ${ceiling} bytes)`
        : `over the ${MAX_SANDBOX_INLINE_IMAGE_BYTES}-byte inline limit`;
    return {
      toolCallId: tc.id,
      status: 'success',
      content: `Image "${filePath}" is ${read.bytes} bytes, ${overBudget}. Downscale it under ${ceiling} bytes in the sandbox with \`bash_tool\` and read the smaller copy to view it, or inspect it with \`bash_tool\` (e.g. \`file ${filePath}\` for metadata).`,
    };
  }

  const buffer = Buffer.from(read.base64, 'base64');
  if (buffer.length !== read.bytes) {
    logger.warn(
      `[handleReadFileCall] Sandbox image byte mismatch for "${filePath}" (decoded ${buffer.length} != reported ${read.bytes})`,
    );
    return readFailure(
      `the sandbox returned ${buffer.length} of ${read.bytes} bytes (truncated transfer)`,
    );
  }
  // Resolve the MIME from the actual bytes, never the extension: a file
  // routed here by its `.png`/`.jpg`/... name whose header matches none of
  // the supported formats is a mislabeled non-image (a renamed .txt/.pdf).
  // Refuse it (and any truncated/incomplete image) with the bash hint
  // instead of shipping bytes the provider would reject as a corrupt image.
  const mimeType = sniffImageMime(buffer);
  if (!mimeType || !isCompleteImage(buffer, mimeType)) {
    return binaryHint();
  }
  onSuccess?.();
  return buildImageArtifactResult(tc.id, filePath, mimeType, buffer.length, read.base64);
}

/**
 * Routes a `read_file` call to the code-execution sandbox via the
 * host-provided `readSandboxFile` callback. The sandbox session id and
 * primed file refs come from `tc.codeSessionContext` (emitted by ToolNode
 * for `read_file` tool calls in agents v3.1.72+) so the read lands in the
 * same session that holds the agent's prior-turn artifacts. Returns a
 * `ToolExecuteResult` with the file content (line-numbered) on success,
 * or an instructive error pointing the model at `bash_tool` when the
 * sandbox isn't reachable from this configuration.
 *
 * Supported raster images (`.png/.jpg/.jpeg/.gif/.webp`) take a dedicated
 * base64 read path (`handleSandboxImageRead`) so the model can actually see
 * them. Two binary guards then keep `cat`-on-a-PNG-style mojibake out of the
 * LLM context for everything else: (1) an extension precheck that short-
 * circuits known binary types BEFORE any network call, and (2) a NUL-byte
 * content sniff after the read for unknown extensions. The codeapi `/exec`
 * transport is JSON, which lossily down-converts non-UTF-8 `cat` stdout to
 * replacement characters — text bytes are unrecoverable there, so the goal
 * is to fail fast with an instructive message rather than ship garbage.
 */
async function handleSandboxFileFallback(
  tc: ToolCallRequest,
  filePath: string,
  options: ToolExecuteOptions,
  req?: ServerRequest,
  codeExecutionContext?: CodeExecutionContext,
  onSuccess?: () => void,
  signal?: AbortSignal,
): Promise<ToolExecuteResult> {
  const ext = lowercaseExtension(filePath);
  if (SANDBOX_IMAGE_EXTENSIONS.has(ext)) {
    return handleSandboxImageRead(
      tc,
      filePath,
      ext,
      options,
      req,
      codeExecutionContext,
      onSuccess,
      signal,
    );
  }
  const filteredName = filteredFileNameResult(tc, req, filePath);
  if (filteredName != null) {
    return filteredName;
  }
  if (BINARY_EXTENSIONS_NEVER_READABLE.has(ext)) {
    return {
      toolCallId: tc.id,
      status: 'error',
      content: '',
      errorMessage: buildBinaryFileError(filePath, ext),
    };
  }

  const { readSandboxFile } = options;
  if (!readSandboxFile) {
    return {
      toolCallId: tc.id,
      status: 'error',
      content: '',
      errorMessage: `Path "${filePath}" is not a skill file. Use \`bash_tool\` to read code-execution sandbox files (e.g. \`cat ${filePath}\`).`,
    };
  }

  const rangeArgs = tc.args as ReadFileRangeArguments;
  const ranged = rangeArgs.start_line !== undefined || rangeArgs.max_lines !== undefined;
  if (ranged && resolveReadFileRange(rangeArgs) == null)
    return errorResult(tc, READ_FILE_RANGE_ERROR);
  const ctx = tc.codeSessionContext as SandboxSessionContext | undefined;
  try {
    const result = await readSandboxFile({
      file_path: filePath,
      session_id: ctx?.session_id,
      files: ctx?.files,
      ...codeExecutionRequestParams(codeExecutionContext),
      ...(req ? { req } : {}),
      ...(ranged ? { maxBytes: MAX_READABLE_BYTES, ...(signal ? { signal } : {}) } : {}),
    });
    if (result != null && 'tooLarge' in result) {
      return errorResult(
        tc,
        `Sandbox file could not be retrieved completely within the ${MAX_READABLE_BYTES}-byte read budget. Use bash_tool to inspect it.`,
      );
    }
    if (ranged && result != null && result.complete !== true) {
      return errorResult(
        tc,
        'Sandbox text retrieval was incomplete. Use bash_tool to inspect the file.',
      );
    }
    if (!result || result.content == null) {
      return {
        toolCallId: tc.id,
        status: 'error',
        content: '',
        errorMessage: `Failed to read "${filePath}" from the code-execution sandbox. Try \`bash_tool\` (e.g. \`cat ${filePath}\`).`,
      };
    }
    const filtered = filteredFileResult(tc, req, filePath, result.content);
    if (filtered != null) {
      return filtered;
    }
    if (looksBinary(result.content)) {
      return {
        toolCallId: tc.id,
        status: 'error',
        content: '',
        errorMessage: `"${filePath}" appears to be a binary file and cannot be read as text. Use \`bash_tool\` to process it (e.g. \`file ${filePath}\` for metadata).`,
      };
    }
    /**
     * Cap before line-numbering. `addLineNumbers` allocates a SECOND
     * full-size string with per-line prefixes, so a multi-MB log read
     * would materialize ~2x in memory before downstream truncation
     * kicks in. Match the skill-file path's `MAX_READABLE_BYTES`
     * (256KB) ceiling: truncate the raw content first, then number,
     * and surface the truncation to the model so it can use
     * `bash_tool head` / `tail` for the rest.
     */
    if (ranged) {
      const rangedResult = localTextReadResult(tc, filePath, result.content);
      if (rangedResult.status === 'success') onSuccess?.();
      return rangedResult;
    }
    let payload = result.content;
    let truncated = false;
    if (payload.length > MAX_READABLE_BYTES) {
      payload = payload.slice(0, MAX_READABLE_BYTES);
      truncated = true;
    }
    let numbered = formatReadFileText(payload, filePath);
    if (truncated) {
      numbered += `\n\n[truncated at ${MAX_READABLE_BYTES} bytes — use \`bash_tool\` (e.g. \`head -c\` / \`tail\`) to read the rest of "${filePath}"]`;
    }
    onSuccess?.();
    return {
      toolCallId: tc.id,
      status: 'success',
      content: numbered,
    };
  } catch (error) {
    if (signal?.aborted === true && isAbortError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[handleReadFileCall] Sandbox fallback failed', getSafeErrorMetadata(error));
    return {
      toolCallId: tc.id,
      status: 'error',
      content: '',
      errorMessage: `Error reading "${filePath}" from the code-execution sandbox: ${message}. Try \`bash_tool\` (e.g. \`cat ${filePath}\`).`,
    };
  }
}

async function handleWorkspaceFileRead(
  tc: ToolCallRequest,
  filePath: string,
  options: ToolExecuteOptions,
  req: ServerRequest | undefined,
  codeExecutionContext: CodeExecutionContext,
  signal?: AbortSignal,
): Promise<ToolExecuteResult> {
  const { readWorkspaceFile } = options;
  if (!readWorkspaceFile) {
    return {
      toolCallId: tc.id,
      status: 'error',
      content: '',
      errorMessage: 'Attached workspace reading is not configured.',
    };
  }
  const workspaceId = selectedWorkspaceId(codeExecutionContext, 'read_file');
  if (!workspaceId) return unavailableWorkspaceOperation(tc, 'read_file');
  const args = tc.args as { start_line?: number; max_lines?: number };
  const range = resolveReadFileRange(
    args,
    resolveAttachedWorkspaceReadFileLines(codeExecutionContext.codeEnvironmentConfigSchema),
  );
  if (filePath.length === 0) {
    return {
      toolCallId: tc.id,
      status: 'error',
      content: '',
      errorMessage: 'A relative path after workspace/ is required.',
    };
  }
  if (range == null) return errorResult(tc, READ_FILE_RANGE_ERROR);
  const filteredName = filteredFileNameResult(tc, req, filePath);
  if (filteredName != null) {
    return filteredName;
  }

  try {
    const result = await readWorkspaceFile({
      file_path: filePath,
      workspace_id: workspaceId,
      ...(codeExecutionContext.codeWorkspace?.workspaceInstanceId
        ? { workspace_instance_id: codeExecutionContext.codeWorkspace.workspaceInstanceId }
        : {}),
      ...(codeExecutionContext.codeWorkspace?.linkedWorktrees ? { linked_worktrees: true } : {}),
      start_line: range.startLine,
      max_lines: range.maxLines,
      codeApiBaseUrl: codeExecutionContext.baseUrl,
      ...attachedWorkspaceRequestLimits(codeExecutionContext),
      executionProfile: codeExecutionContext.executionProfile,
      ...(codeExecutionContext.bridgeWorkerId
        ? { bridgeWorkerId: codeExecutionContext.bridgeWorkerId }
        : {}),
      ...(req ? { req } : {}),
      ...(signal ? { signal } : {}),
    });
    const filtered = filteredFileResult(tc, req, filePath, result.content);
    if (filtered != null) {
      return filtered;
    }
    if (looksBinary(result.content)) {
      return {
        toolCallId: tc.id,
        status: 'error',
        content: '',
        errorMessage: `"${filePath}" appears to be a binary file and cannot be read as text.`,
      };
    }
    return successResult(
      tc,
      formatReadFileText(result.content, `workspace/${filePath}`, undefined, {
        startLine: result.startLine,
        ...(result.truncated && result.nextStartLine != null
          ? { nextStartLine: result.nextStartLine }
          : {}),
      }),
    );
  } catch (error) {
    if (error instanceof WorkspaceToolHttpError) {
      throw explainWorkspacePathRejection(error, 'read', `workspace/${filePath}`);
    }
    if (signal?.aborted === true && isAbortError(error)) throw error;
    logger.warn(
      '[handleWorkspaceFileRead] Attached workspace read failed',
      getSafeErrorMetadata(error),
    );
    return {
      toolCallId: tc.id,
      status: 'error',
      content: '',
      errorMessage: `"${filePath}" could not be read from the attached workspace.`,
    };
  }
}

async function handleWorkspaceSearchCall(
  tc: ToolCallRequest,
  mergedConfigurable: Record<string, unknown> | undefined,
  options: ToolExecuteOptions,
  req: ServerRequest | undefined,
  signal?: AbortSignal,
): Promise<ToolExecuteResult> {
  const codeExecutionContext = getCodeExecutionContext(mergedConfigurable ?? {});
  if (
    mergedConfigurable?.codeEnvAvailable !== true ||
    codeExecutionContext?.environmentType !== 'attached'
  ) {
    return errorResult(tc, 'search_workspace requires an attached code environment.');
  }
  if (!options.searchWorkspace) {
    return errorResult(tc, 'Attached workspace search is not configured.');
  }
  const workspaceId = selectedWorkspaceId(codeExecutionContext, 'search_text');
  if (!workspaceId) return unavailableWorkspaceOperation(tc, 'search_text');

  const args = tc.args as { query?: unknown; path?: unknown; max_results?: unknown };
  const maxResults = args.max_results ?? 50;
  if (
    typeof args.query !== 'string' ||
    args.query.length === 0 ||
    args.query.length > 4096 ||
    (args.path != null && typeof args.path !== 'string') ||
    !Number.isSafeInteger(maxResults) ||
    Number(maxResults) < 1 ||
    Number(maxResults) > 200
  ) {
    return errorResult(tc, 'query, path, or max_results is invalid for workspace search.');
  }

  try {
    const result = await options.searchWorkspace({
      query: args.query,
      workspace_id: workspaceId,
      ...(codeExecutionContext.codeWorkspace?.workspaceInstanceId
        ? { workspace_instance_id: codeExecutionContext.codeWorkspace.workspaceInstanceId }
        : {}),
      ...(codeExecutionContext.codeWorkspace?.linkedWorktrees ? { linked_worktrees: true } : {}),
      ...(typeof args.path === 'string' && args.path.length > 0 ? { path: args.path } : {}),
      max_results: Number(maxResults),
      codeApiBaseUrl: codeExecutionContext.baseUrl,
      ...attachedWorkspaceRequestLimits(codeExecutionContext),
      executionProfile: codeExecutionContext.executionProfile,
      ...(codeExecutionContext.bridgeWorkerId
        ? { bridgeWorkerId: codeExecutionContext.bridgeWorkerId }
        : {}),
      ...(req ? { req } : {}),
      ...(signal ? { signal } : {}),
    });

    for (const match of result.matches) {
      const filtered = filteredFileResult(tc, req, match.path, match.text);
      if (filtered != null) return filtered;
    }
    const unboundedContent =
      result.matches.length === 0
        ? 'No matches found.'
        : result.matches
            .map((match) => `workspace/${match.path}:${match.line}:${match.column}: ${match.text}`)
            .join('\n');
    const truncationNotice = '\n\n[results truncated]';
    const locallyTruncated = Buffer.byteLength(unboundedContent, 'utf8') > MAX_READABLE_BYTES;
    const truncated = locallyTruncated || result.truncated;
    const content = truncated
      ? truncateUtf8(
          unboundedContent,
          MAX_READABLE_BYTES - Buffer.byteLength(truncationNotice, 'utf8'),
        )
      : unboundedContent;
    return {
      toolCallId: tc.id,
      status: 'success',
      content: truncated ? `${content}${truncationNotice}` : content,
    };
  } catch (error) {
    if (error instanceof WorkspaceToolHttpError) {
      throw explainWorkspacePathRejection(
        error,
        'search',
        `workspace/${typeof args.path === 'string' ? args.path : ''}`,
      );
    }
    if (signal?.aborted === true && isAbortError(error)) throw error;
    logger.warn(
      '[handleWorkspaceSearchCall] Attached workspace search failed',
      getSafeErrorMetadata(error),
    );
    return errorResult(tc, 'The attached workspace could not be searched.');
  }
}

async function handleWorkspaceListCall(
  tc: ToolCallRequest,
  mergedConfigurable: Record<string, unknown> | undefined,
  options: ToolExecuteOptions,
  req: ServerRequest | undefined,
  signal?: AbortSignal,
): Promise<ToolExecuteResult> {
  const codeExecutionContext = getCodeExecutionContext(mergedConfigurable ?? {});
  if (
    mergedConfigurable?.codeEnvAvailable !== true ||
    codeExecutionContext?.environmentType !== 'attached'
  ) {
    return errorResult(tc, 'list_workspace_files requires an attached code environment.');
  }
  if (!options.listWorkspaceFiles) {
    return errorResult(tc, 'Attached workspace file listing is not configured.');
  }
  const workspaceId = selectedWorkspaceId(codeExecutionContext, 'list_files');
  if (!workspaceId) return unavailableWorkspaceOperation(tc, 'list_files');

  const args = tc.args as { path?: unknown; after_path?: unknown; max_results?: unknown };
  const maxResults = args.max_results ?? 100;
  if (
    (args.path != null && typeof args.path !== 'string') ||
    (args.after_path != null && typeof args.after_path !== 'string') ||
    !Number.isSafeInteger(maxResults) ||
    Number(maxResults) < 1 ||
    Number(maxResults) > 500
  ) {
    return errorResult(
      tc,
      'path, after_path, or max_results is invalid for workspace file listing.',
    );
  }

  try {
    const result = await options.listWorkspaceFiles({
      workspace_id: workspaceId,
      ...(codeExecutionContext.codeWorkspace?.workspaceInstanceId
        ? { workspace_instance_id: codeExecutionContext.codeWorkspace.workspaceInstanceId }
        : {}),
      ...(codeExecutionContext.codeWorkspace?.linkedWorktrees ? { linked_worktrees: true } : {}),
      ...(typeof args.path === 'string' && args.path.length > 0 ? { path: args.path } : {}),
      ...(typeof args.after_path === 'string' && args.after_path.length > 0
        ? { after_path: args.after_path }
        : {}),
      max_results: Number(maxResults),
      codeApiBaseUrl: codeExecutionContext.baseUrl,
      ...attachedWorkspaceRequestLimits(codeExecutionContext),
      executionProfile: codeExecutionContext.executionProfile,
      ...(codeExecutionContext.bridgeWorkerId
        ? { bridgeWorkerId: codeExecutionContext.bridgeWorkerId }
        : {}),
      ...(req ? { req } : {}),
      ...(signal ? { signal } : {}),
    });

    for (const path of result.paths) {
      const filtered = filteredFileNameResult(tc, req, path);
      if (filtered != null) return filtered;
    }
    if (result.paths.length === 0) {
      return {
        toolCallId: tc.id,
        status: 'success',
        content: 'The attached workspace contains no discoverable files in that path.',
      };
    }
    const renderedPaths: string[] = [];
    let content = '';
    let contentBytes = 0;
    for (const [index, path] of result.paths.entries()) {
      const entry = `workspace/${path}`;
      const separator = renderedPaths.length > 0 ? '\n' : '';
      const hasMore = index < result.paths.length - 1 || result.truncated;
      const notice = hasMore
        ? `\n\n[results truncated; continue with after_path: ${JSON.stringify(path)}]`
        : '';
      const entryBytes = Buffer.byteLength(`${separator}${entry}`, 'utf8');
      if (contentBytes + entryBytes + Buffer.byteLength(notice, 'utf8') > MAX_READABLE_BYTES) {
        break;
      }
      renderedPaths.push(entry);
      content += `${separator}${entry}`;
      contentBytes += entryBytes;
    }
    const locallyTruncated = renderedPaths.length < result.paths.length;
    const continuationPath = locallyTruncated
      ? result.paths[renderedPaths.length - 1]
      : result.nextAfterPath;
    const truncated = locallyTruncated || result.truncated;
    const truncationNotice = truncated
      ? `\n\n[results truncated; continue with after_path: ${JSON.stringify(continuationPath)}]`
      : '';
    return {
      toolCallId: tc.id,
      status: 'success',
      content: `${content}${truncationNotice}`,
    };
  } catch (error) {
    if (error instanceof WorkspaceToolHttpError) {
      throw explainWorkspacePathRejection(
        error,
        'list',
        `workspace/${typeof args.path === 'string' ? args.path : ''}`,
      );
    }
    if (signal?.aborted === true && isAbortError(error)) throw error;
    logger.warn(
      '[handleWorkspaceListCall] Attached workspace file listing failed',
      getSafeErrorMetadata(error),
    );
    return errorResult(tc, 'The attached workspace files could not be listed.');
  }
}

function sandboxSessionContext(
  tc: ToolCallRequest,
  override?: SandboxSessionContext,
): SandboxSessionContext | undefined {
  return override ?? (tc.codeSessionContext as SandboxSessionContext | undefined);
}

function cloneSandboxSessionContext(
  context: SandboxSessionContext | undefined,
): SandboxSessionContext {
  return {
    ...(context?.session_id ? { session_id: context.session_id } : {}),
    ...(context?.files ? { files: context.files.map((file) => ({ ...file })) } : {}),
  };
}

/** Storage identity of a mounted ref, matching the code session's own key. */
function sandboxFileIdentity(file: SandboxFileRef): string {
  return `${file.storage_session_id ?? ''}\0${file.id}`;
}

/**
 * Folds a host file-authoring result's `session_id` / `files` into the
 * batch-local sandbox context that the next authoring call on the same path
 * reuses, matching how the graph's own code session folds the same artifact:
 * incoming refs win field by field, an existing ref superseded by storage
 * identity or by name is dropped, and every other mounted ref survives.
 *
 * Both halves are load-bearing. Rebuilding refs from a field subset dropped
 * `kind`, `resource_id`, `version` and `inherited`, and a primed skill file
 * stripped of its `version` is an invalid input ref — the Code API requires
 * it whenever `kind === 'skill'`. Replacing the list wholesale unmounted
 * every file the run had primed but this particular write did not return.
 */
function mergeSandboxSessionArtifact(
  context: SandboxSessionContext,
  artifact: ToolExecuteResult['artifact'],
): void {
  if (!artifact || typeof artifact !== 'object') {
    return;
  }
  const value = artifact as {
    session_id?: unknown;
    files?: unknown;
  };
  if (typeof value.session_id === 'string' && value.session_id.length > 0) {
    context.session_id = value.session_id;
  }
  if (!Array.isArray(value.files)) {
    return;
  }

  const execSessionId = context.session_id;
  const incoming: SandboxFileRef[] = [];
  const incomingByIdentity = new Map<string, number>();
  const incomingNames = new Set<string>();
  for (const file of value.files) {
    if (!file || typeof file !== 'object') {
      continue;
    }
    const ref = file as SandboxFileRef;
    if (typeof ref.id !== 'string' || typeof ref.name !== 'string') {
      continue;
    }
    /* Carry the ref whole: the Code API reads fields this host never
     * inspects, so a copy is a downgrade. Only the storage session is
     * defaulted, and it resolves exactly as `getPreparedCodeOutputBuffer`
     * resolves it — the legacy per-file `session_id` outranks the execution
     * session, or an older Code API response would be remounted against the
     * bucket that merely produced it. */
    const merged: SandboxFileRef = { ...ref };
    merged.storage_session_id ??= ref.session_id ?? execSessionId;

    /* One artifact can name the same stored file twice. Fold the repeat into
     * the entry already collected rather than mounting it again: codeapi
     * rejects an `/exec` whose files collide on a destination, taking the
     * whole call down with it. */
    const identity = sandboxFileIdentity(merged);
    const seen = incomingByIdentity.get(identity);
    if (seen !== undefined) {
      incoming[seen] = { ...incoming[seen], ...merged };
      continue;
    }
    incomingByIdentity.set(identity, incoming.length);
    incomingNames.add(merged.name);
    incoming.push(merged);
  }
  if (incoming.length === 0) {
    return;
  }

  const retained: SandboxFileRef[] = [];
  for (const existing of context.files ?? []) {
    const index = incomingByIdentity.get(sandboxFileIdentity(existing));
    if (index !== undefined) {
      incoming[index] = { ...existing, ...incoming[index] };
      continue;
    }
    if (!incomingNames.has(existing.name)) {
      retained.push(existing);
    }
  }
  context.files = [...retained, ...incoming];
}

/**
 * Broader than {@link isMissingSandboxPathError}: the authoring flow also
 * treats a bare "not found" as an absent file, because a `cat` that cannot
 * start is indistinguishable from a `cat` that found nothing as far as
 * "should this create or overwrite?" is concerned.
 */
function isSandboxMissingFileError(error: unknown): boolean {
  const message = getThrownValueMessage(error);
  return isMissingSandboxPathError(message) || message.toLowerCase().includes('not found');
}

function invalidSandboxAuthoringPath(filePath: string): string | null {
  if (filePath.length === 0) {
    return 'path is required';
  }
  if (filePath.includes('\0')) {
    return 'path cannot contain NUL bytes';
  }
  if (filePath.endsWith('/')) {
    return `File path "${filePath}" points to a directory. Provide a file path.`;
  }
  return null;
}

async function loadSandboxTextForAuthoring({
  filePath,
  tc,
  options,
  req,
  sandboxContext,
  codeExecutionContext,
}: {
  filePath: string;
  tc: ToolCallRequest;
  options: ToolExecuteOptions;
  req?: ServerRequest;
  sandboxContext?: SandboxSessionContext;
  codeExecutionContext?: CodeExecutionContext;
}): Promise<LoadedSandboxText> {
  const ext = lowercaseExtension(filePath);
  if (BINARY_EXTENSIONS_NEVER_READABLE.has(ext)) {
    return { status: 'error', message: buildBinaryFileError(filePath, ext) };
  }
  if (!options.readSandboxFile) {
    return {
      status: 'error',
      message: `Sandbox file reading is not configured. Use \`bash_tool\` to inspect "${filePath}".`,
    };
  }

  const ctx = sandboxSessionContext(tc, sandboxContext);
  try {
    const result = await options.readSandboxFile({
      file_path: filePath,
      session_id: ctx?.session_id,
      files: ctx?.files,
      ...codeExecutionRequestParams(codeExecutionContext),
      ...(req ? { req } : {}),
    });
    if (result != null && 'tooLarge' in result) {
      return {
        status: 'error',
        message: 'Sandbox file could not be retrieved completely. Use bash_tool to inspect it.',
      };
    }
    if (!result || result.content == null) {
      return {
        status: 'error',
        message: `Failed to read "${filePath}" from the code-execution sandbox.`,
      };
    }
    if (looksBinary(result.content)) {
      return {
        status: 'error',
        message: `"${filePath}" appears to be binary and cannot be edited as text.`,
      };
    }
    if (Buffer.byteLength(result.content, 'utf8') > MAX_AUTHORING_BYTES) {
      return {
        status: 'error',
        message: `File "${filePath}" is too large to edit directly (${Buffer.byteLength(
          result.content,
          'utf8',
        )} bytes, limit: ${MAX_AUTHORING_BYTES}).`,
      };
    }
    return {
      status: 'loaded',
      content: result.content,
      bytes: Buffer.byteLength(result.content, 'utf8'),
    };
  } catch (error) {
    if (isSandboxMissingFileError(error)) {
      return { status: 'missing' };
    }
    const message = getThrownValueMessage(error);
    logger.warn('[file_authoring] Sandbox read failed', getSafeErrorMetadata(error));
    return {
      status: 'error',
      message: `Error reading "${filePath}" from the code-execution sandbox: ${message}.`,
    };
  }
}

async function writeSandboxTextForAuthoring({
  tc,
  options,
  req,
  filePath,
  content,
  oldContent,
  created,
  sandboxContext,
  codeExecutionContext,
  signal,
}: {
  tc: ToolCallRequest;
  options: ToolExecuteOptions;
  req?: ServerRequest;
  filePath: string;
  content: string;
  oldContent?: string;
  created: boolean;
  sandboxContext?: SandboxSessionContext;
  codeExecutionContext?: CodeExecutionContext;
  signal?: AbortSignal;
}): AuthoringResult {
  if (!options.writeSandboxFile) {
    return errorResult(
      tc,
      `Sandbox file writing is not configured. Use \`bash_tool\` to write "${filePath}".`,
    );
  }
  const filtered = filteredFileResult(tc, req, filePath, content);
  if (filtered != null) {
    return filtered;
  }
  let diff =
    oldContent !== undefined ? createUnifiedDiff(filePath, oldContent, content) : undefined;
  if (
    diff &&
    (filteredFileResult(tc, req, filePath, oldContent ?? '') != null ||
      filteredFileResult(tc, req, filePath, diff) != null)
  ) {
    diff = undefined;
  }
  const ctx = sandboxSessionContext(tc, sandboxContext);
  let writeResult: Awaited<ReturnType<NonNullable<ToolExecuteOptions['writeSandboxFile']>>>;
  signal?.throwIfAborted();
  try {
    writeResult = await options.writeSandboxFile({
      file_path: filePath,
      content,
      session_id: ctx?.session_id,
      files: ctx?.files,
      ...codeExecutionRequestParams(codeExecutionContext),
      ...(req ? { req } : {}),
    });
  } catch (error) {
    if (signal?.aborted === true && isAbortError(error)) throw error;
    const message = getThrownValueMessage(error);
    logger.warn('[file_authoring] Sandbox write failed', getSafeErrorMetadata(error));
    return errorResult(
      tc,
      `Error writing "${filePath}" to the code-execution sandbox: ${message}.`,
    );
  }
  if (!writeResult) {
    return errorResult(tc, `Failed to write "${filePath}" to the code-execution sandbox.`);
  }
  if (writeResult.artifact_delivery) {
    const { attempted, failed } = writeResult.artifact_delivery;
    return errorResult(
      tc,
      `Wrote "${filePath}" in the sandbox, but ${failed} of ${attempted} generated files could not be persisted. The file is not guaranteed to be available to later calls or downloadable. The execution may have had side effects; do not retry automatically.`,
    );
  }

  const action = created ? 'Created' : 'Updated';
  const summary = `${action} ${filePath} (${content.length} chars).`;
  return successResult(tc, diff ? `${summary}\n\n${diff}` : summary, {
    path: filePath,
    [HOST_FILE_AUTHORING_ARTIFACT_KEY]: true,
    bytes_written: Buffer.byteLength(content, 'utf8'),
    created,
    ...(diff ? { diff } : {}),
    ...(writeResult.session_id ? { session_id: writeResult.session_id } : {}),
    ...(writeResult.files ? { files: writeResult.files } : {}),
  });
}

async function resolveSkillForAuthoring(
  skillName: string,
  mergedConfigurable: Record<string, unknown>,
  options: ToolExecuteOptions,
): Promise<AuthoringSkill | null> {
  const { getSkillByName } = options;
  if (!getSkillByName) {
    return null;
  }

  const skillPrimedIdsByName =
    (mergedConfigurable?.skillPrimedIdsByName as Record<string, string> | undefined) ?? {};
  const primedIdString = skillPrimedIdsByName[skillName];
  if (primedIdString) {
    return await getSkillByName(skillName, [new Types.ObjectId(primedIdString)], {});
  }

  const accessibleIds = (mergedConfigurable?.accessibleSkillIds as Types.ObjectId[]) ?? [];
  if (accessibleIds.length === 0) {
    return null;
  }

  return await getSkillByName(skillName, accessibleIds, { preferModelInvocable: true });
}

async function resolveAuthorSkillForCurrentUser({
  skillName,
  mergedConfigurable,
  sourceConfigurable,
  options,
  req,
}: {
  skillName: string;
  mergedConfigurable: Record<string, unknown>;
  sourceConfigurable?: Record<string, unknown>;
  options: ToolExecuteOptions;
  req?: ServerRequest;
}): Promise<AuthoringSkill | null> {
  if (!req || !options.getAuthorSkillByName) {
    return null;
  }
  if (!isSkillKnownToCurrentRun(skillName, mergedConfigurable)) {
    return null;
  }
  const skill = await options.getAuthorSkillByName({ req, name: skillName });
  if (!skill) {
    return null;
  }
  rememberAuthoredSkill([mergedConfigurable, sourceConfigurable], skill, { prime: false });
  return skill;
}

function isDuplicateSkillNameError(error: unknown): boolean {
  const maybeError = error as { code?: string | number; message?: string } | undefined;
  return (
    maybeError?.code === 11000 ||
    /skill with name .* already exists/i.test(maybeError?.message ?? '')
  );
}

function isSkillAuthoringAvailable(mergedConfigurable: Record<string, unknown>): boolean {
  return mergedConfigurable.skillAuthoringAvailable === true;
}

/**
 * Tells the model that the skill it just created is a legal `skill` target.
 * Creation neither loads nor activates the skill, so the run has no other
 * signal that the name became invocable. Only reachable on runs that can
 * author skills, which are exactly the runs where the `skill` tool is
 * registered (see `isSkillToolAvailable`).
 *
 * Suppressed for `disable-model-invocation: true`, which
 * `handleSkillToolCall` rejects — advertising it would send the model into a
 * guaranteed error.
 */
function authoredSkillInvocationHint(frontmatter: Record<string, unknown> | undefined): string {
  return deriveStructuredFrontmatterFields(frontmatter).disableModelInvocation === true
    ? ''
    : ' Invoke it with the skill tool when you want its instructions loaded.';
}

function getFileAuthoringToolNames(
  mergedConfigurable: Record<string, unknown>,
): Set<string> | undefined {
  const names = mergedConfigurable.fileAuthoringToolNames;
  return names instanceof Set ? (names as Set<string>) : undefined;
}

function isHostFileAuthoringToolCall(
  toolName: string,
  mergedConfigurable: Record<string, unknown>,
): boolean {
  return getFileAuthoringToolNames(mergedConfigurable)?.has(toolName) === true;
}

function isCodeSessionAwareToolCall(
  toolName: string,
  mergedConfigurable: Record<string, unknown>,
): boolean {
  return isCodeSessionToolName(toolName, getFileAuthoringToolNames(mergedConfigurable));
}

function isSkillPrimedForAuthoring(
  skillName: string,
  mergedConfigurable: Record<string, unknown>,
): boolean {
  const skillPrimedIdsByName =
    (mergedConfigurable.skillPrimedIdsByName as Record<string, string> | undefined) ?? {};
  return typeof skillPrimedIdsByName[skillName] === 'string';
}

function isSkillKnownToCurrentRun(
  skillName: string,
  mergedConfigurable: Record<string, unknown>,
): boolean {
  if (isSkillPrimedForAuthoring(skillName, mergedConfigurable)) {
    return true;
  }
  const activeSkillNames = mergedConfigurable.activeSkillNames;
  return activeSkillNames instanceof Set && activeSkillNames.has(skillName);
}

function hiddenSkillAuthoringDenied(
  tc: ToolCallRequest,
  skill: AuthoringSkill | null,
  skillName: string,
  mergedConfigurable: Record<string, unknown>,
): ToolExecuteResult | null {
  if (
    skill?.disableModelInvocation !== true ||
    isSkillPrimedForAuthoring(skillName, mergedConfigurable)
  ) {
    return null;
  }
  return errorResult(tc, `Skill "${skillName}" cannot be authored by the model`);
}

function mergeAccessibleSkillIds(
  base: Record<string, unknown> | undefined,
  loaded: Record<string, unknown> | undefined,
): Types.ObjectId[] | undefined {
  const values = [
    ...(Array.isArray(loaded?.accessibleSkillIds)
      ? (loaded.accessibleSkillIds as Types.ObjectId[])
      : []),
    ...(Array.isArray(base?.accessibleSkillIds)
      ? (base.accessibleSkillIds as Types.ObjectId[])
      : []),
  ];
  if (values.length === 0) {
    return undefined;
  }
  const seen = new Set<string>();
  const merged: Types.ObjectId[] = [];
  for (const value of values) {
    const key = value.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(value);
  }
  return merged;
}

function mergeSkillPrimedIdsByName(
  base: Record<string, unknown> | undefined,
  loaded: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  const loadedPrimed = loaded?.skillPrimedIdsByName as Record<string, string> | undefined;
  const basePrimed = base?.skillPrimedIdsByName as Record<string, string> | undefined;
  const merged = { ...(loadedPrimed ?? {}), ...(basePrimed ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeAuthoredSkillIdsByName(
  base: Record<string, unknown> | undefined,
  loaded: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  const loadedAuthored = loaded?.authoredSkillIdsByName as Record<string, string> | undefined;
  const baseAuthored = base?.authoredSkillIdsByName as Record<string, string> | undefined;
  const merged = { ...(loadedAuthored ?? {}), ...(baseAuthored ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * The `_id` this run's authoring path bound to a skill name, when it bound one.
 *
 * Deliberately separate from `skillPrimedIdsByName`: that map also carries
 * manual (`$`) and always-apply primes and doubles as the switch that relaxes
 * the `disable-model-invocation` gate for primed bodies, so widening its
 * meaning would change how those primes resolve. This map carries identity
 * only, for the names this run authored.
 */
function getAuthoredSkillId(
  skillName: string,
  mergedConfigurable: Record<string, unknown> | undefined,
): string | undefined {
  const authoredIds = mergedConfigurable?.authoredSkillIdsByName as
    | Record<string, string>
    | undefined;
  const id = authoredIds?.[skillName];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function mergeActiveSkillNames(
  base: Record<string, unknown> | undefined,
  loaded: Record<string, unknown> | undefined,
): Set<string> | undefined {
  const names = new Set<string>();
  const loadedNames = loaded?.activeSkillNames;
  if (loadedNames instanceof Set) {
    for (const name of loadedNames) {
      names.add(name);
    }
  }
  const baseNames = base?.activeSkillNames;
  if (baseNames instanceof Set) {
    for (const name of baseNames) {
      names.add(name);
    }
  }
  return names.size > 0 ? names : undefined;
}

/**
 * True for MCP tools on an ephemeral request-scoped connection (runtime body
 * placeholders), tagged in `createToolInstance`. Their connection is torn down
 * at request end, so they must run in the foreground rather than be backgrounded.
 */
function toolRequiresEphemeralConnection(tool: StructuredToolInterface | undefined): boolean {
  return (
    (tool as (StructuredToolInterface & { mcpRequiresEphemeralConnection?: boolean }) | undefined)
      ?.mcpRequiresEphemeralConnection === true
  );
}

const EMPTY_BACKGROUND_TOOL_SET: ReadonlySet<string> = new Set();

/**
 * Authenticated user id for background-task scoping. The in-repo routes merge
 * `req` into the tool-execute configurable, but external hosts of the exported
 * OpenAI-compatible service inject their own `loadTools` and may not — fall
 * back to the run configurable's user identity so tasks are never registered
 * under an empty user id (which would collapse isolation to conversationId).
 */
function resolveBackgroundUserId(configurable: Record<string, unknown> | undefined): string {
  const req = configurable?.req as ServerRequest | undefined;
  if (req?.user?.id) {
    return req.user.id;
  }
  const userId = configurable?.user_id;
  if (typeof userId === 'string' && userId !== '') {
    return userId;
  }
  const user = configurable?.user;
  if (typeof user === 'string') {
    return user;
  }
  const idFromUser = (user as { id?: string } | undefined)?.id;
  return typeof idFromUser === 'string' ? idFromUser : '';
}

/**
 * True when the tool's own schema declares `run_in_background` (zod shape or
 * raw JSON schema), i.e. the parameter belongs to the tool rather than being
 * host-injected — such a tool must receive the argument untouched.
 */
function toolDeclaresRunInBackgroundParam(tool: StructuredToolInterface): boolean {
  const schema = (
    tool as StructuredToolInterface & {
      schema?: { shape?: Record<string, unknown>; properties?: Record<string, unknown> };
    }
  ).schema;
  if (schema == null) {
    return false;
  }
  return (
    schema.shape?.[RUN_IN_BACKGROUND_ARG] != null ||
    schema.properties?.[RUN_IN_BACKGROUND_ARG] != null
  );
}

/**
 * True when the tool's own schema declares `intent` (zod shape or raw JSON
 * schema) — SDK-native intent tools do, so they receive the argument
 * untouched and handle it themselves; host-injected tools do not, so the
 * arg is stripped before invocation.
 */
function toolDeclaresIntentParam(tool: StructuredToolInterface): boolean {
  const schema = (
    tool as StructuredToolInterface & {
      schema?: { shape?: Record<string, unknown>; properties?: Record<string, unknown> };
    }
  ).schema;
  if (schema == null) {
    return false;
  }
  return schema.shape?.[INTENT_ARG] != null || schema.properties?.[INTENT_ARG] != null;
}

/**
 * Strips the host-injected `intent` label from invoke args unless the tool's
 * own schema declares it. The label rides `tool_call.args` to the client
 * untouched — only the tool body must never see an undeclared parameter
 * (strict MCP/action schemas would reject it; zod tools would strip-or-throw).
 */
function stripIntentForInvoke(args: unknown, tool: StructuredToolInterface): unknown {
  if (!hasIntentArg(args) || toolDeclaresIntentParam(tool)) {
    return args;
  }
  return stripIntentArg(args);
}

function mergeToolConfigurables(
  base: Record<string, unknown> | undefined,
  loaded: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged = { ...base, ...loaded };
  const accessibleSkillIds = mergeAccessibleSkillIds(base, loaded);
  if (accessibleSkillIds) {
    merged.accessibleSkillIds = accessibleSkillIds;
  }
  const skillPrimedIdsByName = mergeSkillPrimedIdsByName(base, loaded);
  if (skillPrimedIdsByName) {
    merged.skillPrimedIdsByName = skillPrimedIdsByName;
  }
  const authoredSkillIdsByName = mergeAuthoredSkillIdsByName(base, loaded);
  if (authoredSkillIdsByName) {
    merged.authoredSkillIdsByName = authoredSkillIdsByName;
  }
  const activeSkillNames = mergeActiveSkillNames(base, loaded);
  if (activeSkillNames) {
    merged.activeSkillNames = activeSkillNames;
  }
  return merged;
}

function rememberAuthoredSkill(
  configurables: Array<Record<string, unknown> | undefined>,
  skill: { _id: Types.ObjectId; name: string },
  options: { prime?: boolean } = {},
): void {
  const prime = options.prime !== false;
  const idString = skill._id.toString();
  for (const configurable of configurables) {
    if (!configurable) {
      continue;
    }

    const accessibleIds = Array.isArray(configurable.accessibleSkillIds)
      ? (configurable.accessibleSkillIds as Types.ObjectId[])
      : [];
    if (!Array.isArray(configurable.accessibleSkillIds)) {
      configurable.accessibleSkillIds = accessibleIds;
    }
    if (!accessibleIds.some((id) => id.toString() === idString)) {
      accessibleIds.push(skill._id);
    }

    if (prime) {
      const primedIds =
        (configurable.skillPrimedIdsByName as Record<string, string> | undefined) ?? {};
      primedIds[skill.name] = idString;
      configurable.skillPrimedIdsByName = primedIds;
    }

    /**
     * Recorded for every authoring resolution, including `prime: false`
     * recovery: both mean this run's authoring path bound this name to this
     * doc, which is the doc invocation has to load. Unlike the primed map this
     * grants no gate relaxation, so recording it during recovery cannot let a
     * `disable-model-invocation: true` skill slip past its gate.
     */
    const authoredIds =
      (configurable.authoredSkillIdsByName as Record<string, string> | undefined) ?? {};
    authoredIds[skill.name] = idString;
    configurable.authoredSkillIdsByName = authoredIds;

    const activeSkillNames = configurable.activeSkillNames as Set<string> | undefined;
    if (activeSkillNames) {
      activeSkillNames.add(skill.name);
    } else {
      configurable.activeSkillNames = new Set([skill.name]);
    }
  }
}

async function ensureCanEditSkill(
  tc: ToolCallRequest,
  options: ToolExecuteOptions,
  req: ServerRequest | undefined,
  skillId: Types.ObjectId | string,
): Promise<ToolExecuteResult | null> {
  if (!req) {
    return errorResult(tc, 'Skill file editing is not configured for this request.');
  }
  if (!options.canEditSkill) {
    return errorResult(tc, 'Skill file editing is not configured.');
  }
  const allowed = await options.canEditSkill({ req, skillId });
  return allowed ? null : errorResult(tc, 'Insufficient permissions to edit this skill.');
}

async function ensureCanCreateSkill(
  tc: ToolCallRequest,
  options: ToolExecuteOptions,
  req: ServerRequest | undefined,
): Promise<ToolExecuteResult | null> {
  if (!req) {
    return errorResult(tc, 'Skill creation is not configured for this request.');
  }
  if (!options.canCreateSkill) {
    return errorResult(tc, 'Skill creation is not configured.');
  }
  const allowed = await options.canCreateSkill({ req });
  return allowed ? null : errorResult(tc, 'Insufficient permissions to create skills.');
}

async function loadSkillFileTextForAuthoring({
  skill,
  relativePath,
  options,
  req,
}: {
  skill: AuthoringSkill;
  relativePath: string;
  options: ToolExecuteOptions;
  req?: ServerRequest;
}): Promise<LoadedSkillText> {
  if (relativePath === SKILL_MD) {
    return {
      status: 'loaded',
      content: skill.body ?? '',
      bytes: Buffer.byteLength(skill.body ?? '', 'utf8'),
    };
  }

  const { getSkillFileByPath, getStrategyFunctions, updateSkillFileContent } = options;
  if (!getSkillFileByPath) {
    return { status: 'error', message: 'Skill file reading is not configured.' };
  }

  const file = await getSkillFileByPath(skill._id, relativePath);
  if (!file) {
    return { status: 'missing' };
  }
  if (file.isBinary === true) {
    return { status: 'error', message: `File "${relativePath}" is binary and cannot be edited.` };
  }
  if (file.content != null && file.content !== '') {
    return {
      status: 'loaded',
      content: file.content,
      bytes: Buffer.byteLength(file.content, 'utf8'),
      fileId: file.file_id,
    };
  }
  if (file.bytes > MAX_CACHE_BYTES) {
    return {
      status: 'error',
      message: `File "${relativePath}" is too large to edit directly (${file.bytes} bytes, limit: ${MAX_CACHE_BYTES}).`,
    };
  }
  if (!getStrategyFunctions || !req) {
    return { status: 'error', message: 'Storage access is not configured.' };
  }

  const strategy = getStrategyFunctions(file.source);
  if (!strategy.getDownloadStream) {
    return { status: 'error', message: 'Download is not supported for this storage backend.' };
  }

  const stream = await strategy.getDownloadStream(req, resolveDownloadPath(file));
  const chunks: Uint8Array[] = [];
  let streamedBytes = 0;
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    streamedBytes += chunk.byteLength;
    if (streamedBytes > MAX_CACHE_BYTES) {
      if (
        'destroy' in stream &&
        typeof (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy === 'function'
      ) {
        (stream as NodeJS.ReadableStream & { destroy: () => void }).destroy();
      }
      return {
        status: 'error',
        message: `File "${relativePath}" exceeded edit limit (${MAX_CACHE_BYTES} bytes).`,
      };
    }
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);
  const checkLen = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) {
      if (updateSkillFileContent) {
        updateSkillFileContent(skill._id, relativePath, { isBinary: true }, file.file_id).catch(
          (err: unknown) => {
            logAxiosError({
              message: '[loadSkillFileTextForAuthoring] cache write failed',
              error: err,
            });
          },
        );
      }
      return { status: 'error', message: `File "${relativePath}" is binary and cannot be edited.` };
    }
  }

  const text = buffer.toString('utf-8');
  if (updateSkillFileContent) {
    updateSkillFileContent(
      skill._id,
      relativePath,
      { content: text, isBinary: false },
      file.file_id,
    ).catch((err: unknown) => {
      logAxiosError({
        message: '[loadSkillFileTextForAuthoring] cache write failed',
        error: err,
      });
    });
  }
  return { status: 'loaded', content: text, bytes: buffer.length, fileId: file.file_id };
}

async function inspectBundledSkillFileForCreate({
  skill,
  relativePath,
  options,
  req,
}: {
  skill: AuthoringSkill;
  relativePath: string;
  options: ToolExecuteOptions;
  req?: ServerRequest;
}): Promise<ExistingSkillFile> {
  const { getSkillFileByPath } = options;
  if (!getSkillFileByPath) {
    return { status: 'error', message: 'Skill file reading is not configured.' };
  }

  const file = await getSkillFileByPath(skill._id, relativePath);
  if (!file) {
    return { status: 'missing' };
  }
  if (file.isBinary === true || file.bytes > MAX_CACHE_BYTES) {
    return { status: 'present', fileId: file.file_id };
  }
  if (file.content != null && file.content !== '') {
    return { status: 'present', oldContent: file.content, fileId: file.file_id };
  }
  if (!options.getStrategyFunctions || !req) {
    return { status: 'present', fileId: file.file_id };
  }

  const loaded = await loadSkillFileTextForAuthoring({
    skill,
    relativePath,
    options,
    req,
  });
  if (loaded.status === 'missing') {
    return { status: 'missing' };
  }
  if (loaded.status === 'error') {
    return { status: 'present', fileId: file.file_id };
  }
  return { status: 'present', oldContent: loaded.content, fileId: loaded.fileId };
}

async function ensureBundledSkillVersionCurrent({
  tc,
  options,
  skill,
  displayPath,
}: {
  tc: ToolCallRequest;
  options: ToolExecuteOptions;
  skill: AuthoringSkill;
  displayPath: string;
}): Promise<ToolExecuteResult | null> {
  if (!options.getSkillByName) {
    return null;
  }

  const current = await options.getSkillByName(skill.name, [skill._id], {});
  if (!current) {
    return errorResult(tc, `Skill "${skill.name}" not found or not accessible.`);
  }
  if (current.version !== skill.version) {
    return errorResult(
      tc,
      `Skill "${skill.name}" changed while editing. Re-read ${displayPath} and retry.`,
    );
  }
  return null;
}

async function writeSkillMd({
  tc,
  options,
  req,
  mergedConfigurable,
  sourceConfigurable,
  skill,
  skillName,
  content,
  signal,
}: {
  tc: ToolCallRequest;
  options: ToolExecuteOptions;
  req?: ServerRequest;
  mergedConfigurable: Record<string, unknown>;
  sourceConfigurable?: Record<string, unknown>;
  skill: AuthoringSkill | null;
  skillName: string;
  content: string;
  signal?: AbortSignal;
}): AuthoringResult {
  const normalized = normalizeSkillMdContent(content, skillName);
  if (normalized.status === 'error') {
    return errorResult(tc, normalized.error);
  }
  content = normalized.content;
  const structured = parseStructuredSkillFrontmatter(content);
  if (structured.error) {
    return errorResult(tc, structured.error);
  }
  const parsedContent = parseSkillMdUpdate(content);
  const filtered = filteredSkillResult(tc, req, {
    name: skillName,
    description: parsedContent.description,
    body: content,
    frontmatter: structured.frontmatter,
  });
  if (filtered != null) {
    return filtered;
  }

  if (!skill) {
    const createDenied = await ensureCanCreateSkill(tc, options, req);
    if (createDenied) {
      return createDenied;
    }
    if (!req || !options.createSkill || !options.grantSkillOwner) {
      return errorResult(tc, 'Skill creation is not configured.');
    }
    const author = getAuthorInfo(req);
    if (!author) {
      return errorResult(tc, 'Authentication required to create a skill.');
    }
    let result: Awaited<ReturnType<NonNullable<ToolExecuteOptions['createSkill']>>>;
    try {
      result = await options.createSkill({
        name: skillName,
        description: parsedContent.description,
        body: content,
        ...(parsedContent.frontmatter !== undefined
          ? { frontmatter: parsedContent.frontmatter }
          : {}),
        author: author.author,
        authorName: author.authorName,
        ...(parsedContent.alwaysApply !== undefined
          ? { alwaysApply: parsedContent.alwaysApply }
          : {}),
        ...(author.tenantId ? { tenantId: author.tenantId } : {}),
      });
    } catch (error) {
      if (isDuplicateSkillNameError(error)) {
        return errorResult(
          tc,
          `Skill "${skillName}" already exists for this author. It cannot be created again or overwritten blindly. Read or enable the existing skill, then use edit_file for targeted changes, or choose a new skill name.`,
        );
      }
      throw error;
    }
    try {
      await options.grantSkillOwner({ req, skillId: result.skill._id });
    } catch (error) {
      if (options.deleteSkill) {
        await deleteSkillWithRetry(options.deleteSkill, result.skill._id.toString())
          .then((deletion) => {
            if (!deletion.cleanupComplete) {
              logger.error('[create_file] Skill rollback left dependent cleanup incomplete', {
                skillId: result.skill._id.toString(),
                failedCleanupSteps: deletion.failedCleanupSteps,
              });
            }
          })
          .catch((rollbackError: unknown) => {
            logger.error('[create_file] Failed to roll back skill after permission error', {
              rollbackError,
            });
          });
      }
      throw error;
    }
    rememberAuthoredSkill([mergedConfigurable, sourceConfigurable], result.skill);
    const surfacedWarnings = surfaceSkillAuthoringWarnings(result.warnings);
    const invocationHint = authoredSkillInvocationHint(structured.frontmatter);
    return successResult(
      tc,
      `Created ${SKILL_FILE_PREFIX}${skillName}/${SKILL_MD} (${content.length} chars).${surfacedWarnings?.contentSuffix ?? ''}${invocationHint}`,
      {
        path: `${SKILL_FILE_PREFIX}${skillName}/${SKILL_MD}`,
        bytes_written: Buffer.byteLength(content, 'utf8'),
        created: true,
        ...(surfacedWarnings
          ? {
              warnings: surfacedWarnings.warnings,
              warning_count: surfacedWarnings.warningCount,
            }
          : {}),
      },
    );
  }

  const editDenied = await ensureCanEditSkill(tc, options, req, skill._id);
  if (editDenied) {
    return editDenied;
  }
  if (!options.updateSkill) {
    return errorResult(tc, 'Skill updating is not configured.');
  }
  let diff = createUnifiedDiff(`${SKILL_FILE_PREFIX}${skillName}/${SKILL_MD}`, skill.body, content);
  if (
    diff &&
    (isFilteredSkillProjection(tc, req, {
      name: skill.name,
      description: skill.description,
      body: skill.body,
      frontmatter: skill.frontmatter,
    }) ||
      isFilteredSkillProjection(tc, req, { body: diff }))
  ) {
    diff = '';
  }
  signal?.throwIfAborted();
  const result = await options.updateSkill({
    id: skill._id.toString(),
    expectedVersion: skill.version,
    update: {
      body: content,
      description: parsedContent.description,
      ...(parsedContent.frontmatter !== undefined
        ? { frontmatter: parsedContent.frontmatter }
        : {}),
      ...(parsedContent.alwaysApply !== undefined
        ? { alwaysApply: parsedContent.alwaysApply }
        : {}),
    },
  });
  if (result.status === 'conflict') {
    return errorResult(
      tc,
      `Skill "${skillName}" changed while editing. Re-read ${SKILL_FILE_PREFIX}${skillName}/${SKILL_MD} and retry.`,
    );
  }
  if (result.status === 'not_found') {
    return errorResult(tc, `Skill "${skillName}" not found or not accessible.`);
  }

  const summary = `Updated ${SKILL_FILE_PREFIX}${skillName}/${SKILL_MD} (${content.length} chars).`;
  const surfacedWarnings = surfaceSkillAuthoringWarnings(result.warnings);
  const summaryWithWarnings = `${summary}${surfacedWarnings?.contentSuffix ?? ''}`;
  return successResult(tc, diff ? `${summaryWithWarnings}\n\n${diff}` : summaryWithWarnings, {
    path: `${SKILL_FILE_PREFIX}${skillName}/${SKILL_MD}`,
    bytes_written: Buffer.byteLength(content, 'utf8'),
    created: false,
    ...(diff ? { diff } : {}),
    ...(surfacedWarnings
      ? {
          warnings: surfacedWarnings.warnings,
          warning_count: surfacedWarnings.warningCount,
        }
      : {}),
  });
}

async function writeBundledSkillFile({
  tc,
  options,
  req,
  skill,
  relativePath,
  displayPath,
  content,
  oldContent,
  fileId,
  created,
  signal,
}: {
  tc: ToolCallRequest;
  options: ToolExecuteOptions;
  req?: ServerRequest;
  skill: AuthoringSkill;
  relativePath: string;
  displayPath: string;
  content: string;
  oldContent?: string;
  fileId?: string;
  created: boolean;
  signal?: AbortSignal;
}): AuthoringResult {
  const editDenied = await ensureCanEditSkill(tc, options, req, skill._id);
  if (editDenied) {
    return editDenied;
  }
  if (!req || !options.saveSkillFileContent) {
    return errorResult(tc, 'Skill file writing is not configured.');
  }
  if (skill.source != null && skill.source !== 'inline') {
    return errorResult(tc, 'Externally managed skill files are read-only.');
  }
  if (!created && !fileId) {
    return errorResult(
      tc,
      `File revision unavailable for ${displayPath}. Re-read the file and retry.`,
    );
  }
  const staleDenied = await ensureBundledSkillVersionCurrent({
    tc,
    options,
    skill,
    displayPath,
  });
  if (staleDenied) {
    return staleDenied;
  }
  const skillFiltered = filteredSkillResult(tc, req, {
    files: [{ filename: displayPath, content }],
  });
  if (skillFiltered != null) {
    return skillFiltered;
  }
  const fileFiltered = filteredFileResult(tc, req, displayPath, content);
  if (fileFiltered != null) {
    return fileFiltered;
  }

  let diff =
    oldContent !== undefined ? createUnifiedDiff(displayPath, oldContent, content) : undefined;
  if (
    diff &&
    (isFilteredSkillProjection(tc, req, {
      files: [{ filename: displayPath, content: oldContent }],
    }) ||
      filteredFileResult(tc, req, displayPath, oldContent ?? '') != null ||
      isFilteredSkillProjection(tc, req, {
        files: [{ filename: displayPath, content: diff }],
      }) ||
      filteredFileResult(tc, req, displayPath, diff) != null)
  ) {
    diff = undefined;
  }

  try {
    signal?.throwIfAborted();
    await options.saveSkillFileContent({
      req,
      skillId: skill._id,
      relativePath,
      content,
      mimeType: guessMimeType(relativePath),
      expectedFileId: fileId,
      createOnly: created,
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'SKILL_FILE_CONFLICT') {
      return errorResult(
        tc,
        created
          ? `File already exists: ${displayPath}. Re-read it and pass overwrite: true to replace.`
          : `Skill file changed while editing. Re-read ${displayPath} and retry.`,
      );
    }
    throw error;
  }
  const action = created ? 'Created' : 'Updated';
  const summary = `${action} ${displayPath} (${content.length} chars).`;
  return successResult(tc, diff ? `${summary}\n\n${diff}` : summary, {
    path: displayPath,
    bytes_written: Buffer.byteLength(content, 'utf8'),
    created,
    ...(diff ? { diff } : {}),
  });
}

function attachedWorkspaceAuthoringPath(
  tc: ToolCallRequest,
  filePath: string,
): { filePath: string } | ToolExecuteResult {
  if (!filePath.startsWith('workspace/')) {
    return errorResult(tc, 'Attached environment file paths must use "workspace/{relativePath}".');
  }
  const relativePath = filePath.slice('workspace/'.length);
  const pathError = invalidSandboxAuthoringPath(relativePath);
  return pathError ? errorResult(tc, pathError) : { filePath: relativePath };
}

function attachedWorkspaceRequestLimits(codeExecutionContext: CodeExecutionContext): {
  maxQueueWaitMs: number;
  maxRequestTimeoutMs?: number;
} & WorkspaceAdmissionOptions {
  const config = codeExecutionContext.codeEnvironmentConfigSchema;
  const maxRequestTimeoutMs = resolveAttachedWorkspaceRequestTimeoutMs(config);
  return {
    ...resolveAttachedWorkspaceAdmissionOptions(config),
    maxQueueWaitMs: resolveAttachedWorkspaceQueueWaitMs(config),
    ...(maxRequestTimeoutMs == null ? {} : { maxRequestTimeoutMs }),
  };
}

function attachedWorkspaceMutationParams(
  codeExecutionContext: CodeExecutionContext,
  workspaceId: string,
  req: ServerRequest | undefined,
  signal: AbortSignal | undefined,
): {
  workspace_id: string;
  workspace_instance_id?: string;
  linked_worktrees?: boolean;
  codeApiBaseUrl: string;
  executionProfile: CodeExecutionContext['executionProfile'];
  bridgeWorkerId?: string;
  req?: ServerRequest;
  signal?: AbortSignal;
  maxQueueWaitMs: number;
  maxRequestTimeoutMs?: number;
  deadlineAtMs?: number;
} & WorkspaceAdmissionOptions {
  const limits = attachedWorkspaceRequestLimits(codeExecutionContext);
  const runTimeoutMs = limits.maxRunTimeoutMs ?? limits.maxRequestTimeoutMs;
  return {
    workspace_id: workspaceId,
    ...(codeExecutionContext.codeWorkspace?.workspaceInstanceId
      ? { workspace_instance_id: codeExecutionContext.codeWorkspace.workspaceInstanceId }
      : {}),
    ...(codeExecutionContext.codeWorkspace?.linkedWorktrees ? { linked_worktrees: true } : {}),
    codeApiBaseUrl: codeExecutionContext.baseUrl,
    ...limits,
    ...(runTimeoutMs == null ? {} : { deadlineAtMs: Date.now() + runTimeoutMs }),
    executionProfile: codeExecutionContext.executionProfile,
    ...(codeExecutionContext.bridgeWorkerId
      ? { bridgeWorkerId: codeExecutionContext.bridgeWorkerId }
      : {}),
    ...(req ? { req } : {}),
    ...(signal ? { signal } : {}),
  };
}

async function handleAttachedWorkspaceCreateFileCall({
  tc,
  options,
  req,
  filePath,
  content,
  overwrite,
  codeExecutionContext,
  signal,
}: {
  tc: ToolCallRequest;
  options: ToolExecuteOptions;
  req?: ServerRequest;
  filePath: string;
  content: string;
  overwrite: boolean;
  codeExecutionContext: CodeExecutionContext;
  signal?: AbortSignal;
}): AuthoringResult {
  if (!options.writeWorkspaceFile) {
    return errorResult(tc, 'Attached workspace file writing is not configured.');
  }
  const path = attachedWorkspaceAuthoringPath(tc, filePath);
  if ('status' in path) return path;
  if (new TextEncoder().encode(content).byteLength > WORKSPACE_WRITE_MAX_BYTES) {
    return errorResult(tc, 'Attached workspace files are limited to 1 MiB per write.');
  }
  const filtered = filteredFileResult(tc, req, path.filePath, content);
  if (filtered != null) return filtered;
  const workspaceId = selectedWorkspaceId(codeExecutionContext, 'write_file');
  if (!workspaceId) return unavailableWorkspaceOperation(tc, 'write_file');

  try {
    const result = await options.writeWorkspaceFile({
      file_path: path.filePath,
      content,
      overwrite,
      ...attachedWorkspaceMutationParams(codeExecutionContext, workspaceId, req, signal),
    });
    const action = result.created ? 'Created' : 'Updated';
    return successResult(tc, `${action} workspace/${path.filePath} (${content.length} chars).`, {
      path: `workspace/${path.filePath}`,
      [HOST_FILE_AUTHORING_ARTIFACT_KEY]: true,
      bytes_written: result.bytesWritten,
      created: result.created,
    });
  } catch (error) {
    if (error instanceof WorkspaceToolHttpError) {
      if (error.upstreamStatus === 409 && !overwrite) {
        error.message += '. File already exists. Pass overwrite: true to replace.';
      }
      throw explainWorkspacePathRejection(error, 'write', `workspace/${path.filePath}`);
    }
    if (signal?.aborted === true && isAbortError(error)) throw error;
    logger.warn('[file_authoring] Attached workspace write failed', getSafeErrorMetadata(error));
    return errorResult(tc, `Failed to write "workspace/${path.filePath}".`);
  }
}

/** One sentence per edit that did not match exactly once, so the model can verify it. */
function describeAttachedEdit(filePath: string, result: WorkspaceEditResult): string {
  const count = result.replacements;
  const notes = (result.matches ?? []).flatMap((match, index) => {
    const edit = count === 1 ? 'the edit' : `edit ${index + 1}`;
    const found = match.strategy === 'exact' ? [] : [`${edit} matched with ${match.strategy}`];
    return match.occurrences > 1
      ? [...found, `${edit} replaced ${match.occurrences} locations`]
      : found;
  });
  if (notes.length === 0) {
    return `Updated workspace/${filePath} with ${count} exact replacement${count === 1 ? '' : 's'}.`;
  }
  return `Updated workspace/${filePath} with ${count} replacement${count === 1 ? '' : 's'} (${notes.join('; ')}).`;
}

/**
 * A rejected attached edit that keeps its status and code but none of its body, so logs never
 * retain upstream text. `message` is what logs keep; `modelMessage` may add the current file text
 * a worker quoted, which the model sees just as it would see a read_file result.
 */
class AttachedEditRejectionError extends WorkspaceToolHttpError {
  constructor(
    reason: WorkspaceToolHttpError['reason'],
    message: string,
    public readonly modelMessage: string,
    code = 'EDIT_CONFLICT',
  ) {
    super(reason, 409, JSON.stringify({ code }));
    this.message = message;
  }
}

/**
 * Any other 409, such as a quarantined workspace, is not a text mismatch the model can fix by
 * re-reading. Only its validated code is kept, in host words.
 */
function attachedEditRejection(
  filePath: string,
  error: WorkspaceToolHttpError,
  code: string,
): AttachedEditRejectionError {
  const guidance =
    code === 'WORKSPACE_QUARANTINED'
      ? ' The workspace is quarantined after an earlier operation did not finish; it must be reset on its machine before edits can apply, so retrying will not help.'
      : '';
  const message = `The edit to "workspace/${filePath}" was rejected by the code environment (${code}), so nothing was written.${guidance}`;
  return new AttachedEditRejectionError(error.reason, message, message, code);
}

/**
 * A worker is outside LibreChat's trust boundary, so its conflict text is never forwarded: only the
 * facts a strict parse recovers from it (which edits failed, how, and on which lines) reach the
 * model, in LibreChat's own words. The one exception is a well-formed excerpt of the edited file's
 * current text, which is file content like any read_file result: it is quoted only when the selected
 * workspace allows read_file, and only after it passes the same file-content policy. Anything else
 * gets the generic retry guidance.
 */
function attachedEditConflict(
  tc: ToolCallRequest,
  req: ServerRequest | undefined,
  filePath: string,
  error: WorkspaceToolHttpError,
  canRead: boolean,
): AttachedEditRejectionError {
  const conflict = error.editConflict;
  const settle = (message: string, modelMessage = message) =>
    new AttachedEditRejectionError(error.reason, message, modelMessage);
  if (conflict?.startsWith('Workspace file changed')) {
    return settle(
      `"workspace/${filePath}" changed while this edit was being applied, so nothing was written. Re-read the file and retry.`,
    );
  }
  const report = conflict == null ? undefined : parseEditConflict(conflict);
  if (!report) {
    return settle(
      `The edit to "workspace/${filePath}" did not apply, so nothing was written. The requested text did not match exactly once; re-read the file and retry.`,
    );
  }
  const path = `workspace/${filePath}`;
  const message = formatEditConflict(path, report);
  const excerpts = editConflictExcerptText(report);
  if (!canRead || !excerpts || filteredFileResult(tc, req, filePath, excerpts) != null) {
    return settle(message);
  }
  return settle(message, formatEditConflict(path, report, true));
}

async function handleAttachedWorkspaceEditFileCall({
  tc,
  options,
  req,
  filePath,
  edits,
  codeExecutionContext,
  signal,
}: {
  tc: ToolCallRequest;
  options: ToolExecuteOptions;
  req?: ServerRequest;
  filePath: string;
  edits: TextEdit[];
  codeExecutionContext: CodeExecutionContext;
  signal?: AbortSignal;
}): AuthoringResult {
  if (!options.editWorkspaceFile) {
    return errorResult(tc, 'Attached workspace file editing is not configured.');
  }
  const path = attachedWorkspaceAuthoringPath(tc, filePath);
  if ('status' in path) return path;
  if (edits.length > WORKSPACE_EDIT_MAX_COUNT) {
    return errorResult(
      tc,
      `Attached workspace edits are limited to ${WORKSPACE_EDIT_MAX_COUNT} replacements per call.`,
    );
  }
  const editBytes = edits.reduce(
    (bytes, edit) =>
      bytes +
      new TextEncoder().encode(edit.old_text).byteLength +
      new TextEncoder().encode(edit.new_text).byteLength,
    0,
  );
  if (editBytes > WORKSPACE_WRITE_MAX_BYTES) {
    return errorResult(tc, 'Attached workspace edit text is limited to 1 MiB per call.');
  }
  const filteredName = filteredFileNameResult(tc, req, path.filePath);
  if (filteredName != null) return filteredName;
  const workspaceId = selectedWorkspaceId(codeExecutionContext, 'edit_file');
  if (!workspaceId) return unavailableWorkspaceOperation(tc, 'edit_file');
  const editFeatures = codeExecutionContext.codeWorkspace?.editFileFeatures ?? [];
  if (edits.some((edit) => edit.replace_all === true) && !editFeatures.includes('replace_all')) {
    return errorResult(
      tc,
      'replace_all needs a newer LibreChat Code worker on this machine. Make each old_text unique instead.',
    );
  }
  /** Tolerant by default, like every other edit_file variant; operators can require exact. */
  const matching: WorkspaceEditMatching | undefined =
    codeExecutionContext.codeEnvironmentConfigSchema?.edits?.tolerantMatching !== false &&
    editFeatures.includes('tolerant_match')
      ? 'tolerant'
      : undefined;

  try {
    const workspaceEdits: WorkspaceTextEdit[] = edits.map((edit) => ({
      oldText: edit.old_text,
      newText: edit.new_text,
      ...(edit.replace_all === true ? { replaceAll: true } : {}),
    }));
    const workspaceParams = attachedWorkspaceMutationParams(
      codeExecutionContext,
      workspaceId,
      req,
      signal,
    );
    const queueDeadlineAt = Date.now() + workspaceParams.maxQueueWaitMs;
    let expectedBaseSha256: string | undefined;
    if (hasActiveFileFieldPolicy(req?.config?.filters, ['content', 'extracted_text'])) {
      if (!options.previewWorkspaceEdit) {
        return errorResult(
          tc,
          'Attached workspace editing requires an updated BYOM worker while file-content protections are enabled.',
        );
      }
      if (!selectedWorkspaceId(codeExecutionContext, 'preview_edit')) {
        return unavailableWorkspaceOperation(tc, 'preview_edit');
      }
      let preview: WorkspacePreviewEditResult;
      try {
        preview = await options.previewWorkspaceEdit({
          file_path: path.filePath,
          edits: workspaceEdits,
          ...(matching ? { matching } : {}),
          ...workspaceParams,
        });
      } catch (error) {
        if (signal?.aborted === true && isAbortError(error)) throw error;
        if (error instanceof WorkspaceToolHttpError && error.upstreamStatus === 400) {
          error.message +=
            '. This attached environment must update its LibreChat Code worker before protected files can be edited.';
        }
        throw error;
      }
      const filteredContent = filteredFileResult(tc, req, path.filePath, preview.content);
      if (filteredContent != null) return filteredContent;
      expectedBaseSha256 = preview.baseSha256;
      /** A spent queue horizon disables capacity retries, not the required
       * hash-guarded edit attempt or its independent rate-limit recovery. */
      if (workspaceParams.maxQueueWaitMs > 0) {
        workspaceParams.maxQueueWaitMs = Math.max(0, queueDeadlineAt - Date.now());
      }
    }
    const result = await options.editWorkspaceFile({
      file_path: path.filePath,
      edits: workspaceEdits,
      ...(expectedBaseSha256 ? { expected_base_sha256: expectedBaseSha256 } : {}),
      ...(matching ? { matching } : {}),
      ...workspaceParams,
    });
    return successResult(tc, describeAttachedEdit(path.filePath, result), {
      path: `workspace/${path.filePath}`,
      [HOST_FILE_AUTHORING_ARTIFACT_KEY]: true,
      bytes_written: result.bytesWritten,
      created: false,
      edits: result.replacements,
      strategies:
        result.matches?.map((match) => match.strategy) ??
        Array.from({ length: result.replacements }, () => 'exact'),
    });
  } catch (error) {
    if (error instanceof WorkspaceToolHttpError) {
      if (error.upstreamStatus !== 409) {
        throw explainWorkspacePathRejection(error, 'edit', `workspace/${path.filePath}`);
      }
      const code = error.upstreamCode;
      throw code == null || code === 'EDIT_CONFLICT'
        ? attachedEditConflict(
            tc,
            req,
            path.filePath,
            error,
            selectedWorkspaceId(codeExecutionContext, 'read_file') != null,
          )
        : attachedEditRejection(path.filePath, error, code);
    }
    if (signal?.aborted === true && isAbortError(error)) throw error;
    logger.warn('[file_authoring] Attached workspace edit failed', getSafeErrorMetadata(error));
    return errorResult(tc, `Failed to edit "workspace/${path.filePath}".`);
  }
}

async function handleSandboxCreateFileCall({
  tc,
  options,
  req,
  filePath,
  content,
  overwrite,
  sandboxContext,
  codeExecutionContext,
  signal,
}: {
  tc: ToolCallRequest;
  options: ToolExecuteOptions;
  req?: ServerRequest;
  filePath: string;
  content: string;
  overwrite: boolean;
  sandboxContext?: SandboxSessionContext;
  codeExecutionContext?: CodeExecutionContext;
  signal?: AbortSignal;
}): AuthoringResult {
  if (codeExecutionContext?.environmentType === 'attached') {
    return await handleAttachedWorkspaceCreateFileCall({
      tc,
      options,
      req,
      filePath,
      content,
      overwrite,
      codeExecutionContext,
      signal,
    });
  }
  const pathError = invalidSandboxAuthoringPath(filePath);
  if (pathError) {
    return errorResult(tc, pathError);
  }

  const current = await loadSandboxTextForAuthoring({
    filePath,
    tc,
    options,
    req,
    sandboxContext,
    codeExecutionContext,
  });
  if (current.status === 'error') {
    return errorResult(tc, current.message);
  }
  if (current.status === 'loaded' && !overwrite) {
    return errorResult(tc, 'File already exists. Pass overwrite: true to replace.');
  }

  return await writeSandboxTextForAuthoring({
    tc,
    options,
    req,
    filePath,
    content,
    oldContent: current.status === 'loaded' ? current.content : undefined,
    created: current.status === 'missing',
    sandboxContext,
    codeExecutionContext,
  });
}

function hostEditFailure(tc: ToolCallRequest, error: unknown): ToolExecuteResult {
  if (error instanceof HostEditError) return errorResult(tc, error.message);
  logger.warn('[file_authoring] Host edit processing failed', getSafeErrorMetadata(error));
  return errorResult(tc, 'File edit processing failed. Nothing was written.');
}

async function handleSandboxEditFileCall({
  tc,
  options,
  req,
  filePath,
  edits,
  sandboxContext,
  codeExecutionContext,
  signal,
}: {
  tc: ToolCallRequest;
  options: ToolExecuteOptions;
  req?: ServerRequest;
  filePath: string;
  edits: TextEdit[];
  sandboxContext?: SandboxSessionContext;
  codeExecutionContext?: CodeExecutionContext;
  signal?: AbortSignal;
}): AuthoringResult {
  if (codeExecutionContext?.environmentType === 'attached') {
    return await handleAttachedWorkspaceEditFileCall({
      tc,
      options,
      req,
      filePath,
      edits,
      codeExecutionContext,
      signal,
    });
  }
  const pathError = invalidSandboxAuthoringPath(filePath);
  if (pathError) {
    return errorResult(tc, pathError);
  }

  const current = await loadSandboxTextForAuthoring({
    filePath,
    tc,
    options,
    req,
    sandboxContext,
    codeExecutionContext,
  });
  if (current.status === 'missing') {
    return errorResult(tc, `File not found: "${filePath}"`);
  }
  if (current.status === 'error') {
    return errorResult(tc, current.message);
  }

  let edited: { content: string; strategies: string[] };
  try {
    edited = await applyHostTextEdits(
      current.content,
      edits,
      req?.config?.endpoints?.agents?.hostFileEdits,
      signal,
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    return hostEditFailure(tc, error);
  }
  signal?.throwIfAborted();
  if (Buffer.byteLength(edited.content, 'utf8') > MAX_AUTHORING_BYTES) {
    return errorResult(tc, `edited content exceeds ${MAX_AUTHORING_BYTES} byte limit`);
  }

  const result = await writeSandboxTextForAuthoring({
    tc,
    options,
    req,
    filePath,
    content: edited.content,
    oldContent: current.content,
    signal,
    created: false,
    sandboxContext,
    codeExecutionContext,
  });
  if (result.status === 'success') {
    result.artifact = {
      ...(typeof result.artifact === 'object' && result.artifact ? result.artifact : {}),
      edits: edits.length,
      strategies: edited.strategies,
    };
    result.content = `${String(result.content)}\n\nStrategies: ${edited.strategies.join(', ')}`;
  }
  return result;
}

async function handleCreateFileCall(
  tc: ToolCallRequest,
  mergedConfigurable: Record<string, unknown>,
  options: ToolExecuteOptions,
  req?: ServerRequest,
  sourceConfigurable?: Record<string, unknown>,
  sandboxContext?: SandboxSessionContext,
  signal?: AbortSignal,
): AuthoringResult {
  const args = tc.args as { path?: unknown; content?: unknown; overwrite?: unknown };
  if (typeof args.path !== 'string' || args.path.length === 0) {
    return errorResult(tc, 'path is required');
  }
  if (typeof args.content !== 'string') {
    return errorResult(
      tc,
      'content is required. If the file is large, your response may have been cut off at the ' +
        'output token limit before content finished. Keep the main file lean and move bulky ' +
        'sections (templates, schemas, long docs) into separate files written in their own calls.',
    );
  }
  if (Buffer.byteLength(args.content, 'utf8') > MAX_AUTHORING_BYTES) {
    return errorResult(tc, `content exceeds ${MAX_AUTHORING_BYTES} byte limit`);
  }

  const overwrite = args.overwrite === true;
  if (!isSkillFilePath(args.path)) {
    if (mergedConfigurable?.codeEnvAvailable !== true) {
      return errorResult(
        tc,
        `Path "${args.path}" is not a skill file, and this agent does not have code execution enabled.`,
      );
    }
    return await handleSandboxCreateFileCall({
      tc,
      options,
      req,
      filePath: args.path,
      content: args.content,
      overwrite,
      sandboxContext,
      codeExecutionContext: getCodeExecutionContext(mergedConfigurable),
      signal,
    });
  }

  const parsed = parseSkillAuthoringPath(args.path);
  if (typeof parsed === 'string') {
    return errorResult(tc, parsed);
  }
  if (!isSkillAuthoringAvailable(mergedConfigurable)) {
    return errorResult(tc, 'Skill file authoring is not available for this agent.');
  }

  let skill = await resolveSkillForAuthoring(parsed.skillName, mergedConfigurable, options);
  if (!skill) {
    skill = await resolveAuthorSkillForCurrentUser({
      skillName: parsed.skillName,
      mergedConfigurable,
      sourceConfigurable,
      options,
      req,
    });
  }
  const hiddenDenied = hiddenSkillAuthoringDenied(tc, skill, parsed.skillName, mergedConfigurable);
  if (hiddenDenied) {
    return hiddenDenied;
  }
  if (parsed.relativePath === SKILL_MD) {
    if (skill && !overwrite) {
      return errorResult(
        tc,
        `Skill "${parsed.skillName}" already exists. Use edit_file for targeted changes, or pass overwrite: true only if replacing the entire ${parsed.displayPath} is intended.`,
      );
    }
    return await writeSkillMd({
      tc,
      options,
      req,
      mergedConfigurable,
      sourceConfigurable,
      skill,
      skillName: parsed.skillName,
      content: args.content,
    });
  }

  if (!skill) {
    return errorResult(tc, `Skill "${parsed.skillName}" not found or not accessible.`);
  }

  const current = await inspectBundledSkillFileForCreate({
    skill,
    relativePath: parsed.relativePath,
    options,
    req,
  });
  if (current.status === 'error') {
    return errorResult(tc, current.message);
  }
  if (current.status === 'present' && !overwrite) {
    return errorResult(tc, 'File already exists. Pass overwrite: true to replace.');
  }
  return await writeBundledSkillFile({
    tc,
    options,
    req,
    skill,
    relativePath: parsed.relativePath,
    displayPath: parsed.displayPath,
    content: args.content,
    oldContent: current.status === 'present' ? current.oldContent : undefined,
    fileId: current.status === 'present' ? current.fileId : undefined,
    created: current.status === 'missing',
  });
}

async function handleEditFileCall(
  tc: ToolCallRequest,
  mergedConfigurable: Record<string, unknown>,
  options: ToolExecuteOptions,
  req?: ServerRequest,
  sandboxContext?: SandboxSessionContext,
  signal?: AbortSignal,
): AuthoringResult {
  const args = tc.args as {
    path?: unknown;
    old_text?: unknown;
    new_text?: unknown;
    replace_all?: unknown;
    edits?: unknown;
  };
  if (typeof args.path !== 'string' || args.path.length === 0) {
    return errorResult(tc, 'path is required');
  }

  const edits = normalizeEditArgs(args);
  if (typeof edits === 'string') {
    return errorResult(tc, edits);
  }

  if (!isSkillFilePath(args.path)) {
    if (mergedConfigurable?.codeEnvAvailable !== true) {
      return errorResult(
        tc,
        `Path "${args.path}" is not a skill file, and this agent does not have code execution enabled.`,
      );
    }
    return await handleSandboxEditFileCall({
      tc,
      options,
      req,
      filePath: args.path,
      edits,
      sandboxContext,
      codeExecutionContext: getCodeExecutionContext(mergedConfigurable),
      signal,
    });
  }

  const parsed = parseSkillAuthoringPath(args.path);
  if (typeof parsed === 'string') {
    return errorResult(tc, parsed);
  }
  if (!isSkillAuthoringAvailable(mergedConfigurable)) {
    return errorResult(tc, 'Skill file authoring is not available for this agent.');
  }

  let skill = await resolveSkillForAuthoring(parsed.skillName, mergedConfigurable, options);
  if (!skill) {
    skill = await resolveAuthorSkillForCurrentUser({
      skillName: parsed.skillName,
      mergedConfigurable,
      options,
      req,
    });
  }
  if (!skill) {
    return errorResult(tc, `Skill "${parsed.skillName}" not found or not accessible.`);
  }
  const hiddenDenied = hiddenSkillAuthoringDenied(tc, skill, parsed.skillName, mergedConfigurable);
  if (hiddenDenied) {
    return hiddenDenied;
  }

  const current = await loadSkillFileTextForAuthoring({
    skill,
    relativePath: parsed.relativePath,
    options,
    req,
  });
  if (current.status === 'missing') {
    return errorResult(
      tc,
      `File not found: "${parsed.relativePath}" in skill "${parsed.skillName}"`,
    );
  }
  if (current.status === 'error') {
    return errorResult(tc, current.message);
  }

  let edited: { content: string; strategies: string[] };
  try {
    edited = await applyHostTextEdits(
      current.content,
      edits,
      req?.config?.endpoints?.agents?.hostFileEdits,
      signal,
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    return hostEditFailure(tc, error);
  }
  signal?.throwIfAborted();
  if (Buffer.byteLength(edited.content, 'utf8') > MAX_AUTHORING_BYTES) {
    return errorResult(tc, `edited content exceeds ${MAX_AUTHORING_BYTES} byte limit`);
  }

  if (parsed.relativePath === SKILL_MD) {
    const result = await writeSkillMd({
      tc,
      options,
      req,
      mergedConfigurable,
      skill,
      skillName: parsed.skillName,
      content: edited.content,
      signal,
    });
    if (result.status === 'success') {
      result.artifact = {
        ...(typeof result.artifact === 'object' && result.artifact ? result.artifact : {}),
        edits: edits.length,
        strategies: edited.strategies,
      };
      result.content = `${String(result.content)}\n\nStrategies: ${edited.strategies.join(', ')}`;
    }
    return result;
  }

  const result = await writeBundledSkillFile({
    tc,
    options,
    req,
    skill,
    relativePath: parsed.relativePath,
    displayPath: parsed.displayPath,
    content: edited.content,
    signal,
    oldContent: current.content,
    fileId: current.fileId,
    created: false,
  });
  if (result.status === 'success') {
    result.artifact = {
      ...(typeof result.artifact === 'object' && result.artifact ? result.artifact : {}),
      edits: edits.length,
      strategies: edited.strategies,
    };
    result.content = `${String(result.content)}\n\nStrategies: ${edited.strategies.join(', ')}`;
  }
  return result;
}

async function handleReadFileCall(
  tc: ToolCallRequest,
  mergedConfigurable: Record<string, unknown>,
  options: ToolExecuteOptions,
  req?: ServerRequest,
  onSandboxReadSuccess?: () => void,
  signal?: AbortSignal,
): Promise<ToolExecuteResult> {
  const { getSkillByName, getSkillFileByPath, getStrategyFunctions, updateSkillFileContent } =
    options;
  const args = tc.args as { path?: string };
  if (!args.path) {
    return {
      toolCallId: tc.id,
      status: 'error',
      content: '',
      errorMessage: 'path is required',
    };
  }

  const codeEnvAvailable = mergedConfigurable?.codeEnvAvailable === true;
  const codeExecutionContext = getCodeExecutionContext(mergedConfigurable);
  let accessibleIds = (mergedConfigurable?.accessibleSkillIds as Types.ObjectId[]) ?? [];

  if (args.path.startsWith('workspace/')) {
    if (!codeEnvAvailable || codeExecutionContext?.environmentType !== 'attached') {
      return {
        toolCallId: tc.id,
        status: 'error',
        content: '',
        errorMessage: 'workspace/ paths require an attached code environment.',
      };
    }
    return handleWorkspaceFileRead(
      tc,
      args.path.slice('workspace/'.length),
      options,
      req,
      codeExecutionContext,
      signal,
    );
  }

  /**
   * Short-circuit absolute code-env paths: the path can never be a skill
   * reference (skill paths are relative `{skillName}/...`), and consulting
   * `getSkillByName` would just burn a DB round-trip on a guaranteed miss.
   */
  if (args.path.startsWith('/mnt/data/')) {
    if (codeEnvAvailable) {
      return handleSandboxFileFallback(
        tc,
        args.path,
        options,
        req,
        codeExecutionContext,
        onSandboxReadSuccess,
        signal,
      );
    }
    return {
      toolCallId: tc.id,
      status: 'error',
      content: '',
      errorMessage: `Path "${args.path}" is a code-execution sandbox path, but this agent does not have code execution enabled.`,
    };
  }

  let skillName: string;
  let relativePath: string;
  const explicitSkillNamespace = args.path.startsWith(SKILL_FILE_PREFIX);
  if (explicitSkillNamespace) {
    const parsed = parseSkillAuthoringPath(args.path);
    if (typeof parsed === 'string') {
      return {
        toolCallId: tc.id,
        status: 'error',
        content: '',
        errorMessage: parsed,
      };
    }
    skillName = parsed.skillName;
    relativePath = parsed.relativePath;
  } else {
    const slashIdx = args.path.indexOf('/');
    if (slashIdx < 1) {
      if (codeEnvAvailable) {
        return handleSandboxFileFallback(
          tc,
          args.path,
          options,
          req,
          codeExecutionContext,
          onSandboxReadSuccess,
          signal,
        );
      }
      return {
        toolCallId: tc.id,
        status: 'error',
        content: '',
        errorMessage: `Invalid file path "${args.path}". Use format: {skillName}/{path}`,
      };
    }

    skillName = args.path.slice(0, slashIdx);
    relativePath = args.path.slice(slashIdx + 1);
    if (!relativePath) {
      /**
       * `read_file("output/")`: a malformed-but-unambiguously-not-a-skill
       * path. Stay consistent with the other malformed-path branches and
       * route to the sandbox when code execution is available, instead of
       * dead-ending with a skill-centric error message.
       */
      if (codeEnvAvailable) {
        return handleSandboxFileFallback(
          tc,
          args.path,
          options,
          req,
          codeExecutionContext,
          onSandboxReadSuccess,
          signal,
        );
      }
      return {
        toolCallId: tc.id,
        status: 'error',
        content: '',
        errorMessage: 'Missing file path after skill name',
      };
    }
  }

  let skillPrimedIdsByName =
    (mergedConfigurable?.skillPrimedIdsByName as Record<string, string> | undefined) ?? {};
  let primedIdString = skillPrimedIdsByName[skillName];
  let isPrimedThisTurn = primedIdString != null;
  const refreshSkillReadScope = () => {
    accessibleIds = (mergedConfigurable?.accessibleSkillIds as Types.ObjectId[]) ?? [];
    skillPrimedIdsByName =
      (mergedConfigurable?.skillPrimedIdsByName as Record<string, string> | undefined) ?? {};
    primedIdString = skillPrimedIdsByName[skillName];
    isPrimedThisTurn = primedIdString != null;
  };
  let recoveredAuthorSkill: AuthoringSkill | null | undefined;
  const recoverAuthorSkill = async () => {
    if (recoveredAuthorSkill !== undefined) {
      return recoveredAuthorSkill;
    }
    recoveredAuthorSkill = await resolveAuthorSkillForCurrentUser({
      skillName,
      mergedConfigurable,
      options,
      req,
    });
    refreshSkillReadScope();
    return recoveredAuthorSkill;
  };
  /**
   * `accessibleSkillIds` is the resolver's normal output (admin
   * capability AND ACL access AND ephemeral badge / persisted
   * `skills_enabled`). A skill authored earlier in this run is also
   * resolvable through `skillPrimedIdsByName`, even when the run started
   * with an empty accessible set for a first-time creator.
   */
  let skillsEffectivelyEnabled = accessibleIds.length > 0 || isPrimedThisTurn;
  if (
    !skillsEffectivelyEnabled &&
    explicitSkillNamespace &&
    isSkillAuthoringAvailable(mergedConfigurable)
  ) {
    await recoverAuthorSkill();
    skillsEffectivelyEnabled = accessibleIds.length > 0 || isPrimedThisTurn;
  }

  /**
   * Skills not in scope (admin capability off, ephemeral badge off, or
   * persisted `skills_enabled !== true` — all already collapsed into
   * `accessibleSkillIds.length === 0` by `resolveAgentScopedSkillIds`):
   * route to the sandbox fallback when code execution is available, else
   * the lookup truly has nowhere to go.
   */
  if (!skillsEffectivelyEnabled) {
    if (codeEnvAvailable && !explicitSkillNamespace) {
      return handleSandboxFileFallback(
        tc,
        args.path,
        options,
        req,
        codeExecutionContext,
        onSandboxReadSuccess,
        signal,
      );
    }
    return {
      toolCallId: tc.id,
      status: 'error',
      content: '',
      errorMessage:
        'Skill files are not available for this agent and code execution is not enabled.',
    };
  }

  /**
   * Read the primed-skills map BEFORE the `activeSkillNames` shortcut.
   *
   * `activeSkillNames` is the catalog-visible set after the
   * `SKILL_CATALOG_LIMIT` cap and the active-state filter run in
   * `injectSkillCatalog`. Manual ($-popover) primes and always-apply
   * primes are intentionally resolved off the wider `accessibleSkillIds`
   * ACL set BEFORE catalog injection — see `resolveManualSkills` for
   * why a skill outside the catalog cap can still be authorized for
   * direct manual invocation. So a primed skill name may legitimately
   * be absent from `activeSkillNames`. Treat any name in
   * `skillPrimedIdsByName` as "known" for the gate below; otherwise the
   * shortcut would misroute `read_file("primed-skill/references/foo.md")`
   * to the sandbox even though the primed skill is in scope.
   */
  /**
   * Skills are in scope, but the first segment isn't a name we know.
   * Use the catalog-derived `activeSkillNames` Set (no DB read) to detect
   * this and fall through to the sandbox so the model doesn't have to
   * eat a wasted `read_file` error before retrying with `bash_tool`.
   * Primed names bypass this shortcut even when absent from the catalog
   * (see comment on `skillPrimedIdsByName` above).
   */
  const activeSkillNames = mergedConfigurable?.activeSkillNames as Set<string> | undefined;
  if (activeSkillNames && !activeSkillNames.has(skillName) && !isPrimedThisTurn) {
    const recovered = await recoverAuthorSkill();
    if (!recovered) {
      if (codeEnvAvailable && !explicitSkillNamespace) {
        return handleSandboxFileFallback(
          tc,
          args.path,
          options,
          req,
          codeExecutionContext,
          onSandboxReadSuccess,
          signal,
        );
      }
      return {
        toolCallId: tc.id,
        status: 'error',
        content: '',
        errorMessage: `Skill "${skillName}" not found or not accessible`,
      };
    }
  }

  if (!getSkillByName) {
    return {
      toolCallId: tc.id,
      status: 'error',
      content: '',
      errorMessage: 'File reading is not configured',
    };
  }
  /* On a primed lookup (manual `$` OR always-apply), pin the accessible
     set to ONLY the primed `_id`. This guarantees the doc whose body got
     primed is the SAME doc whose files we read, even when same-name
     duplicates exist and `activeSkillIds` had to drop some via the
     disable-model dedup. For autonomous probes we keep the full ACL set
     + `preferModelInvocable` so the lookup matches the catalog the model
     saw (and falls back to newest so the disabled-only case still fires
     the explicit rejection gate below). Constructing a real `ObjectId`
     (rather than relying on mongoose's string auto-cast in `$in` queries)
     keeps the value correct for any future consumer that compares with
     `.equals()` or `===`. */
  const lookupAccessibleIds = primedIdString ? [new Types.ObjectId(primedIdString)] : accessibleIds;
  const lookupOptions: { preferUserInvocable?: boolean; preferModelInvocable?: boolean } =
    primedIdString ? {} : { preferModelInvocable: true };
  let skill = await getSkillByName(skillName, lookupAccessibleIds, lookupOptions);
  if (!skill) {
    skill = await recoverAuthorSkill();
    if (!skill) {
      return {
        toolCallId: tc.id,
        status: 'error',
        content: '',
        errorMessage: `Skill "${skillName}" not found or not accessible`,
      };
    }
  }

  /**
   * `disable-model-invocation: true` blocks AUTONOMOUS read_file probes:
   * a model that learned a hidden skill's name (stale catalog, hallucination)
   * shouldn't be able to read its SKILL.md body or bundled files. But when
   * the skill was primed this turn (manual `$` invocation OR always-apply),
   * the body is already in context — and a primed skill that depends on
   * `references/foo.md` would be non-functional if read_file were blocked.
   * Bypass the gate for primed names so this stays usable end-to-end for
   * both prime sources.
   *
   * Sticky-primed skills (manually or model-invoked in prior turns) are not
   * yet in this exception list — that's a known limitation tracked for
   * a follow-up. Same-turn priming is the load-bearing path.
   */
  if (skill.disableModelInvocation === true && !isPrimedThisTurn) {
    return {
      toolCallId: tc.id,
      status: 'error',
      content: '',
      errorMessage: `Skill "${skillName}" cannot be invoked by the model`,
    };
  }

  // SKILL.md special case: read from skill.body directly
  if (relativePath === 'SKILL.md') {
    if (!skill.body) {
      return {
        toolCallId: tc.id,
        status: 'error',
        content: '',
        errorMessage: `SKILL.md is empty for skill "${skillName}"`,
      };
    }
    const filtered = filteredSkillResult(tc, req, {
      name: skill.name,
      description: skill.description,
      body: skill.body,
      frontmatter: skill.frontmatter,
    });
    if (filtered != null) {
      return filtered;
    }
    return localTextReadResult(tc, args.path, skill.body, `File: ${args.path}\n\n`);
  }

  /* Bundled skill files are primed into the sandbox under the `skills/`
   * namespace (see `primeSkillFiles`), so the on-disk path is always
   * `/mnt/data/skills/{skillName}/{relativePath}` regardless of whether the
   * model addressed the file with or without the explicit prefix. Use this
   * canonical path in the bash-fallback hints below so they never echo a
   * prefix-less `args.path` that points nowhere on disk. */
  const sandboxFilePath = `/mnt/data/${SKILL_FILE_PREFIX}${skillName}/${relativePath}`;

  if (!getSkillFileByPath) {
    return {
      toolCallId: tc.id,
      status: 'error',
      content: '',
      errorMessage: 'File reading is not configured',
    };
  }

  const file = await getSkillFileByPath(skill._id, relativePath);
  if (!file) {
    return {
      toolCallId: tc.id,
      status: 'error',
      content: '',
      errorMessage: `File not found: "${relativePath}" in skill "${skillName}"`,
    };
  }

  const fileFiltered = IMAGE_MIMES.has(file.mimeType)
    ? filteredBinaryFileResult(tc, req, args.path)
    : filteredFileNameResult(tc, req, args.path);
  if (fileFiltered != null) {
    return fileFiltered;
  }

  // Known binary — serve images as artifacts, others as metadata
  if (file.isBinary === true) {
    if (IMAGE_MIMES.has(file.mimeType) && file.bytes <= MAX_BINARY_BYTES) {
      // Stream and return as image artifact (handled below in stream path)
    } else {
      return {
        toolCallId: tc.id,
        status: 'success',
        content: `Binary file (${file.mimeType}, ${file.bytes} bytes). Use bash to process: ${sandboxFilePath}`,
      };
    }
  }

  // Cached text content
  if (file.isBinary !== true && file.content != null && file.content !== '') {
    const skillFiltered = filteredSkillResult(tc, req, {
      files: [{ filename: args.path, content: file.content }],
    });
    if (skillFiltered != null) {
      return skillFiltered;
    }
    const fileFiltered = filteredFileResult(tc, req, args.path, file.content);
    if (fileFiltered != null) {
      return fileFiltered;
    }
    return localTextReadResult(
      tc,
      args.path,
      file.content,
      `File: ${args.path} (${file.bytes} bytes)\n\n`,
    );
  }

  // Early size check from DB metadata before streaming
  const isImage = IMAGE_MIMES.has(file.mimeType);
  if (!isImage && file.bytes > MAX_READABLE_BYTES) {
    return {
      toolCallId: tc.id,
      status: 'success',
      content: `File "${args.path}" is too large to read directly (${file.bytes} bytes, limit: ${MAX_READABLE_BYTES}). Invoke the skill first, then use bash to read it at ${sandboxFilePath}.`,
    };
  }
  if (isImage && file.bytes > MAX_BINARY_BYTES) {
    return {
      toolCallId: tc.id,
      status: 'success',
      content: `File too large (${file.bytes} bytes, limit: ${MAX_BINARY_BYTES}). Use bash to process: ${sandboxFilePath}`,
    };
  }

  // Stream from storage
  if (!getStrategyFunctions || !req) {
    return {
      toolCallId: tc.id,
      status: 'error',
      content: '',
      errorMessage: 'Storage access not available',
    };
  }

  try {
    const strategy = getStrategyFunctions(file.source);
    if (!strategy.getDownloadStream) {
      return {
        toolCallId: tc.id,
        status: 'error',
        content: '',
        errorMessage: 'Download not supported for this storage backend',
      };
    }

    const stream = await strategy.getDownloadStream(req, resolveDownloadPath(file));
    const chunks: Uint8Array[] = [];
    // Use the larger binary limit as streaming cap; cheaper type-specific
    // checks happen after binary detection on the assembled buffer.
    const streamLimit = MAX_BINARY_BYTES;
    let streamedBytes = 0;
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      streamedBytes += chunk.byteLength;
      if (streamedBytes > streamLimit) {
        // Destroy the stream if possible to free resources
        if (
          'destroy' in stream &&
          typeof (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy === 'function'
        ) {
          (stream as NodeJS.ReadableStream & { destroy: () => void }).destroy();
        }
        return {
          toolCallId: tc.id,
          status: 'success',
          content: `File "${args.path}" exceeded streaming limit (${streamLimit} bytes). Invoke the skill first, then use bash to read it at ${sandboxFilePath}.`,
        };
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Binary detection on first 8KB
    const checkLen = Math.min(buffer.length, 8192);
    let isBinary = file.isBinary === true;
    if (!isBinary) {
      for (let i = 0; i < checkLen; i++) {
        if (buffer[i] === 0) {
          isBinary = true;
          break;
        }
      }
    }

    if (isBinary) {
      // Cache the binary flag (first read only)
      if (file.isBinary == null && updateSkillFileContent) {
        updateSkillFileContent(skill._id, relativePath, { isBinary: true }, file.file_id).catch(
          (err: unknown) => {
            logAxiosError({
              message: '[handleReadFileCall] cache write failed',
              error: err,
            });
          },
        );
      }

      // Return images/PDFs as artifacts
      if (IMAGE_MIMES.has(file.mimeType) && buffer.length <= MAX_BINARY_BYTES) {
        return buildImageArtifactResult(
          tc.id,
          args.path,
          file.mimeType,
          buffer.length,
          buffer.toString('base64'),
        );
      }

      // TODO: PDF artifact support requires a document content block path
      // (image_url runs image processing which fails for PDFs). Falls through
      // to the generic binary handler below.

      return {
        toolCallId: tc.id,
        status: 'success',
        content: `Binary file (${file.mimeType}, ${buffer.length} bytes). Use bash to process: ${sandboxFilePath}`,
      };
    }

    const text = buffer.toString('utf-8');
    const skillFiltered = filteredSkillResult(tc, req, {
      files: [{ filename: args.path, content: text }],
    });
    if (skillFiltered != null) {
      return skillFiltered;
    }
    const fileFiltered = filteredFileResult(tc, req, args.path, text);
    if (fileFiltered != null) {
      return fileFiltered;
    }

    // Cache text on first read (skill files are immutable)
    if (file.content == null && updateSkillFileContent && buffer.length <= MAX_CACHE_BYTES) {
      updateSkillFileContent(
        skill._id,
        relativePath,
        { content: text, isBinary: false },
        file.file_id,
      ).catch((err: unknown) => {
        logAxiosError({
          message: '[handleReadFileCall] cache write failed',
          error: err,
        });
      });
    }

    if (buffer.length > MAX_READABLE_BYTES) {
      return {
        toolCallId: tc.id,
        status: 'success',
        content: `File too large (${buffer.length} bytes, limit: ${MAX_READABLE_BYTES}). Use bash: cat ${sandboxFilePath}`,
      };
    }

    return localTextReadResult(
      tc,
      args.path,
      text,
      `File: ${args.path} (${buffer.length} bytes)\n\n`,
    );
  } catch (error) {
    return {
      toolCallId: tc.id,
      status: 'error',
      content: '',
      errorMessage: `Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

async function handleSkillToolCall(
  tc: ToolCallRequest,
  mergedConfigurable: Record<string, unknown>,
  options: ToolExecuteOptions,
  agentId?: string,
  req?: ServerRequest,
  signal?: AbortSignal,
  rateLimitBudget?: import('~/utils').CodeApiRateLimitBudget,
): Promise<ToolExecuteResult> {
  const {
    getSkillByName,
    listSkillFiles,
    getStrategyFunctions,
    batchUploadCodeEnvFiles,
    getSessionInfo,
    checkIfActive,
    updateSkillFileCodeEnvIds,
  } = options;
  const args = tc.args as { skillName?: string; args?: string };
  if (!args.skillName) {
    return {
      toolCallId: tc.id,
      status: 'error',
      content: '',
      errorMessage: 'skillName is required',
    };
  }

  if (!getSkillByName) {
    return {
      toolCallId: tc.id,
      status: 'error',
      content: '',
      errorMessage: 'Skill execution is not configured',
    };
  }

  const accessibleIds = (mergedConfigurable?.accessibleSkillIds as Types.ObjectId[]) ?? [];
  /* On a name this run's authoring path bound to a specific doc, pin the
     accessible set to ONLY that `_id`, exactly as the `read_file` path
     pins to a primed `_id`. `getSkillByName` resolves deployment skills
     from the registry before the database and matches on name plus
     accessibility alone, so a same-name deployment skill sharing the
     accessible set would otherwise shadow the doc just authored — the
     model would be told its creation is invocable and then be handed
     different instructions. Pinning also drops `preferModelInvocable`,
     matching `resolveSkillForAuthoring`: with one candidate there is no
     collision to resolve, and the `disable-model-invocation` gate below
     must still see the authored doc rather than a same-name twin.

     `preferModelInvocable` keeps name-collision resolution aligned with
     the catalog otherwise: a newer `disable-model-invocation: true`
     duplicate can't shadow the cataloged invocable doc. Model-only
     (`userInvocable: false`) skills are intentionally still resolvable
     here — they're valid model-invocation targets. Falls back to the
     newest match so the disabled-only case still resolves and the gate
     below fires its explicit error. */
  const authoredIdString = getAuthoredSkillId(args.skillName, mergedConfigurable);
  const lookupAccessibleIds = authoredIdString
    ? [new Types.ObjectId(authoredIdString)]
    : accessibleIds;
  const skill = await getSkillByName(
    args.skillName,
    lookupAccessibleIds,
    authoredIdString ? {} : { preferModelInvocable: true },
  );

  if (!skill) {
    return {
      toolCallId: tc.id,
      status: 'error',
      content: '',
      errorMessage: `Skill "${args.skillName}" not found or not accessible`,
    };
  }

  /**
   * `disable-model-invocation: true` skills are excluded from the catalog
   * the model sees, but a model that learned the name elsewhere (stale
   * cache, hallucinated guess) could still try to invoke it. Reject
   * explicitly so the error message tells the model exactly why and it
   * doesn't loop retrying. Manual `$` invocation goes through
   * `resolveManualSkills`, which is unaffected by this flag.
   */
  if (skill.disableModelInvocation === true) {
    return {
      toolCallId: tc.id,
      status: 'error',
      content: '',
      errorMessage: `Skill "${args.skillName}" cannot be invoked by the model`,
    };
  }

  let body = skill.body;
  if (args.args) {
    body = body.replace(/\$ARGUMENTS/g, args.args);
  }
  const filtered = filteredSkillResult(tc, req, {
    name: skill.name,
    description: skill.description,
    body,
    frontmatter: skill.frontmatter,
  });
  if (filtered != null) {
    return filtered;
  }

  const injectedMessages: InjectedMessage[] = [buildSkillPrimeMessage({ name: skill.name, body })];

  let contentText = `Skill "${args.skillName}" loaded. Follow the instructions below.`;
  let artifact:
    | {
        session_id: string;
        files: Array<{
          id: string;
          /** Resource id (skill `_id`). codeapi requires this distinct
           *  from the storage `id` to scope sessionKey by resource. */
          resource_id: string;
          name: string;
          storage_session_id: string;
          kind?: 'skill' | 'agent' | 'user';
          version?: number;
        }>;
      }
    | undefined;

  // Prime skill files to code env — only when the `execute_code` capability
  // is enabled for this run. The flag is threaded via configurable upstream
  // so this gate cannot be bypassed.
  const codeEnvAvailable = mergedConfigurable?.codeEnvAvailable === true;
  const codeExecutionContext = getCodeExecutionContext(mergedConfigurable);
  if (
    codeEnvAvailable &&
    skill.fileCount > 0 &&
    req &&
    listSkillFiles &&
    getStrategyFunctions &&
    batchUploadCodeEnvFiles
  ) {
    let primeResult: PrimeSkillFilesResult | null = null;
    try {
      signal?.throwIfAborted();
      const skillFiles = await listSkillFiles(skill._id);
      signal?.throwIfAborted();
      primeResult = await primeSkillFiles({
        skill,
        skillFiles,
        req,
        getStrategyFunctions,
        batchUploadCodeEnvFiles,
        getSessionInfo,
        checkIfActive,
        updateSkillFileCodeEnvIds,
        codeExecutionContext,
        signal,
        rateLimitBudget,
      });
      if (primeResult) {
        /* `session_id` at the top of the artifact is the (representative)
         * execution session — ToolNode reads it for CodeSessionContext
         * continuity. Per-file storage lives on each file's
         * `storage_session_id`. Skill files carry `kind: 'skill'` and
         * the skill's version so codeapi's sessionKey scopes the
         * cache per-revision. */
        artifact = {
          session_id: primeResult.storage_session_id,
          files: primeResult.files.map((f) => ({
            id: f.id,
            /* `resource_id` (skill `_id`) is what codeapi feeds into
             * `<tenant>:skill:<id>:v:<version>` — without it the next
             * /exec authorizer sees `resource_id: undefined` and 400s. */
            resource_id: f.resource_id,
            name: f.name,
            storage_session_id: f.storage_session_id,
            kind: 'skill',
            version: skill.version,
          })),
        };
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      if (isContentFilterError(error)) {
        return error instanceof ContentFilterError
          ? errorResult(tc, modelBoundContentFilterErrorMessage(error.body))
          : errorResult(tc, error.body.message);
      }
      logger.error(
        `[handleSkillToolCall] Failed to prime files for skill "${args.skillName}":`,
        error instanceof Error ? error.message : error,
      );
    }
    if (!primeResult) {
      /* Degrade loudly: without this note the model follows skill
       * instructions referencing sandbox paths that were never mounted
       * and burns turns on missing-path errors. */
      contentText +=
        `\n\nNote: this skill's bundled files could not be loaded into the code environment ` +
        `(upload failed or was rate-limited). Paths under /mnt/data/${SKILL_FILE_PREFIX}${skill.name}/ ` +
        `are NOT available to bash or code execution this turn. Use the read_file tool to view bundled files instead.`;
    }
  }

  options.onSkillResolved?.(
    {
      id: skill._id.toString(),
      name: skill.name,
      version: skill.version,
      contentDigest: createSkillContentDigest(skill.body),
    },
    { agentId },
  );

  return {
    toolCallId: tc.id,
    content: contentText,
    status: 'success',
    artifact,
    injectedMessages,
  };
}

function getFileAuthoringQueueKey(
  tc: ToolCallRequest,
  mergedConfigurable: Record<string, unknown>,
): string | undefined {
  if (!isHostFileAuthoringToolCall(tc.name, mergedConfigurable)) {
    return undefined;
  }
  const args = tc.args as { path?: unknown };
  if (typeof args.path !== 'string' || args.path.length === 0) {
    return undefined;
  }
  if (!args.path.startsWith(SKILL_FILE_PREFIX)) {
    return `sandbox:${args.path}`;
  }
  const parsed = parseSkillAuthoringPath(args.path);
  if (typeof parsed === 'string') {
    return `skill:${args.path}`;
  }
  return `skill:${parsed.skillName}`;
}

/**
 * Creates the ON_TOOL_EXECUTE handler for event-driven tool execution.
 * This handler receives batched tool calls, loads the required tools,
 * executes them in parallel, and resolves with the results.
 */
/**
 * Foreground tool failures reach persisted parts wrapped by the graph as
 * `Error: [toolName] tool call failed: <message>` — the exact shape the
 * client's `isError` detection keys on. Detached failures bypass the graph,
 * so wrap them identically before patching the dispatch row, or a reloaded
 * failed background run renders as clean stdout.
 */
function toBackgroundToolFailure(toolName: string, message: string): string {
  if (hasToolCallErrorPrefix(message)) {
    return message;
  }
  return `Error: [${toolName}] tool call failed: ${message}`;
}

/**
 * Invoke-time `toolCall` config for a call: identity plus the stateful
 * runtime-session hint and code-session context (`session_id` +
 * `_injected_files`) for sandbox-bound tools. Shared by the foreground path
 * and background dispatch so a detached code call keeps the same session and
 * file continuity a foreground call gets.
 */
function buildToolCallConfig(
  tc: ToolCallRequest,
  mergedConfigurable: Record<string, unknown>,
): Record<string, unknown> {
  const toolCallConfig: Record<string, unknown> = {
    id: tc.id,
    stepId: tc.stepId,
    turn: tc.turn,
  };

  /* Stateful runtime-session hint: the SDK resolves it onto
   * the request for execute_code/bash (orthogonal to the
   * transient exec-session below — a first call has a hint but
   * no session yet). The remote executors read it off
   * `config.toolCall._runtime_session_hint`; without this the
   * event-driven ON_TOOL_EXECUTE path drops it and every
   * conversation collapses onto the Code API's `default`
   * session (no per-conversation isolation). */
  if (tc.runtimeSessionHint != null && tc.runtimeSessionHint !== '') {
    toolCallConfig._runtime_session_hint = tc.runtimeSessionHint;
  }

  if (tc.codeSessionContext && isCodeSessionAwareToolCall(tc.name, mergedConfigurable)) {
    toolCallConfig.session_id = tc.codeSessionContext.session_id;
    if (tc.codeSessionContext.files && tc.codeSessionContext.files.length > 0) {
      toolCallConfig._injected_files = tc.codeSessionContext.files;
      /* Last LC-controlled point before the wire. Mirrors
       * codeapi's validator context so the two log sides
       * correlate on a single grep. */
      const refs = tc.codeSessionContext.files as Array<{
        id?: unknown;
        resource_id?: unknown;
        storage_session_id?: unknown;
        kind?: unknown;
        version?: unknown;
        name?: unknown;
      }>;
      const summary = refs.map((f) => ({
        kind: f.kind,
        hasResourceId: typeof f.resource_id === 'string' && !!f.resource_id,
        hasStorageSessionId: typeof f.storage_session_id === 'string' && !!f.storage_session_id,
        hasVersion: typeof f.version === 'number',
      }));
      let missingResourceId = 0;
      let missingStorageSessionId = 0;
      let missingVersion = 0;
      const kindCounts: Record<string, number> = {};
      for (const s of summary) {
        if (!s.hasResourceId) missingResourceId++;
        if (!s.hasStorageSessionId) missingStorageSessionId++;
        if (!s.hasVersion) missingVersion++;
        const k = typeof s.kind === 'string' ? s.kind : 'unknown';
        kindCounts[k] = (kindCounts[k] ?? 0) + 1;
      }
      logger.debug(
        `[code-env:inject] tool=${tc.name} files=${refs.length} ` +
          `missingResourceId=${missingResourceId} ` +
          `missingStorageSessionId=${missingStorageSessionId} ` +
          `missingVersion=${missingVersion} ` +
          `kinds=${JSON.stringify(kindCounts)}`,
      );
      if (missingResourceId > 0) {
        logger.warn(
          `[code-env:inject] ${missingResourceId}/${refs.length} files missing resource_id ` +
            `for tool=${tc.name} — codeapi will reject with 400`,
          { summary },
        );
      }
    } else {
      /* Empty `_injected_files` on a code-execution tool
       * call. Almost always means the seeding chain
       * (primeCodeFiles → initialSessions →
       * CodeSessionContext) dropped the file upstream.
       * `session_id` is still emitted for continuity, but
       * concrete file refs must arrive through
       * `_injected_files`; agents no longer falls back to
       * `/files/<sid>`. Pair with `[primeCodeFiles]`
       * traces below to locate the layer that lost the ref. */
      logger.warn(
        `[code-env:inject] tool=${tc.name} _injected_files=0 — sandbox will see no input files`,
        {
          tool: tc.name,
          session_id: tc.codeSessionContext.session_id,
          codeSessionContextHasFiles: tc.codeSessionContext.files !== undefined,
          codeSessionContextFileCount: tc.codeSessionContext.files?.length ?? 0,
        },
      );
    }
  }

  return toolCallConfig;
}

/**
 * One-shot handoff of the files a `skill` call uploads to the code calls that
 * share its batch.
 *
 * The graph hands every call in a batch the code-session snapshot it took when
 * it planned the batch, and folds a `skill` call's artifact back into the
 * session only after the whole batch settles. A code call dispatched beside a
 * `skill` call therefore reads a context with none of the skill's bundled
 * files: `_injected_files` omits them and the sandbox has no
 * `/mnt/data/skills/<name>/` for that batch. Waiting here, then merging the
 * uploaded refs into the code call's own context, is what makes the files
 * visible on the turn that loaded them.
 */
interface SkillFilesHandoff {
  /** Records a settled `skill` call; the last one releases every waiter. */
  record(result: ToolExecuteResult): void;
  /** Resolves once every `skill` call in the batch has settled, then merges
   *  their uploaded files into this call's own code-session context. Never
   *  rejects: a skill whose files failed to load contributes nothing and the
   *  waiting call runs with the context it already had. */
  applyTo(tc: ToolCallRequest): Promise<void>;
}

function createSkillFilesHandoff(
  skillToolCallIds: ReadonlySet<string>,
  signal?: AbortSignal,
): SkillFilesHandoff {
  const pendingSkillCallIds = new Set(skillToolCallIds);
  const uploadedFiles: CodeEnvFile[] = [];
  let release!: () => void;
  const settled = new Promise<void>((resolve) => {
    release = resolve;
  });
  /** A Stop ends the turn for every call in the batch, so waiters are released
   *  the moment it lands instead of riding out the upload's own cancellation. */
  const onAbort = (): void => release();
  if (signal?.aborted === true) {
    release();
  } else {
    signal?.addEventListener('abort', onAbort, { once: true });
  }
  return {
    record(result: ToolExecuteResult): void {
      if (!pendingSkillCallIds.delete(result.toolCallId)) {
        return;
      }
      const files =
        result.status === 'success'
          ? (result.artifact as { files?: CodeEnvFile[] } | undefined)?.files
          : undefined;
      if (files && files.length > 0) {
        uploadedFiles.push(...files);
      }
      if (pendingSkillCallIds.size === 0) {
        signal?.removeEventListener('abort', onAbort);
        release();
      }
    },
    async applyTo(tc: ToolCallRequest): Promise<void> {
      await settled;
      /* Same call shape as the provisioned-attachment fold in the executor, so
       * identity (`storage_session_id` + `id`) and destination rules stay
       * consistent. Returns undefined when no skill contributed a file. */
      const merged = mergeCodeFilesIntoContext(
        tc.codeSessionContext as CodeSessionContext | undefined,
        uploadedFiles,
      );
      if (merged) {
        tc.codeSessionContext = merged;
      }
    },
  };
}

function getToolFailureFeedback(content: ToolExecuteResult['content']): string {
  if (typeof content === 'string') return content;
  const messages: string[] = [];
  for (const part of content) {
    if (
      part != null &&
      typeof part === 'object' &&
      'type' in part &&
      part.type === 'text' &&
      'text' in part &&
      typeof part.text === 'string'
    )
      messages.push(part.text);
  }
  return messages.join('\n') || 'Tool execution failed.';
}

export function createToolExecuteHandler(options: ToolExecuteOptions): EventHandler {
  const {
    scheduledMCPExecution,
    runSignal: hostRunSignal,
    foregroundRunId,
    loadTools,
    toolEndCallback,
    attachedCommandStepIds,
    eventActorDetachedAction,
    persistBackgroundCodeResult,
    backgroundToolCompletion,
    emitAttachment,
    emitPtcProgress,
    subagentTasks,
    runFiles,
    ordinaryToolCancellation = false,
    backgroundCompletionResultMaxChars = AGENT_BACKGROUND_COMPLETION_RESULT_MAX_CHARS_DEFAULT,
    provisionFiles,
  } = options;

  return {
    handle: async (_event: string, data: ToolExecuteBatchRequest) => {
      const {
        toolCalls,
        agentId,
        configurable: incomingConfigurable,
        metadata: incomingMetadata,
        signal: eventRunSignal,
        resolve,
        reject,
      } = data;
      const onResultAdmissionStart = (data as InterruptibleToolBatchRequest).onResultAdmissionStart;
      const executionContext = (
        data as ToolExecuteBatchRequest & { executionContext?: SubagentExecutionContext }
      ).executionContext;
      // Only the SDK-owned batch field may establish a child execution. Runtime
      // configurable and callback metadata can otherwise carry inherited values.
      /**
       * Authored-skill identity has to outlive the per-batch copy below, which
       * is what makes a skill created in one batch resolvable in the next.
       * A shallow copy shares object references, so seeding the map on the
       * run's own configurable lets `rememberAuthoredSkill` mutate it in place
       * and later batches observe it, exactly as the shared
       * `accessibleSkillIds` array already crosses batches. A fresh map
       * assigned onto the copy would be discarded with the copy.
       */
      if (incomingConfigurable != null && incomingConfigurable.authoredSkillIdsByName == null) {
        incomingConfigurable.authoredSkillIdsByName = {};
      }
      const configurable: Record<string, unknown> | undefined =
        incomingConfigurable == null ? undefined : { ...incomingConfigurable, executionContext };
      const metadata: Record<string, unknown> | undefined =
        incomingMetadata == null && executionContext == null
          ? undefined
          : { ...incomingMetadata, executionContext };
      let eventRunId: string | undefined;
      if (typeof metadata?.run_id === 'string') {
        eventRunId = metadata.run_id;
      } else if (typeof configurable?.run_id === 'string') {
        eventRunId = configurable.run_id;
      }
      const foregroundHostSignal =
        eventRunId == null || eventRunId === foregroundRunId ? hostRunSignal : undefined;
      const runSignal =
        foregroundHostSignal != null &&
        eventRunSignal != null &&
        foregroundHostSignal !== eventRunSignal
          ? AbortSignal.any([foregroundHostSignal, eventRunSignal])
          : (foregroundHostSignal ?? eventRunSignal);
      const callerCapabilityProjection = resolveCallerCapabilityProjectionSnapshot(
        (
          data as ToolExecuteBatchRequest & {
            callerCapabilityProjection?: unknown;
          }
        ).callerCapabilityProjection,
      );
      /** Optional per-call channel (agents SDK > 3.2.33); cast keeps older
       * installed SDK typings compiling until the release lands. */
      const onResult = (
        data as ToolExecuteBatchRequest & {
          onResult?: (result: ToolExecuteResult) => void;
        }
      ).onResult;
      /** Set only for a batch that mixes `skill` calls with code calls (see
       * {@link createSkillFilesHandoff}); `undefined` leaves every other batch
       * fully concurrent. */
      let skillFilesHandoff: SkillFilesHandoff | undefined;
      /** Reports a settled result so the agent graph can emit that call's
       * completion immediately instead of waiting for the whole batch;
       * `resolve` below remains the authoritative batch outcome. */
      const reportResult = (result: ToolExecuteResult): ToolExecuteResult => {
        /* Every per-call return in the batch funnels through here, so this is
         * the one place that observes a `skill` call settling whatever path
         * produced its result, including the filtered and error paths. */
        skillFilesHandoff?.record(result);
        try {
          onResult?.(result);
        } catch (callbackError) {
          logger.warn('[ON_TOOL_EXECUTE] onResult callback error:', callbackError);
        }
        return result;
      };

      try {
        await runOutsideTracing(async () => {
          try {
            const sourceConfigurable = configurable as Record<string, unknown> | undefined;
            const sourceReq = sourceConfigurable?.req as ServerRequest | undefined;
            const preloadedNameBlocks = new Map<ToolCallRequest, ToolExecuteResult>();
            const allowedToolCalls: ToolCallRequest[] = [];
            for (const tc of toolCalls) {
              const filteredName = filteredToolArgumentsResult(tc, sourceReq, undefined);
              if (filteredName != null) {
                preloadedNameBlocks.set(tc, filteredName);
              } else {
                allowedToolCalls.push(tc);
              }
            }
            if (allowedToolCalls.length === 0) {
              resolve(
                toolCalls.map((tc) =>
                  reportResult(
                    preloadedNameBlocks.get(tc) ??
                      errorResult(tc, 'Submitted tool name was blocked.'),
                  ),
                ),
              );
              return;
            }
            const toolNames = [...new Set(allowedToolCalls.map((tc) => tc.name))];

            const runFileSharingActive = runFiles?.isActive() === true;
            if (runFileSharingActive) {
              if (!agentId) throw new Error('Shared-file tools require an executing agent.');
              await runFiles!.prepareTools(
                agentId,
                executionContext,
                runSignal ?? new AbortController().signal,
                toolNames.some(isFileResourceToolName) ? 'refresh' : 'snapshot',
              );
            }
            const provisionedCodeFiles = provisionFiles
              ? await provisionFiles(toolNames, agentId, runSignal, executionContext)
              : undefined;

            const { loadedTools, configurable: toolConfigurable } = await loadTools(
              toolNames,
              agentId,
              sourceConfigurable,
              callerCapabilityProjection,
              runSignal,
              executionContext,
            );
            const toolMap = new Map(loadedTools.map((t) => [t.name, t]));
            const loadedConfigurable = toolConfigurable as Record<string, unknown> | undefined;
            const mergedConfigurable = mergeToolConfigurables(
              sourceConfigurable,
              loadedConfigurable,
            );
            if (mergedConfigurable != null) mergedConfigurable.executionContext = executionContext;
            /* The graph populated each call's code-session context from the sessions that
             * existed at run start, before this batch provisioned anything, and nothing
             * downstream refreshes it. buildToolCallConfig reads `_injected_files` from
             * that context alone, so without this fold a successful upload still reaches
             * a sandbox that cannot see the file. */
            if (provisionedCodeFiles && provisionedCodeFiles.length > 0) {
              for (const tc of allowedToolCalls) {
                if (
                  !isCodeSessionAwareToolCall(tc.name, mergedConfigurable) &&
                  !(runFileSharingActive && isCodeFileToolName(tc.name))
                ) {
                  continue;
                }
                const merged = mergeCodeFilesIntoContext(
                  tc.codeSessionContext as CodeSessionContext | undefined,
                  provisionedCodeFiles,
                );
                if (merged) {
                  tc.codeSessionContext = merged;
                }
              }
            }

            /* A code call in this batch reads its code-session context when it
             * executes, while the `skill` call beside it is still uploading the
             * files that belong in that context. Only a batch carrying both
             * kinds of call waits; every other batch stays fully concurrent. */
            const waitsForSkillFiles = (tc: ToolCallRequest): boolean =>
              tc.name !== Constants.SKILL_TOOL &&
              (isCodeSessionAwareToolCall(tc.name, mergedConfigurable) ||
                (runFileSharingActive && isCodeFileToolName(tc.name)));
            const skillToolCallIds = new Set(
              allowedToolCalls.filter((tc) => tc.name === Constants.SKILL_TOOL).map((tc) => tc.id),
            );
            if (skillToolCallIds.size > 0 && allowedToolCalls.some(waitsForSkillFiles)) {
              skillFilesHandoff = createSkillFilesHandoff(skillToolCallIds, runSignal);
            }

            const codeExecutionContext = getCodeExecutionContext(mergedConfigurable);
            const runtimeSessionHint = codeExecutionContext?.runtimeSessionHint;
            if (runFileSharingActive && executionContext != null) {
              for (const tc of allowedToolCalls) {
                if (
                  !isCodeSessionAwareToolCall(tc.name, mergedConfigurable) &&
                  !isCodeFileToolName(tc.name)
                )
                  continue;
                if (!runtimeSessionHint || codeExecutionContext?.environmentType === 'attached') {
                  throw new Error('This child execution has no isolated file workspace.');
                }
                // SDK tool configs may still carry a parent's runtime hint. The
                // host prepared this partition using the authorized child identity.
                tc.runtimeSessionHint = runtimeSessionHint;
              }
            }
            const executionRouteKey =
              codeExecutionContext?.executionRouteKey ?? codeExecutionContext?.executionProfile;
            const sandboxConversationId =
              ((metadata as Record<string, unknown>)?.thread_id as string | undefined) ??
              (mergedConfigurable?.thread_id as string | undefined) ??
              (
                (mergedConfigurable?.req as ServerRequest | undefined)?.body as
                  | { conversationId?: string }
                  | undefined
              )?.conversationId;
            const markCodeSandboxWarm = (): void => {
              if (runtimeSessionHint) {
                void markSandboxReady(runtimeSessionHint, executionRouteKey);
              }
              if (sandboxConversationId) {
                void markSandboxReady(sandboxConversationId);
              }
            };
            /** Provenance is the resolved tool instance, never the output. */
            const recordAttachedCommand = (tc: ToolCallRequest, tool: unknown): void => {
              if (tc.stepId && isAttachedWorkspaceBashTool(tool)) {
                attachedCommandStepIds?.add(tc.stepId);
              }
            };
            const authoringQueues = new Map<string, Promise<void>>();
            const sandboxAuthoringContexts = new Map<string, SandboxSessionContext>();

            /**
             * Background tool calls. The set of tools that received the injected
             * `run_in_background` param is threaded per-agent from `initializeAgent`
             * via `configurable.backgroundToolNames` (a reliable channel, unlike
             * `toolRegistry` which only reaches the executor for PTC/tool_search).
             * A non-empty set is the exact condition under which the run registered
             * the poll tool and the model could have been shown the param, so it
             * also gates the `check_background_task` interception and enforces the
             * per-tool opt-in (a tool not in the set never had the param).
             */
            const backgroundToolNames = mergedConfigurable?.backgroundToolNames as
              | string[]
              | undefined;
            const backgroundEnabledForRun = (backgroundToolNames?.length ?? 0) > 0;
            const backgroundControlEnabled = backgroundEnabledForRun || subagentTasks != null;
            const backgroundToolSet: ReadonlySet<string> = backgroundEnabledForRun
              ? new Set(backgroundToolNames)
              : EMPTY_BACKGROUND_TOOL_SET;
            const backgroundReq = backgroundControlEnabled
              ? (mergedConfigurable?.req as ServerRequest | undefined)
              : undefined;
            const backgroundUserId = backgroundControlEnabled
              ? resolveBackgroundUserId(mergedConfigurable)
              : '';
            const backgroundConversationId = backgroundControlEnabled
              ? (((metadata as Record<string, unknown>)?.thread_id as string | undefined) ??
                (mergedConfigurable?.thread_id as string | undefined) ??
                (backgroundReq?.body as { conversationId?: string } | undefined)?.conversationId ??
                '')
              : '';

            /**
             * Registers the task, returns a synthetic handle immediately, and
             * runs the real tool as a floating promise whose result lands in the
             * registry for `check_background_task` to collect. Idempotent by
             * `toolCallId` so graph re-execution (resume/replay) never double-fires.
             */
            const backgroundRunId = (metadata as Record<string, unknown>)?.run_id as
              | string
              | undefined;
            const dispatchBackgroundToolCall = async (
              tc: ToolCallRequest,
            ): Promise<ToolExecuteResult> => {
              /** A tool that failed to load must error immediately (matching the
               *  foreground path) — a synthetic "started" handle would tell the
               *  model a side effect is in flight that never executed. */
              const tool = toolMap.get(tc.name);
              if (!tool) {
                const missingToolResult: ToolExecuteResult = {
                  toolCallId: tc.id,
                  status: 'error' as const,
                  content: '',
                  errorMessage: `Tool ${tc.name} not found`,
                };
                return (
                  filteredToolOutputResult(tc, backgroundReq, {
                    errorMessage: missingToolResult.errorMessage,
                  }) ?? missingToolResult
                );
              }
              recordAttachedCommand(tc, tool);
              const isCodeCall = isCodeSessionAwareToolCall(tc.name, mergedConfigurable);
              const harvestEnabled = isCodeCall && persistBackgroundCodeResult != null;
              const liveArtifactPollRequired =
                !harvestEnabled &&
                (tool as StructuredToolInterface & { responseFormat?: unknown }).responseFormat ===
                  Constants.CONTENT_AND_ARTIFACT;
              const backgroundStepId =
                typeof tc.stepId === 'string' && tc.stepId.trim() !== '' ? tc.stepId : undefined;
              const strippedArgs = stripIntentForInvoke(stripRunInBackgroundArg(tc.args), tool);
              const normalizedArgs = normalizeToolInvokeArgs(strippedArgs, tool);
              const filtered = filteredToolArgumentsResult(tc, backgroundReq, normalizedArgs);
              if (filtered != null) {
                return filtered;
              }
              const registration = {
                userId: backgroundUserId,
                conversationId: backgroundConversationId,
                toolCallId: tc.id,
                stepId: backgroundStepId,
                toolName: tc.name,
                messageId: backgroundRunId,
                harvestStarted: harvestEnabled,
                liveArtifactPollRequired,
                /** Scope idempotency to the agent + run + turn so a later turn's
                 *  or a second agent's repeated provider id (e.g. `call_0`)
                 *  starts a fresh task instead of colliding. */
                agentId,
                runId: `${backgroundRunId ?? ''}:${tc.turn ?? backgroundStepId ?? ''}`,
              };
              const capacityAdmission =
                eventActorDetachedAction == null
                  ? undefined
                  : backgroundTaskRegistry.reserveCapacity(registration);
              if (capacityAdmission != null && 'atCapacity' in capacityAdmission) {
                return {
                  toolCallId: tc.id,
                  status: 'success' as const,
                  content: buildBackgroundCapacityContent(tc.name, capacityAdmission.scope),
                };
              }
              const capacityPermit =
                capacityAdmission != null && 'permit' in capacityAdmission
                  ? capacityAdmission.permit
                  : undefined;
              let detachedReservation;
              try {
                detachedReservation = await eventActorDetachedAction?.reserve({
                  toolName: tc.name,
                  toolCallId: tc.id,
                  turnId: registration.runId,
                  arguments: normalizedArgs,
                });
              } catch (error) {
                if (capacityPermit != null) {
                  backgroundTaskRegistry.releaseCapacity(capacityPermit);
                }
                throw error;
              }
              if (detachedReservation?.status === 'conflict') {
                if (capacityPermit != null) {
                  backgroundTaskRegistry.releaseCapacity(capacityPermit);
                }
                return {
                  toolCallId: tc.id,
                  status: 'error' as const,
                  content: '',
                  errorMessage:
                    detachedReservation.error ??
                    'Detached Event Actor action conflicts with its durable launch authority',
                };
              }
              if (detachedReservation?.status === 'terminal') {
                if (capacityPermit != null) {
                  backgroundTaskRegistry.releaseCapacity(capacityPermit);
                }
                if (detachedReservation.outcome === 'succeeded') {
                  return {
                    toolCallId: tc.id,
                    status: 'success' as const,
                    content: detachedReservation.result ?? '',
                  };
                }
                return {
                  toolCallId: tc.id,
                  status: 'error' as const,
                  content: '',
                  errorMessage:
                    detachedReservation.error ?? `Detached action ${detachedReservation.outcome}`,
                };
              }
              if (detachedReservation?.status === 'replay') {
                if (capacityPermit != null) {
                  backgroundTaskRegistry.releaseCapacity(capacityPermit);
                }
                return {
                  toolCallId: tc.id,
                  status: 'success' as const,
                  content: buildBackgroundHandleContent({
                    id: detachedReservation.taskId,
                    toolName: tc.name,
                    status: 'running',
                  }),
                };
              }
              const backgroundAbortController = new AbortController();
              let backgroundAbortSource: 'manual' | 'timeout' | 'shutdown' | undefined;
              const created = backgroundTaskRegistry.create({
                ...(detachedReservation?.status === 'reserved'
                  ? { taskId: detachedReservation.taskId }
                  : {}),
                ...registration,
                ...(capacityPermit == null ? {} : { capacityPermit }),
                requestCancellation: () => {
                  if (backgroundAbortSource != null || backgroundAbortController.signal.aborted) {
                    return false;
                  }
                  backgroundAbortSource = 'manual';
                  backgroundAbortController.abort(
                    new DOMException('Background task cancellation requested', 'AbortError'),
                  );
                  return true;
                },
              });
              if ('atCapacity' in created) {
                if (detachedReservation?.status === 'reserved') {
                  throw new Error('Detached Event Actor lost its pre-admitted background capacity');
                }
                return {
                  toolCallId: tc.id,
                  status: 'success' as const,
                  content: buildBackgroundCapacityContent(tc.name, created.scope),
                };
              }
              const { task, isNew } = created;
              let completionPreregistered = task.completionWakeup === true;
              let completionAdmission: BackgroundToolWakeupAdmission | undefined;
              if (isNew) {
                if (
                  detachedReservation?.status !== 'reserved' &&
                  backgroundToolCompletion?.preregister != null &&
                  backgroundStepId != null &&
                  backgroundRunId != null &&
                  backgroundRunId !== ''
                ) {
                  try {
                    const admission = await backgroundToolCompletion.preregister({
                      scheduleMCPIdentity: scheduledMCPExecution?.identity ?? null,
                      taskId: task.id,
                      toolCallId: tc.id,
                      toolName: tc.name,
                      userId: backgroundUserId,
                      ...(typeof backgroundReq?.user?.tenantId === 'string' &&
                      backgroundReq.user.tenantId !== ''
                        ? { tenantId: backgroundReq.user.tenantId }
                        : {}),
                      conversationId: backgroundConversationId,
                      parentMessageId: backgroundRunId,
                      parentAgentId: agentId,
                      createdAt: task.createdAt,
                    });
                    if (admission !== false) {
                      completionAdmission = admission;
                      completionPreregistered = true;
                      backgroundTaskRegistry.markCompletionWakeup(
                        backgroundUserId,
                        backgroundConversationId,
                        task.id,
                        admission,
                      );
                    }
                  } catch (registrationError) {
                    logger.warn(
                      `[background] Failed to preregister completion for task ${task.id}; polling remains available.`,
                      registrationError,
                    );
                  }
                }
                let durableReceiptWrite: Promise<boolean> | undefined;
                let durableReceiptAmbiguous = false;
                let durableResultConfirmed = false;
                let forcedShutdownResult = false;
                let resolveDurableReceipt: () => void = () => undefined;
                const durableReceiptSettled = new Promise<void>((resolve) => {
                  resolveDurableReceipt = resolve;
                });
                const confirmDurableResult = (): void => {
                  durableResultConfirmed = true;
                  resolveDurableReceipt();
                };
                /** One durable receipt per task. The task's own settlement and a
                 *  shutdown flush share the first write, so neither can retire or
                 *  contradict a receipt the other already stored. */
                const writeDurableReceipt = (receipt: {
                  status: 'completed' | 'error' | 'cancelled';
                  output?: string;
                  settledAt: Date;
                }): Promise<boolean> => {
                  if (durableReceiptWrite != null) {
                    return durableReceiptWrite;
                  }
                  durableReceiptWrite = (async (): Promise<boolean> => {
                    if (completionAdmission?.persistResult == null) {
                      return false;
                    }
                    try {
                      return await completionAdmission.persistResult({
                        status: receipt.status,
                        output: truncateMiddle(
                          receipt.output ?? '',
                          backgroundCompletionResultMaxChars,
                        ),
                        settledAt: receipt.settledAt,
                      });
                    } catch (receiptError) {
                      durableReceiptAmbiguous = true;
                      logger.warn(
                        `[background] Failed to persist independent result receipt for task ${task.id}:`,
                        receiptError,
                      );
                      return false;
                    }
                  })();
                  void durableReceiptWrite.then((written) => {
                    if (written) {
                      confirmDurableResult();
                    }
                  });
                  return durableReceiptWrite;
                };
                /** The task's own terminal result, recorded before its (possibly slow)
                 *  persistence starts, so a shutdown flush can store it durably. */
                let settledReceipt:
                  | { status: 'completed' | 'error' | 'cancelled'; output?: string }
                  | undefined;
                /** Persists the settled result onto the dispatch turn's message
                 *  (patch the tool-call part's output, persist generated files,
                 *  append attachments), so a backgrounded code call reads like a
                 *  foreground one on reload and in later model turns — even if
                 *  the model never polls. Runs DETACHED from task completion:
                 *  the dispatch row may not exist until that turn finalizes, so
                 *  gating `complete()` on the patch would livelock same-turn
                 *  polls on `running`. Failures degrade to poll-only delivery. */
                const persistBackgroundResult = async (params: {
                  output?: string;
                  artifact?: unknown;
                  status: 'completed' | 'error' | 'cancelled';
                }): Promise<void> => {
                  /** A provider id alone is not a durable part identity: it may
                   * repeat in later turns of the same response. New automatic
                   * completion delivery therefore fails closed to the legacy
                   * poll path when the host run-step anchor is unavailable. */
                  if (
                    detachedReservation?.status !== 'reserved' &&
                    backgroundToolCompletion != null &&
                    backgroundStepId == null &&
                    !harvestEnabled
                  ) {
                    return;
                  }
                  const resolveBackgroundTask = (): BackgroundToolResultState => {
                    const current = backgroundTaskRegistry.get(
                      backgroundUserId,
                      backgroundConversationId,
                      task.id,
                    );
                    return {
                      taskId: task.id,
                      toolName: tc.name,
                      status: params.status === 'cancelled' ? 'error' : params.status,
                      ...(params.status === 'cancelled' ? { cancelled: true } : {}),
                      settledAt: new Date(current?.updatedAt ?? Date.now()),
                      ...(completionPreregistered ? { completionWakeup: true } : {}),
                      ...(completionAdmission?.persistResult != null
                        ? { completionReceipt: true }
                        : {}),
                      ...(current?.resultClaim != null
                        ? {
                            resultClaim: {
                              kind: current.resultClaim.kind,
                              claimId: current.resultClaim.claimId,
                              claimedAt: new Date(current.resultClaim.claimedAt),
                              ...(current.resultClaim.receiptReconciled === true && {
                                receiptReconciled: true,
                              }),
                              ...(current.resultClaim.generationId == null
                                ? {}
                                : { generationId: current.resultClaim.generationId }),
                            },
                          }
                        : {}),
                    };
                  };
                  const localTask = backgroundTaskRegistry.get(
                    backgroundUserId,
                    backgroundConversationId,
                    task.id,
                  );
                  const backgroundTask = resolveBackgroundTask();
                  let durableReceiptReady = false;
                  const persistDurableReceipt = (receipt: {
                    status: 'completed' | 'error' | 'cancelled';
                    output?: string;
                  }): Promise<boolean> =>
                    writeDurableReceipt({ ...receipt, settledAt: backgroundTask.settledAt });
                  const retireFailedPersistence = async (
                    reason: string,
                    certainty: 'definite' | 'ambiguous',
                  ): Promise<void> => {
                    /** Never retire a delivery that already holds a durable receipt,
                     *  including one a shutdown flush stored ahead of this path. */
                    if (durableReceiptAmbiguous || (await durableReceiptWrite) === true) {
                      return;
                    }
                    if (completionAdmission == null) {
                      backgroundTaskRegistry.markCompletionPersistenceFailed(
                        backgroundUserId,
                        backgroundConversationId,
                        task.id,
                      );
                      return;
                    }
                    try {
                      /** A thrown write receipt is ambiguous: Mongo may have
                       * applied it before the response was lost, so only an
                       * unclaimed delivery may fall back. A returned `false`
                       * proves no terminal row was anchored and may retire a
                       * live deferring lease before it dead-letters forever. */
                      const retired = await completionAdmission.retire(
                        reason,
                        certainty === 'ambiguous' ? { onlyIfUnclaimed: true } : undefined,
                      );
                      if (!retired) {
                        const current = backgroundTaskRegistry.get(
                          backgroundUserId,
                          backgroundConversationId,
                          task.id,
                        );
                        /** A prior manual poll may already have durably retired
                         * this exact unclaimed delivery. In that case there is
                         * no automatic consumer left to race the process-local
                         * fallback, even though a second retirement is a no-op. */
                        if (current?.completionWakeupRetired === true) {
                          backgroundTaskRegistry.markCompletionPersistenceFailed(
                            backgroundUserId,
                            backgroundConversationId,
                            task.id,
                          );
                          return;
                        }
                        logger.warn(
                          `[background] Could not retire failed completion delivery for task ${task.id}.`,
                        );
                        return;
                      }
                      backgroundTaskRegistry.markCompletionPersistenceFailed(
                        backgroundUserId,
                        backgroundConversationId,
                        task.id,
                      );
                    } catch (retireError) {
                      logger.warn(
                        `[background] Failed to retire completion delivery for task ${task.id}:`,
                        retireError,
                      );
                    }
                  };
                  if (!harvestEnabled || !persistBackgroundCodeResult) {
                    durableReceiptReady = await persistDurableReceipt({
                      status: params.status,
                      output: params.output ?? localTask?.result,
                    });
                    if (
                      backgroundToolCompletion == null ||
                      detachedReservation?.status === 'reserved'
                    ) {
                      return;
                    }
                    try {
                      const deliveryReady = await backgroundToolCompletion.persist({
                        toolName: tc.name,
                        toolCallId: tc.id,
                        stepId: backgroundStepId,
                        messageId: backgroundRunId,
                        conversationId: backgroundConversationId,
                        agentId,
                        output: params.output ?? localTask?.result,
                        backgroundTask,
                        resolveBackgroundTask,
                      });
                      if (!deliveryReady && !durableReceiptReady) {
                        await retireFailedPersistence(
                          'background tool result was not persisted',
                          'definite',
                        );
                      } else if (deliveryReady && !durableReceiptReady) {
                        confirmDurableResult();
                        completionAdmission?.expedite?.();
                      }
                    } catch (persistError) {
                      if (!durableReceiptReady) {
                        await retireFailedPersistence(
                          'background tool result persistence failed',
                          isContentFilterError(persistError) ? 'definite' : 'ambiguous',
                        );
                      }
                      logger.warn(
                        `[background] Failed to persist result for task ${task.id}:`,
                        persistError,
                      );
                    }
                    return;
                  }
                  try {
                    const persisted = await persistBackgroundCodeResult({
                      toolName: tc.name,
                      toolCallId: tc.id,
                      stepId: backgroundStepId,
                      messageId: backgroundRunId,
                      conversationId: backgroundConversationId,
                      /** Disambiguates repeated provider ids (e.g. `call_0`)
                       *  across agents sharing one response message. */
                      agentId,
                      /** Stale-output ordering is decided by DISPATCH order,
                       *  not harvest wall-clock: a slow old task settling
                       *  after a newer run wrote the same filename must not
                       *  overwrite it. */
                      dispatchedAt: task.createdAt,
                      codeExecutionContext,
                      ...(detachedReservation?.status === 'reserved' ||
                      (!completionPreregistered && params.status !== 'cancelled')
                        ? {}
                        : { backgroundTask, resolveBackgroundTask }),
                      output: params.output ?? localTask?.result,
                      artifact: params.artifact,
                      onFilesPersisted: (attachments) =>
                        backgroundTaskRegistry.finishHarvest(
                          backgroundUserId,
                          backgroundConversationId,
                          task.id,
                          attachments,
                        ),
                    });
                    if (persisted == null) {
                      /** Harvest never persisted anything (missing anchor
                       *  identity): hand delivery back to the legacy poll-turn
                       *  callback, restoring the artifact if a poll already
                       *  claimed it while the harvest was in flight. */
                      backgroundTaskRegistry.revokeHarvest(
                        backgroundUserId,
                        backgroundConversationId,
                        task.id,
                        params.artifact,
                      );
                      if (completionPreregistered && !durableReceiptReady) {
                        await retireFailedPersistence(
                          'background code result had no durable message anchor',
                          'definite',
                        );
                      }
                      return;
                    }
                    if (persisted.deliveryReady !== false) {
                      durableReceiptReady = await persistDurableReceipt({
                        status: params.status,
                        output: params.output ?? localTask?.result,
                      });
                    }
                    if (persisted.deliveryReady !== false) {
                      confirmDurableResult();
                    }
                    if (persisted.deliveryReady === false) {
                      await retireFailedPersistence(
                        'background code result was not persisted',
                        'definite',
                      );
                    }
                    backgroundTaskRegistry.finishHarvest(
                      backgroundUserId,
                      backgroundConversationId,
                      task.id,
                      persisted.attachments,
                    );
                  } catch (persistError) {
                    if (isContentFilterError(persistError)) {
                      const blockedMessage =
                        persistError instanceof ContentFilterError
                          ? modelBoundContentFilterErrorMessage(persistError.body)
                          : persistError.body.message;
                      backgroundTaskRegistry.blockArtifact(
                        backgroundUserId,
                        backgroundConversationId,
                        task.id,
                        blockedMessage,
                      );
                      durableReceiptReady = await persistDurableReceipt({
                        status: 'error',
                        output: blockedMessage,
                      });
                      if (completionPreregistered && !durableReceiptReady) {
                        await retireFailedPersistence(
                          'background code result was blocked by content policy',
                          'definite',
                        );
                      }
                      logger.warn(
                        `[background] Generated code output for task ${task.id} was blocked by content policy.`,
                      );
                      return;
                    }
                    if (completionPreregistered && !durableReceiptReady) {
                      await retireFailedPersistence(
                        'background code result persistence failed',
                        'ambiguous',
                      );
                    }
                    logger.warn(
                      `[background] Failed to persist code result for task ${task.id}:`,
                      persistError,
                    );
                    backgroundTaskRegistry.revokeHarvest(
                      backgroundUserId,
                      backgroundConversationId,
                      task.id,
                      params.artifact,
                    );
                  }
                };
                const persistSettledBackgroundResult = async (
                  params: {
                    output?: string;
                    artifact?: unknown;
                    status: 'completed' | 'error' | 'cancelled';
                  },
                  forced = false,
                ): Promise<void> => {
                  if (forcedShutdownResult && !forced) {
                    return;
                  }
                  settledReceipt = { status: params.status, output: params.output };
                  /** Held for the whole persist, including a code harvest that waits for
                   *  a long dispatch turn, so retention pressure cannot evict the task. */
                  backgroundTaskRegistry.markCompletionPersistencePending(
                    backgroundUserId,
                    backgroundConversationId,
                    task.id,
                  );
                  try {
                    await persistBackgroundResult(params);
                  } finally {
                    backgroundTaskRegistry.markCompletionPersistenceFinished(
                      backgroundUserId,
                      backgroundConversationId,
                      task.id,
                    );
                  }
                };
                const approvalDispatch = {
                  agentId,
                  toolCallId: tc.id,
                  executionScope: getToolApprovalExecutionScope(executionContext),
                  background: true,
                };
                noteToolApprovalDispatch(approvalDispatch);
                let invokePromise: Promise<{ content?: unknown; artifact?: unknown }>;
                try {
                  invokePromise = Promise.resolve(
                    tool.invoke(normalizedArgs, {
                      /** Full invoke config (not just identity): a detached
                       *  code call still needs `session_id`/`_injected_files`/
                       *  `_runtime_session_hint` or it runs fileless on the
                       *  Code API's default runtime session. */
                      toolCall: buildToolCallConfig(tc, mergedConfigurable),
                      signal: backgroundAbortController.signal,
                      configurable: {
                        ...mergedConfigurable,
                        [BACKGROUND_TOOL_INVOCATION_CONFIG_KEY]: true,
                        ...(detachedReservation?.status === 'reserved'
                          ? {
                              eventActorDetachedAction: {
                                taskId: detachedReservation.taskId,
                                idempotencyKey: detachedReservation.idempotencyKey,
                              },
                            }
                          : {}),
                      },
                      metadata: bindToolApprovalInvocation(
                        { ...metadata, executingAgentId: agentId },
                        approvalDispatch,
                      ),
                    } as Record<string, unknown>),
                  ) as Promise<{ content?: unknown; artifact?: unknown }>;
                } catch (error) {
                  /** Structured tools are permitted to reject synchronously.
                   * Preserve the durable reservation and route that rejection
                   * through the same terminal-evidence path as an async one. */
                  invokePromise = Promise.reject(error);
                }
                invokePromise = invokePromise.finally(() =>
                  finishToolApprovalDispatch(approvalDispatch),
                );
                const persistDetachedTerminal = async (
                  input:
                    | { status: 'succeeded'; result: unknown }
                    | { status: 'failed' | 'cancelled'; error: string },
                ): Promise<boolean> => {
                  if (
                    detachedReservation?.status !== 'reserved' ||
                    eventActorDetachedAction == null
                  ) {
                    return true;
                  }
                  return eventActorDetachedAction.settle({
                    taskId: detachedReservation.taskId,
                    idempotencyKey: detachedReservation.idempotencyKey,
                    ...input,
                  });
                };
                const wakeDetachedActor = async (): Promise<void> => {
                  if (
                    detachedReservation?.status !== 'reserved' ||
                    eventActorDetachedAction == null
                  ) {
                    return;
                  }
                  try {
                    await eventActorDetachedAction.wake({
                      taskId: detachedReservation.taskId,
                      idempotencyKey: detachedReservation.idempotencyKey,
                    });
                  } catch (wakeError) {
                    logger.warn(
                      `[event-actor] Failed to wake detached action ${detachedReservation.taskId}`,
                      wakeError,
                    );
                  }
                };
                let producerHeartbeatInFlight: Promise<void> | undefined;
                let producerHeartbeatStopped = false;
                const producerAdmission = completionAdmission;
                const producerHeartbeat =
                  producerAdmission == null
                    ? undefined
                    : setInterval(() => {
                        if (producerHeartbeatStopped) {
                          return;
                        }
                        if (producerHeartbeatInFlight != null) {
                          return;
                        }
                        producerHeartbeatInFlight = producerAdmission
                          .renew()
                          .then((renewed) => {
                            if (!renewed) {
                              producerHeartbeatStopped = true;
                              if (producerHeartbeat != null) {
                                clearInterval(producerHeartbeat);
                              }
                              logger.warn(
                                `[background] Completion producer lease was not renewed for task ${task.id}.`,
                              );
                            }
                          })
                          .catch((heartbeatError) => {
                            logger.warn(
                              `[background] Failed to renew completion producer lease for task ${task.id}:`,
                              heartbeatError,
                            );
                          })
                          .finally(() => {
                            producerHeartbeatInFlight = undefined;
                          });
                      }, BACKGROUND_TOOL_PRODUCER_HEARTBEAT_MS);
                (producerHeartbeat as { unref?: () => void } | undefined)?.unref?.();
                const stopProducerHeartbeat = async (retireReason?: string): Promise<void> => {
                  if (!producerHeartbeatStopped) {
                    producerHeartbeatStopped = true;
                    if (producerHeartbeat != null) {
                      clearInterval(producerHeartbeat);
                    }
                  }
                  await producerHeartbeatInFlight;
                  if (retireReason == null || producerAdmission == null) {
                    return;
                  }
                  try {
                    const retired = await producerAdmission.retire(retireReason, {
                      onlyIfUnclaimed: true,
                    });
                    if (!retired) {
                      logger.warn(
                        `[background] Could not retire timed-out completion delivery for task ${task.id}.`,
                      );
                    }
                  } catch (retireError) {
                    logger.warn(
                      `[background] Failed to retire timed-out completion delivery for task ${task.id}:`,
                      retireError,
                    );
                  }
                };
                let producerRetirementTimeout: ReturnType<typeof setTimeout> | undefined;
                const requestBackgroundAbort = (): void => {
                  backgroundAbortSource ??= 'timeout';
                  backgroundAbortController.abort(
                    new DOMException('Background task timed out', 'AbortError'),
                  );
                  producerRetirementTimeout = setTimeout(() => {
                    producerRetirementTimeout = undefined;
                    void stopProducerHeartbeat(
                      'background task did not settle after its abort grace period',
                    );
                  }, BACKGROUND_TASK_ABORT_GRACE_MS);
                  producerRetirementTimeout.unref?.();
                };
                const settlement = (async () => {
                  try {
                    const result = await withBackgroundTaskTimeout(
                      invokePromise,
                      requestBackgroundAbort,
                    );
                    if (isCodeCall) {
                      markCodeSandboxWarm();
                    }
                    const content =
                      isCodeCall && typeof result.content === 'string'
                        ? cleanCodeToolOutput(result.content)
                        : result.content;
                    const filteredOutput = filteredToolOutputResult(tc, backgroundReq, {
                      content,
                      artifact: result.artifact,
                    });
                    if (filteredOutput != null) {
                      const policyError =
                        filteredOutput.errorMessage ?? 'Submitted content was blocked.';
                      const errorOutput = toBackgroundToolFailure(tc.name, policyError);
                      const registryError = isCodeCall ? errorOutput : policyError;
                      if (
                        !(await persistDetachedTerminal({
                          status: 'succeeded',
                          result: registryError,
                        }))
                      ) {
                        return;
                      }
                      backgroundTaskRegistry.fail(
                        backgroundUserId,
                        backgroundConversationId,
                        task.id,
                        registryError,
                        { harvestStarted: harvestEnabled },
                      );
                      await persistSettledBackgroundResult({
                        output: errorOutput,
                        status: 'error',
                      });
                      await wakeDetachedActor();
                      return;
                    }
                    /** Hold any artifact (images, files, UI resources,
                     *  citations) on the task instead of routing it through
                     *  this dispatch turn's callback: a slow background call
                     *  resolves after the turn finalized, when its
                     *  artifactPromises are already awaited and the stream is
                     *  closed, so that push would be silently dropped. The poll
                     *  turn delivers it live in `check_background_task`. */
                    if (
                      !(await persistDetachedTerminal({
                        status: 'succeeded',
                        result: content,
                      }))
                    ) {
                      return;
                    }
                    if (result.artifact != null && !harvestEnabled && completionAdmission != null) {
                      /** Eligibility is decided from the actual result, not the
                       * tool's declared response format. A content-only result
                       * from a content-and-artifact tool can wake normally; an
                       * actual artifact still needs the live poll callback. */
                      try {
                        const retired = await completionAdmission.retire(
                          'background tool artifact requires live polling',
                        );
                        if (!retired) {
                          logger.warn(
                            `[background] Could not retire artifact wakeup for task ${task.id}.`,
                          );
                        }
                      } catch (retireError) {
                        logger.warn(
                          `[background] Failed to retire artifact wakeup for task ${task.id}:`,
                          retireError,
                        );
                      } finally {
                        /** Never publish an eligibility marker for an artifact
                         * the continuation cannot reconstruct. An ambiguous
                         * retire receipt therefore fails closed to polling; any
                         * surviving delivery expires with the producer lease. */
                        completionPreregistered = false;
                        backgroundTaskRegistry.markCompletionPersistenceFailed(
                          backgroundUserId,
                          backgroundConversationId,
                          task.id,
                        );
                      }
                    }
                    const storedContent = backgroundTaskRegistry.complete(
                      backgroundUserId,
                      backgroundConversationId,
                      task.id,
                      { content, artifact: result.artifact, harvestStarted: harvestEnabled },
                    );
                    await persistSettledBackgroundResult({
                      /** Use the registry's canonical bounded serialization so
                       * structured content cannot leave the durable card on its
                       * synthetic running handle. */
                      output: storedContent,
                      artifact: result.artifact,
                      status: 'completed',
                    });
                    await wakeDetachedActor();
                  } catch (toolError) {
                    const policyError =
                      toolError instanceof ContentFilterError
                        ? modelBoundContentFilterErrorMessage(toolError.body)
                        : null;
                    const { message, logContext } = getSafeToolError(
                      toolError,
                      toolValidationFeedback(
                        toolError,
                        tc.name,
                        tool.schema,
                        normalizedArgs,
                        backgroundControlEnabled,
                      ),
                    );
                    /** Tools report an abort in their own words; a shutdown interrupt
                     *  tells the agent why it happened and that it may retry. */
                    const errorOutput =
                      backgroundAbortSource === 'shutdown'
                        ? BACKGROUND_TASK_SHUTDOWN_MESSAGE
                        : (policyError ?? message);
                    const filteredError =
                      policyError == null
                        ? filteredToolOutputResult(tc, backgroundReq, {
                            errorMessage: errorOutput,
                            upstreamBody:
                              toolError instanceof WorkspaceToolHttpError
                                ? toolError.upstreamBody
                                : undefined,
                          })
                        : null;
                    const neutralizedError = filteredError?.errorMessage ?? errorOutput;
                    if (policyError == null && filteredError == null) {
                      logger.debug('[background] Tool failed', {
                        ...logContext,
                        toolName: tc.name,
                        toolCallId: tc.id,
                        backgroundTaskId: task.id,
                      });
                    }
                    const deliveredError = toBackgroundToolFailure(tc.name, neutralizedError);
                    const registryError = isCodeCall ? deliveredError : neutralizedError;
                    /** Only an owner-authorized request is cancellation evidence.
                     * Providers and timeout controllers also use AbortError, so
                     * classifying by error shape would turn failures into a false
                     * claim that the owner cancelled the task. */
                    const detachedTerminalStatus =
                      backgroundAbortSource === 'manual' ? 'cancelled' : 'failed';
                    if (
                      !(await persistDetachedTerminal({
                        status: detachedTerminalStatus,
                        error: registryError,
                      }))
                    ) {
                      return;
                    }
                    const settleOptions = { harvestStarted: harvestEnabled };
                    if (detachedTerminalStatus === 'cancelled') {
                      backgroundTaskRegistry.cancel(
                        backgroundUserId,
                        backgroundConversationId,
                        task.id,
                        registryError,
                        settleOptions,
                      );
                    } else {
                      backgroundTaskRegistry.fail(
                        backgroundUserId,
                        backgroundConversationId,
                        task.id,
                        registryError,
                        /** Failed code tasks join the heal path too: without this,
                         *  a full-row save reverting the error patch would leave
                         *  the dispatch card on the handle JSON forever. */
                        settleOptions,
                      );
                    }
                    await persistSettledBackgroundResult({
                      output: deliveredError,
                      status: detachedTerminalStatus === 'cancelled' ? 'cancelled' : 'error',
                    });
                    await wakeDetachedActor();
                  } finally {
                    if (producerRetirementTimeout != null) {
                      clearTimeout(producerRetirementTimeout);
                    }
                    await stopProducerHeartbeat();
                  }
                })();
                void settlement.then(
                  () => {
                    if (completionAdmission == null || !completionPreregistered) {
                      resolveDurableReceipt();
                    }
                  },
                  () => undefined,
                );
                backgroundTaskRegistry.trackShutdown(task, {
                  settled: durableReceiptSettled,
                  interrupt: (reason) => {
                    if (backgroundAbortSource != null || backgroundAbortController.signal.aborted) {
                      return;
                    }
                    backgroundAbortSource = 'shutdown';
                    backgroundAbortController.abort(new DOMException(reason, 'AbortError'));
                  },
                  flush: async (reason) => {
                    await stopProducerHeartbeat();
                    if (durableReceiptWrite != null) {
                      await durableReceiptWrite;
                    } else if (settledReceipt != null) {
                      await writeDurableReceipt({ ...settledReceipt, settledAt: new Date() });
                    } else {
                      forcedShutdownResult = true;
                      const failure = toBackgroundToolFailure(tc.name, reason);
                      backgroundTaskRegistry.fail(
                        backgroundUserId,
                        backgroundConversationId,
                        task.id,
                        isCodeCall ? failure : reason,
                        { harvestStarted: harvestEnabled },
                      );
                      try {
                        await persistDetachedTerminal({ status: 'failed', error: failure });
                      } catch (detachedError) {
                        logger.warn(
                          `[background] Failed to settle detached action for interrupted task ${task.id}:`,
                          detachedError,
                        );
                      }
                      if (completionAdmission?.persistResult != null) {
                        await writeDurableReceipt({
                          status: 'error',
                          output: failure,
                          settledAt: new Date(),
                        });
                      } else if (completionAdmission != null) {
                        await persistSettledBackgroundResult(
                          { status: 'error', output: failure },
                          true,
                        );
                      }
                    }
                    if (durableResultConfirmed || completionAdmission == null) {
                      return;
                    }
                    if (settledReceipt != null && !forcedShutdownResult) {
                      await settlement;
                      if (durableResultConfirmed) {
                        return;
                      }
                    }
                    if (completionPreregistered) {
                      throw new Error(`Background task ${task.id} has no durable shutdown result`);
                    }
                  },
                });
                if (
                  detachedReservation?.status === 'reserved' &&
                  eventActorDetachedAction != null &&
                  !(await eventActorDetachedAction.markRunning({
                    taskId: detachedReservation.taskId,
                    idempotencyKey: detachedReservation.idempotencyKey,
                  }))
                ) {
                  throw new Error('Detached Event Actor launch acknowledgement is stale');
                }
              }
              return {
                toolCallId: tc.id,
                status: 'success' as const,
                content: buildBackgroundHandleContent(task, {
                  completionWakeup: completionPreregistered,
                  liveArtifactPollRequired,
                }),
              };
            };

            const batchReq = mergedConfigurable?.req as ServerRequest | undefined;
            const batchCodeApiRateLimitBudget = createCodeApiRateLimitBudget(
              batchReq?.config?.endpoints?.agents?.codeApiMaxRetryWaitMs,
            );
            const results: ToolExecuteResult[] = await Promise.all(
              toolCalls.map(async (tc: ToolCallRequest) => {
                const preloadedNameBlock = preloadedNameBlocks.get(tc);
                if (preloadedNameBlock != null) {
                  return reportResult(preloadedNameBlock);
                }
                /** Tool names are user/model-submitted content too. Check them
                 *  before lookup so an unknown blocked name cannot reach logs
                 *  or error history. Arguments are inspected after the tool
                 *  schema normalizes them below. */
                const filteredName = filteredToolArgumentsResult(
                  tc,
                  mergedConfigurable?.req as ServerRequest | undefined,
                  undefined,
                );
                if (filteredName != null) {
                  return reportResult(filteredName);
                }
                if (backgroundControlEnabled && tc.name === CHECK_BACKGROUND_TASK_NAME) {
                  const req = mergedConfigurable?.req as ServerRequest | undefined;
                  const filteredArguments = filteredToolArgumentsResult(tc, req, tc.args);
                  if (filteredArguments != null) {
                    return reportResult(filteredArguments);
                  }
                  if (runSignal?.reason instanceof SteerToolInterrupt) {
                    return reportResult(interruptedToolResult(tc.id));
                  }
                  onResultAdmissionStart?.(tc.id);
                  const pollContent = await runCheckBackgroundTask({
                    userId: backgroundUserId,
                    conversationId: backgroundConversationId,
                    args: tc.args,
                    toolCallId: tc.id,
                    agentId,
                    runId: `${backgroundRunId ?? ''}:${tc.turn ?? ''}`,
                    generationId: backgroundRunId,
                    subagentTasks,
                    claimBackgroundToolResult: backgroundToolCompletion?.claim,
                    recoverDeadBackgroundToolClaim: backgroundToolCompletion?.recoverDeadClaim,
                    pendingCompletions: backgroundToolCompletion?.pending,
                    ordinaryToolCancellation,
                  });
                  const taskSnapshot = getBackgroundTaskSnapshot({
                    userId: backgroundUserId,
                    conversationId: backgroundConversationId,
                    args: tc.args,
                  });
                  /** Read harvest delivery before filtering and reuse that
                   *  snapshot below. If attachments land afterward, this poll
                   *  cannot emit them; the next poll reads and inspects them. */
                  const delivery = getBackgroundCodeDelivery({
                    userId: backgroundUserId,
                    conversationId: backgroundConversationId,
                    args: tc.args,
                  });
                  const filteredPollOutput = filteredToolOutputResult(tc, req, {
                    content: pollContent,
                    task:
                      taskSnapshot == null
                        ? undefined
                        : {
                            result: taskSnapshot.result,
                            error: taskSnapshot.error,
                            artifact: taskSnapshot.artifact,
                            attachments: taskSnapshot.attachments,
                          },
                    delivery,
                  });
                  if (filteredPollOutput != null) {
                    return reportResult(filteredPollOutput);
                  }
                  /** Deliver a completed task's artifact through THIS live poll
                   *  turn (once): the tool's own turn finalized before the
                   *  artifact resolved, so this is where it can be surfaced.
                   *  Code tasks are claimed even without a `toolEndCallback` —
                   *  their files were already persisted at completion, and the
                   *  claimed artifact still has to ride this result so the SDK
                   *  folds the exec session into the run's shared code session. */
                  let codeSessionArtifact: unknown;
                  const pending = claimBackgroundArtifact({
                    userId: backgroundUserId,
                    conversationId: backgroundConversationId,
                    args: tc.args,
                    shouldClaim: (pendingTask) =>
                      toolEndCallback != null ||
                      isCodeSessionAwareToolCall(pendingTask.toolName, mergedConfigurable),
                  });
                  if (pending) {
                    const isCodeTask = isCodeSessionAwareToolCall(
                      pending.toolName,
                      mergedConfigurable,
                    );
                    if (isCodeTask) {
                      codeSessionArtifact = pending.artifact;
                    }
                    /** Harvested code tasks never route through the poll turn's
                     *  callback — their files were already persisted with the
                     *  ORIGINAL tool-call identity by the completion harvest. */
                    if (toolEndCallback && !(isCodeTask && pending.harvestStarted === true)) {
                      try {
                        onResultAdmissionStart?.(tc.id);
                        await toolEndCallback(
                          {
                            input: tc.args,
                            backgroundDelivery: true,
                            output: {
                              name: pending.toolName,
                              tool_call_id: tc.id,
                              content: pending.content,
                              artifact: pending.artifact,
                            },
                          },
                          {
                            ...(metadata ?? {}),
                            executingAgentId: agentId,
                            stepId: tc.stepId,
                          } as ToolEndCallbackMetadata,
                        );
                      } catch (callbackError) {
                        if (isContentFilterError(callbackError)) {
                          backgroundTaskRegistry.blockArtifact(
                            backgroundUserId,
                            backgroundConversationId,
                            pending.taskId,
                            callbackError instanceof ContentFilterError
                              ? modelBoundContentFilterErrorMessage(callbackError.body)
                              : callbackError.body.message,
                          );
                          logger.warn(
                            `[background] Artifact delivery for task ${pending.taskId} was blocked by content policy.`,
                          );
                          return reportResult({
                            toolCallId: tc.id,
                            status: 'success' as const,
                            content: await runCheckBackgroundTask({
                              userId: backgroundUserId,
                              conversationId: backgroundConversationId,
                              args: tc.args,
                            }),
                          });
                        }
                        /** Only synchronous callback throws land here (e.g. a
                         *  malformed artifact shape); the callback's downstream
                         *  persistence is fire-and-forget, so a storage failure
                         *  is at-most-once — the same semantics as a foreground
                         *  artifact. */
                        restoreBackgroundArtifact({
                          userId: backgroundUserId,
                          conversationId: backgroundConversationId,
                          taskId: pending.taskId,
                          artifact: pending.artifact,
                        });
                        logger.warn(
                          '[background] toolEndCallback error delivering artifact on poll:',
                          callbackError,
                        );
                      }
                    }
                  }
                  /** Harvest delivery is independent of the one-shot artifact
                   *  claim so attachments that land AFTER an earlier poll still
                   *  reach a later one. Re-emitting is idempotent (the client
                   *  upserts by `file_id`) and the row patch re-application
                   *  guards against a HITL-pause/resume full-row save having
                   *  reverted the anchored result. */
                  if (
                    delivery &&
                    delivery.status !== 'running' &&
                    isCodeSessionAwareToolCall(delivery.toolName, mergedConfigurable)
                  ) {
                    for (const attachment of delivery.attachments ?? []) {
                      try {
                        emitAttachment?.(attachment);
                      } catch (emitError) {
                        logger.warn(
                          '[background] Failed to emit harvested attachment on poll:',
                          emitError,
                        );
                      }
                    }
                    /** Live completion signal for the original card: stdout-only
                     *  runs emit no file attachments, so a settled task also
                     *  emits a synthetic status marker (upserted client-side by
                     *  its stable id; filtered out of file rendering). */
                    if (emitAttachment && delivery.messageId) {
                      try {
                        emitAttachment({
                          type: BACKGROUND_STATUS_ATTACHMENT_TYPE,
                          /** Provider ids repeat across agents and turns; the
                           *  host identity suffix keeps sibling markers from
                           *  upserting over each other client-side. */
                          file_id: `bg-${delivery.toolCallId}${
                            delivery.agentId != null ? `-${delivery.agentId}` : ''
                          }${delivery.stepId != null ? `-${delivery.stepId}` : ''}`,
                          messageId: delivery.messageId,
                          conversationId: backgroundConversationId,
                          toolCallId: delivery.toolCallId,
                          agentId: delivery.agentId,
                          stepId: delivery.stepId,
                          status: delivery.status,
                        });
                      } catch (emitError) {
                        logger.warn(
                          '[background] Failed to emit background status marker on poll:',
                          emitError,
                        );
                      }
                    }
                    if (persistBackgroundCodeResult && delivery.messageId) {
                      /** Error/cancelled tasks carry their message in `error`, not
                       *  `result`; abort-confirmed timeouts store it raw, so
                       *  wrap here — `toBackgroundToolFailure` is a no-op for
                       *  already-wrapped detached failures. */
                      const reapplyOutput =
                        delivery.status === 'error' || delivery.status === 'cancelled'
                          ? toBackgroundToolFailure(
                              delivery.toolName,
                              delivery.error ?? delivery.result ?? 'Background task failed',
                            )
                          : delivery.result;
                      void persistBackgroundCodeResult({
                        toolName: delivery.toolName,
                        toolCallId: delivery.toolCallId,
                        stepId: delivery.stepId,
                        messageId: delivery.messageId,
                        conversationId: backgroundConversationId,
                        agentId: delivery.agentId,
                        output: reapplyOutput,
                        attachments: delivery.attachments,
                        ...(delivery.backgroundTask == null
                          ? {}
                          : { backgroundTask: delivery.backgroundTask }),
                        reapply: true,
                      }).catch((reapplyError) => {
                        logger.warn(
                          '[background] Failed to re-anchor harvested code result:',
                          reapplyError,
                        );
                      });
                    }
                  }
                  return reportResult({
                    toolCallId: tc.id,
                    status: 'success' as const,
                    content: pollContent,
                    ...(codeSessionArtifact != null ? { artifact: codeSessionArtifact } : {}),
                  });
                }

                const usesCodeFiles =
                  isCodeFileToolName(tc.name) ||
                  isCodeSessionAwareToolCall(tc.name, mergedConfigurable);
                if (runFileSharingActive && usesCodeFiles && isBackgroundRequested(tc.args)) {
                  return reportResult(
                    errorResult(tc, 'Shared-file code tools require foreground execution.'),
                  );
                }

                /* Before the background dispatch and before the sandbox
                 * authoring context is cloned below: both capture this call's
                 * code-session context, and a copy taken now would stay the
                 * pre-skill snapshot for the rest of the call's life. */
                if (skillFilesHandoff != null && waitsForSkillFiles(tc)) {
                  await skillFilesHandoff.applyTo(tc);
                  if (runSignal?.aborted === true) {
                    /** The Stop landed while the skill upload held this call.
                     *  Starting the tool now would send a request the turn has
                     *  already abandoned. */
                    return reportResult(errorResult(tc, 'This operation was aborted'));
                  }
                }

                if (
                  scheduledMCPExecution?.enrolled !== true &&
                  backgroundToolSet.has(tc.name) &&
                  isBackgroundRequested(tc.args) &&
                  !toolRequiresEphemeralConnection(toolMap.get(tc.name)) &&
                  /** Code tools depend on the completion-time harvest to anchor
                   *  results; hosts that don't wire the persister (OpenAI-compat
                   *  and Responses controllers) downgrade code calls to
                   *  foreground rather than losing generated files. */
                  !(
                    isCodeSessionAwareToolCall(tc.name, mergedConfigurable) &&
                    persistBackgroundCodeResult == null
                  )
                ) {
                  if (runSignal?.reason instanceof SteerToolInterrupt) {
                    return reportResult(interruptedToolResult(tc.id));
                  }
                  onResultAdmissionStart?.(tc.id);
                  return reportResult(await dispatchBackgroundToolCall(tc));
                }

                const execute = async (
                  sandboxContext?: SandboxSessionContext,
                ): Promise<ToolExecuteResult> => {
                  const isFileAuthoringCall = isHostFileAuthoringToolCall(
                    tc.name,
                    mergedConfigurable,
                  );
                  const isSandboxFileAuthoringCall =
                    isFileAuthoringCall &&
                    typeof (tc.args as { path?: unknown }).path === 'string' &&
                    !(tc.args as { path: string }).path.startsWith(SKILL_FILE_PREFIX);
                  if (runSignal?.reason instanceof SteerToolInterrupt) {
                    return interruptedToolResult(tc.id);
                  }
                  let sandboxReadSucceeded = false;
                  if (
                    tc.name === Constants.SKILL_TOOL ||
                    tc.name === Constants.READ_FILE ||
                    tc.name === SEARCH_WORKSPACE_TOOL_NAME ||
                    tc.name === LIST_WORKSPACE_FILES_TOOL_NAME ||
                    isFileAuthoringCall
                  ) {
                    const req = mergedConfigurable?.req as ServerRequest | undefined;
                    const filtered = filteredToolArgumentsResult(tc, req, tc.args);
                    if (filtered != null) {
                      return filtered;
                    }
                    let handlerResult: ToolExecuteResult;
                    try {
                      if (tc.name === Constants.SKILL_TOOL) {
                        handlerResult = await handleSkillToolCall(
                          tc,
                          mergedConfigurable,
                          options,
                          agentId,
                          req,
                          runSignal,
                          batchCodeApiRateLimitBudget,
                        );
                      } else if (tc.name === Constants.READ_FILE) {
                        handlerResult = await handleReadFileCall(
                          tc,
                          mergedConfigurable,
                          options,
                          req,
                          () => {
                            sandboxReadSucceeded = true;
                          },
                          runSignal,
                        );
                      } else if (tc.name === SEARCH_WORKSPACE_TOOL_NAME) {
                        handlerResult = await handleWorkspaceSearchCall(
                          tc,
                          mergedConfigurable,
                          options,
                          req,
                          runSignal,
                        );
                      } else if (tc.name === LIST_WORKSPACE_FILES_TOOL_NAME) {
                        handlerResult = await handleWorkspaceListCall(
                          tc,
                          mergedConfigurable,
                          options,
                          req,
                          runSignal,
                        );
                      } else if (tc.name === CREATE_FILE_TOOL_NAME && isFileAuthoringCall) {
                        handlerResult = await handleCreateFileCall(
                          tc,
                          mergedConfigurable,
                          options,
                          req,
                          sourceConfigurable,
                          sandboxContext,
                          runSignal,
                        );
                      } else if (tc.name === EDIT_FILE_TOOL_NAME && isFileAuthoringCall) {
                        handlerResult = await handleEditFileCall(
                          tc,
                          mergedConfigurable,
                          options,
                          req,
                          sandboxContext,
                          runSignal,
                        );
                      } else {
                        handlerResult = errorResult(tc, `Tool ${tc.name} not found`);
                      }
                    } catch (toolError) {
                      if (toolError instanceof ContentFilterError) {
                        logger.error(`[ON_TOOL_EXECUTE] Tool ${tc.name} error`, {
                          name: toolError.name,
                          contentFiltered: true,
                        });
                        return errorResult(tc, modelBoundContentFilterErrorMessage(toolError.body));
                      }
                      const { message, logContext } = getSafeToolError(toolError);
                      const filteredError = filteredToolOutputResult(tc, req, {
                        errorMessage: message,
                        upstreamBody:
                          toolError instanceof WorkspaceToolHttpError
                            ? toolError.upstreamBody
                            : undefined,
                      });
                      if (filteredError != null) {
                        logger.error(`[ON_TOOL_EXECUTE] Tool ${tc.name} error`, {
                          errorName: logContext.errorName,
                          contentFiltered: true,
                        });
                        return filteredError;
                      }
                      const context = {
                        ...logContext,
                        toolName: tc.name,
                        toolCallId: tc.id,
                        toolCallArgsShape: getValueShape(tc.args),
                      };
                      if (runSignal?.aborted === true && isAbortError(toolError)) {
                        logger.debug(
                          `[ON_TOOL_EXECUTE] Tool ${tc.name} cancelled by run abort`,
                          context,
                        );
                      } else {
                        logger.error(`[ON_TOOL_EXECUTE] Tool ${tc.name} error`, context);
                      }
                      return {
                        toolCallId: tc.id,
                        status: 'error' as const,
                        content: '',
                        errorMessage: message,
                      };
                    }

                    if (runSignal?.reason instanceof SteerToolInterrupt) {
                      return interruptedToolResult(tc.id);
                    }
                    const filteredOutput = filteredToolOutputResult(tc, req, {
                      content: handlerResult.content,
                      artifact: handlerResult.artifact,
                      errorMessage: handlerResult.errorMessage,
                    });
                    if (filteredOutput != null) {
                      /** The side effect already happened; only the returned
                       * content is being withheld. Emit execution identity so
                       * an applied action is never reclassified as actionless
                       * and re-executed — the blocked output stays blank. */
                      if (toolEndCallback && handlerResult.errorMessage == null) {
                        try {
                          onResultAdmissionStart?.(tc.id);
                          await toolEndCallback(
                            {
                              input: tc.args,
                              outputFiltered: true,
                              output: { name: tc.name, tool_call_id: tc.id, content: '' },
                            },
                            {
                              ...(metadata ?? {}),
                              executingAgentId: agentId,
                            } as ToolEndCallbackMetadata,
                          );
                        } catch (evidenceError) {
                          logger.warn(
                            `[ON_TOOL_EXECUTE] Filtered-output evidence delivery failed for ${tc.name}`,
                            evidenceError,
                          );
                        }
                      }
                      return filteredOutput;
                    }

                    if (toolEndCallback && handlerResult.artifact) {
                      try {
                        onResultAdmissionStart?.(tc.id);
                        await toolEndCallback(
                          {
                            input: tc.args,
                            output: {
                              name: tc.name,
                              tool_call_id: tc.id,
                              content: handlerResult.content,
                              artifact: handlerResult.artifact,
                            },
                          },
                          {
                            run_id: (metadata as Record<string, unknown>)?.run_id as
                              | string
                              | undefined,
                            thread_id: (metadata as Record<string, unknown>)?.thread_id as
                              | string
                              | undefined,
                            ...metadata,
                            executingAgentId: agentId,
                            stepId: tc.stepId,
                            codeExecutionContext,
                          },
                        );
                      } catch (callbackError) {
                        if (callbackError instanceof ContentFilterError) {
                          logger.warn(
                            `[ON_TOOL_EXECUTE] Artifact delivery for tool ${tc.name} was blocked by content policy.`,
                          );
                          return errorResult(
                            tc,
                            modelBoundContentFilterErrorMessage(callbackError.body),
                          );
                        }
                        throw callbackError;
                      }
                    }

                    if (
                      isSandboxFileAuthoringCall &&
                      handlerResult.status === 'success' &&
                      sandboxContext
                    ) {
                      mergeSandboxSessionArtifact(sandboxContext, handlerResult.artifact);
                    }

                    /* Sandbox-routed host file tools return before the
                     * generic invoke path's marker below, so refresh the warm
                     * window here. `sandboxReadSucceeded` is set only after an
                     * actual Code API read succeeds, so skill reads never mark
                     * the sandbox warm. */
                    if (
                      (isSandboxFileAuthoringCall || sandboxReadSucceeded) &&
                      handlerResult.status === 'success' &&
                      (runtimeSessionHint || sandboxConversationId)
                    ) {
                      markCodeSandboxWarm();
                    }

                    return handlerResult;
                  }

                  const tool = toolMap.get(tc.name);

                  if (!tool) {
                    const missingToolResult: ToolExecuteResult = {
                      toolCallId: tc.id,
                      status: 'error' as const,
                      content: '',
                      errorMessage: `Tool ${tc.name} not found`,
                    };
                    const filteredMissingTool = filteredToolOutputResult(
                      tc,
                      mergedConfigurable?.req as ServerRequest | undefined,
                      { errorMessage: missingToolResult.errorMessage },
                    );
                    if (filteredMissingTool != null) {
                      return filteredMissingTool;
                    }
                    logger.warn(
                      `[ON_TOOL_EXECUTE] Tool "${tc.name}" not found. Available: ${[...toolMap.keys()].map((k) => `"${k}"`).join(', ')}`,
                    );
                    return missingToolResult;
                  }
                  recordAttachedCommand(tc, tool);

                  let normalizedArgs: unknown = tc.args;
                  try {
                    const toolCallConfig = buildToolCallConfig(tc, mergedConfigurable);

                    if (
                      tc.name === Constants.BASH_PROGRAMMATIC_TOOL_CALLING ||
                      tc.name === Constants.PROGRAMMATIC_TOOL_CALLING
                    ) {
                      const toolRegistry = mergedConfigurable?.toolRegistry as
                        | LCToolRegistry
                        | undefined;
                      const ptcToolMap = mergedConfigurable?.ptcToolMap as
                        | Map<string, StructuredToolInterface>
                        | undefined;
                      if (toolRegistry) {
                        const activeCodeExecutionToolNames = callerCapabilityProjection
                          ? new Set(callerCapabilityProjection.codeExecutionToolNames)
                          : undefined;
                        const activeDirectOnlyToolNames = callerCapabilityProjection
                          ? new Set(callerCapabilityProjection.directOnlyToolNames)
                          : undefined;
                        const fileAuthoringToolNames =
                          getFileAuthoringToolNames(mergedConfigurable) ?? new Set<string>();
                        const eligibleToolDefs: LCTool[] = [];
                        const disallowedToolDefs: LCTool[] = [];
                        for (const toolDef of toolRegistry.values()) {
                          const isInnerTool =
                            toolDef.name !== Constants.PROGRAMMATIC_TOOL_CALLING &&
                            toolDef.name !== Constants.BASH_PROGRAMMATIC_TOOL_CALLING &&
                            toolDef.name !== Constants.TOOL_SEARCH &&
                            toolDef.name !== CHECK_BACKGROUND_TASK_NAME &&
                            !fileAuthoringToolNames.has(toolDef.name);
                          if (!isInnerTool) {
                            continue;
                          }
                          const allowsCodeExecution = (
                            toolDef.allowed_callers ?? ['direct']
                          ).includes('code_execution');
                          if (
                            allowsCodeExecution &&
                            (activeCodeExecutionToolNames == null ||
                              activeCodeExecutionToolNames.has(toolDef.name))
                          ) {
                            eligibleToolDefs.push(toolDef);
                          } else if (
                            !allowsCodeExecution &&
                            (activeDirectOnlyToolNames == null ||
                              activeDirectOnlyToolNames.has(toolDef.name))
                          ) {
                            disallowedToolDefs.push({
                              name: toolDef.name,
                            });
                          }
                        }
                        /* PTC-generated calls don't go through the host background
                         * interceptor, so strip the injected `run_in_background`
                         * param from target schemas (the registry entries were
                         * mutated to include it) — mirrors the self-spawn path.
                         * Intent LABELS are stripped for the same reason —
                         * host-injected AND SDK-native alike (marker-guarded):
                         * no card renders for an inner call, so the sandbox
                         * bridge must not advertise them. */
                        const toolDefs = stripIntentLabelsFromToolDefinitions(
                          stripBackgroundFromToolDefinitions(
                            eligibleToolDefs,
                            mergedConfigurable?.backgroundToolNames as string[] | undefined,
                          ),
                        );
                        toolCallConfig.toolDefs = toolDefs;
                        toolCallConfig.disallowedToolDefs = disallowedToolDefs;
                        const eligibleNames = new Set(toolDefs.map((toolDef) => toolDef.name));
                        /* Instrument the ELIGIBLE map, never the raw one: the
                         * caller-capability restriction decides what the sandbox
                         * may reach, and tracing must not widen it. */
                        const eligiblePtcToolMap = new Map(
                          [...(ptcToolMap ?? toolMap)].filter(([name]) => eligibleNames.has(name)),
                        );
                        /* Inner calls produce no run step and no card of their
                         * own, so the only record of what the program did is
                         * this trace. `invoke` is the single seam every inner
                         * call passes through.
                         *
                         * They also never reach `filteredToolArgumentsResult` —
                         * the sandbox bridge invokes them directly — so when the
                         * deployment filters tool arguments for PII, the trace
                         * must not put their values on the wire. */
                        const ptcReq = mergedConfigurable?.req as ServerRequest | undefined;
                        const ptcArgumentPii = ptcReq?.config?.filters?.toolArguments?.pii;
                        toolCallConfig.toolMap = emitPtcProgress
                          ? instrumentPtcToolMap({
                              toolMap: eligiblePtcToolMap,
                              toolCallId: tc.id,
                              runId: (metadata as Record<string, unknown>)?.run_id as
                                | string
                                | undefined,
                              includePreviews: !hasActivePiiFields(ptcArgumentPii, [
                                'name',
                                'arguments',
                                'output',
                              ]),
                              traceExclusions: collectFilteredPtcToolNames(
                                eligiblePtcToolMap.keys(),
                                ptcReq,
                              ),
                              emit: (event) => {
                                if (!(runSignal?.reason instanceof SteerToolInterrupt)) {
                                  emitPtcProgress(event);
                                }
                              },
                            })
                          : eligiblePtcToolMap;
                      }
                    }

                    /** Strip the host-only `run_in_background` flag on foreground
                     *  calls (the model may emit it as `false`, or imitate it from
                     *  another agent's history on a tool this agent never opted
                     *  in), so a strict MCP/action schema doesn't reject an
                     *  undeclared argument. Only a tool whose own schema declares
                     *  the parameter receives it. */
                    const foregroundArgs =
                      backgroundToolSet.has(tc.name) ||
                      (hasRunInBackgroundArg(tc.args) && !toolDeclaresRunInBackgroundParam(tool))
                        ? stripRunInBackgroundArg(tc.args)
                        : tc.args;
                    normalizedArgs = normalizeToolInvokeArgs(
                      stripIntentForInvoke(foregroundArgs, tool),
                      tool,
                    );
                    const filtered = filteredToolArgumentsResult(
                      tc,
                      mergedConfigurable?.req as ServerRequest | undefined,
                      normalizedArgs,
                    );
                    if (filtered != null) {
                      return filtered;
                    }
                    const result = await tool.invoke(normalizedArgs, {
                      toolCall: toolCallConfig,
                      configurable: mergedConfigurable,
                      metadata: { ...metadata, executingAgentId: agentId },
                      /** The run's cancellation signal. Without it a foreground
                       *  tool call keeps running after Stop: an MCP call never
                       *  sends `notifications/cancelled`, and every other
                       *  signal-aware tool keeps burning quota on a turn the
                       *  user already abandoned. Detached background calls
                       *  intentionally use their own controller instead. */
                      ...(runSignal != null && { signal: runSignal }),
                    } as Record<string, unknown>);

                    if (runSignal?.reason instanceof SteerToolInterrupt) {
                      return interruptedToolResult(tc.id);
                    }

                    /* Only sandbox-bound calls carry a runtime session hint, so
                     * this refreshes the prewarm module's warm window without
                     * inspecting tool names. */
                    if (isCodeSessionAwareToolCall(tc.name, mergedConfigurable)) {
                      markCodeSandboxWarm();
                    }

                    // Code-execution tools emit per-call boilerplate
                    // ("Note: ..." paragraphs and `| <annotation>` per-file
                    // suffixes) that wastes tokens when re-injected into
                    // every subsequent model turn. Strip it here, *after*
                    // the tool resolved but *before* downstream consumers
                    // (model context, SSE forwarding, persistence) see it.
                    // Non-code-execution tools pass through unchanged.
                    const cleanedContent =
                      isCodeSessionAwareToolCall(tc.name, mergedConfigurable) &&
                      typeof result.content === 'string'
                        ? cleanCodeToolOutput(result.content)
                        : result.content;
                    const filteredOutput = filteredToolOutputResult(
                      tc,
                      mergedConfigurable?.req as ServerRequest | undefined,
                      {
                        content: cleanedContent,
                        artifact: result.artifact,
                      },
                    );
                    if (filteredOutput != null) {
                      /** The side effect already happened; only the returned
                       * content is being withheld. Emit execution identity so
                       * an applied action is never reclassified as actionless
                       * and re-executed — the blocked output stays blank. */
                      if (toolEndCallback) {
                        try {
                          onResultAdmissionStart?.(tc.id);
                          await toolEndCallback(
                            {
                              input: tc.args,
                              outputFiltered: true,
                              output: { name: tc.name, tool_call_id: tc.id, content: '' },
                            },
                            {
                              ...(metadata ?? {}),
                              executingAgentId: agentId,
                            } as ToolEndCallbackMetadata,
                          );
                        } catch (evidenceError) {
                          logger.warn(
                            `[ON_TOOL_EXECUTE] Filtered-output evidence delivery failed for ${tc.name}`,
                            evidenceError,
                          );
                        }
                      }
                      return filteredOutput;
                    }

                    if (toolEndCallback) {
                      onResultAdmissionStart?.(tc.id);
                      await toolEndCallback(
                        {
                          input: tc.args,
                          output: {
                            name: tc.name,
                            tool_call_id: tc.id,
                            content: cleanedContent,
                            artifact: result.artifact,
                          },
                        },
                        {
                          run_id: (metadata as Record<string, unknown>)?.run_id as
                            | string
                            | undefined,
                          thread_id: (metadata as Record<string, unknown>)?.thread_id as
                            | string
                            | undefined,
                          ...metadata,
                          executingAgentId: agentId,
                          stepId: tc.stepId,
                          codeExecutionContext,
                        },
                      );
                    }

                    return {
                      toolCallId: tc.id,
                      content: cleanedContent,
                      artifact: result.artifact,
                      status: result.status === 'error' ? ('error' as const) : ('success' as const),
                      ...(result.status === 'error' && {
                        errorMessage: getToolFailureFeedback(cleanedContent),
                      }),
                    };
                  } catch (toolError) {
                    if (toolError instanceof ContentFilterError) {
                      logger.error(`[ON_TOOL_EXECUTE] Tool ${tc.name} error`, {
                        name: toolError.name,
                        contentFiltered: true,
                      });
                      return errorResult(tc, modelBoundContentFilterErrorMessage(toolError.body));
                    }
                    const { message, logContext } = getSafeToolError(
                      toolError,
                      toolValidationFeedback(
                        toolError,
                        tc.name,
                        tool.schema,
                        normalizedArgs,
                        backgroundControlEnabled,
                      ),
                    );
                    /** A user Stop rejects every in-flight call at once. That is
                     *  the abort working, not a fault, so it is logged at debug.
                     *  An aborted run says the turn is over, not that THIS
                     *  rejection was the cancellation, so the error must look
                     *  like one too; an unrelated failure racing the Stop stays
                     *  at error level. Either way the level is all that changes
                     *  — filtering and the result shape are identical. */
                    const logToolFailure = (context: Record<string, unknown>): void => {
                      if (runSignal?.aborted === true && isAbortError(toolError)) {
                        logger.debug(
                          `[ON_TOOL_EXECUTE] Tool ${tc.name} cancelled by run abort`,
                          context,
                        );
                        return;
                      }
                      logger.error(`[ON_TOOL_EXECUTE] Tool ${tc.name} error`, context);
                    };
                    const req = mergedConfigurable?.req as ServerRequest | undefined;
                    const filteredError = filteredToolOutputResult(tc, req, {
                      errorMessage: message,
                      upstreamBody:
                        toolError instanceof WorkspaceToolHttpError
                          ? toolError.upstreamBody
                          : undefined,
                    });
                    if (filteredError != null) {
                      logToolFailure({
                        errorName: logContext.errorName,
                        contentFiltered: true,
                      });
                      return filteredError;
                    }
                    logToolFailure({
                      ...logContext,
                      toolName: tc.name,
                      toolCallId: tc.id,
                      toolCallArgsShape: getValueShape(tc.args),
                      toolInputSchemaKind: getToolInputSchemaKind(tool),
                    });
                    return {
                      toolCallId: tc.id,
                      status: 'error' as const,
                      content: '',
                      errorMessage: message,
                    };
                  }
                };

                const executeWithFileScope = (sandboxContext?: SandboxSessionContext) =>
                  runFileSharingActive && usesCodeFiles && runFiles != null && agentId != null
                    ? runFiles.withCodeExecution(
                        agentId,
                        executionContext,
                        runSignal ?? new AbortController().signal,
                        () => execute(sandboxContext),
                      )
                    : execute(sandboxContext);
                const queueKey = getFileAuthoringQueueKey(tc, mergedConfigurable);
                if (!queueKey) {
                  return reportResult(await executeWithFileScope());
                }
                let sandboxContext: SandboxSessionContext | undefined;
                if (queueKey.startsWith('sandbox:')) {
                  sandboxContext =
                    sandboxAuthoringContexts.get(queueKey) ??
                    cloneSandboxSessionContext(sandboxSessionContext(tc));
                  sandboxAuthoringContexts.set(queueKey, sandboxContext);
                }
                const previous = authoringQueues.get(queueKey) ?? Promise.resolve();
                const resultPromise = previous.then(
                  () => executeWithFileScope(sandboxContext),
                  () => executeWithFileScope(sandboxContext),
                );
                authoringQueues.set(
                  queueKey,
                  resultPromise.then(
                    () => undefined,
                    () => undefined,
                  ),
                );
                return reportResult(await resultPromise);
              }),
            );

            resolve(results);
          } catch (error) {
            logger.error('[ON_TOOL_EXECUTE] Fatal error:', error);
            reject(error as Error);
          }
        });
      } catch (outerError) {
        logger.error('[ON_TOOL_EXECUTE] Unexpected error:', outerError);
        reject(outerError as Error);
      }
    },
  };
}

/**
 * Creates a handlers object that includes ON_TOOL_EXECUTE.
 * Can be merged with other handler objects.
 */
export function createToolExecuteHandlers(
  options: ToolExecuteOptions,
): Record<string, EventHandler> {
  return {
    [GraphEvents.ON_TOOL_EXECUTE]: createToolExecuteHandler(options),
  };
}
