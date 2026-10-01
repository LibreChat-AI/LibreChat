import {
  CODE_ENVIRONMENT_ADMISSION_MAX_MS,
  CODE_ENVIRONMENT_COMMAND_ADMISSION_DEFAULT_MS,
  CODE_ENVIRONMENT_QUEUE_WAIT_DEFAULT_MS,
  CODE_ENVIRONMENT_REQUEST_TIMEOUT_HARD_MAX_MS,
} from 'librechat-data-provider';
import type { WorkspaceEditMatch, WorkspaceEditMatching } from './edits';
import type { CodeBridgeFetch } from './bridge';
import { CODE_API_RATE_LIMIT_WAIT_DEFAULT_MS } from './limits';
import { WORKSPACE_EDIT_MATCH_STRATEGIES } from './edits';

const WORKSPACE_TOOL_TIMEOUT_MS = 30_000;
const MAX_PATH_LENGTH = 4096;
const MAX_QUERY_LENGTH = 4096;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_READ_LINES = 500;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_TEXT_LENGTH = 2000;
const MAX_LIST_RESULTS = 500;
export const WORKSPACE_WRITE_MAX_BYTES: number = 1024 * 1024;
export const WORKSPACE_EDIT_MAX_COUNT: number = 100;
const MAX_COMMAND_BYTES = 32 * 1024;
/** Keep aligned with data-provider's deployment schema defaults and hard cap. */
export const WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS: number = 30_000;
export const WORKSPACE_COMMAND_MAX_TIMEOUT_MS: number = 5 * 60_000;
const DEFAULT_COMMAND_OUTPUT_BYTES = 256 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_COMMAND_SIGNAL_LENGTH = 32;
const WORKSPACE_COMMAND_TRANSPORT_GRACE_MS = 5_000;
/** Legacy admission window and Retry-After cap, independent of the retry horizon. */
const WORKSPACE_QUEUE_TIMEOUT_MS = 30_000;
const WORKSPACE_QUEUE_WAIT_HEADER = 'X-LibreChat-Workspace-Queue-Wait-Ms';
/** Compatibility export; the deployment schema owns the default and hard cap. */
export const WORKSPACE_QUEUE_MAX_WAIT_MS: number = CODE_ENVIRONMENT_QUEUE_WAIT_DEFAULT_MS;
const WORKSPACE_QUEUE_RETRY_DELAY_MS = 1_000;
const WORKSPACE_COMMAND_SETTLEMENT_GRACE_MS = 5_000;

/**
 * Longest command timeout a total HTTP budget can carry: the budget minus settlement and delivery
 * grace and a minimum admission allowance. A command whose reserve reaches the budget is refused
 * before dispatch, so a larger ceiling would only advertise timeouts that can never start.
 */
export function fitWorkspaceCommandTimeoutToBudget(
  maxRequestTimeoutMs: number,
  minCommandAdmissionMs: number = CODE_ENVIRONMENT_COMMAND_ADMISSION_DEFAULT_MS,
): number {
  return Math.max(
    1,
    maxRequestTimeoutMs -
      WORKSPACE_COMMAND_SETTLEMENT_GRACE_MS -
      WORKSPACE_COMMAND_TRANSPORT_GRACE_MS -
      minCommandAdmissionMs,
  );
}
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 4096;
const ERROR_BODY_TIMEOUT_MS = 1000;
const READ_RESULT_KEYS = new Set([
  'protocolVersion',
  'operation',
  'workspaceId',
  'path',
  'content',
  'startLine',
  'endLine',
  'truncated',
  'nextStartLine',
]);
const SEARCH_RESULT_KEYS = new Set([
  'protocolVersion',
  'operation',
  'workspaceId',
  'matches',
  'truncated',
]);
const SEARCH_MATCH_KEYS = new Set(['path', 'line', 'column', 'text']);
const LIST_RESULT_KEYS = new Set([
  'protocolVersion',
  'operation',
  'workspaceId',
  'paths',
  'truncated',
  'nextAfterPath',
]);
const COMMAND_RESULT_KEYS = new Set([
  'protocolVersion',
  'operation',
  'workspaceId',
  'exitCode',
  'signal',
  'stdout',
  'stderr',
  'truncated',
  'timedOut',
]);
const WRITE_RESULT_KEYS = new Set([
  'protocolVersion',
  'operation',
  'workspaceId',
  'path',
  'created',
  'bytesWritten',
]);
const EDIT_RESULT_KEYS = new Set([
  'protocolVersion',
  'operation',
  'workspaceId',
  'path',
  'replacements',
  'bytesWritten',
  'matches',
]);
const PREVIEW_EDIT_RESULT_KEYS = new Set([
  'protocolVersion',
  'operation',
  'workspaceId',
  'path',
  'content',
  'hasUtf8Bom',
  'baseSha256',
  'replacements',
  'bytesWritten',
  'matches',
]);
const TEXT_EDIT_KEYS = new Set(['oldText', 'newText', 'replaceAll']);
const EDIT_MATCH_KEYS = new Set(['strategy', 'occurrences']);

export interface WorkspaceReadRequest {
  protocolVersion: 1;
  operation: 'read_file';
  workspaceId: string;
  workspaceInstanceId?: string;
  path: string;
  startLine?: number;
  maxLines?: number;
  instructionSha256?: string;
}

