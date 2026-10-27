import { createHash } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import { Constants as AgentConstants } from '@librechat/agents';
import {
  Tools,
  Constants,
  getCodeEnvRefForProfile,
  resolveSandboxFilename,
} from 'librechat-data-provider';
import type {
  TFile,
  TurnFileConsumers,
  TFileWorkspaceImport,
  TFileWorkspaceImports,
} from 'librechat-data-provider';
import type { CodeEnvFile } from '@librechat/agents';
import type { AttachedCodeEnvironmentPolicySettings } from '~/agents/hitl/byom';
import type { StoredFileDigest } from '~/files/provision/service';
import type { CodeExecutionContext } from '~/agents/execution';
import type { CodeContextEntry } from '~/files/code/priming';
import type { ProvisionState } from '~/agents/resources';
import type { CodeBridgeFetch } from './bridge';
import {
  executeWorkspaceTool,
  WorkspaceToolHttpError,
  resolveAttachedWorkspaceAdmissionOptions,
} from './workspace';
import {
  isDescribedCodeFile,
  getCodeFileLocation,
  getCodeFileContextSuffix,
} from '~/files/code/priming';
import { codeExecutionAuthHeaders, getCodeExecutionRouteKey } from '~/agents/execution';
import { isAttachedFileWriteDenied } from '~/agents/hitl/byom';
import { getSafeErrorMetadata } from '~/utils/errors';
import { isWorkspacePathMissing } from './paths';

/** Workspace-relative folder chat attachments are copied into. */
export const WORKSPACE_ATTACHMENTS_DIRECTORY = '.librechat/attachments';
/** The whole import phase, provisioning included, never holds a turn longer than this. */
export const WORKSPACE_ATTACHMENT_IMPORT_TIMEOUT_MS = 10_000;
/** Workspace requests in flight for the whole turn, across every agent it primes. */
export const WORKSPACE_ATTACHMENT_IMPORT_CONCURRENCY = 3;
const WORKSPACE_ATTACHMENTS_GITIGNORE = `${WORKSPACE_ATTACHMENTS_DIRECTORY}/.gitignore`;
const MAX_ATTACHMENT_NAME_LENGTH = 120;
const MAX_EXTENSION_LENGTH = 16;
/** Conflicting names tried after the first before a file is reported as unavailable. */
const MAX_CONFLICT_RETRIES = 3;
const QUEUED_CODE_FILES_CONTEXT_KEY = 'queued_code_files';
const PROGRAMMATIC_TOOL_NAMES: ReadonlySet<string> = new Set([
  AgentConstants.PROGRAMMATIC_TOOL_CALLING,
  AgentConstants.BASH_PROGRAMMATIC_TOOL_CALLING,
]);
const UNSAFE_NAME_CHARACTERS: ReadonlySet<string> = new Set('<>:"/\\|?*');
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;

export type WorkspaceAttachmentUnavailableReason =
  | 'unsupported'
  | 'denied'
  | 'agent_file'
  | 'not_owned'
  | 'not_staged'
  | 'too_large'
  | 'conflict'
  | 'not_ignored'
  | 'timeout'
  | 'failed';

export type WorkspaceAttachmentOutcome =
  | { status: 'imported'; path: string }
  | { status: 'unavailable'; reason: WorkspaceAttachmentUnavailableReason };

const UNAVAILABLE_REASONS: Record<WorkspaceAttachmentUnavailableReason, string> = {
  unsupported:
    "this machine's LibreChat worker cannot receive attachments yet; updating the worker enables it",
  denied: 'file writes are not allowed in this workspace',
  agent_file: "it is one of the agent's own files, not one attached in this chat",
  not_owned: 'only files you uploaded yourself are copied to your machine',
  not_staged: 'it could not be prepared for transfer to this machine',
  too_large: "it is larger than this machine's file size limit",
  conflict: `a different file already uses that name in ${WORKSPACE_ATTACHMENTS_DIRECTORY}`,
  not_ignored: `the existing ${WORKSPACE_ATTACHMENTS_DIRECTORY}/.gitignore does not ignore the folder, so a copy could end up in the repository; adding a line with * to it enables copies`,
  timeout: 'copying it to this machine did not finish in time; it is retried next turn',
  failed: 'copying it to this machine failed',
};

/** One code-environment object a workspace copy is read from. */
interface AttachmentSource {
  storage_session_id: string;
  file_id: string;
}

/**
 * Persists a copy and/or a freshly computed digest, so a later turn skips the copy without a
 * workspace call and never hashes the same stored object twice.
 */
export interface WorkspaceImportRecord {
  file_id: string;
  user: string;
  tenantId?: string | null;
  copy?: { key: string; target: TFileWorkspaceImport };
  digest?: NonNullable<TFileWorkspaceImports['digest']>;
}

