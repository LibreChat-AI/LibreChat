import path from 'path';
import crypto from 'crypto';
import { Types } from 'mongoose';
import { logger, tenantStorage } from '@librechat/data-schemas';
import {
  ResourceType,
  PrincipalType,
  AccessRoleIds,
  SKILL_SYNC_DEFAULT_DISCOVERY_DEPTH,
} from 'librechat-data-provider';
import type {
  ISkill,
  ISkillFile,
  ValidationIssue,
  ISkillSyncSkippedFile,
  ISkillSyncSkippedSkill,
  CreateSkillInput,
  UpdateSkillInput,
  CreateSkillResult,
  UpdateSkillResult,
  UpsertSkillFileInput,
  ISkillSyncStatus,
  SkillSyncProvider,
  SkillSyncCredentialSummary,
  SkillSyncStatusInput,
  DeleteSkillResult,
} from '@librechat/data-schemas';
import type { SkillSyncConfig, SkillSyncGitHubSourceConfig } from 'librechat-data-provider';
import type {
  RepoCommit,
  RepoTreeEntry,
  GitRepoAdapter,
  AssertNotCancelled,
} from './adapters/types';
import type { GitHubRepoAdapterConfig } from './adapters/github';
import {
  GITHUB_FINE_GRAINED_TOKEN_RECOMMENDATION,
  createGitHubRepoAdapter,
} from './adapters/github';
import { DEFAULT_SKILL_IMPORT_LIMITS } from '../limits';
import { parseSkillMarkdown } from '../parse';
import { normalizeRepoPath } from './path';
import { SkillSyncError } from './errors';

const SYSTEM_AUTHOR_NAME = 'GitHub Sync';

let systemAuthorId: Types.ObjectId | undefined;

/** Constructed on demand so importing this module never depends on a live mongoose binding. */
function getSystemAuthorId(): Types.ObjectId {
  systemAuthorId ??= new Types.ObjectId('000000000000000000000000');
  return systemAuthorId;
}
const PROVIDER: SkillSyncProvider = 'github';
const LOCK_LEASE_MS = 30 * 60 * 1000;
/** Keeps a pathological source from writing an unbounded status document. */
const MAX_RECORDED_SKIPPED_SKILLS = 20;
/** Same bound for files, which a single malformed source can produce far more of. */
const MAX_RECORDED_SKIPPED_FILES = 20;
const UNSUPPORTED_FILE_PATH_CODE = 'SKILL_FILE_PATH_UNSUPPORTED';
const UNSUPPORTED_FILE_PATH_MESSAGE =
  'File path uses characters that skill file paths cannot represent';
/** Shared cap for skipped-skill and successful-skill validation warning logs. */
const MAX_LOGGED_PER_SKILL_WARNINGS = 20;
const SKIP_PATH_MAX = 500;
const SKIP_NAME_MAX = 128;
const SKIP_MESSAGE_MAX = 500;
const VALIDATION_ISSUE_LIMIT = 5;
const VALIDATION_ISSUE_FIELD_MAX = 100;
const VALIDATION_ISSUE_CODE_MAX = 64;
const VALIDATION_ISSUE_MESSAGE_MAX = 250;

export { GITHUB_FINE_GRAINED_TOKEN_RECOMMENDATION };
export type { GitHubRepoAdapterConfig };

type FetchFn = typeof fetch;

type SyncCounters = {
  syncedSkillCount: number;
  syncedFileCount: number;
  deletedSkillCount: number;
  deletedFileCount: number;
  skippedSkillCount: number;
  skippedFileCount: number;
};

type DiscoveredSkill = {
  rootPath: string;
  skillMd: RepoTreeEntry;
  files: RepoTreeEntry[];
  /**
   * Repository paths under the skill root that exist upstream but cannot be
   * mirrored, because their path is not representable as a skill file path.
   * Dropping them silently would publish a skill that looks complete while
   * missing files, so they are carried out to the sync status instead.
   */
  unsupportedFiles: string[];
};

type UpsertRemoteSkillResult = {
  skill: ISkill & { _id: Types.ObjectId };
  created: boolean;
  warnings?: ValidationIssue[];
};

type PreparedRemoteSkill = {
  existing: (ISkill & { _id: Types.ObjectId }) | null;
  update: UpdateSkillInput;
  createInput: CreateSkillInput;
};

type PreparedExistingRemoteSkill = PreparedRemoteSkill & {
  existing: ISkill & { _id: Types.ObjectId };
};

type PreparedDiscoveredSkill = {
  discovered: DiscoveredSkill;
  prepared: PreparedRemoteSkill;
};

type SaveBufferResult = {
  filepath: string;
  source: string;
  storageKey?: string;
  storageRegion?: string;
};

type StoredSkillFileRef = {
  filepath: string;
  source: string;
  storageKey?: string;
  storageRegion?: string;
  author?: Types.ObjectId | string;
  tenantId?: string;
};

type DeletedSyncedSkillJournal = {
  skill: ISkill & { _id: Types.ObjectId };
  files: Array<ISkillFile & { _id: Types.ObjectId }>;
};

type SyncSkillFilesJournal = {
  staleFiles: StoredSkillFileRef[];
  savedFiles: StoredSkillFileRef[];
};

type SyncSkillFilesResult = Pick<SyncCounters, 'syncedFileCount' | 'deletedFileCount'> &
  SyncSkillFilesJournal;

type MaybePromise<T> = T | Promise<T>;

export type GitHubSkillSyncDeps = {
  getConfig: () => MaybePromise<SkillSyncConfig | undefined>;
  getCredentialToken: (
    provider: SkillSyncProvider,
    credentialKey: string,
  ) => Promise<string | null>;
  getCredentialSummary: (
    provider: SkillSyncProvider,
    credentialKey: string,
  ) => Promise<SkillSyncCredentialSummary | null>;
  listCredentials: (provider: SkillSyncProvider) => Promise<SkillSyncCredentialSummary[]>;
  listStatuses: (provider: SkillSyncProvider) => Promise<ISkillSyncStatus[]>;
  upsertStatus: (input: SkillSyncStatusInput) => Promise<ISkillSyncStatus>;
  tryAcquireLock: (params: {
    provider: SkillSyncProvider;
    lockOwner: string;
    leaseMs: number;
    tenantId?: string;
  }) => Promise<boolean>;
  refreshLock: (params: {
    provider: SkillSyncProvider;
    lockOwner: string;
    leaseMs: number;
    tenantId?: string;
  }) => Promise<boolean>;
  releaseLock: (params: {
    provider: SkillSyncProvider;
    lockOwner: string;
    tenantId?: string;
  }) => Promise<void>;
  createSkill: (data: CreateSkillInput) => Promise<CreateSkillResult>;
  updateSkill: (params: {
    id: string;
    expectedVersion: number;
    update: UpdateSkillInput;
  }) => Promise<UpdateSkillResult>;
  getSkillById: (id: string | Types.ObjectId) => Promise<(ISkill & { _id: Types.ObjectId }) | null>;
  findSkillBySourceIdentity: (params: {
    source: 'github' | 'notion';
    upstreamId: string;
    tenantId?: string;
  }) => Promise<(ISkill & { _id: Types.ObjectId }) | null>;
  listSkillsBySource: (params: {
    source: 'github' | 'notion';
    sourceId: string;
  }) => Promise<Array<ISkill & { _id: Types.ObjectId }>>;
  listSkillFiles: (
    skillId: string | Types.ObjectId,
  ) => Promise<Array<ISkillFile & { _id: Types.ObjectId }>>;
  getSkillFileByPath: (
    skillId: string | Types.ObjectId,
    relativePath: string,
  ) => Promise<(ISkillFile & { _id: Types.ObjectId }) | null>;
  upsertSkillFile: (row: UpsertSkillFileInput) => Promise<ISkillFile & { _id: Types.ObjectId }>;
  deleteSkillFile: (
    skillId: string | Types.ObjectId,
    relativePath: string,
  ) => Promise<{ deleted: boolean }>;
  deleteSkill: (id: string) => Promise<DeleteSkillResult>;
  saveBuffer: (params: {
    userId: string;
    buffer: Buffer;
    fileName: string;
    basePath?: string;
    isImage?: boolean;
    tenantId?: string;
  }) => Promise<SaveBufferResult>;
  deleteFile?: (file: {
    filepath: string;
    source: string;
    storageKey?: string;
    storageRegion?: string;
    user?: Types.ObjectId | string;
    tenantId?: string;
  }) => Promise<void>;
  grantPermission: (params: {
    principalType: string;
    principalId: string | Types.ObjectId | null;
    resourceType: string;
    resourceId: string | Types.ObjectId;
    accessRoleId: string;
    grantedBy: string | Types.ObjectId;
  }) => Promise<unknown>;
  fetchFn?: FetchFn;
  /**
   * Builds the repository client a source is synced through. Defaults to the
   * GitHub adapter; overridable so the orchestration can be exercised against a
   * fake repository without standing up provider HTTP responses.
   */
  createAdapter?: (config: GitHubRepoAdapterConfig) => GitRepoAdapter;
  lockOwner?: string;
  allowServerCredentials?: boolean;
};

export type GitHubSkillSyncRunResult = {
  status: 'started' | 'skipped' | 'completed' | 'failed';
  message?: string;
  sources: Array<ISkillSyncStatus & { credentialPresent?: boolean }>;
};

export type GitHubSkillSyncStatus = {
  enabled: boolean;
  intervalMinutes: number;
  runOnStartup: boolean;
  sources: Array<ISkillSyncStatus & { credentialPresent: boolean }>;
  credentials: SkillSyncCredentialSummary[];
  fineGrainedTokenRecommendation: string;
};

export type GitHubSkillSyncRunner = {
  getStatus: () => Promise<GitHubSkillSyncStatus>;
  runOnce: () => Promise<GitHubSkillSyncRunResult>;
};

function isSafeRelativePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.startsWith('\\')) {
    return false;
  }
  if (!/^[a-zA-Z0-9._\-/]+$/.test(value)) {
    return false;
  }
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function makeUpstreamId(source: SkillSyncGitHubSourceConfig, rootPath: string): string {
  // Identity is keyed on the stable, admin-controlled source id and the skill's
  // root path only — never owner/repo/ref. Repointing a source to a renamed or
  // replacement repository (or rotating its ref) keeps the same upstream id, so
  // existing mirrors are updated in place instead of being treated as new and
  // colliding on the (name, author, tenantId) uniqueness constraint.
  return `${source.id}:${rootPath}`;
}

function makeSourceAuthorId(source: SkillSyncGitHubSourceConfig): Types.ObjectId {
  // Fold the tenant into the synthetic author so the same source mirrored into
  // different tenants gets distinct author ids (clearer audits, no cross-tenant
  // author collisions). The tenant suffix is omitted when absent so single-tenant
  // author ids stay stable.
  const seed = source.tenantId
    ? `${PROVIDER}:${source.id}:${source.tenantId}`
    : `${PROVIDER}:${source.id}`;
  const digest = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24);
  return new Types.ObjectId(digest);
}

function toSkillName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return normalized || 'github-skill';
}

function getFilename(relativePath: string): string {
  return path.posix.basename(relativePath);
}

function guessMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.js': 'application/javascript',
    '.ts': 'text/typescript',
    '.jsx': 'text/jsx',
    '.tsx': 'text/tsx',
    '.json': 'application/json',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.py': 'text/x-python',
    '.sh': 'application/x-sh',
    '.css': 'text/css',
    '.html': 'text/html',
    '.xml': 'application/xml',
    '.csv': 'text/csv',
    '.toml': 'text/toml',
    '.ini': 'text/ini',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
  };
  return mimeMap[ext] ?? 'application/octet-stream';
}

function toCleanFrontmatter(
  frontmatter: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!frontmatter) {
    return {};
  }
  const clean = { ...frontmatter };
  delete clean.name;
  delete clean.description;
  // Drop a placeholder/non-boolean always-apply (e.g. `always-apply:` or
  // `always-apply: # TODO`, which js-yaml yields as null). Apply the same
  // cleanup to the accepted `alwaysApply` alias so a malformed alias does not
  // survive after the canonical key has already supplied the effective flag.
  // The boolean is already captured in the dedicated alwaysApply field, and
  // persisting a null here would leave ambiguous/invalid frontmatter on the
  // synced skill.
  if ('always-apply' in clean && typeof clean['always-apply'] !== 'boolean') {
    delete clean['always-apply'];
  }
  if ('alwaysApply' in clean && typeof clean.alwaysApply !== 'boolean') {
    delete clean.alwaysApply;
  }
  return clean;
}