export interface WorkspaceSearchRequest {
  protocolVersion: 1;
  operation: 'search_text';
  workspaceId: string;
  workspaceInstanceId?: string;
  query: string;
  path?: string;
  maxResults?: number;
}

export interface WorkspaceListRequest {
  protocolVersion: 1;
  operation: 'list_files';
  workspaceId: string;
  workspaceInstanceId?: string;
  path?: string;
  maxResults?: number;
  afterPath?: string;
}

export interface WorkspaceExecuteCommandRequest {
  protocolVersion: 1;
  operation: 'execute_command';
  workspaceId: string;
  workspaceInstanceId?: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  environmentAction?: { name: string; fingerprint: string };
}

export interface WorkspaceWriteRequest {
  protocolVersion: 1;
  operation: 'write_file';
  workspaceId: string;
  workspaceInstanceId?: string;
  path: string;
  content: string;
  overwrite?: boolean;
}

export interface WorkspaceTextEdit {
  oldText: string;
  newText: string;
  /** Requires the worker's `replace_all` edit feature. */
  replaceAll?: boolean;
}

export interface WorkspaceEditRequest {
  protocolVersion: 1;
  operation: 'edit_file';
  workspaceId: string;
  workspaceInstanceId?: string;
  path: string;
  edits: WorkspaceTextEdit[];
  expectedBaseSha256?: string;
  /** Requires the worker's `tolerant_match` edit feature. */
  matching?: WorkspaceEditMatching;
}

export interface WorkspacePreviewEditRequest {
  protocolVersion: 1;
  operation: 'preview_edit';
  workspaceId: string;
  workspaceInstanceId?: string;
  path: string;
  edits: WorkspaceTextEdit[];
  /** Requires the worker's `tolerant_match` edit feature. */
  matching?: WorkspaceEditMatching;
}

export type WorkspaceToolRequest =
  | WorkspaceReadRequest
  | WorkspaceSearchRequest
  | WorkspaceListRequest
  | WorkspaceWriteRequest
  | WorkspacePreviewEditRequest
  | WorkspaceEditRequest
  | WorkspaceExecuteCommandRequest;

export interface WorkspaceReadResult {
  protocolVersion: 1;
  operation: 'read_file';
  workspaceId: string;
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
  nextStartLine?: number;
}

export interface WorkspaceSearchResult {
  protocolVersion: 1;
  operation: 'search_text';
  workspaceId: string;
  matches: Array<{ path: string; line: number; column: number; text: string }>;
  truncated: boolean;
}

export interface WorkspaceListResult {
  protocolVersion: 1;
  operation: 'list_files';
  workspaceId: string;
  paths: string[];
  truncated: boolean;
  nextAfterPath?: string;
}

export interface WorkspaceExecuteCommandResult {
  protocolVersion: 1;
  operation: 'execute_command';
  workspaceId: string;
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface WorkspaceWriteResult {
  protocolVersion: 1;
  operation: 'write_file';
  workspaceId: string;
  path: string;
  created: boolean;
  bytesWritten: number;
}

export interface WorkspaceEditResult {
  protocolVersion: 1;
  operation: 'edit_file';
  workspaceId: string;
  path: string;
  replacements: number;
  bytesWritten: number;
  matches?: WorkspaceEditMatch[];
}

export interface WorkspacePreviewEditResult {
  protocolVersion: 1;
  operation: 'preview_edit';
  workspaceId: string;
  path: string;
  content: string;
  hasUtf8Bom: boolean;
  baseSha256: string;
  replacements: number;
  bytesWritten: number;
  matches?: WorkspaceEditMatch[];
}

export type WorkspaceToolResult =
  | WorkspaceReadResult
  | WorkspaceSearchResult
  | WorkspaceListResult
  | WorkspaceWriteResult
  | WorkspacePreviewEditResult
  | WorkspaceEditResult
  | WorkspaceExecuteCommandResult;

export class WorkspaceToolHttpError extends Error {
  /**
   * The worker's own explanation of a rejected edit (`EDIT_CONFLICT`), which current workers
   * phrase for the model: which edits failed, why, and where. Absent for other failures.
   */
  public readonly editConflict?: string;