export interface WorkspaceAttachmentDeps {
  userId: string;
  conversationId?: string | null;
  getAuthHeaders: (bridgeWorkerId?: string) => Promise<Record<string, string>>;
  /** SHA-256 and length of the stored bytes, or null when storage cannot be streamed. */
  digestFile: (file: TFile, signal: AbortSignal) => Promise<StoredFileDigest | null>;
  recordImport: (record: WorkspaceImportRecord) => Promise<unknown>;
  codeApiMaxRetryWaitMs?: number;
  fetchImpl?: CodeBridgeFetch;
  timeoutMs?: number;
  /** Workspace requests in flight for the turn; defaults to three. */
  concurrency?: number;
}

export interface WorkspaceAttachmentCandidate {
  file: TFile;
  /** Name under `$LIBRECHAT_CODE_DATA_DIR`, for programmatic Bash. */
  destination: string;
  agentScoped: boolean;
  source?: AttachmentSource;
}

/**
 * A portable single path segment for `filename`: directories, control and reserved
 * characters, leading dots and trailing dots or spaces are removed, a reserved Windows device
 * name is prefixed, and an overlong name keeps its extension. A safe name is returned as is.
 */
export function toAttachmentName(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const cleaned = replaceUnsafeCharacters(base.normalize('NFC'))
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  const name = cleaned === '' ? 'attachment' : cleaned;
  const portable = RESERVED_WINDOWS_NAME.test(name) ? `_${name}` : name;
  if (portable.length <= MAX_ATTACHMENT_NAME_LENGTH) {
    return portable;
  }
  const { stem, extension } = splitExtension(portable);
  return `${stem.slice(0, MAX_ATTACHMENT_NAME_LENGTH - extension.length).trimEnd()}${extension}`;
}

/** Collapses each run of control or path-reserved characters to one underscore. */
function replaceUnsafeCharacters(value: string): string {
  let result = '';
  let replacing = false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || UNSAFE_NAME_CHARACTERS.has(character)) {
      result += replacing ? '' : '_';
      replacing = true;
      continue;
    }
    result += character;
    replacing = false;
  }
  return result;
}

function splitExtension(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || name.length - dot > MAX_EXTENSION_LENGTH) {
    return { stem: name, extension: '' };
  }
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

/** The `index`-th name for `name`: the name itself, then `name (2).ext`, `name (3).ext`… */
export function getAttachmentNameVariant(name: string, index: number): string {
  if (index <= 1) {
    return name;
  }
  const { stem, extension } = splitExtension(name);
  return `${stem} (${index})${extension}`;
}

/**
 * Claims the first variant of `name` not yet taken, comparing case-insensitively because
 * the target may be a Windows or macOS checkout.
 */
function claimAttachmentName(taken: Set<string>, name: string, start = 1): string {
  for (let index = start; ; index++) {
    const candidate = getAttachmentNameVariant(name, index);
    const key = candidate.toLowerCase();
    if (!taken.has(key)) {
      taken.add(key);
      return candidate;
    }
  }
}

/** Assigns distinct portable names in order, so the earliest file keeps the bare name. */
export function assignAttachmentNames(filenames: readonly string[]): string[] {
  const taken = new Set<string>();
  return filenames.map((filename) => claimAttachmentName(taken, toAttachmentName(filename)));
}

/**
 * Whether LibreChat may copy chat attachments into the selected workspace, or why not. The
 * upload is the user's consent, so an `ask` file-write policy still allows it; only `deny`
 * on this machine, or a worker without `import_file`, stops it.
 */
export function resolveWorkspaceAttachmentPolicy(
  context: CodeExecutionContext,
): { eligible: true } | { eligible: false; reason: 'unsupported' | 'denied' } {
  const operations = context.codeWorkspace?.operations;
  /** Without `write_file` the folder could not ignore itself, and copies would surface as
   *  untracked repository content. */
  if (operations?.includes('import_file') !== true || !operations.includes('write_file')) {
    return { eligible: false, reason: 'unsupported' };
  }
  const policy: AttachedCodeEnvironmentPolicySettings = {
    configSchema: context.codeEnvironmentConfigSchema,
    settings: context.codeEnvironmentSettings,
  };
  if (isAttachedFileWriteDenied(policy)) {
    return { eligible: false, reason: 'denied' };
  }
  return { eligible: true };
}

/**
 * Opaque key for one conversation's copies in one workspace checkout on one live worker. The
 * Code API route and worker are part of it, so a machine replaced under the same environment
 * id never inherits the previous machine's copies.
 */
