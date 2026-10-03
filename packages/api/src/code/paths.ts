import type { WorkspaceToolHttpError } from './workspace';

/** The attached file tools whose path rejections LibreChat explains to the model. */
export type WorkspacePathOperation = 'read' | 'write' | 'edit' | 'search' | 'list';

/**
 * `missing`: the worker reports the path absent, as `NOT_FOUND` or, through a Code API that
 * predates that code, as `INVALID_PATH` with the same message. `unusable`: an older worker's
 * `INVALID_PATH`, which it also returns for a file that does not exist.
 */
type WorkspacePathRejection = 'missing' | 'unusable';

const WORKSPACE_PATH_MISSING_MESSAGE = 'Workspace path does not exist';

/** Older workers cannot tell a missing file from an unusable path, so only these get that hint. */
const LEGACY_REJECTION_OPERATIONS: ReadonlySet<WorkspacePathOperation> = new Set([
  'read',
  'write',
  'edit',
]);

function getWorkspacePathRejection(
  error: WorkspaceToolHttpError,
): WorkspacePathRejection | undefined {
  if (error.reason !== 'rejected' || error.upstreamStatus !== 422 || !error.upstreamBody) {
    return undefined;
  }
  try {
    const parsed: { code?: unknown; error?: unknown } | null = JSON.parse(error.upstreamBody);
    if (parsed?.code === 'NOT_FOUND') return 'missing';
    if (parsed?.code !== 'INVALID_PATH') return undefined;
    return parsed.error === WORKSPACE_PATH_MISSING_MESSAGE ? 'missing' : 'unusable';
  } catch {
    return undefined;
  }
}

function describeMissingPath(operation: WorkspacePathOperation, displayPath: string): string {
  const quoted = JSON.stringify(displayPath);
  if (operation === 'write') {
    return `A parent directory of ${quoted} does not exist. Create it first (for example with mkdir -p), then retry.`;
  }
  if (operation === 'search' || operation === 'list') {
    return `${quoted} does not exist. List a parent directory to find the right path.`;
  }
  return `${quoted} does not exist. If a command is still writing it, wait for that command to finish before reading it again; otherwise list its directory to find the right path.`;
}

function describeUnusablePath(operation: WorkspacePathOperation, displayPath: string): string {
  const quoted = JSON.stringify(displayPath);
  if (operation === 'write') {
    return `The worker could not write ${quoted}. Its parent directory may not exist yet, so create it first (for example with mkdir -p) and retry; otherwise the path is a symlink or passes through one.`;
  }
  return `The worker could not open ${quoted}. The file may not exist yet (a command may still be writing it), or the path is a directory or a symlink, or passes through one. List its directory to check before retrying.`;
}

/**
 * Appends a short explanation to a worker's path rejection so the model can tell a file that
 * does not exist yet from a malformed path. Other rejections are returned unchanged.
 */
export function explainWorkspacePathRejection(
  error: WorkspaceToolHttpError,
  operation: WorkspacePathOperation,
  displayPath: string,
): WorkspaceToolHttpError {
  const rejection = getWorkspacePathRejection(error);
  if (rejection === 'missing') {
    error.message += `. ${describeMissingPath(operation, displayPath)}`;
  } else if (rejection === 'unusable' && LEGACY_REJECTION_OPERATIONS.has(operation)) {
    error.message += `. ${describeUnusablePath(operation, displayPath)}`;
  }
  return error;
}