  constructor(
    public readonly reason: 'rejected' | 'invalid' | 'timeout' | 'failed' | 'insufficient_time',
    public readonly upstreamStatus?: number,
    public readonly upstreamBody?: string,
    public readonly upstreamBodyTruncated = false,
  ) {
    let message = `Workspace tool request ${reason}`;
    const admissionRejection =
      reason === 'rejected'
        ? getWorkspaceAdmissionRejection(upstreamStatus, upstreamBody, upstreamBodyTruncated)
        : undefined;
    if (admissionRejection === 'queue_timeout') {
      message =
        'Workspace capacity was unavailable before the queue deadline. The operation was not started. Wait for active work to finish or select an independent workspace on a machine with available capacity.';
    }
    if (admissionRejection === 'rate_limited') {
      message =
        'The Code API request rate limit was reached. The operation was not started. Wait a few seconds before retrying, or make fewer concurrent workspace calls.';
    }
    if (reason === 'insufficient_time') {
      message =
        'Workspace execution cannot fit within the remaining HTTP budget. The operation was not started.';
    }
    super(
      message +
        (upstreamStatus == null ? '' : ` (upstreamStatus: ${upstreamStatus})`) +
        (upstreamBody ? `; upstreamBody: ${JSON.stringify(upstreamBody)}` : '') +
        (upstreamBodyTruncated ? ' [body truncated or incomplete]' : ''),
    );
    this.name = 'WorkspaceToolHttpError';
    this.editConflict =
      reason === 'rejected' ? getEditConflict(upstreamStatus, upstreamBody) : undefined;
  }
}

function getEditConflict(status?: number, body?: string): string | undefined {
  if (status !== 409 || !body) {
    return undefined;
  }
  try {
    const parsed: { code?: unknown; error?: unknown } | null = JSON.parse(body);
    return parsed?.code === 'EDIT_CONFLICT' && typeof parsed.error === 'string'
      ? parsed.error
      : undefined;
  } catch {
    return undefined;
  }
}

type WorkspaceAdmissionRejection = 'queue_timeout' | 'rate_limited';

/**
 * Rejections the Code API issues before an operation is assigned, so retrying cannot repeat a
 * mutation: a queue deadline that expired before admission, or its rate limiter, which runs as
 * middleware ahead of the workspace router. Anything else, including an unparsable body under
 * either status, keeps an unknown outcome and is never retried.
 */
function getWorkspaceAdmissionRejection(
  status?: number,
  body?: string,
  truncated = false,
): WorkspaceAdmissionRejection | undefined {
  if (
    (status !== 503 && status !== 429) ||
    !body ||
    truncated ||
    body.length > MAX_ERROR_BODY_BYTES
  ) {
    return undefined;
  }
  try {
    const parsed: { code?: string; error?: string } | null = JSON.parse(body);
    if (status === 503 && parsed?.code === 'WORKSPACE_QUEUE_TIMEOUT') {
      return 'queue_timeout';
    }
    if (status === 429 && parsed?.error === 'rate_limited') {
      return 'rate_limited';
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function waitForWorkspaceAdmission(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const finish = () => {
      cleanup();
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted === true) abort();
  });
}

function workspaceAdmissionRetryDelay(value: string | null, rateLimitBody?: string): number {
  if (value != null && /^\d+$/.test(value)) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
      return Math.max(100, Math.min(seconds * 1_000, WORKSPACE_QUEUE_TIMEOUT_MS));
    }
  }
  if (rateLimitBody) {
    try {
      const parsed: { retry_after_seconds?: number } | null = JSON.parse(rateLimitBody);
      const seconds = parsed?.retry_after_seconds;
      if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
        return Math.max(100, Math.min(seconds * 1_000, WORKSPACE_QUEUE_TIMEOUT_MS));
      }
    } catch {
      // Fall back when the delay hint is unusable.
    }
  }
  return WORKSPACE_QUEUE_RETRY_DELAY_MS;
}

/** Keep a received HTTP status even if reading its diagnostic body fails or stalls. */
async function readErrorBody(
  response: Response,
  signal: AbortSignal,
): Promise<{
  body: string;
  truncated: boolean;
}> {
  if (!response.body) return { body: '', truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let bytes = 0;
  let complete = false;
  let interrupted = false;
  const cancel = () => {
    interrupted = true;
    void reader.cancel().catch(() => undefined);
  };
  const timer = setTimeout(cancel, ERROR_BODY_TIMEOUT_MS);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) return { body, truncated: true };
    while (bytes <= MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        complete = !interrupted;
        body += decoder.decode();
        break;
      }
      const remaining = MAX_ERROR_BODY_BYTES - bytes;
      body += decoder.decode(value.subarray(0, remaining), { stream: true });
      bytes += value.byteLength;
    }
  } catch {
    complete = false;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
  return { body, truncated: !complete || signal.aborted };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null;
}

function isSafePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    !value.includes('\0') &&
    !value.includes('\r') &&
    !value.includes('\n') &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !/^[A-Za-z]:/.test(value) &&
    value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

function isPositiveInteger(value: unknown, maximum: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= maximum;
}

function isUtf8StringWithinBytes(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    Buffer.from(value).toString('utf8') === value &&
    new TextEncoder().encode(value).byteLength <= maximum
  );
}

function areValidWorkspaceEdits(edits: unknown): edits is WorkspaceTextEdit[] {
  if (!Array.isArray(edits)) return false;
  if (edits.length < 1 || edits.length > WORKSPACE_EDIT_MAX_COUNT) return false;
  let bytes = 0;
  for (const edit of edits) {
    if (
      !isRecord(edit) ||
      !hasOnlyKeys(edit, TEXT_EDIT_KEYS) ||
      !isUtf8StringWithinBytes(edit.oldText, WORKSPACE_WRITE_MAX_BYTES) ||
      edit.oldText.length === 0 ||
      !isUtf8StringWithinBytes(edit.newText, WORKSPACE_WRITE_MAX_BYTES) ||
      (edit.replaceAll !== undefined && typeof edit.replaceAll !== 'boolean')
    ) {
      return false;
    }
    bytes +=
      new TextEncoder().encode(edit.oldText).byteLength +
      new TextEncoder().encode(edit.newText).byteLength;
    if (bytes > WORKSPACE_WRITE_MAX_BYTES) return false;
  }
  return true;
}