export function getWorkspaceAttachmentTargetKey(
  context: CodeExecutionContext,
  conversationId: string,
): string | undefined {
  const workspace = context.codeWorkspace;
  if (workspace == null) {
    return undefined;
  }
  return createHash('sha256')
    .update(
      JSON.stringify([
        conversationId,
        context.baseUrl.trim().replace(/\/+$/, ''),
        context.bridgeWorkerId ?? null,
        context.environmentId ?? workspace.environmentId,
        workspace.workspaceId,
        workspace.workspaceInstanceId ?? null,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
}

/** A create-only write found different bytes at the path; older workers say `FILE_EXISTS`. */
const CONFLICT_CODES: ReadonlySet<string> = new Set(['EDIT_CONFLICT', 'FILE_EXISTS']);

function classifyImportFailure(error: unknown): WorkspaceAttachmentUnavailableReason {
  if (!(error instanceof WorkspaceToolHttpError)) {
    return 'failed';
  }
  if (error.reason === 'timeout' || error.reason === 'insufficient_time') {
    return 'timeout';
  }
  if (error.reason !== 'rejected') {
    return 'failed';
  }
  const code = error.upstreamCode ?? '';
  if (error.upstreamStatus === 409 && CONFLICT_CODES.has(code)) {
    return 'conflict';
  }
  if (error.upstreamStatus === 403 && code === 'WRITE_DISABLED') {
    return 'denied';
  }
  if (error.upstreamStatus === 413) {
    return 'too_large';
  }
  return 'failed';
}

/**
 * A worker that cannot create the attachments folder reports it missing, as `NOT_FOUND` or,
 * through an older Code API, as `INVALID_PATH` with the same message: workers before
 * LibreChat-AI/code-interpreter#360 never created a parent on a root registered by path alone.
 */
function classifyIgnoreFailure(error: unknown): WorkspaceAttachmentUnavailableReason {
  if (error instanceof WorkspaceToolHttpError && isWorkspacePathMissing(error)) {
    return 'unsupported';
  }
  return classifyImportFailure(error);
}

/** What a failed workspace request may log: its outcome and the worker's error code, never a
 *  response body, a host path, or file content. */
interface WorkspaceFailureMetadata {
  type: string;
  status?: number;
  reason?: WorkspaceToolHttpError['reason'];
  upstreamStatus?: number;
  upstreamCode?: string;
}

function getWorkspaceFailureMetadata(error: unknown): WorkspaceFailureMetadata {
  if (!(error instanceof WorkspaceToolHttpError)) {
    return getSafeErrorMetadata(error);
  }
  return {
    type: error.name,
    reason: error.reason,
    ...(error.upstreamStatus != null ? { upstreamStatus: error.upstreamStatus } : {}),
    ...(error.upstreamCode != null ? { upstreamCode: error.upstreamCode } : {}),
  };
}

/** Admits at most `limit` tasks at once; a finishing task hands its slot to the next waiter. */
function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active++;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) {
        next();
      } else {
        active--;
      }
    }
  };
}

/**
 * What one turn shares across the agents it primes: copies and ignore checks already started,
 * so each file and each folder is handled once, and one cap on concurrent workspace requests.
 */
export interface WorkspaceAttachmentTurn {
  imports: Map<string, Promise<WorkspaceAttachmentOutcome>>;
  ignores: Map<string, Promise<WorkspaceAttachmentUnavailableReason | null>>;
  limit: <T>(task: () => Promise<T>) => Promise<T>;
}

export function createWorkspaceAttachmentTurn(
  concurrency: number = WORKSPACE_ATTACHMENT_IMPORT_CONCURRENCY,
): WorkspaceAttachmentTurn {
  return {
    imports: new Map(),
    ignores: new Map(),
    limit: createLimiter(Math.max(1, Math.floor(concurrency))),
  };
}

/** Resolves when `signal` aborts; never rejects, so it can bound a race. */
function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

interface ImportTarget {
  context: CodeExecutionContext;
  workspaceId: string;
  workspaceInstanceId?: string;
  key?: string;
}

/**
 * Copies chat attachments into one workspace and reports where each landed. Copies already
 * recorded for this conversation and workspace with the same digest are not sent again, the
 * worker's own digest check makes a resend harmless, and anything unfinished when `signal`
 * aborts is reported as timed out rather than holding the turn.
 */
