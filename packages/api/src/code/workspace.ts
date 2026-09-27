import {
  CODE_ENVIRONMENT_ADMISSION_MAX_MS,
  CODE_ENVIRONMENT_QUEUE_WAIT_DEFAULT_MS,
  CODE_ENVIRONMENT_REQUEST_TIMEOUT_HARD_MAX_MS,
} from 'librechat-data-provider';
import type { CodeBridgeFetch } from './bridge';

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
]);
const TEXT_EDIT_KEYS = new Set(['oldText', 'newText']);

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
}

export interface WorkspaceEditRequest {
  protocolVersion: 1;
  operation: 'edit_file';
  workspaceId: string;
  workspaceInstanceId?: string;
  path: string;
  edits: WorkspaceTextEdit[];
  expectedBaseSha256?: string;
}

export interface WorkspacePreviewEditRequest {
  protocolVersion: 1;
  operation: 'preview_edit';
  workspaceId: string;
  workspaceInstanceId?: string;
  path: string;
  edits: WorkspaceTextEdit[];
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
  constructor(
    public readonly reason: 'rejected' | 'invalid' | 'timeout' | 'failed' | 'insufficient_time',
    public readonly upstreamStatus?: number,
    public readonly upstreamBody?: string,
    public readonly upstreamBodyTruncated = false,
  ) {
    let message = `Workspace tool request ${reason}`;
    if (
      reason === 'rejected' &&
      isWorkspaceAdmissionTimeout(upstreamStatus, upstreamBody, upstreamBodyTruncated)
    ) {
      message =
        'Workspace capacity was unavailable before the queue deadline. The operation was not started. Wait for active work to finish or select an independent workspace on a machine with available capacity.';
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
  }
}

function isWorkspaceAdmissionTimeout(status?: number, body?: string, truncated = false): boolean {
  if (status !== 503 || !body || truncated || body.length > MAX_ERROR_BODY_BYTES) {
    return false;
  }
  try {
    const parsed: { code?: string } | null = JSON.parse(body);
    return parsed?.code === 'WORKSPACE_QUEUE_TIMEOUT';
  } catch {
    return false;
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

function workspaceAdmissionRetryDelay(value: string | null): number {
  if (value == null || !/^\d+$/.test(value)) return WORKSPACE_QUEUE_RETRY_DELAY_MS;
  return Math.max(100, Math.min(Number(value) * 1_000, WORKSPACE_QUEUE_TIMEOUT_MS));
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
      !isUtf8StringWithinBytes(edit.newText, WORKSPACE_WRITE_MAX_BYTES)
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
    return isSafePath(request.path) && areValidWorkspaceEdits(request.edits);
  }
  if (request.operation === 'edit_file') {
    return (
      isSafePath(request.path) &&
      areValidWorkspaceEdits(request.edits) &&
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
      Number(value.bytesWritten) <= WORKSPACE_WRITE_MAX_BYTES
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
      Number(value.bytesWritten) <= WORKSPACE_WRITE_MAX_BYTES
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

export async function executeWorkspaceTool({
  baseURL,
  authHeaders,
  request,
  signal,
  fetchImpl = fetch,
  maxQueueWaitMs = WORKSPACE_QUEUE_MAX_WAIT_MS,
  maxRequestTimeoutMs,
  deadlineAtMs,
}: {
  baseURL: string;
  authHeaders: WorkspaceToolAuthHeaders;
  request: WorkspaceToolRequest;
  signal?: AbortSignal;
  fetchImpl?: CodeBridgeFetch;
  maxQueueWaitMs?: number;
  /** End-to-end HTTP budget for this call. Omission keeps legacy per-attempt timeouts. */
  maxRequestTimeoutMs?: number;
  /** Optional earlier caller deadline; a signal alone has no remaining-time value. */
  deadlineAtMs?: number;
}): Promise<WorkspaceToolResult> {
  if (
    !isValidRequest(request) ||
    !Number.isSafeInteger(maxQueueWaitMs) ||
    maxQueueWaitMs < 0 ||
    maxQueueWaitMs > WORKSPACE_QUEUE_MAX_WAIT_MS ||
    (maxRequestTimeoutMs !== undefined &&
      (!Number.isSafeInteger(maxRequestTimeoutMs) ||
        maxRequestTimeoutMs < 1 ||
        maxRequestTimeoutMs > CODE_ENVIRONMENT_REQUEST_TIMEOUT_HARD_MAX_MS)) ||
    (deadlineAtMs !== undefined && (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs < 1))
  ) {
    throw new WorkspaceToolHttpError('invalid');
  }
  const executionBudgetMs = getWorkspaceExecutionBudgetMs(request);
  const completionReserveMs = executionBudgetMs + WORKSPACE_COMMAND_TRANSPORT_GRACE_MS;
  const perAttemptTimeoutMs = maxRequestTimeoutMs ?? getWorkspaceToolTimeoutMs(request);
  const callerDeadlineAt = Math.min(
    deadlineAtMs ?? Infinity,
    maxRequestTimeoutMs == null ? Infinity : Date.now() + maxRequestTimeoutMs,
  );
  const queueDeadlineAt = Date.now() + maxQueueWaitMs;
  const retryDeadlineAt = Math.min(queueDeadlineAt, callerDeadlineAt - completionReserveMs);
  const body = JSON.stringify(request);
  let lastAdmissionRejection: WorkspaceToolHttpError | undefined;
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
      if (lastAdmissionRejection && Date.now() >= retryDeadlineAt) {
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
        if (
          !isWorkspaceAdmissionTimeout(response.status, body, truncated) ||
          Date.now() >= queueDeadlineAt
        ) {
          throw rejection;
        }
        const delayMs = Math.min(
          workspaceAdmissionRetryDelay(response.headers.get('Retry-After')),
          retryDeadlineAt - Date.now(),
        );
        lastAdmissionRejection = rejection;
        if (delayMs <= 0) throw rejection;
        await waitForWorkspaceAdmission(delayMs, signal);
        /** A clamped delay can land exactly on either deadline. Never open
         * another admission window without the full execution reserve. */
        if (Date.now() >= retryDeadlineAt) {
          throw rejection;
        }
        continue;
      }
      const result = await readBoundedJson(response, requestSignal);
      if (!isValidResult(request, result)) {
        throw new WorkspaceToolHttpError('invalid');
      }
      return result;
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