function isValidEditMatching(matching: unknown): boolean {
  return matching === undefined || matching === 'exact' || matching === 'tolerant';
}

/** Whether an edit request opted into per-edit match reporting (and so must receive it). */
function reportsEditMatches(request: WorkspaceEditRequest | WorkspacePreviewEditRequest): boolean {
  return (
    request.matching !== undefined || request.edits.some((edit) => edit.replaceAll !== undefined)
  );
}

function areValidEditMatches(
  request: WorkspaceEditRequest | WorkspacePreviewEditRequest,
  matches: unknown,
): boolean {
  if (!reportsEditMatches(request)) {
    return matches === undefined;
  }
  return (
    Array.isArray(matches) &&
    matches.length === request.edits.length &&
    matches.every(
      (match, index) =>
        isRecord(match) &&
        hasOnlyKeys(match, EDIT_MATCH_KEYS) &&
        typeof match.strategy === 'string' &&
        WORKSPACE_EDIT_MATCH_STRATEGIES.has(match.strategy) &&
        (request.matching === 'tolerant' || match.strategy === 'exact') &&
        isPositiveInteger(match.occurrences, Number.MAX_SAFE_INTEGER) &&
        (request.edits[index]?.replaceAll === true || match.occurrences === 1),
    )
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizeRelativePath(value: string): string {
  return value
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
}

function isWithinRequestedPath(candidate: string, requestedPath: string | undefined): boolean {
  const prefix = requestedPath == null ? '' : normalizeRelativePath(requestedPath);
  if (prefix === '') return true;
  const normalizedCandidate = normalizeRelativePath(candidate);
  return normalizedCandidate === prefix || normalizedCandidate.startsWith(`${prefix}/`);
}

function comparePortablePaths(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

async function readBoundedJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new WorkspaceToolHttpError('invalid');
  }

  if (!response.body) {
    throw new WorkspaceToolHttpError('invalid');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let body = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new WorkspaceToolHttpError('invalid');
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body) as unknown;
  } catch (error) {
    if (error instanceof WorkspaceToolHttpError) throw error;
    if (
      signal?.aborted === true &&
      (error === signal.reason ||
        (isRecord(error) && (error.name === 'AbortError' || error.name === 'TimeoutError')))
    ) {
      throw signal.reason ?? error;
    }
    if (isRecord(error) && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw error;
    }
    throw new WorkspaceToolHttpError('invalid');
  } finally {
    reader.releaseLock();
  }
}

function isValidRequest(request: WorkspaceToolRequest): boolean {
  if (
    request.protocolVersion !== 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.workspaceId) ||
    (request.workspaceInstanceId !== undefined &&
      !/^[a-f0-9]{64}$/.test(request.workspaceInstanceId))
  ) {
    return false;
  }
  if (request.operation === 'read_file') {
    if (request.instructionSha256 !== undefined) {
      return (
        /^[a-f0-9]{64}$/.test(request.instructionSha256) &&
        (request.path === 'AGENTS.md' || request.path === 'CLAUDE.md') &&
        request.startLine === undefined &&
        request.maxLines === undefined
      );
    }
    return (
      isSafePath(request.path) &&
      (request.startLine == null ||
        isPositiveInteger(request.startLine, Number.MAX_SAFE_INTEGER)) &&
      (request.maxLines == null || isPositiveInteger(request.maxLines, MAX_READ_LINES))
    );
  }
  if (request.operation === 'list_files') {
    return (
      (request.path == null || isSafePath(request.path)) &&
      (request.afterPath == null ||
        (isSafePath(request.afterPath) &&
          isWithinRequestedPath(request.afterPath, request.path))) &&
      (request.maxResults == null || isPositiveInteger(request.maxResults, MAX_LIST_RESULTS))
    );
  }
  if (request.operation === 'execute_command') {
    return (
      isUtf8StringWithinBytes(request.command, MAX_COMMAND_BYTES) &&
      request.command.trim().length > 0 &&
      !request.command.includes('\0') &&
      (request.cwd == null || isSafePath(request.cwd)) &&
      (request.timeoutMs == null ||
        isPositiveInteger(request.timeoutMs, WORKSPACE_COMMAND_MAX_TIMEOUT_MS)) &&
      (request.maxOutputBytes == null ||
        isPositiveInteger(request.maxOutputBytes, MAX_COMMAND_OUTPUT_BYTES))
    );
  }
  if (request.operation === 'write_file') {
    return (
      isSafePath(request.path) &&
      isUtf8StringWithinBytes(request.content, WORKSPACE_WRITE_MAX_BYTES) &&
      (request.overwrite === undefined || typeof request.overwrite === 'boolean')
    );
  }
  if (request.operation === 'preview_edit') {
    return (
      isSafePath(request.path) &&
      areValidWorkspaceEdits(request.edits) &&
      isValidEditMatching(request.matching)
    );
  }
  if (request.operation === 'edit_file') {
    return (
      isSafePath(request.path) &&
      areValidWorkspaceEdits(request.edits) &&
      isValidEditMatching(request.matching) &&
      (request.expectedBaseSha256 == null || /^[a-f0-9]{64}$/.test(request.expectedBaseSha256))
    );
  }
  if (request.operation !== 'search_text') {
    return false;
  }
  return (
    typeof request.query === 'string' &&
    request.query.length > 0 &&
    request.query.length <= MAX_QUERY_LENGTH &&
    !request.query.includes('\0') &&
    (request.path == null || isSafePath(request.path)) &&
    (request.maxResults == null || isPositiveInteger(request.maxResults, MAX_SEARCH_RESULTS))
  );
}