export async function importWorkspaceAttachments({
  context,
  candidates,
  deps,
  signal,
  turn = createWorkspaceAttachmentTurn(deps.concurrency),
}: {
  context: CodeExecutionContext;
  candidates: readonly WorkspaceAttachmentCandidate[];
  deps: WorkspaceAttachmentDeps;
  signal: AbortSignal;
  turn?: WorkspaceAttachmentTurn;
}): Promise<Map<string, WorkspaceAttachmentOutcome>> {
  const outcomes = new Map<string, WorkspaceAttachmentOutcome>();
  const workspace = context.codeWorkspace;
  if (workspace == null) {
    return outcomes;
  }
  const target: ImportTarget = {
    context,
    workspaceId: workspace.workspaceId,
    ...(workspace.workspaceInstanceId
      ? { workspaceInstanceId: workspace.workspaceInstanceId }
      : {}),
    ...(deps.conversationId && deps.conversationId !== Constants.NEW_CONVO
      ? { key: getWorkspaceAttachmentTargetKey(context, deps.conversationId) }
      : {}),
  };
  const ordered = [...candidates].sort(compareCandidates);
  const recordedNames = ordered.map((candidate) => getRecordedName(candidate.file, target.key));
  const taken = new Set(
    recordedNames.flatMap((name) => (name == null ? [] : [name.toLowerCase()])),
  );
  const pending = ordered.map((candidate, index) => ({
    candidate,
    name: recordedNames[index] ?? claimAttachmentName(taken, getAttachmentBaseName(candidate.file)),
  }));

  const workspaceKey = JSON.stringify([
    context.baseUrl,
    context.bridgeWorkerId ?? null,
    target.workspaceId,
    target.workspaceInstanceId ?? null,
  ]);
  /** Checked once per turn and folder, never cached longer: the user may edit the file. */
  const ensureIgnored = (): Promise<WorkspaceAttachmentUnavailableReason | null> => {
    let check = turn.ignores.get(workspaceKey);
    if (check == null) {
      check = ensureAttachmentsIgnored({ target, deps, signal });
      turn.ignores.set(workspaceKey, check);
    }
    return check;
  };

  await Promise.all(
    pending.map(async (item) => {
      const importKey = JSON.stringify([workspaceKey, item.candidate.file.file_id]);
      let outcome = turn.imports.get(importKey);
      if (outcome == null) {
        outcome = turn.limit(() =>
          importOne({ ...item, target, taken, deps, signal, ensureIgnored }),
        );
        turn.imports.set(importKey, outcome);
      }
      outcomes.set(item.candidate.file.file_id, await outcome);
    }),
  );
  return outcomes;
}

/** The portable name for a file's stored bytes: a converted image takes its stored type's
 *  extension, as the sandbox copy does, so tools decode what is actually there. */
function getAttachmentBaseName(file: TFile): string {
  return toAttachmentName(resolveSandboxFilename(file.filename, file.type));
}

/** The name an earlier turn copied this file under, kept so its path never moves. */
function getRecordedName(file: TFile, key: string | undefined): string | undefined {
  const path = key ? file.metadata?.workspaceImports?.targets?.[key]?.path : undefined;
  const prefix = `${WORKSPACE_ATTACHMENTS_DIRECTORY}/`;
  if (path == null || !path.startsWith(prefix) || path.slice(prefix.length).includes('/')) {
    return undefined;
  }
  return path.slice(prefix.length);
}

function compareCandidates(
  left: WorkspaceAttachmentCandidate,
  right: WorkspaceAttachmentCandidate,
): number {
  const leftTime = new Date(left.file.createdAt ?? 0).getTime() || 0;
  const rightTime = new Date(right.file.createdAt ?? 0).getTime() || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (left.file.file_id === right.file.file_id) {
    return 0;
  }
  return left.file.file_id < right.file.file_id ? -1 : 1;
}

async function importOne({
  candidate,
  name,
  target,
  taken,
  deps,
  signal,
  ensureIgnored,
}: {
  candidate: WorkspaceAttachmentCandidate;
  name: string;
  target: ImportTarget;
  taken: Set<string>;
  deps: WorkspaceAttachmentDeps;
  signal: AbortSignal;
  /** Null once the folder is known to ignore itself, else why copies cannot go there. */
  ensureIgnored: () => Promise<WorkspaceAttachmentUnavailableReason | null>;
}): Promise<WorkspaceAttachmentOutcome> {
  const { file, source } = candidate;
  if (source == null) {
    return { status: 'unavailable', reason: 'not_staged' };
  }
  let freshDigest: NonNullable<TFileWorkspaceImports['digest']> | undefined;
  let copy: TFileWorkspaceImport | undefined;
  try {
    const sourceKey = `${source.storage_session_id}/${source.file_id}`;
    const stored = file.metadata?.workspaceImports?.digest;
    const digest =
      stored?.source === sourceKey
        ? { sha256: stored.sha256, bytes: stored.bytes }
        : await deps.digestFile(file, signal);
    if (digest == null) {
      return { status: 'unavailable', reason: 'not_staged' };
    }
    if (stored?.source !== sourceKey) {
      freshDigest = { source: sourceKey, ...digest };
    }
    const recorded = target.key
      ? file.metadata?.workspaceImports?.targets?.[target.key]
      : undefined;
    if (recorded?.sha256 === digest.sha256) {
      return { status: 'imported', path: recorded.path };
    }
    const notIgnored = await ensureIgnored();
    if (notIgnored != null) {
      return { status: 'unavailable', reason: signal.aborted ? 'timeout' : notIgnored };
    }
    let attemptName = name;
    for (let attempt = 0; ; attempt++) {
      try {
        const path = await sendImport({
          target,
          deps,
          signal,
          path: `${WORKSPACE_ATTACHMENTS_DIRECTORY}/${attemptName}`,
          source,
          digest,
        });
        copy = { sha256: digest.sha256, path };
        return { status: 'imported', path };
      } catch (error) {
        const reason = classifyImportFailure(error);
        if (reason !== 'conflict' || attempt >= MAX_CONFLICT_RETRIES || signal.aborted) {
          throw error;
        }
        attemptName = claimAttachmentName(taken, getAttachmentBaseName(file), 2);
      }
    }
  } catch (error) {
    if (signal.aborted) {
      return { status: 'unavailable', reason: 'timeout' };
    }
    const reason = classifyImportFailure(error);
    logger.warn(
      `[workspaceAttachments] Import of file ${file.file_id} into workspace ${target.workspaceId} failed: ${reason}`,
      getWorkspaceFailureMetadata(error),
    );
    return { status: 'unavailable', reason };
  } finally {
    /** Bookkeeping only: past the deadline the turn goes on and the write lands when it can. */
    await Promise.race([
      persistImport({ file, target, deps, copy, digest: freshDigest }),
      whenAborted(signal),
    ]);
  }
}