function getLimitMegabytes(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

function assertGitHubBlobSize(entry: RepoTreeEntry, relativePath: string): number {
  if (typeof entry.size !== 'number' || !Number.isFinite(entry.size) || entry.size < 0) {
    throw new SkillSyncError(
      'GITHUB_BLOB_SIZE_UNKNOWN',
      `GitHub file "${relativePath}" did not include a valid blob size`,
    );
  }
  if (entry.size > DEFAULT_SKILL_IMPORT_LIMITS.maxSingleFileBytes) {
    throw new SkillSyncError(
      'GITHUB_BLOB_TOO_LARGE',
      `GitHub file "${relativePath}" exceeds the ${getLimitMegabytes(
        DEFAULT_SKILL_IMPORT_LIMITS.maxSingleFileBytes,
      )}MB per-file skill import limit`,
    );
  }
  return entry.size;
}

function assertGitHubBufferSize(buffer: Buffer, relativePath: string): void {
  if (buffer.length <= DEFAULT_SKILL_IMPORT_LIMITS.maxSingleFileBytes) {
    return;
  }
  throw new SkillSyncError(
    'GITHUB_BLOB_TOO_LARGE',
    `GitHub file "${relativePath}" exceeds the ${getLimitMegabytes(
      DEFAULT_SKILL_IMPORT_LIMITS.maxSingleFileBytes,
    )}MB per-file skill import limit`,
  );
}

function assertCumulativeGitHubFileSize(totalBytes: number): void {
  if (totalBytes <= DEFAULT_SKILL_IMPORT_LIMITS.maxDecompressedBytes) {
    return;
  }
  throw new SkillSyncError(
    'GITHUB_PACKAGE_TOO_LARGE',
    `GitHub skill files exceed the ${getLimitMegabytes(
      DEFAULT_SKILL_IMPORT_LIMITS.maxDecompressedBytes,
    )}MB cumulative skill import limit`,
  );
}

function assertGitHubEntryCount(discovered: DiscoveredSkill): void {
  const entryCount = discovered.files.length + 1;
  if (entryCount <= DEFAULT_SKILL_IMPORT_LIMITS.maxEntries) {
    return;
  }
  throw new SkillSyncError(
    'GITHUB_TOO_MANY_FILES',
    `GitHub skill "${discovered.rootPath}" exceeds the ${DEFAULT_SKILL_IMPORT_LIMITS.maxEntries} file skill import limit`,
  );
}

function getSkillMdPath(discovered: DiscoveredSkill): string {
  return discovered.rootPath ? `${discovered.rootPath}/SKILL.md` : 'SKILL.md';
}

function getDiscoveredRelativePath(discovered: DiscoveredSkill, entry: RepoTreeEntry): string {
  const prefix = discovered.rootPath ? `${discovered.rootPath}/` : '';
  const normalized = normalizeRepoPath(entry.path);
  return prefix ? normalized.slice(prefix.length) : normalized;
}

function assertGitHubSkillPackageManifest(discovered: DiscoveredSkill): void {
  assertGitHubEntryCount(discovered);
  assertGitHubBlobSize(discovered.skillMd, getSkillMdPath(discovered));
  let totalFileBytes = 0;
  for (const entry of discovered.files) {
    const relativePath = getDiscoveredRelativePath(discovered, entry);
    if (!isSafeRelativePath(relativePath) || relativePath.toUpperCase() === 'SKILL.MD') {
      continue;
    }
    totalFileBytes += assertGitHubBlobSize(entry, relativePath);
    assertCumulativeGitHubFileSize(totalFileBytes);
  }
}

function getSourceMetadataString(
  row: { sourceMetadata?: Record<string, unknown> },
  key: string,
): string | undefined {
  const metadata = row.sourceMetadata;
  const value = metadata && typeof metadata === 'object' ? metadata[key] : undefined;
  return typeof value === 'string' ? value : undefined;
}

function serializeDate(date: Date): string {
  return date.toISOString();
}

function redactErrorText(value: string): string {
  return value.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

function escapeDiagnosticControlCharacters(value: string): string {
  let escaped = '';
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (
      !(
        (codePoint >= 0 && codePoint <= 0x1f) ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        codePoint === 0x2028 ||
        codePoint === 0x2029
      )
    ) {
      escaped += character;
      continue;
    }
    switch (character) {
      case '\n':
        escaped += '\\n';
        break;
      case '\r':
        escaped += '\\r';
        break;
      case '\t':
        escaped += '\\t';
        break;
      default:
        escaped += `\\u${codePoint.toString(16).padStart(4, '0')}`;
    }
  }
  return escaped;
}

function sanitizeDiagnosticText(value: string): string {
  return escapeDiagnosticControlCharacters(redactErrorText(value));
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function summarizeValidationIssues(issues: unknown): string | undefined {
  if (!Array.isArray(issues)) {
    return undefined;
  }
  const summaries: string[] = [];
  for (const rawIssue of issues.slice(0, VALIDATION_ISSUE_LIMIT)) {
    if (!rawIssue || typeof rawIssue !== 'object') {
      continue;
    }
    const issue = rawIssue as Partial<ValidationIssue>;
    if (
      typeof issue.field !== 'string' ||
      typeof issue.code !== 'string' ||
      typeof issue.message !== 'string'
    ) {
      continue;
    }
    const field = truncateText(sanitizeDiagnosticText(issue.field), VALIDATION_ISSUE_FIELD_MAX);
    const code = truncateText(sanitizeDiagnosticText(issue.code), VALIDATION_ISSUE_CODE_MAX);
    const message = truncateText(
      sanitizeDiagnosticText(issue.message),
      VALIDATION_ISSUE_MESSAGE_MAX,
    );
    summaries.push(`${field} [${code}]: ${message}`);
  }
  if (summaries.length === 0) {
    return undefined;
  }
  if (issues.length > VALIDATION_ISSUE_LIMIT) {
    summaries.push(`+${issues.length - VALIDATION_ISSUE_LIMIT} more issue(s)`);
  }
  return summaries.join('; ');
}

function sanitizeError(error: unknown): { code: string; message: string } {
  if (error instanceof SkillSyncError) {
    return { code: error.code, message: sanitizeDiagnosticText(error.message) };
  }
  if (error instanceof Error) {
    const message = sanitizeDiagnosticText(error.message);
    const validationError = error as Error & { code?: unknown; issues?: unknown };
    if (validationError.code === 'SKILL_VALIDATION_FAILED') {
      const issueSummary = summarizeValidationIssues(validationError.issues);
      return {
        code: 'SKILL_VALIDATION_FAILED',
        message: truncateSkipMessage(issueSummary ? `${message}: ${issueSummary}` : message),
      };
    }
    return {
      code: 'SYNC_FAILED',
      message,
    };
  }
  return { code: 'SYNC_FAILED', message: 'Unknown skill sync failure' };
}

/**
 * Failures that say nothing more in this run can succeed: the lock is gone, or
 * GitHub is refusing every request. They abort the source instead of being
 * charged to the skill that happened to hit them first. Everything else is
 * scoped to one skill and only skips that skill.
 */
const SOURCE_FATAL_ERROR_CODES = new Set([
  'SYNC_LOCK_LOST',
  'GITHUB_AUTH_FAILED',
  'GITHUB_RATE_LIMITED',
  'GITHUB_REQUEST_FAILED',
  'SYNC_ROLLBACK_FAILED',
]);

/**
 * A skill that fails and rolls back cleanly is just a skipped skill. One whose
 * rollback also fails leaves a half-written mirror behind, and reporting that
 * as `partial` alongside the skills that did publish would bury it, so it ends
 * the source instead.
 */
function makeRollbackFailure(error: unknown): SkillSyncError {
  return new SkillSyncError(
    'SYNC_ROLLBACK_FAILED',
    `Rollback failed after: ${sanitizeError(error).message}`,
  );
}

function makeStaleDeletionFailure(error: unknown): SkillSyncError {
  return new SkillSyncError(
    'SYNC_ROLLBACK_FAILED',
    `Stale mirror deletion failed: ${sanitizeError(error).message}`,
  );
}

function isSourceFatalError(error: unknown): boolean {
  return error instanceof SkillSyncError && SOURCE_FATAL_ERROR_CODES.has(error.code);
}

function truncateSkipMessage(message: string): string {
  const sanitized = escapeDiagnosticControlCharacters(message);
  return sanitized.length > SKIP_MESSAGE_MAX
    ? `${sanitized.slice(0, SKIP_MESSAGE_MAX - 1)}…`
    : sanitized;
}

function truncateSkipPath(path: string): string {
  const sanitized = escapeDiagnosticControlCharacters(path);
  return sanitized.length > SKIP_PATH_MAX ? `${sanitized.slice(0, SKIP_PATH_MAX - 1)}…` : sanitized;
}

function truncateSkipName(name: string | undefined): string | undefined {
  if (!name) {
    return name;
  }
  const sanitized = escapeDiagnosticControlCharacters(name);
  return sanitized.length > SKIP_NAME_MAX ? `${sanitized.slice(0, SKIP_NAME_MAX - 1)}…` : sanitized;
}

/**
 * Merges the recursive listings of every configured path into one entry set.
 * Configured paths may nest, so entries are deduplicated on their normalized
 * repository path rather than concatenated.
 */
async function fetchConfiguredTreeEntries(params: {
  adapter: GitRepoAdapter;
  commit: RepoCommit;
  source: SkillSyncGitHubSourceConfig;
  assertNotCancelled: AssertNotCancelled;
}): Promise<RepoTreeEntry[]> {
  const entriesByPath = new Map<string, RepoTreeEntry>();
  for (const repoPath of params.source.paths) {
    const entries = await params.adapter.fetchTreeEntries(params.commit, {
      pathPrefix: repoPath,
      assertNotCancelled: params.assertNotCancelled,
    });
    for (const entry of entries) {
      const normalizedPath = normalizeRepoPath(entry.path);
      entriesByPath.set(normalizedPath, { ...entry, path: normalizedPath });
    }
  }
  return [...entriesByPath.values()];
}

function isSkillRootWithinDiscoveryDepth(
  rootPath: string,
  basePath: string,
  maxDepth: number,
): boolean {
  if (rootPath === basePath) {
    return true;
  }
  if (basePath && !rootPath.startsWith(`${basePath}/`)) {
    return false;
  }
  const relative = basePath ? rootPath.slice(basePath.length).replace(/^\/+/, '') : rootPath;
  if (!relative) {
    return true;
  }
  return relative.split('/').length <= maxDepth;
}

function discoverSkills(
  tree: RepoTreeEntry[],
  source: SkillSyncGitHubSourceConfig,
): DiscoveredSkill[] {
  const basePaths = source.paths.map(normalizeRepoPath);
  const skillDiscoveryDepth = source.skillDiscoveryDepth ?? SKILL_SYNC_DEFAULT_DISCOVERY_DEPTH;
  const skillMdByRoot = new Map<string, RepoTreeEntry>();
  for (const entry of tree) {
    if (entry.type !== 'blob') {
      continue;
    }
    const normalized = normalizeRepoPath(entry.path);
    const basename = path.posix.basename(normalized);
    if (basename.toUpperCase() !== 'SKILL.MD') {
      continue;
    }
    const parent = normalizeRepoPath(path.posix.dirname(normalized));
    for (const basePath of basePaths) {
      if (isSkillRootWithinDiscoveryDepth(parent, basePath, skillDiscoveryDepth)) {
        skillMdByRoot.set(parent, entry);
      }
    }
  }

  const skillRoots = [...skillMdByRoot.keys()];
  return [...skillMdByRoot.entries()].map(([rootPath, skillMd]) => {
    const prefix = rootPath ? `${rootPath}/` : '';
    const childSkillRoots = skillRoots.filter((candidate) => {
      if (!candidate || candidate === rootPath) {
        return false;
      }
      return rootPath ? candidate.startsWith(`${rootPath}/`) : true;
    });
    const files: RepoTreeEntry[] = [];
    const unsupportedFiles: string[] = [];
    for (const entry of tree) {
      if (entry.type !== 'blob') {
        continue;
      }
      const normalized = normalizeRepoPath(entry.path);
      if (!normalized.startsWith(prefix) || normalized === skillMd.path) {
        continue;
      }
      if (childSkillRoots.some((childRoot) => normalized.startsWith(`${childRoot}/`))) {
        continue;
      }
      const relativePath = prefix ? normalized.slice(prefix.length) : normalized;
      if (relativePath.toUpperCase() === 'SKILL.MD') {
        continue;
      }
      if (!isSafeRelativePath(relativePath)) {
        unsupportedFiles.push(normalized);
        continue;
      }
      files.push(entry);
    }
    return { rootPath, skillMd, files, unsupportedFiles };
  });
}

function assertConfiguredPathsExist(
  tree: RepoTreeEntry[],
  source: SkillSyncGitHubSourceConfig,
): void {
  for (const configuredPath of source.paths.map(normalizeRepoPath)) {
    if (configuredPath === '') {
      continue;
    }
    const exists = tree.some((entry) => {
      const entryPath = normalizeRepoPath(entry.path);
      return entryPath === configuredPath || entryPath.startsWith(`${configuredPath}/`);
    });
    if (!exists) {
      throw new SkillSyncError(
        'GITHUB_PATH_NOT_FOUND',
        `Configured GitHub skill path "${configuredPath}" was not found`,
      );
    }
  }
}

function makeStatusInput(params: {
  source: SkillSyncGitHubSourceConfig;
  status: SkillSyncStatusInput['status'];
  startedAt?: Date;
  finishedAt?: Date;
  errorCode?: string;
  errorMessage?: string;
  counts?: Partial<SyncCounters>;
  skippedSkills?: ISkillSyncSkippedSkill[];
  skippedFiles?: ISkillSyncSkippedFile[];
}): SkillSyncStatusInput {
  return {
    provider: PROVIDER,
    sourceId: params.source.id,
    tenantId: params.source.tenantId,
    status: params.status,
    credentialKey: params.source.credentialKey,
    owner: params.source.owner,
    repo: params.source.repo,
    ref: params.source.ref,
    paths: params.source.paths,
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    errorCode: params.errorCode,
    errorMessage: params.errorMessage,
    syncedSkillCount: params.counts?.syncedSkillCount ?? 0,
    syncedFileCount: params.counts?.syncedFileCount ?? 0,
    deletedSkillCount: params.counts?.deletedSkillCount ?? 0,
    deletedFileCount: params.counts?.deletedFileCount ?? 0,
    skippedSkillCount: params.counts?.skippedSkillCount ?? 0,
    skippedSkills: params.skippedSkills,
    skippedFileCount: params.counts?.skippedFileCount ?? 0,
    skippedFiles: params.skippedFiles,
  };
}

function makeStatusKey(sourceId: string, tenantId?: string): string {
  return `${tenantId ?? ''}:${sourceId}`;
}

async function ensurePublicViewer(
  deps: GitHubSkillSyncDeps,
  skillId: Types.ObjectId,
): Promise<void> {
  await deps.grantPermission({
    principalType: PrincipalType.PUBLIC,
    principalId: null,
    resourceType: ResourceType.SKILL,
    resourceId: skillId,
    accessRoleId: AccessRoleIds.SKILL_VIEWER,
    grantedBy: getSystemAuthorId(),
  });
}

async function prepareRemoteSkill(params: {
  deps: GitHubSkillSyncDeps;
  source: SkillSyncGitHubSourceConfig;
  discovered: DiscoveredSkill;
  skillMdContent: string;
  commitSha: string;
  syncedAt: Date;
}): Promise<PreparedRemoteSkill> {
  const { deps, source, discovered, skillMdContent, commitSha, syncedAt } = params;
  const parsed = parseSkillMarkdown(skillMdContent);
  if (parsed.parseError) {
    throw new SkillSyncError(
      'SKILL_PARSE_FAILED',
      `${discovered.rootPath}/SKILL.md contains invalid YAML frontmatter: ${parsed.parseError}`,
    );
  }
  if (parsed.invalidBooleans.length > 0) {
    throw new SkillSyncError(
      'SKILL_PARSE_FAILED',
      `${discovered.rootPath}/SKILL.md contains invalid boolean frontmatter`,
    );
  }
  const upstreamId = makeUpstreamId(source, discovered.rootPath);
  const fallbackName = toSkillName(path.posix.basename(discovered.rootPath) || source.id);
  const sourceMetadata = {
    provider: PROVIDER,
    sourceId: source.id,
    upstreamId,
    owner: source.owner,
    repo: source.repo,
    ref: source.ref,
    skillPath: discovered.rootPath,
    commitSha,
    skillBlobSha: discovered.skillMd.id,
    syncedAt: serializeDate(syncedAt),
    syncStatus: 'synced',
  };
  const update: UpdateSkillInput = {
    name: parsed.name || fallbackName,
    description: parsed.description || parsed.name || fallbackName,
    body: skillMdContent,
    frontmatter: toCleanFrontmatter(parsed.frontmatter),
    alwaysApply: parsed.alwaysApply,
    source: PROVIDER,
    sourceMetadata,
  };
  const sourceTenantId = source.tenantId ?? undefined;
  const foundExisting = await deps.findSkillBySourceIdentity({
    source: PROVIDER,
    upstreamId,
    tenantId: sourceTenantId,
  });
  const existing =
    foundExisting && (foundExisting.tenantId ?? undefined) === sourceTenantId
      ? foundExisting
      : null;
  const createInput: CreateSkillInput = {
    ...(update as Omit<UpdateSkillInput, 'source'>),
    name: update.name ?? fallbackName,
    description: update.description ?? fallbackName,
    author: makeSourceAuthorId(source),
    authorName: SYSTEM_AUTHOR_NAME,
    source: PROVIDER,
    tenantId: source.tenantId,
  };
  return { existing, update, createInput };
}

async function commitRemoteSkill(
  deps: GitHubSkillSyncDeps,
  prepared: PreparedRemoteSkill,
): Promise<UpsertRemoteSkillResult> {
  if (prepared.existing) {
    const result = await deps.updateSkill({
      id: prepared.existing._id.toString(),
      expectedVersion: prepared.existing.version,
      update: prepared.update,
    });
    if (result.status === 'updated') {
      return { skill: result.skill, created: false, warnings: result.warnings };
    }
    if (result.status === 'conflict') {
      throw new SkillSyncError(
        'SKILL_CONFLICT',
        `Skill "${prepared.existing.name}" changed during sync`,
      );
    }
    throw new SkillSyncError(
      'SKILL_NOT_FOUND',
      `Previously synced skill "${prepared.existing.name}" was removed`,
    );
  }
  const created = await deps.createSkill(prepared.createInput);
  return { skill: created.skill, created: true, warnings: created.warnings };
}

/**
 * File sync bumps the parent skill's `version` (via file upserts/deletes) but
 * never changes its authored content, so we must re-read to get past our own
 * version bumps. A plain re-read would also silently accept and overwrite a
 * concurrent external edit; compare the refreshed content against the pre-sync
 * snapshot and treat a changed body/name/description/always-apply as a conflict.
 */
function hasExternalSkillEdit(before: ISkill, after: ISkill): boolean {
  return (
    before.body !== after.body ||
    before.name !== after.name ||
    before.description !== after.description ||
    (before.alwaysApply ?? false) !== (after.alwaysApply ?? false) ||
    JSON.stringify(before.frontmatter ?? {}) !== JSON.stringify(after.frontmatter ?? {})
  );
}

async function commitExistingRemoteSkillAfterFileSync(
  deps: GitHubSkillSyncDeps,
  prepared: PreparedExistingRemoteSkill,
  options: {
    forceCommit?: boolean;
    logSkillWarnings: (name: string, warnings: ValidationIssue[] | undefined) => void;
  },
): Promise<UpsertRemoteSkillResult> {
  const refreshed = await deps.getSkillById(prepared.existing._id);
  if (!refreshed) {
    throw new SkillSyncError(
      'SKILL_NOT_FOUND',
      `Previously synced skill "${prepared.existing.name}" was removed`,
    );
  }
  if (hasExternalSkillEdit(prepared.existing, refreshed)) {
    throw new SkillSyncError(
      'SKILL_CONFLICT',
      `Skill "${prepared.existing.name}" was modified during sync`,
    );
  }
  if (!options.forceCommit && !hasRemoteSkillDefinitionChanged(prepared.update, refreshed)) {
    return { skill: refreshed, created: false };
  }
  const result = await commitRemoteSkill(deps, { ...prepared, existing: refreshed });
  options.logSkillWarnings(result.skill.name, result.warnings);
  return result;
}

async function cleanupFile(deps: GitHubSkillSyncDeps, file: StoredSkillFileRef): Promise<void> {
  if (!deps.deleteFile) {
    return;
  }
  await deps.deleteFile({
    filepath: file.filepath,
    source: file.source,
    storageKey: file.storageKey,
    storageRegion: file.storageRegion,
    user: file.author,
    tenantId: file.tenantId,
  });
}

function toStoredFileRef(params: {
  saved: SaveBufferResult;
  author: Types.ObjectId;
  tenantId?: string;
}): StoredSkillFileRef {
  return {
    filepath: params.saved.filepath,
    source: params.saved.source,
    storageKey: params.saved.storageKey,
    storageRegion: params.saved.storageRegion,
    author: params.author,
    tenantId: params.tenantId,
  };
}

function toSkillFileInput(file: ISkillFile & { _id: Types.ObjectId }): UpsertSkillFileInput {
  return {
    skillId: file.skillId,
    relativePath: file.relativePath,
    file_id: file.file_id,
    filename: file.filename,
    filepath: file.filepath,
    storageKey: file.storageKey,
    storageRegion: file.storageRegion,
    source: file.source,
    sourceMetadata: file.sourceMetadata,
    mimeType: file.mimeType,
    bytes: file.bytes,
    isExecutable: file.isExecutable,
    author: file.author,
    tenantId: file.tenantId,
  };
}

function toCreateSkillInput(skill: ISkill & { _id: Types.ObjectId }): CreateSkillInput {
  return {
    name: skill.name,
    displayTitle: skill.displayTitle,
    description: skill.description,
    body: skill.body,
    frontmatter: skill.frontmatter,
    category: skill.category,
    author: skill.author,
    authorName: skill.authorName,
    source: PROVIDER,
    sourceMetadata: skill.sourceMetadata,
    alwaysApply: skill.alwaysApply,
    tenantId: skill.tenantId,
  };
}

function toStoredFileRefFromSkillFile(
  file: ISkillFile & { _id: Types.ObjectId },
): StoredSkillFileRef {
  return {
    filepath: file.filepath,
    source: file.source,
    storageKey: file.storageKey,
    storageRegion: file.storageRegion,
    author: file.author,
    tenantId: file.tenantId,
  };
}

function getStoredFileKey(file: StoredSkillFileRef): string {
  return [file.source, file.filepath, file.storageKey ?? '', file.storageRegion ?? ''].join(':');
}

async function cleanupStoredFiles(params: {
  deps: GitHubSkillSyncDeps;
  files: StoredSkillFileRef[];
  logMessage: string;
  throwOnError?: boolean;
}): Promise<void> {
  const seen = new Set<string>();
  const cleanupErrors: unknown[] = [];
  for (const file of params.files) {
    const key = getStoredFileKey(file);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    await cleanupFile(params.deps, file).catch((cleanupError) => {
      cleanupErrors.push(cleanupError);
      logger.error(params.logMessage, cleanupError);
    });
  }
  if (params.throwOnError && cleanupErrors.length > 0) {
    throw cleanupErrors[0];
  }
}

async function restoreExistingSkillFiles(params: {
  deps: GitHubSkillSyncDeps;
  skill: ISkill & { _id: Types.ObjectId };
  previousFiles: Array<ISkillFile & { _id: Types.ObjectId }>;
  savedFiles: StoredSkillFileRef[];
}): Promise<void> {
  const { deps, skill, previousFiles, savedFiles } = params;
  const previousByPath = new Map(previousFiles.map((file) => [file.relativePath, file]));
  const currentFiles = await deps.listSkillFiles(skill._id);

  for (const file of currentFiles) {
    if (previousByPath.has(file.relativePath)) {
      continue;
    }
    await deps.deleteSkillFile(skill._id, file.relativePath);
  }
  for (const file of previousFiles) {
    await deps.upsertSkillFile(toSkillFileInput(file));
  }
  await cleanupStoredFiles({
    deps,
    files: savedFiles,
    logMessage: '[GitHubSkillSync] Failed to clean up rolled-back synced file:',
    throwOnError: true,
  });
}

async function deleteSyncedSkillForRestore(
  deps: GitHubSkillSyncDeps,
  skill: ISkill & { _id: Types.ObjectId },
): Promise<{ deletedFileCount: number; deletedSkill: DeletedSyncedSkillJournal }> {
  const files = await deps.listSkillFiles(skill._id);
  const deletion = await deps.deleteSkill(skill._id.toString());
  if (!deletion.cleanupComplete) {
    if (!deletion.failedCleanupSteps.includes('skill_files')) {
      await cleanupStoredFiles({
        deps,
        files: files.map(toStoredFileRefFromSkillFile),
        logMessage: '[GitHubSkillSync] Failed to clean up partially deleted stale skill file:',
        throwOnError: true,
      });
    }
    throw new Error(
      `Skill cleanup did not finish: ${deletion.failedCleanupSteps.join(', ') || 'unknown step'}`,
    );
  }
  return {
    deletedFileCount: files.length,
    deletedSkill: { skill, files },
  };
}

async function restoreDeletedSyncedSkill(
  deps: GitHubSkillSyncDeps,
  deleted: DeletedSyncedSkillJournal,
): Promise<void> {
  const restored = await deps.createSkill(toCreateSkillInput(deleted.skill));
  for (const file of deleted.files) {
    await deps.upsertSkillFile({
      ...toSkillFileInput(file),
      skillId: restored.skill._id,
    });
  }
  await ensurePublicViewer(deps, restored.skill._id);
}

async function cleanupDeletedSyncedSkillFiles(
  deps: GitHubSkillSyncDeps,
  deleted: DeletedSyncedSkillJournal,
): Promise<void> {
  await cleanupStoredFiles({
    deps,
    files: deleted.files.map(toStoredFileRefFromSkillFile),
    logMessage: '[GitHubSkillSync] Failed to clean up deleted stale mirrored skill file:',
  });
}

function comparableSourceMetadata(metadata: Record<string, unknown> | undefined): string {
  const { commitSha: _commitSha, syncedAt: _syncedAt, ...rest } = metadata ?? {};
  return JSON.stringify(rest);
}

function hasRemoteSkillDefinitionChanged(update: UpdateSkillInput, existing: ISkill): boolean {
  return (
    update.body !== existing.body ||
    update.name !== existing.name ||
    update.description !== existing.description ||
    (update.alwaysApply ?? false) !== (existing.alwaysApply ?? false) ||
    JSON.stringify(update.frontmatter ?? {}) !== JSON.stringify(existing.frontmatter ?? {}) ||
    comparableSourceMetadata(update.sourceMetadata) !==
      comparableSourceMetadata(existing.sourceMetadata)
  );
}

function findMovedSourceSkill(params: {
  source: SkillSyncGitHubSourceConfig;
  prepared: PreparedRemoteSkill;
  existingSyncedSkills: Array<ISkill & { _id: Types.ObjectId }>;
  excludedUpstreamIds: Set<string>;
}): (ISkill & { _id: Types.ObjectId }) | null {
  const sourceTenantId = params.source.tenantId ?? undefined;
  const sourceAuthor = params.prepared.createInput.author.toString();
  const name = params.prepared.createInput.name;

  return (
    params.existingSyncedSkills.find((skill) => {
      if ((skill.tenantId ?? undefined) !== sourceTenantId) {
        return false;
      }
      if (skill.name !== name || skill.author.toString() !== sourceAuthor) {
        return false;
      }
      const upstreamId = getSourceMetadataString(skill, 'upstreamId');
      if (!upstreamId) {
        return false;
      }
      return !params.excludedUpstreamIds.has(upstreamId);
    }) ?? null
  );
}

function hasNameConflictingStaleSkill(params: {
  source: SkillSyncGitHubSourceConfig;
  prepared: PreparedDiscoveredSkill;
  existingSyncedSkills: Array<ISkill & { _id: Types.ObjectId }>;
  discoveredUpstreamIds: Set<string>;
}): boolean {
  return Boolean(
    findMovedSourceSkill({
      source: params.source,
      prepared: params.prepared.prepared,
      existingSyncedSkills: params.existingSyncedSkills,
      excludedUpstreamIds: params.discoveredUpstreamIds,
    }),
  );
}

function orderPreparedSkillsForSafeStaleDeletes(params: {
  source: SkillSyncGitHubSourceConfig;
  preparedSkills: PreparedDiscoveredSkill[];
  existingSyncedSkills: Array<ISkill & { _id: Types.ObjectId }>;
  discoveredUpstreamIds: Set<string>;
}): PreparedDiscoveredSkill[] {
  const regular: PreparedDiscoveredSkill[] = [];
  const nameConflicting: PreparedDiscoveredSkill[] = [];
  for (const prepared of params.preparedSkills) {
    if (
      prepared.prepared.existing &&
      hasNameConflictingStaleSkill({
        source: params.source,
        prepared,
        existingSyncedSkills: params.existingSyncedSkills,
        discoveredUpstreamIds: params.discoveredUpstreamIds,
      })
    ) {
      nameConflicting.push(prepared);
      continue;
    }
    regular.push(prepared);
  }
  return [...regular, ...nameConflicting];
}

function getMirrorNameKey(params: {
  tenantId?: string;
  author: string;
  name: string | undefined;
}): string {
  return `${params.tenantId ?? ''}:${params.author}:${params.name ?? ''}`;
}

/**
 * Two upstream skills claiming one mirror name have no non-arbitrary winner, so
 * every member of the colliding group is dropped rather than letting tree order
 * decide which one the mirror ends up holding. Skills with unique names are
 * unaffected: one bad pair no longer costs the rest of the repository.
 */
function partitionDuplicatePreparedSkillNames(
  source: SkillSyncGitHubSourceConfig,
  preparedSkills: PreparedDiscoveredSkill[],
): { unique: PreparedDiscoveredSkill[]; duplicates: PreparedDiscoveredSkill[] } {
  const sourceTenantId = source.tenantId ?? undefined;
  const groups = new Map<string, PreparedDiscoveredSkill[]>();
  for (const entry of preparedSkills) {
    const key = getMirrorNameKey({
      tenantId: sourceTenantId,
      author: entry.prepared.createInput.author.toString(),
      name: entry.prepared.createInput.name,
    });
    const group = groups.get(key);
    if (group) {
      group.push(entry);
      continue;
    }
    groups.set(key, [entry]);
  }
  const unique: PreparedDiscoveredSkill[] = [];
  const duplicates: PreparedDiscoveredSkill[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      unique.push(group[0]);
      continue;
    }
    duplicates.push(...group);
  }
  return { unique, duplicates };
}

function makeDuplicateNameError(
  source: SkillSyncGitHubSourceConfig,
  name: string | undefined,
): SkillSyncError {
  return new SkillSyncError(
    'DUPLICATE_SKILL_NAME',
    `GitHub source "${source.id}" contains multiple skills named "${name}"`,
  );
}

async function deleteNameConflictingStaleSkill(params: {
  deps: GitHubSkillSyncDeps;
  source: SkillSyncGitHubSourceConfig;
  prepared: PreparedRemoteSkill;
  existingSyncedSkills: Array<ISkill & { _id: Types.ObjectId }>;
  discoveredUpstreamIds: Set<string>;
  assertNotCancelled: AssertNotCancelled;
}): Promise<{
  remainingSkills: Array<ISkill & { _id: Types.ObjectId }>;
  deletedSkillCount: number;
  deletedFileCount: number;
  deletedSkill?: DeletedSyncedSkillJournal;
}> {
  const staleSkill = findMovedSourceSkill({
    source: params.source,
    prepared: params.prepared,
    existingSyncedSkills: params.existingSyncedSkills,
    excludedUpstreamIds: params.discoveredUpstreamIds,
  });
  if (!staleSkill) {
    return {
      remainingSkills: params.existingSyncedSkills,
      deletedSkillCount: 0,
      deletedFileCount: 0,
    };
  }

  params.assertNotCancelled();
  const { deletedFileCount, deletedSkill } = await deleteSyncedSkillForRestore(
    params.deps,
    staleSkill,
  ).catch((error) => {
    /* deleteSkill can remove the skill row before a later file deletion fails.
       The caller has no complete journal to restore from in that case. */
    throw makeStaleDeletionFailure(error);
  });
  const staleSkillId = staleSkill._id.toString();

  return {
    remainingSkills: params.existingSyncedSkills.filter(
      (skill) => skill._id.toString() !== staleSkillId,
    ),
    deletedSkillCount: 1,
    deletedFileCount,
    deletedSkill,
  };
}

async function syncSkillFiles(params: {
  deps: GitHubSkillSyncDeps;
  adapter: GitRepoAdapter;
  commit: RepoCommit;
  source: SkillSyncGitHubSourceConfig;
  skill: ISkill & { _id: Types.ObjectId };
  discovered: DiscoveredSkill;
  assertNotCancelled: AssertNotCancelled;
  journal?: SyncSkillFilesJournal;
}): Promise<SyncSkillFilesResult> {
  const { deps, adapter, commit, source, skill, discovered, assertNotCancelled } = params;
  const journal = params.journal ?? { staleFiles: [], savedFiles: [] };
  const remotePaths = new Set<string>();
  let syncedFileCount = 0;
  let deletedFileCount = 0;
  let totalFileBytes = 0;

  for (const entry of discovered.files) {
    assertNotCancelled();
    const relativePath = getDiscoveredRelativePath(discovered, entry);
    if (!isSafeRelativePath(relativePath) || relativePath.toUpperCase() === 'SKILL.MD') {
      continue;
    }
    totalFileBytes += assertGitHubBlobSize(entry, relativePath);
    assertCumulativeGitHubFileSize(totalFileBytes);
    remotePaths.add(relativePath);
    const existing = await deps.getSkillFileByPath(skill._id, relativePath);
    if (existing && getSourceMetadataString(existing, 'blobSha') === entry.id) {
      continue;
    }
    const buffer = await adapter.fetchFileContent(commit, entry);
    assertNotCancelled();
    assertGitHubBufferSize(buffer, relativePath);
    const fileId = crypto.randomUUID();
    const filename = getFilename(relativePath);
    const mimeType = guessMimeType(filename);
    const saved = await deps.saveBuffer({
      userId: skill.author.toString(),
      buffer,
      fileName: `${fileId}__${filename}`,
      basePath: 'uploads',
      isImage: mimeType.startsWith('image/'),
      tenantId: skill.tenantId,
    });
    const savedFile = toStoredFileRef({ saved, author: skill.author, tenantId: skill.tenantId });
    try {
      await deps.upsertSkillFile({
        skillId: skill._id,
        relativePath,
        file_id: fileId,
        filename,
        filepath: saved.filepath,
        storageKey: saved.storageKey,
        storageRegion: saved.storageRegion,
        source: saved.source,
        sourceMetadata: {
          provider: PROVIDER,
          sourceId: source.id,
          upstreamId: makeUpstreamId(source, discovered.rootPath),
          commitSha: commit.id,
          blobSha: entry.id,
          path: entry.path,
        },
        mimeType,
        bytes: buffer.length,
        isExecutable: false,
        author: skill.author,
        tenantId: skill.tenantId,
      });
    } catch (error) {
      await cleanupFile(deps, savedFile).catch((cleanupError) => {
        logger.error('[GitHubSkillSync] Failed to clean up orphaned synced file:', cleanupError);
        throw makeRollbackFailure(error);
      });
      throw error;
    }
    syncedFileCount++;
    journal.savedFiles.push(savedFile);
    if (existing && existing.filepath !== saved.filepath) {
      journal.staleFiles.push(existing);
    }
  }

  const existingFiles = await deps.listSkillFiles(skill._id);
  for (const file of existingFiles) {
    assertNotCancelled();
    if (remotePaths.has(file.relativePath)) {
      continue;
    }
    const result = await deps.deleteSkillFile(skill._id, file.relativePath);
    if (result.deleted) {
      deletedFileCount++;
      journal.staleFiles.push(file);
    }
  }
  return { syncedFileCount, deletedFileCount, ...journal };
}

async function deleteSyncedSkill(
  deps: GitHubSkillSyncDeps,
  skill: ISkill & { _id: Types.ObjectId },
): Promise<number> {
  const files = await deps.listSkillFiles(skill._id);
  const deletion = await deps.deleteSkill(skill._id.toString());
  let deletedFiles = 0;
  const cleanupErrors: unknown[] = [];
  if (!deletion.failedCleanupSteps.includes('skill_files')) {
    for (const file of files) {
      await cleanupFile(deps, file).catch((cleanupError) => {
        cleanupErrors.push(cleanupError);
        logger.error('[GitHubSkillSync] Failed to clean up mirrored skill file:', cleanupError);
      });
      deletedFiles++;
    }
  }
  if (!deletion.cleanupComplete) {
    throw new Error(
      `Skill cleanup did not finish: ${deletion.failedCleanupSteps.join(', ') || 'unknown step'}`,
    );
  }
  if (cleanupErrors.length > 0) {
    throw cleanupErrors[0];
  }
  return deletedFiles;
}

function getTokenEnvVarName(tokenReference: string | undefined): string | null {
  const match = tokenReference?.trim().match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  return match?.[1] ?? null;
}

async function resolveGitHubToken(
  deps: GitHubSkillSyncDeps,
  source: SkillSyncGitHubSourceConfig,
): Promise<string | null> {
  if (deps.allowServerCredentials === false) {
    return null;
  }
  const tokenEnvVar = getTokenEnvVarName(source.token);
  if (tokenEnvVar) {
    return process.env[tokenEnvVar]?.trim() || null;
  }
  if (!source.credentialKey) {
    return null;
  }
  return deps.getCredentialToken(PROVIDER, source.credentialKey);
}

function getMissingCredentialMessage(
  source: SkillSyncGitHubSourceConfig,
  allowServerCredentials: boolean,
): string {
  if (!allowServerCredentials) {
    return 'Server GitHub credentials are not available for this skill sync config';
  }
  const tokenEnvVar = getTokenEnvVarName(source.token);
  if (tokenEnvVar) {
    return `Missing GitHub token environment variable "${tokenEnvVar}"`;
  }
  return `Missing GitHub credential "${source.credentialKey ?? source.id}"`;
}

async function syncSource(params: {
  deps: GitHubSkillSyncDeps;
  source: SkillSyncGitHubSourceConfig;
  fetchFn: FetchFn;
  assertNotCancelled: AssertNotCancelled;
}): Promise<ISkillSyncStatus> {
  const { deps, source, fetchFn, assertNotCancelled } = params;
  const createAdapter = deps.createAdapter ?? createGitHubRepoAdapter;
  const startedAt = new Date();
  const counts: SyncCounters = {
    syncedSkillCount: 0,
    syncedFileCount: 0,
    deletedSkillCount: 0,
    deletedFileCount: 0,
    skippedSkillCount: 0,
    skippedFileCount: 0,
  };
  const skippedSkills: ISkillSyncSkippedSkill[] = [];
  const skippedFiles: ISkillSyncSkippedFile[] = [];
  await deps.upsertStatus(makeStatusInput({ source, status: 'running', startedAt }));
  try {
    assertNotCancelled();
    const allowServerCredentials = deps.allowServerCredentials !== false;
    const token = await resolveGitHubToken(deps, source);
    assertNotCancelled();
    if (!token) {
      throw new SkillSyncError(
        'MISSING_CREDENTIAL',
        getMissingCredentialMessage(source, allowServerCredentials),
      );
    }
    const adapter = createAdapter({ source, token, fetchFn });
    const commit = await adapter.resolveCommit();
    assertNotCancelled();
    const treeEntries = await fetchConfiguredTreeEntries({
      adapter,
      commit,
      source,
      assertNotCancelled,
    });
    assertConfiguredPathsExist(treeEntries, source);
    const discoveredSkills = discoverSkills(treeEntries, source);
    const seenUpstreamIds = new Set<string>();
    let existingSyncedSkills: Array<ISkill & { _id: Types.ObjectId }> | null = null;
    const getExistingSyncedSkills = async () => {
      if (!existingSyncedSkills) {
        existingSyncedSkills = await deps.listSkillsBySource({
          source: PROVIDER,
          sourceId: source.id,
        });
      }
      return existingSyncedSkills;
    };
    let loggedPerSkillWarningCount = 0;
    let suppressedSkippedWarningCount = 0;
    let suppressedValidationWarningCount = 0;
    /**
     * Non-blocking validation issues have no user-facing surface on a background
     * sync. Keep them visible without allowing a large source to amplify logs.
     */
    const logSkillWarnings = (name: string, warnings: ValidationIssue[] | undefined): void => {
      if (!warnings?.length) {
        return;
      }
      if (loggedPerSkillWarningCount >= MAX_LOGGED_PER_SKILL_WARNINGS) {
        suppressedValidationWarningCount++;
        return;
      }
      const summary = summarizeValidationIssues(warnings);
      if (!summary) {
        return;
      }
      logger.warn(
        `[GitHubSkillSync] Skill "${truncateSkipName(name)}" synced with warnings: ${truncateSkipMessage(summary)}`,
      );
      loggedPerSkillWarningCount++;
    };
    const logSuppressedPerSkillWarningSummaries = (): void => {
      if (suppressedSkippedWarningCount > 0) {
        logger.warn(
          `[GitHubSkillSync] Source "${source.id}" suppressed ${suppressedSkippedWarningCount} additional skipped skill warning(s)`,
        );
      }
      if (suppressedValidationWarningCount > 0) {
        logger.warn(
          `[GitHubSkillSync] Source "${source.id}" suppressed ${suppressedValidationWarningCount} additional synced skill validation warning(s)`,
        );
      }
    };
    /**
     * Charges one skill's failure to that skill and lets the run continue.
     * Source-level failures are rethrown so the whole source still fails fast
     * instead of being reported as a long list of skipped skills.
     */
    const recordSkippedSkill = ({
      path,
      name,
      error,
    }: {
      path: string;
      name?: string;
      error: unknown;
    }): void => {
      if (isSourceFatalError(error)) {
        throw error;
      }
      const sanitized = sanitizeError(error);
      counts.skippedSkillCount++;
      if (loggedPerSkillWarningCount < MAX_LOGGED_PER_SKILL_WARNINGS) {
        logger.warn(
          `[GitHubSkillSync] Source "${source.id}" skipped "${truncateSkipPath(path)}": ${truncateSkipMessage(sanitized.message)}`,
        );
        loggedPerSkillWarningCount++;
      } else {
        suppressedSkippedWarningCount++;
      }
      if (skippedSkills.length >= MAX_RECORDED_SKIPPED_SKILLS) {
        return;
      }
      skippedSkills.push({
        path: truncateSkipPath(path),
        name: truncateSkipName(name),
        errorCode: sanitized.code,
        errorMessage: truncateSkipMessage(sanitized.message),
      });
    };
    const syncedAt = new Date();
    const preparedSkills: PreparedDiscoveredSkill[] = [];
    let canReconcileStaleSkills = true;
    /* Built from everything discovered upstream, not just what prepared
       cleanly: a skill that failed to prepare is still present in the
       repository, so it must not look stale or like a rename target. */
    const discoveredUpstreamIds = new Set(
      discoveredSkills.map((discovered) => makeUpstreamId(source, discovered.rootPath)),
    );

    for (const discovered of discoveredSkills) {
      assertNotCancelled();
      try {
        assertGitHubSkillPackageManifest(discovered);
        const skillMdPath = getSkillMdPath(discovered);
        const skillMdBuffer = await adapter.fetchFileContent(commit, discovered.skillMd);
        assertNotCancelled();
        assertGitHubBufferSize(skillMdBuffer, skillMdPath);
        const prepared = await prepareRemoteSkill({
          deps,
          source,
          discovered,
          skillMdContent: skillMdBuffer.toString('utf-8'),
          commitSha: commit.id,
          syncedAt,
        });
        preparedSkills.push({ discovered, prepared });
      } catch (error) {
        /* Until preparation succeeds, a moved skill cannot be matched to the
           mirror that still carries its old upstream id. Keep stale mirrors
           for this run rather than deleting a last-known-good moved skill. */
        canReconcileStaleSkills = false;
        seenUpstreamIds.add(makeUpstreamId(source, discovered.rootPath));
        recordSkippedSkill({ path: discovered.rootPath, error });
      }
    }

    /**
     * A moved skill's mirror still carries its old upstream id until the update
     * lands, and only the new path is marked as seen. Marking the old id keeps
     * the published copy in place whenever the new one does not replace it, so
     * the reconcile pass cannot read it as stale.
     */
    const markMovedMirrorAsSeen = async (
      prepared: PreparedRemoteSkill,
    ): Promise<(ISkill & { _id: Types.ObjectId }) | null> => {
      if (prepared.existing || !canReconcileStaleSkills) {
        return null;
      }
      const movedExisting = findMovedSourceSkill({
        source,
        prepared,
        existingSyncedSkills: await getExistingSyncedSkills(),
        excludedUpstreamIds: discoveredUpstreamIds,
      });
      const movedUpstreamId = movedExisting
        ? getSourceMetadataString(movedExisting, 'upstreamId')
        : undefined;
      if (movedUpstreamId) {
        seenUpstreamIds.add(movedUpstreamId);
      }
      return movedExisting;
    };

    const { unique, duplicates } = partitionDuplicatePreparedSkillNames(source, preparedSkills);
    for (const { discovered, prepared } of duplicates) {
      seenUpstreamIds.add(makeUpstreamId(source, discovered.rootPath));
      /* A duplicate never reaches `syncPreparedSkill`, so without this its
         moved mirror goes unmarked and is reconciled away even though nothing
         was published to replace it. */
      const movedMirror = await markMovedMirrorAsSeen(prepared);
      if (!prepared.existing && !movedMirror) {
        /* A duplicate with a new identity can be a moved and renamed skill.
           Without an identity or name match, preserve unmatched stale mirrors
           because one may be its last-known-good copy. */
        canReconcileStaleSkills = false;
      }
      recordSkippedSkill({
        path: discovered.rootPath,
        name: prepared.createInput.name,
        error: makeDuplicateNameError(source, prepared.createInput.name),
      });
    }
    const orderedPreparedSkills = orderPreparedSkillsForSafeStaleDeletes({
      source,
      preparedSkills: unique,
      existingSyncedSkills: await getExistingSyncedSkills(),
      discoveredUpstreamIds,
    });

    /**
     * Only a live skill's dropped files are worth reporting. A skill that was
     * skipped outright is already accounted for in `skippedSkills`, so charging
     * its files here would both misdescribe it as published-but-incomplete and
     * let it crowd genuinely invisible drops out of the recorded sample.
     */
    const recordUnsupportedFiles = (discovered: DiscoveredSkill): void => {
      for (const unsupportedPath of discovered.unsupportedFiles) {
        counts.skippedFileCount++;
        if (skippedFiles.length >= MAX_RECORDED_SKIPPED_FILES) {
          continue;
        }
        skippedFiles.push({
          path: truncateSkipPath(unsupportedPath),
          skillPath: truncateSkipPath(discovered.rootPath),
          errorCode: UNSUPPORTED_FILE_PATH_CODE,
          errorMessage: UNSUPPORTED_FILE_PATH_MESSAGE,
        });
      }
    };

    const syncPreparedSkill = async ({
      discovered,
      prepared,
    }: PreparedDiscoveredSkill): Promise<void> => {
      if (!prepared.existing && !canReconcileStaleSkills) {
        const ambiguousMovedMirror = findMovedSourceSkill({
          source,
          prepared,
          existingSyncedSkills: await getExistingSyncedSkills(),
          excludedUpstreamIds: discoveredUpstreamIds,
        });
        if (ambiguousMovedMirror) {
          throw new SkillSyncError(
            'SKILL_MOVE_AMBIGUOUS',
            `Skill "${prepared.createInput.name}" may have moved, but another skill could not be prepared`,
          );
        }
      }
      const movedExisting = await markMovedMirrorAsSeen(prepared);
      const effectivePrepared: PreparedRemoteSkill = movedExisting
        ? { ...prepared, existing: movedExisting }
        : prepared;
      if (effectivePrepared.existing) {
        // Check for an external edit before mutating files, so a concurrently
        // edited skill fails fast without leaving its bundled files partially
        // rewritten to the upstream version. The post-file-sync check below
        // still guards edits that land during the file sync itself.
        const beforeFileSync = await deps.getSkillById(effectivePrepared.existing._id);
        if (!beforeFileSync) {
          throw new SkillSyncError(
            'SKILL_NOT_FOUND',
            `Previously synced skill "${effectivePrepared.existing.name}" was removed`,
          );
        }
        if (hasExternalSkillEdit(effectivePrepared.existing, beforeFileSync)) {
          throw new SkillSyncError(
            'SKILL_CONFLICT',
            `Skill "${effectivePrepared.existing.name}" was modified during sync`,
          );
        }
        await ensurePublicViewer(deps, effectivePrepared.existing._id);
        const previousFiles = await deps.listSkillFiles(effectivePrepared.existing._id);
        const journal: SyncSkillFilesJournal = { staleFiles: [], savedFiles: [] };
        let fileCounts: SyncSkillFilesResult;
        let staleConflictCleanup:
          | Awaited<ReturnType<typeof deleteNameConflictingStaleSkill>>
          | undefined;
        try {
          fileCounts = await syncSkillFiles({
            deps,
            adapter,
            commit,
            source,
            skill: effectivePrepared.existing,
            discovered,
            assertNotCancelled,
            journal,
          });
          if (prepared.existing && canReconcileStaleSkills) {
            staleConflictCleanup = await deleteNameConflictingStaleSkill({
              deps,
              source,
              prepared: effectivePrepared,
              existingSyncedSkills: await getExistingSyncedSkills(),
              discoveredUpstreamIds,
              assertNotCancelled,
            });
            existingSyncedSkills = staleConflictCleanup.remainingSkills;
            counts.deletedSkillCount += staleConflictCleanup.deletedSkillCount;
            counts.deletedFileCount += staleConflictCleanup.deletedFileCount;
          }
          await commitExistingRemoteSkillAfterFileSync(
            deps,
            {
              ...effectivePrepared,
              existing: effectivePrepared.existing,
            },
            {
              forceCommit: fileCounts.syncedFileCount > 0 || fileCounts.deletedFileCount > 0,
              logSkillWarnings,
            },
          );
        } catch (error) {
          let rollbackFailed = false;
          await restoreExistingSkillFiles({
            deps,
            skill: effectivePrepared.existing,
            previousFiles,
            savedFiles: journal.savedFiles,
          }).catch((cleanupError) => {
            rollbackFailed = true;
            logger.error(
              '[GitHubSkillSync] Failed to restore existing skill files after sync failure:',
              cleanupError,
            );
          });
          if (staleConflictCleanup?.deletedSkill) {
            await restoreDeletedSyncedSkill(deps, staleConflictCleanup.deletedSkill).catch(
              (cleanupError) => {
                logger.error(
                  '[GitHubSkillSync] Failed to recreate stale mirrored skill after sync failure:',
                  cleanupError,
                );
              },
            );
            /* deleteSkill removes the original id from agent allowlists and
               deletes every ACL entry. Recreating the row recovers its data,
               but cannot restore that dependent state, so this is never a
               complete rollback and the source must fail visibly. */
            rollbackFailed = true;
          }
          throw rollbackFailed ? makeRollbackFailure(error) : error;
        }
        await cleanupStoredFiles({
          deps,
          files: fileCounts.staleFiles,
          logMessage: '[GitHubSkillSync] Failed to clean up replaced synced file:',
        });
        if (staleConflictCleanup?.deletedSkill) {
          await cleanupDeletedSyncedSkillFiles(deps, staleConflictCleanup.deletedSkill);
        }
        counts.syncedSkillCount++;
        counts.syncedFileCount += fileCounts.syncedFileCount;
        counts.deletedFileCount += fileCounts.deletedFileCount;
        recordUnsupportedFiles(discovered);
        return;
      }

      const upserted = await commitRemoteSkill(deps, effectivePrepared);
      const { skill } = upserted;
      try {
        const fileCounts = await syncSkillFiles({
          deps,
          adapter,
          commit,
          source,
          skill,
          discovered,
          assertNotCancelled,
        });
        await ensurePublicViewer(deps, skill._id);
        logSkillWarnings(skill.name, upserted.warnings);
        counts.syncedSkillCount++;
        counts.syncedFileCount += fileCounts.syncedFileCount;
        counts.deletedFileCount += fileCounts.deletedFileCount;
        recordUnsupportedFiles(discovered);
      } catch (error) {
        const rolledBack = await deleteSyncedSkill(deps, skill)
          .then(() => true)
          .catch((cleanupError) => {
            logger.error(
              '[GitHubSkillSync] Failed to roll back partially synced skill:',
              cleanupError,
            );
            return false;
          });
        throw rolledBack ? error : makeRollbackFailure(error);
      }
    };

    for (const entry of orderedPreparedSkills) {
      assertNotCancelled();
      /* Marked as seen before the attempt: a skill that fails here is still
         present upstream, so the reconcile pass below must not mirror-delete
         a copy that a later run can repair. */
      seenUpstreamIds.add(makeUpstreamId(source, entry.discovered.rootPath));
      try {
        await syncPreparedSkill(entry);
      } catch (error) {
        if (
          !entry.prepared.existing &&
          !findMovedSourceSkill({
            source,
            prepared: entry.prepared,
            existingSyncedSkills: await getExistingSyncedSkills(),
            excludedUpstreamIds: discoveredUpstreamIds,
          })
        ) {
          /* A new identity can be a moved and renamed skill that name-based
             matching cannot associate with its old mirror. If it fails after
             preparation, preserve stale mirrors because the old upstream id
             is unknown and may be the last-known-good copy. */
          canReconcileStaleSkills = false;
        }
        recordSkippedSkill({
          path: entry.discovered.rootPath,
          name: entry.prepared.createInput.name,
          error,
        });
      }
    }

    const currentSyncedSkills = await deps.listSkillsBySource({
      source: PROVIDER,
      sourceId: source.id,
    });
    // Only mirror-delete skills owned by this source's tenant. With no
    // configured tenantId under non-strict isolation, listSkillsBySource can
    // return github skills across tenants, so without this guard an ambient sync
    // could delete another tenant's mirrored skills. Absent tenantId is its own
    // (ambient) bucket.
    const sourceTenantId = source.tenantId ?? undefined;
    for (const skill of currentSyncedSkills) {
      assertNotCancelled();
      if ((skill.tenantId ?? undefined) !== sourceTenantId) {
        continue;
      }
      const upstreamId =
        skill.sourceMetadata && typeof skill.sourceMetadata.upstreamId === 'string'
          ? skill.sourceMetadata.upstreamId
          : '';
      if (!canReconcileStaleSkills || seenUpstreamIds.has(upstreamId)) {
        continue;
      }
      counts.deletedFileCount += await deleteSyncedSkill(deps, skill);
      counts.deletedSkillCount++;
    }

    if (counts.skippedSkillCount === 0 && counts.skippedFileCount === 0) {
      logSuppressedPerSkillWarningSummaries();
      return deps.upsertStatus(
        makeStatusInput({
          source,
          status: 'succeeded',
          startedAt,
          finishedAt: new Date(),
          counts,
        }),
      );
    }
    /* Nothing published and something skipped means the source produced no
       usable mirror at all, which is a failure however it is spelled. The
       first skip carries the reason so the status is actionable. */
    /* Only dropped *skills* can make a run a failure. A run that published
       every skill it found is still a real mirror, even if some file inside
       one of them could not come along. */
    const publishedNothing = counts.syncedSkillCount === 0 && counts.skippedSkillCount > 0;
    const firstSkip = skippedSkills[0];
    logSuppressedPerSkillWarningSummaries();
    logger.warn(
      `[GitHubSkillSync] Source "${source.id}" synced ${counts.syncedSkillCount} skill(s), skipped ${counts.skippedSkillCount} skill(s) and ${counts.skippedFileCount} file(s)`,
    );
    return deps.upsertStatus(
      makeStatusInput({
        source,
        status: publishedNothing ? 'failed' : 'partial',
        startedAt,
        finishedAt: new Date(),
        counts,
        skippedSkills,
        skippedFiles: skippedFiles.length > 0 ? skippedFiles : undefined,
        errorCode: publishedNothing ? firstSkip?.errorCode : undefined,
        errorMessage: publishedNothing ? firstSkip?.errorMessage : undefined,
      }),
    );
  } catch (error) {
    const sanitized = sanitizeError(error);
    logger.error(`[GitHubSkillSync] Source "${source.id}" failed: ${sanitized.message}`);
    return deps.upsertStatus(
      makeStatusInput({
        source,
        status: 'failed',
        startedAt,
        finishedAt: new Date(),
        counts: {
          syncedSkillCount: 0,
          syncedFileCount: 0,
          deletedSkillCount: 0,
          deletedFileCount: 0,
          skippedSkillCount: counts.skippedSkillCount,
          skippedFileCount: counts.skippedFileCount,
        },
        skippedSkills: skippedSkills.length > 0 ? skippedSkills : undefined,
        skippedFiles: skippedFiles.length > 0 ? skippedFiles : undefined,
        errorCode: sanitized.code,
        errorMessage: sanitized.message,
      }),
    );
  }
}

/**
 * Runs a source sync inside its tenant's async context when `tenantId` is set,
 * so the tenant-isolation mongoose hooks scope every skill/file/ACL read and
 * write to that tenant (required under strict isolation). Storage writes also
 * receive the tenant explicitly via `skill.tenantId`. Without a configured
 * tenant the sync runs in the ambient context, preserving single-tenant behavior.
 *
 * The callback is `async` per the tenant-context contract so the ALS store
 * propagates across every awaited Mongoose operation in `syncSource`.
 */
function syncSourceInTenantContext(params: {
  deps: GitHubSkillSyncDeps;
  source: SkillSyncGitHubSourceConfig;
  fetchFn: FetchFn;
  assertNotCancelled: AssertNotCancelled;
}): Promise<ISkillSyncStatus> {
  if (!params.source.tenantId) {
    return syncSource(params);
  }
  return tenantStorage.run({ tenantId: params.source.tenantId }, async () => syncSource(params));
}

function getGithubConfig(config: SkillSyncConfig | undefined): {
  enabled: boolean;
  intervalMinutes: number;
  runOnStartup: boolean;
  sources: SkillSyncGitHubSourceConfig[];
} {
  return {
    enabled: config?.github?.enabled ?? false,
    intervalMinutes: config?.github?.intervalMinutes ?? 60,
    runOnStartup: config?.github?.runOnStartup ?? false,
    sources:
      config?.github?.sources.map((source) => ({
        ...source,
        skillDiscoveryDepth: source.skillDiscoveryDepth ?? SKILL_SYNC_DEFAULT_DISCOVERY_DEPTH,
      })) ?? [],
  };
}

export function createGitHubSkillSyncRunner(deps: GitHubSkillSyncDeps): GitHubSkillSyncRunner {
  const fetchFn = deps.fetchFn ?? fetch;
  const lockOwnerPrefix = deps.lockOwner ?? `${process.pid}`;

  async function getStatus(): Promise<GitHubSkillSyncStatus> {
    const github = getGithubConfig(await deps.getConfig());
    const allowServerCredentials = deps.allowServerCredentials !== false;
    const [storedStatuses, credentials] = await Promise.all([
      deps.listStatuses(PROVIDER),
      allowServerCredentials ? deps.listCredentials(PROVIDER) : Promise.resolve([]),
    ]);
    const statusBySourceId = new Map(
      storedStatuses.map((status) => [makeStatusKey(status.sourceId, status.tenantId), status]),
    );
    const credentialByKey = new Map(
      credentials.map((credential) => [credential.credentialKey, credential]),
    );
    const sources = github.sources.map((source) => {
      const stored = statusBySourceId.get(makeStatusKey(source.id, source.tenantId));
      const credential =
        allowServerCredentials && source.credentialKey
          ? credentialByKey.get(source.credentialKey)
          : null;
      const tokenEnvVar = getTokenEnvVarName(source.token);
      const envTokenPresent =
        allowServerCredentials && tokenEnvVar ? Boolean(process.env[tokenEnvVar]?.trim()) : false;
      return {
        provider: PROVIDER,
        sourceId: source.id,
        tenantId: source.tenantId,
        status: stored?.status ?? 'idle',
        credentialKey: source.credentialKey,
        credentialPresent: envTokenPresent || Boolean(credential),
        owner: source.owner,
        repo: source.repo,
        ref: source.ref,
        paths: source.paths,
        startedAt: stored?.startedAt,
        finishedAt: stored?.finishedAt,
        lastSuccessAt: stored?.lastSuccessAt,
        lastFailureAt: stored?.lastFailureAt,
        errorCode: stored?.errorCode,
        errorMessage: stored?.errorMessage,
        syncedSkillCount: stored?.syncedSkillCount ?? 0,
        syncedFileCount: stored?.syncedFileCount ?? 0,
        deletedSkillCount: stored?.deletedSkillCount ?? 0,
        deletedFileCount: stored?.deletedFileCount ?? 0,
        skippedSkillCount: stored?.skippedSkillCount ?? 0,
        skippedSkills: stored?.skippedSkills,
        skippedFileCount: stored?.skippedFileCount ?? 0,
        skippedFiles: stored?.skippedFiles,
        createdAt: stored?.createdAt,
        updatedAt: stored?.updatedAt,
      } satisfies ISkillSyncStatus & { credentialPresent: boolean };
    });
    return {
      enabled: github.enabled,
      intervalMinutes: github.intervalMinutes,
      runOnStartup: github.runOnStartup,
      sources,
      credentials,
      fineGrainedTokenRecommendation: GITHUB_FINE_GRAINED_TOKEN_RECOMMENDATION,
    };
  }

  async function runOnce(): Promise<GitHubSkillSyncRunResult> {
    const github = getGithubConfig(await deps.getConfig());
    if (!github.enabled || github.sources.length === 0) {
      return { status: 'skipped', message: 'GitHub skill sync is disabled', sources: [] };
    }
    const allowServerCredentials = deps.allowServerCredentials !== false;
    if (!allowServerCredentials) {
      const status = await getStatus();
      if (!status.sources.some((source) => source.credentialPresent)) {
        return {
          status: 'skipped',
          message: 'GitHub skill sync credentials are not available for this runner',
          sources: status.sources,
        };
      }
    }
    const lockOwner = `${lockOwnerPrefix}:${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const acquired = await deps.tryAcquireLock({
      provider: PROVIDER,
      lockOwner,
      leaseMs: LOCK_LEASE_MS,
    });
    if (!acquired) {
      const status = await getStatus();
      return {
        status: 'skipped',
        message: 'GitHub skill sync is already running',
        sources: status.sources,
      };
    }
    let lockLost = false;
    const assertNotCancelled = () => {
      if (lockLost) {
        throw new SkillSyncError('SYNC_LOCK_LOST', 'GitHub skill sync lock was lost');
      }
    };
    const refreshTimer = setInterval(
      () => {
        deps
          .refreshLock({
            provider: PROVIDER,
            lockOwner,
            leaseMs: LOCK_LEASE_MS,
          })
          .then((refreshed) => {
            if (!refreshed) {
              lockLost = true;
              logger.warn('[GitHubSkillSync] Failed to refresh active sync lock');
            }
          })
          .catch((error) => {
            lockLost = true;
            logger.error('[GitHubSkillSync] Failed to refresh active sync lock:', error);
          });
      },
      Math.max(60_000, Math.floor(LOCK_LEASE_MS / 3)),
    );
    refreshTimer.unref?.();
    try {
      const sources: ISkillSyncStatus[] = [];
      for (const source of github.sources) {
        if (lockLost) {
          break;
        }
        sources.push(
          await syncSourceInTenantContext({ deps, source, fetchFn, assertNotCancelled }),
        );
      }
      const failed = sources.some((source) => source.status === 'failed');
      return {
        status: failed || lockLost ? 'failed' : 'completed',
        message: lockLost ? 'GitHub skill sync lock was lost' : undefined,
        sources,
      };
    } finally {
      clearInterval(refreshTimer);
      await deps.releaseLock({ provider: PROVIDER, lockOwner });
    }
  }

  return { getStatus, runOnce };
}