function isValidResult(
  request: WorkspaceToolRequest,
  value: unknown,
): value is WorkspaceToolResult {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 1 ||
    value.operation !== request.operation ||
    value.workspaceId !== request.workspaceId
  ) {
    return false;
  }
  if (request.operation === 'read_file') {
    if (request.instructionSha256 !== undefined) {
      return (
        hasOnlyKeys(value, READ_RESULT_KEYS) &&
        value.path === request.path &&
        typeof value.content === 'string' &&
        Buffer.byteLength(value.content) <= 32768 &&
        value.startLine === 1 &&
        value.endLine === value.content.split('\n').length &&
        typeof value.truncated === 'boolean' &&
        value.nextStartLine === undefined
      );
    }
    const startLine = request.startLine ?? 1;
    const maxLines = request.maxLines ?? 200;
    const content = typeof value.content === 'string' ? value.content : null;
    const reportedLineCount =
      Number.isSafeInteger(value.endLine) && Number(value.endLine) >= startLine - 1
        ? Number(value.endLine) - startLine + 1
        : -1;
    let actualLineCount = -1;
    if (content != null) {
      actualLineCount = content.length === 0 ? reportedLineCount : content.split('\n').length;
    }
    return (
      hasOnlyKeys(value, READ_RESULT_KEYS) &&
      value.path === request.path &&
      isSafePath(value.path) &&
      content != null &&
      typeof value.truncated === 'boolean' &&
      new TextEncoder().encode(content).byteLength <= MAX_READ_BYTES &&
      value.startLine === startLine &&
      Number.isSafeInteger(value.endLine) &&
      Number(value.endLine) >= startLine - 1 &&
      Number(value.endLine) < startLine + maxLines &&
      reportedLineCount >= 0 &&
      reportedLineCount <= maxLines &&
      (content.length !== 0 || reportedLineCount <= 1) &&
      actualLineCount === reportedLineCount &&
      (value.truncated === true
        ? Number.isSafeInteger(value.nextStartLine) &&
          Number(value.nextStartLine) === Number(value.endLine) + 1
        : value.nextStartLine == null)
    );
  }
  if (request.operation === 'list_files') {
    const maxResults = request.maxResults ?? 100;
    if (
      !hasOnlyKeys(value, LIST_RESULT_KEYS) ||
      typeof value.truncated !== 'boolean' ||
      !Array.isArray(value.paths) ||
      value.paths.length > maxResults
    ) {
      return false;
    }
    let previousPath = request.afterPath;
    for (const path of value.paths) {
      if (
        !isSafePath(path) ||
        !isWithinRequestedPath(path, request.path) ||
        (previousPath != null && comparePortablePaths(path, previousPath) <= 0)
      ) {
        return false;
      }
      previousPath = path;
    }
    return value.truncated === true
      ? value.paths.length > 0 && value.nextAfterPath === value.paths[value.paths.length - 1]
      : value.nextAfterPath == null;
  }
  if (request.operation === 'execute_command') {
    const stdout = typeof value.stdout === 'string' ? value.stdout : null;
    const stderr = typeof value.stderr === 'string' ? value.stderr : null;
    const outputLimit = request.maxOutputBytes ?? DEFAULT_COMMAND_OUTPUT_BYTES;
    return (
      hasOnlyKeys(value, COMMAND_RESULT_KEYS) &&
      typeof value.truncated === 'boolean' &&
      stdout != null &&
      stderr != null &&
      Buffer.from(stdout).toString('utf8') === stdout &&
      Buffer.from(stderr).toString('utf8') === stderr &&
      new TextEncoder().encode(stdout).byteLength + new TextEncoder().encode(stderr).byteLength <=
        outputLimit &&
      (value.exitCode === null ||
        (Number.isSafeInteger(value.exitCode) &&
          Number(value.exitCode) >= 0 &&
          Number(value.exitCode) <= 255)) &&
      (value.signal == null ||
        (typeof value.signal === 'string' &&
          value.signal.length <= MAX_COMMAND_SIGNAL_LENGTH &&
          /^SIG[A-Z0-9]+$/.test(value.signal))) &&
      typeof value.timedOut === 'boolean' &&
      (value.exitCode === null
        ? value.timedOut === true || value.signal != null
        : value.timedOut === false && value.signal == null)
    );
  }
  if (request.operation === 'write_file') {
    return (
      hasOnlyKeys(value, WRITE_RESULT_KEYS) &&
      value.path === request.path &&
      typeof value.created === 'boolean' &&
      (request.overwrite !== false || value.created === true) &&
      Number.isSafeInteger(value.bytesWritten) &&
      Number(value.bytesWritten) === new TextEncoder().encode(request.content).byteLength
    );
  }
  if (request.operation === 'edit_file') {
    return (
      hasOnlyKeys(value, EDIT_RESULT_KEYS) &&
      value.path === request.path &&
      value.replacements === request.edits.length &&
      Number.isSafeInteger(value.bytesWritten) &&
      Number(value.bytesWritten) >= 0 &&
      Number(value.bytesWritten) <= WORKSPACE_WRITE_MAX_BYTES &&
      areValidEditMatches(request, value.matches)
    );
  }
  if (request.operation === 'preview_edit') {
    const content = typeof value.content === 'string' ? value.content : null;
    return (
      hasOnlyKeys(value, PREVIEW_EDIT_RESULT_KEYS) &&
      value.path === request.path &&
      content != null &&
      Buffer.from(content).toString('utf8') === content &&
      typeof value.hasUtf8Bom === 'boolean' &&
      /^[a-f0-9]{64}$/.test(typeof value.baseSha256 === 'string' ? value.baseSha256 : '') &&
      value.replacements === request.edits.length &&
      Number.isSafeInteger(value.bytesWritten) &&
      Number(value.bytesWritten) ===
        new TextEncoder().encode(content).byteLength + (value.hasUtf8Bom ? 3 : 0) &&
      Number(value.bytesWritten) <= WORKSPACE_WRITE_MAX_BYTES &&
      areValidEditMatches(request, value.matches)
    );
  }
  const maxResults = request.maxResults ?? 50;
  return (
    hasOnlyKeys(value, SEARCH_RESULT_KEYS) &&
    typeof value.truncated === 'boolean' &&
    Array.isArray(value.matches) &&
    value.matches.length <= maxResults &&
    value.matches.every(
      (match) =>
        isRecord(match) &&
        hasOnlyKeys(match, SEARCH_MATCH_KEYS) &&
        isSafePath(match.path) &&
        isWithinRequestedPath(match.path, request.path) &&
        isPositiveInteger(match.line, Number.MAX_SAFE_INTEGER) &&
        isPositiveInteger(match.column, Number.MAX_SAFE_INTEGER) &&
        typeof match.text === 'string' &&
        match.text.length <= MAX_SEARCH_TEXT_LENGTH,
    )
  );
}