async function sendImport({
  target,
  deps,
  signal,
  path,
  source,
  digest,
}: {
  target: ImportTarget;
  deps: WorkspaceAttachmentDeps;
  signal: AbortSignal;
  path: string;
  source: AttachmentSource;
  digest: StoredFileDigest;
}): Promise<string> {
  const result = await executeWorkspaceTool({
    ...workspaceRequestOptions(target, deps, signal),
    request: {
      protocolVersion: 1,
      operation: 'import_file',
      workspaceId: target.workspaceId,
      ...(target.workspaceInstanceId ? { workspaceInstanceId: target.workspaceInstanceId } : {}),
      path,
      source: { storage_session_id: source.storage_session_id, id: source.file_id },
      bytes: digest.bytes,
      sha256: digest.sha256,
      overwrite: false,
    },
  });
  if (result.operation !== 'import_file') {
    throw new WorkspaceToolHttpError('invalid');
  }
  return result.path;
}

function workspaceRequestOptions(
  target: ImportTarget,
  deps: WorkspaceAttachmentDeps,
  signal: AbortSignal,
): Omit<Parameters<typeof executeWorkspaceTool>[0], 'request'> {
  return {
    baseURL: target.context.baseUrl,
    authHeaders: () => codeExecutionAuthHeaders(deps.getAuthHeaders, target.context),
    signal,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.codeApiMaxRetryWaitMs == null
      ? {}
      : { codeApiMaxRetryWaitMs: deps.codeApiMaxRetryWaitMs }),
    ...resolveAttachedWorkspaceAdmissionOptions(target.context.codeEnvironmentConfigSchema),
  };
}

async function persistImport({
  file,
  target,
  deps,
  copy,
  digest,
}: {
  file: TFile;
  target: ImportTarget;
  deps: WorkspaceAttachmentDeps;
  copy?: TFileWorkspaceImport;
  digest?: NonNullable<TFileWorkspaceImports['digest']>;
}): Promise<void> {
  const key = target.key;
  const recordedCopy = copy != null && key != null ? { key, target: copy } : undefined;
  if (recordedCopy == null && digest == null) {
    return;
  }
  try {
    await deps.recordImport({
      file_id: file.file_id,
      user: deps.userId,
      tenantId: file.tenantId ?? null,
      ...(recordedCopy ? { copy: recordedCopy } : {}),
      ...(digest ? { digest } : {}),
    });
    const imports = file.metadata?.workspaceImports;
    file.metadata = {
      ...file.metadata,
      workspaceImports: {
        ...imports,
        ...(digest ? { digest } : {}),
        ...(recordedCopy
          ? { targets: { ...imports?.targets, [recordedCopy.key]: recordedCopy.target } }
          : {}),
      },
    };
  } catch (error) {
    logger.warn(
      `[workspaceAttachments] Could not record the import of file ${file.file_id}; it is resent next turn`,
      getSafeErrorMetadata(error),
    );
  }
}

/** Rules that ignore every entry of the folder they sit in. */
const IGNORE_ALL_RULES: ReadonlySet<string> = new Set(['*', '/*', '**', '/**']);

/** Whether a `.gitignore` ignores everything beside it, with no negation re-including a file. */
export function ignoresWholeFolder(content: string): boolean {
  const rules = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  return (
    rules.some((rule) => IGNORE_ALL_RULES.has(rule)) && !rules.some((rule) => rule.startsWith('!'))
  );
}

/**
 * Copies go only where they cannot surface as repository content: the folder's `.gitignore` is
 * created with `*`, never replaced, and an existing one must already ignore the whole folder.
 * Resolves to null when that holds, otherwise to why copies cannot be placed.
 */