function getWorkspaceExecutionBudgetMs(request: WorkspaceToolRequest): number {
  return request.operation === 'execute_command'
    ? (request.timeoutMs ?? WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS) +
        WORKSPACE_COMMAND_SETTLEMENT_GRACE_MS
    : WORKSPACE_TOOL_TIMEOUT_MS;
}

function getWorkspaceToolTimeoutMs(request: WorkspaceToolRequest): number {
  return (
    WORKSPACE_QUEUE_TIMEOUT_MS +
    getWorkspaceExecutionBudgetMs(request) +
    WORKSPACE_COMMAND_TRANSPORT_GRACE_MS
  );
}

/**
 * Credentials for one admission attempt. A supplier is minted per attempt, so a
 * call that stays queued past the Code API token TTL presents a fresh token
 * instead of failing permanently with 401 while capacity is still pending.
 */
export type WorkspaceToolAuthHeaders =
  | Record<string, string>
  | (() => Promise<Record<string, string>> | Record<string, string>);

function getWorkspaceAuthHeaders(
  supplier: () => Promise<Record<string, string>> | Record<string, string>,
  signal: AbortSignal,
): Promise<Record<string, string>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    try {
      void Promise.resolve(supplier())
        .then(resolve, reject)
        .finally(() => {
          signal.removeEventListener('abort', abort);
        });
    } catch (error) {
      signal.removeEventListener('abort', abort);
      reject(error);
    }
  });
}

/** Linked worktrees live at `.worktrees/<name>` beneath a registered checkout. */
const LINKED_WORKTREE_DIRECTORY = '.worktrees/';
/** Mirrors Code API's single-segment worktree name rule. */
const LINKED_WORKTREE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type LinkedWorktreeRequest = WorkspaceToolRequest & { worktree: string };

interface LinkedWorktreePath {
  worktree: string;
  /** Path relative to the worktree root; empty for the worktree root itself. */
  rest: string;
}

function splitLinkedWorktreePath(path: string | undefined): LinkedWorktreePath | undefined {
  if (path == null || !path.startsWith(LINKED_WORKTREE_DIRECTORY)) return undefined;
  const remainder = path.slice(LINKED_WORKTREE_DIRECTORY.length);
  const slash = remainder.indexOf('/');
  const worktree = slash === -1 ? remainder : remainder.slice(0, slash);
  if (!LINKED_WORKTREE_NAME_PATTERN.test(worktree) || worktree.endsWith('.lock')) {
    return undefined;
  }
  return { worktree, rest: slash === -1 ? '' : remainder.slice(slash + 1) };
}

function prefixed(worktree: string, path: string): string {
  return `${LINKED_WORKTREE_DIRECTORY}${worktree}/${path}`;
}

/**
 * Route a request that targets `.worktrees/<name>/…` into that worktree's own
 * scheduling lane, so work in sibling worktrees runs concurrently. Only
 * structural targets are routed: a file path, a search or listing scope, or a
 * command `cwd`. Anything else, including a command that `cd`s into a worktree
 * from the root, stays root-scoped because its reach cannot be bounded.
 */
export function toLinkedWorktreeRequest(
  request: WorkspaceToolRequest,
): { request: LinkedWorktreeRequest; worktree: string } | undefined {
  if (request.workspaceInstanceId != null) return undefined;
  switch (request.operation) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'preview_edit': {
      if (request.operation === 'read_file' && request.instructionSha256 != null) return undefined;
      const target = splitLinkedWorktreePath(request.path);
      if (target == null || target.rest === '') return undefined;
      return {
        worktree: target.worktree,
        request: { ...request, path: target.rest, worktree: target.worktree },
      };
    }
    case 'search_text': {
      const target = splitLinkedWorktreePath(request.path);
      if (target == null) return undefined;
      const { path: _path, ...rest } = request;
      return {
        worktree: target.worktree,
        request: {
          ...rest,
          ...(target.rest === '' ? {} : { path: target.rest }),
          worktree: target.worktree,
        },
      };
    }
    case 'list_files': {
      const target = splitLinkedWorktreePath(request.path);
      if (target == null) return undefined;
      const after =
        request.afterPath == null ? undefined : splitLinkedWorktreePath(request.afterPath);
      if (
        request.afterPath != null &&
        (after == null || after.worktree !== target.worktree || after.rest === '')
      ) {
        return undefined;
      }
      const { path: _path, afterPath: _afterPath, ...rest } = request;
      return {
        worktree: target.worktree,
        request: {
          ...rest,
          ...(target.rest === '' ? {} : { path: target.rest }),
          ...(after == null ? {} : { afterPath: after.rest }),
          worktree: target.worktree,
        },
      };
    }
    case 'execute_command': {
      if (request.environmentAction != null) return undefined;
      const target = splitLinkedWorktreePath(request.cwd);
      if (target == null) return undefined;
      const { cwd: _cwd, ...rest } = request;
      return {
        worktree: target.worktree,
        request: {
          ...rest,
          ...(target.rest === '' ? {} : { cwd: target.rest }),
          worktree: target.worktree,
        },
      };
    }
  }
}

/** Restore the `.worktrees/<name>/` prefix on every path a lane result reports. */
export function fromLinkedWorktreeResult(
  result: WorkspaceToolResult,
  worktree: string,
): WorkspaceToolResult {
  switch (result.operation) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'preview_edit':
      return { ...result, path: prefixed(worktree, result.path) };
    case 'search_text':
      return {
        ...result,
        matches: result.matches.map((match) => ({
          ...match,
          path: prefixed(worktree, match.path),
        })),
      };
    case 'list_files':
      return {
        ...result,
        paths: result.paths.map((path) => prefixed(worktree, path)),
        ...(result.nextAfterPath == null
          ? {}
          : { nextAfterPath: prefixed(worktree, result.nextAfterPath) }),
      };
    case 'execute_command':
      return result;
  }
}