async function ensureAttachmentsIgnored({
  target,
  deps,
  signal,
}: {
  target: ImportTarget;
  deps: WorkspaceAttachmentDeps;
  signal: AbortSignal;
}): Promise<WorkspaceAttachmentUnavailableReason | null> {
  const workspace = {
    workspaceId: target.workspaceId,
    ...(target.workspaceInstanceId ? { workspaceInstanceId: target.workspaceInstanceId } : {}),
  };
  try {
    await executeWorkspaceTool({
      ...workspaceRequestOptions(target, deps, signal),
      request: {
        protocolVersion: 1,
        operation: 'write_file',
        ...workspace,
        path: WORKSPACE_ATTACHMENTS_GITIGNORE,
        content: '*\n',
        overwrite: false,
      },
    });
  } catch (error) {
    const reason = classifyIgnoreFailure(error);
    if (reason !== 'conflict') {
      logger.warn(
        `[workspaceAttachments] Could not create ${WORKSPACE_ATTACHMENTS_GITIGNORE} in workspace ${target.workspaceId}: ${reason}`,
        getWorkspaceFailureMetadata(error),
      );
      return reason;
    }
    if (target.context.codeWorkspace?.operations.includes('read_file') !== true) {
      return 'not_ignored';
    }
    try {
      const existing = await executeWorkspaceTool({
        ...workspaceRequestOptions(target, deps, signal),
        request: {
          protocolVersion: 1,
          operation: 'read_file',
          ...workspace,
          path: WORKSPACE_ATTACHMENTS_GITIGNORE,
          maxLines: 200,
        },
      });
      /** A rule past the part read could re-include a file, so only a whole read counts. */
      if (
        existing.operation !== 'read_file' ||
        existing.truncated ||
        !ignoresWholeFolder(existing.content)
      ) {
        return 'not_ignored';
      }
    } catch (readError) {
      logger.warn(
        `[workspaceAttachments] Could not read ${WORKSPACE_ATTACHMENTS_GITIGNORE} in workspace ${target.workspaceId}`,
        getWorkspaceFailureMetadata(readError),
      );
      return classifyImportFailure(readError);
    }
  }
  return null;
}

/**
 * The code-file note for an attached workspace: copied attachments by their workspace path,
 * which every workspace tool can open, and plainly why any other file is not on the machine.
 * The `$LIBRECHAT_CODE_DATA_DIR` path is offered only to an agent that has programmatic Bash.
 */
export function buildWorkspaceAttachmentContext({
  candidates,
  outcomes,
  programmaticBash,
}: {
  candidates: readonly WorkspaceAttachmentCandidate[];
  outcomes: ReadonlyMap<string, WorkspaceAttachmentOutcome>;
  programmaticBash: boolean;
}): string {
  let imported = '';
  let unavailable = '';
  for (const { file, destination, agentScoped } of candidates) {
    const outcome = outcomes.get(file.file_id);
    if (outcome?.status === 'imported') {
      const name = outcome.path.slice(outcome.path.lastIndexOf('/') + 1);
      imported += `\n\t- ${outcome.path}${getCodeFileContextSuffix(file, agentScoped, name)}`;
      continue;
    }
    const reason = UNAVAILABLE_REASONS[outcome?.reason ?? 'unsupported'];
    const programmatic = programmaticBash
      ? `; scripts run by the programmatic Bash tool can read it at $LIBRECHAT_CODE_DATA_DIR/${destination} during that run`
      : '';
    unavailable += `\n\t- ${file.filename}${getCodeFileContextSuffix(
      file,
      agentScoped,
      file.filename,
    )}: ${reason}${programmatic}`;
  }
  const sections: string[] = [];
  if (imported) {
    sections.push(
      `- Note: Attached files are in the workspace at these paths, so every workspace tool (shell, read, search) can open them:${imported}`,
    );
  }
  if (unavailable) {
    sections.push(`- Note: These files are not available on this machine:${unavailable}`);
  }
  return sections.join('\n');
}

export interface WorkspaceAttachmentAgent {
  id: string;
  codeExecutionContext?: CodeExecutionContext;
  /** Files the primed code-file note described, kept structured so it can be rebuilt. */
  codeContextEntries?: CodeContextEntry[];
  provisionState?: ProvisionState;
  fileConsumers?: TurnFileConsumers;
  dynamicToolContextMap?: Record<string, unknown>;
  toolDefinitions?: ReadonlyArray<{ name?: string }>;
  primedCodeFiles?: CodeEnvFile[];
}

/** Late provisioning refs go here so the first code tool call still receives them. */
export interface WorkspaceAttachmentToolContext {
  pendingProvisionedCodeFiles?: CodeEnvFile[];
}

export type ProvisionFiles = (
  toolNames: string[],
  agentId?: string,
  signal?: AbortSignal,
) => Promise<CodeEnvFile[] | void>;

function mergeCodeEnvFiles(
  current: readonly CodeEnvFile[] | undefined,
  added: readonly CodeEnvFile[],
): CodeEnvFile[] {
  const merged = [...(current ?? [])];
  for (const file of added) {
    if (!merged.some((existing) => existing.id === file.id && existing.name === file.name)) {
      merged.push(file);
    }
  }
  return merged;
}

function collectQueuedCandidates(agent: WorkspaceAttachmentAgent): WorkspaceAttachmentCandidate[] {
  const state = agent.provisionState;
  if (state == null || agent.fileConsumers?.executeCode !== true) {
    return [];
  }
  return state.codeEnvFiles.flatMap((file) => {
    const destination = state.codeEnvDestinations?.get(file.file_id) ?? file.filename;
    return isDescribedCodeFile(file, destination)
      ? [{ file, destination, agentScoped: state.agentScopedFileIds.has(file.file_id) }]
      : [];
  });
}