export async function executeWorkspaceTool({
  baseURL,
  authHeaders,
  request,
  signal,
  fetchImpl = fetch,
  maxQueueWaitMs = WORKSPACE_QUEUE_MAX_WAIT_MS,
  codeApiMaxRetryWaitMs = CODE_API_RATE_LIMIT_WAIT_DEFAULT_MS,
  maxRequestTimeoutMs,
  deadlineAtMs,
  linkedWorktrees = false,
}: {
  baseURL: string;
  authHeaders: WorkspaceToolAuthHeaders;
  request: WorkspaceToolRequest;
  signal?: AbortSignal;
  fetchImpl?: CodeBridgeFetch;
  maxQueueWaitMs?: number;
  /** Maximum time waiting for Code API rate-limit admission, independent of queue retries. */
  codeApiMaxRetryWaitMs?: number;
  /** End-to-end HTTP budget for this call. Omission keeps legacy per-attempt timeouts. */
  maxRequestTimeoutMs?: number;
  /** Optional earlier caller deadline; a signal alone has no remaining-time value. */
  deadlineAtMs?: number;
  /** The worker runs each `.worktrees/<name>` in its own lane; route matching requests there. */
  linkedWorktrees?: boolean;
}): Promise<WorkspaceToolResult> {
  if (
    !isValidRequest(request) ||
    !Number.isSafeInteger(maxQueueWaitMs) ||
    maxQueueWaitMs < 0 ||
    maxQueueWaitMs > WORKSPACE_QUEUE_MAX_WAIT_MS ||
    !Number.isSafeInteger(codeApiMaxRetryWaitMs) ||
    codeApiMaxRetryWaitMs < 0 ||
    codeApiMaxRetryWaitMs > 300_000 ||
    (maxRequestTimeoutMs !== undefined &&
      (!Number.isSafeInteger(maxRequestTimeoutMs) ||
        maxRequestTimeoutMs < 1 ||
        maxRequestTimeoutMs > CODE_ENVIRONMENT_REQUEST_TIMEOUT_HARD_MAX_MS)) ||
    (deadlineAtMs !== undefined && (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs < 1))
  ) {
    throw new WorkspaceToolHttpError('invalid');
  }
  const lane = linkedWorktrees === true ? toLinkedWorktreeRequest(request) : undefined;
  const wireRequest: WorkspaceToolRequest = lane?.request ?? request;
  const executionBudgetMs = getWorkspaceExecutionBudgetMs(wireRequest);
  const completionReserveMs = executionBudgetMs + WORKSPACE_COMMAND_TRANSPORT_GRACE_MS;
  const perAttemptTimeoutMs = maxRequestTimeoutMs ?? getWorkspaceToolTimeoutMs(wireRequest);
  const callerDeadlineAt = Math.min(
    deadlineAtMs ?? Infinity,
    maxRequestTimeoutMs == null ? Infinity : Date.now() + maxRequestTimeoutMs,
  );
  const queueDeadlineAt = Date.now() + maxQueueWaitMs;
  const callerRetryDeadlineAt = callerDeadlineAt - completionReserveMs;
  const body = JSON.stringify(wireRequest);
  let lastAdmissionRejection: WorkspaceToolHttpError | undefined;
  let lastRetryDeadlineAt = Infinity;
  let rateLimitWaitedMs = 0;
  while (true) {
    try {
      signal?.throwIfAborted();
      /** Admission and retries cannot consume the reserved execution or delivery time. */
      const attemptTimeoutMs = Math.floor(
        Math.min(perAttemptTimeoutMs, callerDeadlineAt - Date.now()),
      );
      if (attemptTimeoutMs <= completionReserveMs) {
        throw lastAdmissionRejection ?? new WorkspaceToolHttpError('insufficient_time');
      }
      const attemptStartedAt = Date.now();
      const timeoutSignal = AbortSignal.timeout(attemptTimeoutMs);
      const requestSignal =
        signal != null && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal;
      let attemptHeaders: Record<string, string>;
      try {
        attemptHeaders =
          typeof authHeaders === 'function'
            ? await getWorkspaceAuthHeaders(authHeaders, requestSignal)
            : authHeaders;
      } catch (error) {
        if (timeoutSignal.aborted && signal?.aborted !== true) {
          throw lastAdmissionRejection ?? new WorkspaceToolHttpError('insufficient_time');
        }
        throw error;
      }
      signal?.throwIfAborted();
      if (timeoutSignal.aborted) {
        throw lastAdmissionRejection ?? new WorkspaceToolHttpError('insufficient_time');
      }
      if (lastAdmissionRejection && Date.now() >= lastRetryDeadlineAt) {
        throw lastAdmissionRejection;
      }
      const remainingMs = Math.min(
        attemptTimeoutMs - (Date.now() - attemptStartedAt),
        callerDeadlineAt - Date.now(),
      );
      const queueAllowanceMs = Math.min(
        CODE_ENVIRONMENT_ADMISSION_MAX_MS,
        Math.floor(remainingMs - completionReserveMs),
      );
      if (queueAllowanceMs < 1) {
        throw lastAdmissionRejection ?? new WorkspaceToolHttpError('insufficient_time');
      }
      const response = await fetchImpl(
        `${baseURL.trim().replace(/\/+$/, '')}/workspace-tools/execute`,
        {
          method: 'POST',
          headers: {
            ...attemptHeaders,
            'Content-Type': 'application/json',
            [WORKSPACE_QUEUE_WAIT_HEADER]: String(queueAllowanceMs),
          },
          body,
          redirect: 'error',
          signal: requestSignal,
        },
      );
      if (!response.ok) {
        const { body, truncated } = await readErrorBody(response, requestSignal);
        signal?.throwIfAborted();
        const rejection = new WorkspaceToolHttpError('rejected', response.status, body, truncated);
        const admission = getWorkspaceAdmissionRejection(response.status, body, truncated);
        if (admission == null) throw rejection;
        const retryDeadlineAt = Math.min(
          admission === 'queue_timeout' ? queueDeadlineAt : Infinity,
          callerRetryDeadlineAt,
        );
        if (Date.now() >= retryDeadlineAt) throw rejection;
        const retryAfterMs = workspaceAdmissionRetryDelay(
          response.headers.get('Retry-After'),
          admission === 'rate_limited' ? body : undefined,
        );
        if (
          admission === 'rate_limited' &&
          retryAfterMs > codeApiMaxRetryWaitMs - rateLimitWaitedMs
        ) {
          throw rejection;
        }
        const delayMs = Math.min(retryAfterMs, retryDeadlineAt - Date.now());
        lastAdmissionRejection = rejection;
        lastRetryDeadlineAt = retryDeadlineAt;
        if (delayMs <= 0) throw rejection;
        const waitStartedAt = Date.now();
        await waitForWorkspaceAdmission(delayMs, signal);
        if (admission === 'rate_limited') {
          /** A timer may run late. Charge the actual wait, but honor the retry that
           * was authorized before waiting; another 429 cannot exceed the balance. */
          rateLimitWaitedMs += Math.max(retryAfterMs, Date.now() - waitStartedAt);
        }
        /** A clamped delay can land exactly on this admission's retry deadline. Never open
         * another admission window without the full execution reserve. */
        if (Date.now() >= retryDeadlineAt) {
          throw rejection;
        }
        continue;
      }
      const result = await readBoundedJson(response, requestSignal);
      if (!isValidResult(wireRequest, result)) {
        throw new WorkspaceToolHttpError('invalid');
      }
      return lane ? fromLinkedWorktreeResult(result, lane.worktree) : result;
    } catch (error) {
      if (error instanceof WorkspaceToolHttpError) throw error;
      if (
        signal?.aborted === true &&
        (error === signal.reason || (isRecord(error) && error.name === 'AbortError'))
      ) {
        throw error;
      }
      if (isRecord(error) && error.name === 'TimeoutError') {
        throw new WorkspaceToolHttpError('timeout');
      }
      throw new WorkspaceToolHttpError('failed');
    }
  }
}