/** Reads the route's stored ref after provisioning wrote it onto the shared record. */
function withProvisionedSource(
  candidate: WorkspaceAttachmentCandidate,
  routeKey: string,
): WorkspaceAttachmentCandidate {
  if (candidate.source != null) {
    return candidate;
  }
  const ref = getCodeEnvRefForProfile(candidate.file.metadata, routeKey);
  if (ref?.storage_session_id == null || ref.file_id == null) {
    return candidate;
  }
  return {
    ...candidate,
    destination: ref.sandboxFilename ?? candidate.destination,
    source: { storage_session_id: ref.storage_session_id, file_id: ref.file_id },
  };
}

/**
 * Uploads queued attachments to the Code API so they can be copied, bounded by `signal`.
 * Refs that arrive in time seed the run's sessions; later ones wait for the first code tool
 * call, exactly as lazily provisioned files do.
 */
async function provisionQueued({
  agent,
  toolContext,
  provisionFiles,
  turnSignal,
  deadline,
}: {
  agent: WorkspaceAttachmentAgent;
  toolContext?: WorkspaceAttachmentToolContext;
  provisionFiles: ProvisionFiles;
  turnSignal?: AbortSignal;
  deadline: AbortSignal;
}): Promise<void> {
  const provisioning = provisionFiles([AgentConstants.READ_FILE], agent.id, turnSignal).then(
    (files) => files ?? [],
  );
  const onTime = await Promise.race([
    provisioning.then(
      (files) => files,
      (error: unknown) => {
        logger.warn(
          `[workspaceAttachments] Provisioning attachments for agent ${agent.id} failed`,
          getSafeErrorMetadata(error),
        );
        return [];
      },
    ),
    whenAborted(deadline).then(() => undefined),
  ]);
  if (onTime != null) {
    agent.primedCodeFiles = mergeCodeEnvFiles(agent.primedCodeFiles, onTime);
    return;
  }
  provisioning
    .then((files) => {
      if (toolContext && files.length > 0) {
        toolContext.pendingProvisionedCodeFiles = mergeCodeEnvFiles(
          toolContext.pendingProvisionedCodeFiles,
          files,
        );
      }
    })
    .catch(() => undefined);
}

/** Overrides for one priming call: a routed subagent brings the exact tool context it runs
 *  in, and a provisioning callback bound to it, rather than the turn's per-agent defaults. */
export interface WorkspaceAttachmentPrimeOptions {
  signal?: AbortSignal;
  toolContexts?: ReadonlyMap<string, WorkspaceAttachmentToolContext>;
  provisionFiles?: ProvisionFiles;
}

/**
 * Primes every agent once per turn, whether it is initialized with the turn or joins later as
 * a lazily selected subagent. `getProvisionFiles` is read at call time, so a callback wrapped
 * after the primer was created is the one used.
 */
export function createWorkspaceAttachmentPrimer({
  toolContexts,
  getProvisionFiles,
  deps,
}: {
  toolContexts?: ReadonlyMap<string, WorkspaceAttachmentToolContext>;
  getProvisionFiles?: () => ProvisionFiles | undefined;
  deps: WorkspaceAttachmentDeps;
}): (
  agents: ReadonlyArray<WorkspaceAttachmentAgent | null | undefined>,
  options?: WorkspaceAttachmentPrimeOptions,
) => Promise<void> {
  const primed = new WeakSet<WorkspaceAttachmentAgent>();
  const turn = createWorkspaceAttachmentTurn(deps.concurrency);
  return (agents, options = {}) => {
    const pending = agents.filter(
      (agent): agent is WorkspaceAttachmentAgent => agent != null && !primed.has(agent),
    );
    for (const agent of pending) {
      primed.add(agent);
    }
    return primeWorkspaceAttachments({
      agents: pending,
      toolContexts: options.toolContexts ?? toolContexts,
      provisionFiles: options.provisionFiles ?? getProvisionFiles?.(),
      signal: options.signal,
      turn,
      deps,
    });
  };
}

/**
 * For agents on an attached workspace, copies the chat's own attachments into
 * `.librechat/attachments/` before the model runs and replaces the code-file note with
 * where they are. Agents that cannot receive them get a note saying so instead of a path
 * only programmatic Bash could open. The whole phase is bounded; whatever is unfinished
 * falls back to that note, and the copy is retried next turn.
 */
export async function primeWorkspaceAttachments({
  agents,
  toolContexts,
  provisionFiles,
  signal,
  deps,
  turn = createWorkspaceAttachmentTurn(deps.concurrency),
}: {
  agents: ReadonlyArray<WorkspaceAttachmentAgent | null | undefined>;
  toolContexts?: ReadonlyMap<string, WorkspaceAttachmentToolContext>;
  provisionFiles?: ProvisionFiles;
  signal?: AbortSignal;
  /** Shared with later priming of the same turn, such as a lazily selected subagent. */
  turn?: WorkspaceAttachmentTurn;
  deps: WorkspaceAttachmentDeps;
}): Promise<void> {
  const eligibleAgents = agents.flatMap((agent) =>
    agent?.codeExecutionContext != null &&
    getCodeFileLocation(agent.codeExecutionContext) === 'programmatic'
      ? [{ agent, context: agent.codeExecutionContext }]
      : [],
  );
  if (eligibleAgents.length === 0) {
    return;
  }
  signal?.throwIfAborted();
  const deadline = new AbortController();
  const timeoutMs = deps.timeoutMs ?? WORKSPACE_ATTACHMENT_IMPORT_TIMEOUT_MS;
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const abortOnTurn = () => deadline.abort(signal?.reason);
  signal?.addEventListener('abort', abortOnTurn, { once: true });
  try {
    await Promise.all(
      eligibleAgents.map(({ agent, context }) =>
        primeAgentAttachments({
          agent,
          context,
          toolContext: toolContexts?.get(agent.id),
          provisionFiles,
          turnSignal: signal,
          deadline: deadline.signal,
          turn,
          deps,
        }).catch((error: unknown) => {
          if (signal?.aborted) {
            throw error;
          }
          /** The primed note still stands; only the copy is skipped this turn. */
          logger.error(
            `[workspaceAttachments] Preparing attachments for agent ${agent.id} failed`,
            getSafeErrorMetadata(error),
          );
        }),
      ),
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortOnTurn);
  }
  signal?.throwIfAborted();
}

async function primeAgentAttachments({
  agent,
  context,
  toolContext,
  provisionFiles,
  turnSignal,
  deadline,
  turn,
  deps,
}: {
  agent: WorkspaceAttachmentAgent;
  context: CodeExecutionContext;
  toolContext?: WorkspaceAttachmentToolContext;
  provisionFiles?: ProvisionFiles;
  turnSignal?: AbortSignal;
  deadline: AbortSignal;
  turn: WorkspaceAttachmentTurn;
  deps: WorkspaceAttachmentDeps;
}): Promise<void> {
  const primed: WorkspaceAttachmentCandidate[] = agent.codeContextEntries ?? [];
  const queued = collectQueuedCandidates(agent);
  if (primed.length === 0 && queued.length === 0) {
    return;
  }
  const policy = resolveWorkspaceAttachmentPolicy(context);
  const owned = (candidate: WorkspaceAttachmentCandidate): boolean =>
    !candidate.agentScoped && String(candidate.file.user) === deps.userId;
  const notOwnedReason = (
    candidate: WorkspaceAttachmentCandidate,
  ): WorkspaceAttachmentUnavailableReason => (candidate.agentScoped ? 'agent_file' : 'not_owned');
  if (policy.eligible && provisionFiles && queued.some(owned)) {
    await provisionQueued({ agent, toolContext, provisionFiles, turnSignal, deadline });
  }
  const routeKey = getCodeExecutionRouteKey(context);
  const candidates = [...primed, ...queued.map((item) => withProvisionedSource(item, routeKey))];
  const outcomes = new Map<string, WorkspaceAttachmentOutcome>();
  const importable: WorkspaceAttachmentCandidate[] = [];
  for (const candidate of candidates) {
    if (policy.eligible && owned(candidate) && candidate.source == null) {
      outcomes.set(candidate.file.file_id, {
        status: 'unavailable',
        reason: deadline.aborted ? 'timeout' : 'not_staged',
      });
    } else if (!owned(candidate)) {
      outcomes.set(candidate.file.file_id, {
        status: 'unavailable',
        reason: notOwnedReason(candidate),
      });
    } else if (!policy.eligible) {
      outcomes.set(candidate.file.file_id, { status: 'unavailable', reason: policy.reason });
    } else {
      importable.push(candidate);
    }
  }
  if (importable.length > 0) {
    const imported = await importWorkspaceAttachments({
      context,
      candidates: importable,
      deps,
      signal: deadline,
      turn,
    });
    for (const [fileId, outcome] of imported) {
      outcomes.set(fileId, outcome);
    }
  }
  const note = buildWorkspaceAttachmentContext({
    candidates,
    outcomes,
    programmaticBash:
      agent.toolDefinitions?.some(
        (definition) => definition.name != null && PROGRAMMATIC_TOOL_NAMES.has(definition.name),
      ) === true,
  });
  agent.dynamicToolContextMap ??= {};
  delete agent.dynamicToolContextMap[QUEUED_CODE_FILES_CONTEXT_KEY];
  if (note) {
    agent.dynamicToolContextMap[Tools.execute_code] = note;
  } else {
    delete agent.dynamicToolContextMap[Tools.execute_code];
  }
  if (agent.provisionState) {
    agent.provisionState.describedFileIds = new Set(
      candidates.map((candidate) => candidate.file.file_id),
    );
  }
}
