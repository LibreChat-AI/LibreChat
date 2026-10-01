import path from 'path';
import JSZip from 'jszip';
import crypto from 'crypto';
import { logger, pickValidFrontmatter, validateRelativePath } from '@librechat/data-schemas';
import {
  ResourceType,
  DEFAULT_SKILL_IMPORT_CLEANUP_CONCURRENCY,
  AccessRoleIds,
  PrincipalType,
  hasActivePiiFields,
  hasActivePiiPatterns,
} from 'librechat-data-provider';
import type {
  AppConfig,
  ISkill,
  ISkillFile,
  CreateSkillInput,
  CreateSkillResult,
  DeleteSkillResult,
  UpsertSkillFileInput,
} from '@librechat/data-schemas';
import type { SkillImportFailureReason, TSkillImportFailedResponse } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import type {
  ContentTraversalLimitError,
  TextContentFragment,
  SkillContentInput,
} from '~/protection';
import type { ImportLimits } from './limits';
import {
  inspectContent,
  extractFileContent,
  extractSkillContent,
  getContentTraversalFragments,
  hasActiveFilePolicy,
  hasActiveFileFieldPolicy,
  isContentTraversalProtected,
  isContentTraversalLimitError,
  contentFilterUninspectableResponse,
  getBlockedUninspectableSkillFileField,
} from '~/protection';
import { deleteSkillWithRetry, mergeDeleteSkillResults } from './cleanup';
import { contentFilterBlockResponse } from '~/middleware/contentFilter';
import { parseSkillMarkdown, toCleanFrontmatter } from './parse';
import { resolveRequestTenantId } from '~/middleware/tenant';
import { createConcurrencyLimiter } from '~/utils/promise';
import { DEFAULT_SKILL_IMPORT_LIMITS } from './limits';
import { isBinaryBuffer } from './binary';

const SKILL_MD = 'SKILL.md';

export type { ImportLimits } from './limits';

type ParsedSkillFile = {
  name: string;
  description: string;
  alwaysApply?: boolean;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
  /**
   * Frontmatter bag ready for `createSkill`: cleaned of the fields that live
   * as their own columns, and narrowed to entries strict validation accepts.
   */
  frontmatter: Record<string, unknown>;
  /** Keys that carried non-boolean values for fields that must be boolean. */
  invalidBooleans: string[];
  parseError?: string;
};

/**
 * YAML frontmatter parser for an uploaded SKILL.md — hands `createSkill` the
 * first-class columns (`name`, `description`, `alwaysApply`) plus the
 * frontmatter bag the remaining columns are derived from. Every
 * invocation-mode flag (`always-apply` with its accepted `alwaysApply` alias,
 * `user-invocable`, `disable-model-invocation`) reaches the document through
 * that bag, so an uploaded file governs its own invocation channels the same
 * way an explicit `frontmatter` payload to `POST /api/skills` does.
 *
 * When a boolean field carries a value that isn't recognizable as
 * `true`/`false`, the parser records it on `invalidBooleans[]` so the import
 * handler can surface a 400 instead of silently dropping the flag. Without
 * this signal, authoring mistakes like `user-invocable: yes` would be
 * lossy-converted to the schema default and the user would never learn their
 * frontmatter was malformed.
 *
 * Entries outside the flags are filtered rather than rejected: an uploaded
 * file is not something the uploader typed into a form, so a stray
 * `version: 1.0` or a bespoke key from another skill ecosystem must not fail
 * the upload. Admin-authored paths (GitHub sync, deployment skills) keep
 * supported pass-through metadata; known fields with invalid shapes still
 * fail validation there.
 *
 * Exported for unit testing only — prefer `createImportHandler` at runtime.
 */
function parseFrontmatterForImport(raw: string): {
  parsed: ParsedSkillFile;
  inspectionFrontmatter: Record<string, unknown>;
} {
  const markdown = parseSkillMarkdown(raw);
  const result: ParsedSkillFile = {
    name: markdown.name,
    description: markdown.description,
    alwaysApply: markdown.alwaysApply,
    userInvocable: markdown.userInvocable,
    disableModelInvocation: markdown.disableModelInvocation,
    frontmatter: pickValidFrontmatter(toCleanFrontmatter(markdown)),
    invalidBooleans: markdown.invalidBooleans,
  };
  if (markdown.parseError) {
    result.parseError = markdown.parseError;
  }
  return { parsed: result, inspectionFrontmatter: markdown.frontmatter ?? {} };
}

export function parseFrontmatter(raw: string): ParsedSkillFile {
  return parseFrontmatterForImport(raw).parsed;
}

/**
 * Reject a SKILL.md whose frontmatter can't be trusted — unparseable YAML, or
 * a boolean invocation-mode flag with a value that is neither `true` nor
 * `false`. Returns the sent response, or `null` when the parse is clean.
 */
function sendFrontmatterIssues(res: Response, parsed: ParsedSkillFile): Response | null {
  if (parsed.parseError) {
    return res.status(400).json({
      error: 'Validation failed',
      issues: [
        {
          field: 'frontmatter',
          code: 'INVALID_YAML',
          message: `Invalid YAML frontmatter: ${parsed.parseError}`,
        },
      ],
    });
  }
  if (parsed.invalidBooleans.length > 0) {
    return res.status(400).json({
      error: 'Validation failed',
      issues: parsed.invalidBooleans.map((key) => ({
        field: `frontmatter.${key}`,
        code: 'INVALID_TYPE',
        message: `"${key}" must be a boolean (true or false)`,
      })),
    });
  }
  return null;
}

/** Type guard for validation errors thrown by data-schemas. */
function isValidationError(error: unknown): error is Error & { code: string; issues: unknown[] } {
  return (
    error instanceof Error &&
    (error as Error & { code?: string }).code === 'SKILL_VALIDATION_FAILED'
  );
}

/** Type guard for MongoDB duplicate key errors. */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code: unknown }).code === 11000
  );
}

export interface ImportSkillDeps {
  limits?: Partial<ImportLimits> | ((req: ServerRequest) => Partial<ImportLimits> | undefined);
  createSkill: (data: CreateSkillInput) => Promise<CreateSkillResult>;
  getSkillById: (id: string | Types.ObjectId) => Promise<(ISkill & { _id: Types.ObjectId }) | null>;
  deleteSkill: (id: string) => Promise<DeleteSkillResult>;
  upsertSkillFile: (row: UpsertSkillFileInput) => Promise<ISkillFile & { _id: Types.ObjectId }>;
  saveBuffer: (
    req: Request,
    params: {
      userId: string;
      buffer: Buffer;
      fileName: string;
      basePath?: string;
      isImage?: boolean;
      tenantId?: string;
    },
  ) => Promise<{ filepath: string; source: string; storageKey?: string; storageRegion?: string }>;
  deleteFile?: (
    req: Request,
    file: { filepath: string; source: string; [key: string]: unknown },
  ) => Promise<void>;
  grantPermission: (params: {
    principalType: string;
    principalId: string;
    resourceType: string;
    resourceId: Types.ObjectId;
    accessRoleId: string;
    grantedBy: string;
  }) => Promise<unknown>;
}

interface ServerRequest extends Request {
  tenantId?: string;
  config?: AppConfig;
  user: {
    id: string;
    _id: Types.ObjectId;
    name?: string;
    username?: string;
    tenantId?: string;
  };
  file?: Express.Multer.File;
}

interface FilterableSkillFile {
  readonly filename: string;
  readonly text?: string;
}

function blockFilteredImportContent(
  req: ServerRequest,
  res: Response,
  skill: SkillContentInput,
  files: readonly FilterableSkillFile[],
): boolean {
  const filters = req.config?.filters;
  const skillPii = filters?.skills?.pii;
  const skillPolicyActive = hasActivePiiPatterns(skillPii);
  const filePolicyActive = hasActiveFilePolicy(filters);
  if (!skillPolicyActive && !filePolicyActive) {
    return false;
  }

  const fragments: TextContentFragment[] = [];
  let traversalError: ContentTraversalLimitError | undefined;
  if (skillPolicyActive) {
    const skillFileNamesActive = hasActivePiiFields(skillPii, ['file_name']);
    const skillFileTextActive = hasActivePiiFields(skillPii, ['file_text']);
    try {
      fragments.push(
        ...extractSkillContent({
          name: hasActivePiiFields(skillPii, ['name']) ? skill.name : undefined,
          displayTitle: hasActivePiiFields(skillPii, ['display_title'])
            ? skill.displayTitle
            : undefined,
          description: hasActivePiiFields(skillPii, ['description'])
            ? skill.description
            : undefined,
          category: hasActivePiiFields(skillPii, ['category']) ? skill.category : undefined,
          body: hasActivePiiFields(skillPii, ['instructions']) ? skill.body : undefined,
          instructions: hasActivePiiFields(skillPii, ['instructions'])
            ? skill.instructions
            : undefined,
          importedText: hasActivePiiFields(skillPii, ['imported_text'])
            ? skill.importedText
            : undefined,
          frontmatter: hasActivePiiFields(skillPii, ['frontmatter'])
            ? skill.frontmatter
            : undefined,
          ...(skillFileNamesActive || skillFileTextActive
            ? {
                files: files.map((file) => ({
                  filename: skillFileNamesActive ? file.filename : undefined,
                  text: skillFileTextActive ? file.text : undefined,
                })),
              }
            : {}),
        }),
      );
    } catch (error) {
      if (!isContentTraversalLimitError(error)) {
        throw error;
      }
      fragments.push(...getContentTraversalFragments(error));
      traversalError = error;
    }
  }

  if (filePolicyActive) {
    const fileNamesActive = hasActiveFileFieldPolicy(filters, ['name']);
    const fileContentActive = hasActiveFileFieldPolicy(filters, ['content']);
    const fileTextActive = hasActiveFileFieldPolicy(filters, ['extracted_text']);
    for (const file of files) {
      fragments.push(
        ...extractFileContent({
          originalname: fileNamesActive ? file.filename : undefined,
          content: fileContentActive ? file.text : undefined,
          text: fileTextActive ? file.text : undefined,
        }),
      );
    }
  }
  const finding = inspectContent(fragments, { filters });
  if (finding == null) {
    if (
      traversalError == null ||
      !isContentTraversalProtected({ error: traversalError, filters })
    ) {
      return false;
    }
    res.status(traversalError.statusCode).json(traversalError.body);
    return true;
  }
  res.status(400).json(contentFilterBlockResponse(finding));
  return true;
}

function blockUninspectableImportFile(req: ServerRequest, res: Response): boolean {
  const field = getBlockedUninspectableSkillFileField(req.config?.filters, [
    'content',
    'extracted_text',
  ]);
  if (field == null) {
    return false;
  }
  res.status(400).json(contentFilterUninspectableResponse(field));
  return true;
}

/**
 * `POST /api/skills/import`
 *
 * Accepts a single multipart file (.md, .zip, or .skill).
 * Creates the skill, then processes additional files individually.
 * Grants SKILL_OWNER to the uploader.
 */
export function createImportHandler(deps: ImportSkillDeps) {
  return async function importSkillHandler(req: ServerRequest, res: Response): Promise<Response> {
    const { file } = req;
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const ext = path.extname(file.originalname).toLowerCase();

    try {
      if (ext === '.md') {
        return await handleMarkdown(req, res, deps, file);
      }
      if (ext === '.zip' || ext === '.skill') {
        return await handleZip(req, res, deps, file);
      }
      return res.status(400).json({ error: `Unsupported file type: ${ext}` });
    } catch (error) {
      // Surface validation errors as 400 instead of generic 500
      if (isValidationError(error)) {
        return res.status(400).json({
          error: 'Validation failed',
          issues: error.issues,
          message: (error.issues as Array<{ message?: string }>)?.map((i) => i.message).join('; '),
        });
      }
      if (isDuplicateKeyError(error)) {
        return res.status(409).json({ error: 'A skill with this name already exists' });
      }
      logger.error('[importSkill] Unhandled error:', error);
      return res.status(500).json({ error: 'Failed to import skill' });
    }
  };
}

function getImportLimits(limits?: Partial<ImportLimits>): ImportLimits {
  return {
    maxZipBytes: limits?.maxZipBytes ?? DEFAULT_SKILL_IMPORT_LIMITS.maxZipBytes,
    maxDecompressedBytes:
      limits?.maxDecompressedBytes ?? DEFAULT_SKILL_IMPORT_LIMITS.maxDecompressedBytes,
    maxContentInspectionBytes:
      limits?.maxContentInspectionBytes ?? DEFAULT_SKILL_IMPORT_LIMITS.maxContentInspectionBytes,
    maxEntries: limits?.maxEntries ?? DEFAULT_SKILL_IMPORT_LIMITS.maxEntries,
    maxSingleFileBytes:
      limits?.maxSingleFileBytes ?? DEFAULT_SKILL_IMPORT_LIMITS.maxSingleFileBytes,
  };
}

function resolveImportLimits(
  limits: ImportSkillDeps['limits'],
  req: ServerRequest,
): Partial<ImportLimits> | undefined {
  return typeof limits === 'function' ? limits(req) : limits;
}

/** Resolve author metadata from the request user. */
function getAuthorInfo(req: ServerRequest) {
  const user = req.user;
  const authorId = (user._id ?? user.id) as unknown as Types.ObjectId;
  const authorName = user.name ?? user.username ?? 'Unknown';
  const tenantId = resolveRequestTenantId(req);
  return { authorId, authorName, tenantId };
}

/** Grant SKILL_OWNER permission to the uploader. Rolls back skill on failure. */
async function grantOwnership(
  deps: ImportSkillDeps,
  userId: string,
  skillId: Types.ObjectId,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await deps.grantPermission({
      principalType: PrincipalType.USER,
      principalId: userId,
      resourceType: ResourceType.SKILL,
      resourceId: skillId,
      accessRoleId: AccessRoleIds.SKILL_OWNER,
      grantedBy: userId,
    });
    return { ok: true };
  } catch (error) {
    logger.error(`[importSkill] Failed to grant SKILL_OWNER for ${skillId}, rolling back:`, error);
    try {
      const deletion = await deleteSkillWithRetry(deps.deleteSkill, skillId.toString());
      if (!deletion.cleanupComplete) {
        logger.error(
          `[importSkill] Compensating delete incomplete for ${skillId}: ${deletion.failedCleanupSteps.join(', ')}`,
        );
      }
    } catch (rollbackError) {
      logger.error(`[importSkill] Compensating delete failed for ${skillId}:`, rollbackError);
    }
    return { ok: false, error: 'Failed to initialize skill permissions' };
  }
}

async function handleMarkdown(
  req: ServerRequest,
  res: Response,
  deps: ImportSkillDeps,
  file: Express.Multer.File,
) {
  const limits = getImportLimits(resolveImportLimits(deps.limits, req));
  const skillPii = req.config?.filters?.skills?.pii;
  const inspectFileText =
    hasActivePiiFields(skillPii, ['file_text']) ||
    hasActiveFileFieldPolicy(req.config?.filters, ['content', 'extracted_text']);
  const contentInspectionLimit = Math.min(
    limits.maxContentInspectionBytes,
    limits.maxDecompressedBytes,
  );
  if (
    inspectFileText &&
    file.buffer.length > contentInspectionLimit &&
    blockUninspectableImportFile(req, res)
  ) {
    return res;
  }
  if (isBinaryBuffer(file.buffer) && blockUninspectableImportFile(req, res)) {
    return res;
  }
  const content = file.buffer.toString('utf-8');

  const { parsed, inspectionFrontmatter } = parseFrontmatterForImport(content);
  const frontmatterError = sendFrontmatterIssues(res, parsed);
  if (frontmatterError) {
    return frontmatterError;
  }
  const { name, description, alwaysApply, frontmatter } = parsed;
  const inferredName =
    name ||
    file.originalname
      .replace(/\.md$/i, '')
      .replace(/[^a-z0-9-]/gi, '-')
      .replace(/^-+/, '')
      .toLowerCase();
  if (!inferredName) {
    return res
      .status(400)
      .json({ error: 'Could not determine skill name from file or frontmatter' });
  }

  const { authorId, authorName, tenantId } = getAuthorInfo(req);
  if (
    blockFilteredImportContent(
      req,
      res,
      {
        name: inferredName,
        description: description || inferredName,
        body: content,
        importedText: content,
        frontmatter: inspectionFrontmatter,
      },
      [{ filename: file.originalname, text: content }],
    )
  ) {
    return res;
  }

  const result = await deps.createSkill({
    name: inferredName,
    description: description || inferredName,
    body: content,
    frontmatter,
    author: authorId,
    authorName,
    alwaysApply,
    tenantId,
  });

  const skill = result.skill as ISkill & { _id: Types.ObjectId };
  const grant = await grantOwnership(deps, req.user.id, skill._id);
  if (!grant.ok) {
    return res.status(500).json({ error: grant.error });
  }

  return res.status(201).json(skill);
}

type ImportFileResult = {
  path: string;
  status: 'ok' | 'error';
  /** Stable code the client localizes; set on every failure. */
  reason?: SkillImportFailureReason;
  /** Limit in MB, when `reason` names a size limit. */
  limitMb?: number;
  /**
   * Human-readable detail for the server log only. Storage and database
   * messages can name buckets, hosts and driver internals, so this never
   * reaches the client — `reason` does.
   */
  error?: string;
};

/**
 * Limits are reported to the user in MB. Two decimals, and never 0 for a
 * positive limit: a deployment configured in kilobytes would otherwise render
 * as "exceeds the 0 MB limit".
 */
function bytesToMb(bytes: number): number {
  if (bytes <= 0) {
    return 0;
  }
  return Math.max(0.01, Math.round((bytes / (1024 * 1024)) * 100) / 100);
}

interface ArchiveFileDescriptor {
  readonly entryPath: string;
  readonly relativePath: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: number;
}

interface ArchiveScan {
  readonly files: ArchiveFileDescriptor[];
  readonly results: ImportFileResult[];
  readonly blocked: boolean;
  readonly cumulativeLimitExceeded: boolean;
}

interface ArchiveScanCallbacks {
  readonly onName?: (name: string) => boolean;
  readonly onFile?: (file: ArchiveFileDescriptor, buffer: Buffer) => boolean | Promise<boolean>;
}

async function readZipEntry(
  zipEntry: JSZip.JSZipObject,
  effectiveLimit: number,
): Promise<{ buffer: Buffer | null; bytesRead: number }> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  let exceededLimit = false;
  const entryStream = zipEntry.nodeStream('nodebuffer');

  await new Promise<void>((resolve, reject) => {
    entryStream.on('data', (chunk: Buffer) => {
      if (exceededLimit) {
        return;
      }
      bytesRead += chunk.length;
      if (bytesRead > effectiveLimit) {
        exceededLimit = true;
        if ('destroy' in entryStream && typeof entryStream.destroy === 'function') {
          entryStream.destroy();
        }
        resolve();
        return;
      }
      chunks.push(chunk);
    });
    entryStream.on('end', resolve);
    entryStream.on('error', reject);
  });

  return {
    buffer: exceededLimit ? null : Buffer.concat(chunks),
    bytesRead,
  };
}

/**
 * Record every archive entry the scan never reached.
 *
 * The decompression budget stops the loop mid-archive, and an import that
 * reported only the entries it happened to read would tell the user they had
 * seen the whole failure set: they would fix those paths, retry, and meet the
 * next batch. `startIndex` is the entry the loop stopped on, inclusive.
 */
function pushUnprocessedEntries(
  results: ImportFileResult[],
  entries: readonly [string, JSZip.JSZipObject][],
  startIndex: number,
  prefix: string,
  limitMb: number,
): void {
  for (let index = startIndex; index < entries.length; index++) {
    const [entryPath, zipEntry] = entries[index];
    if (zipEntry.dir) {
      continue;
    }
    const normalized = entryPath.replace(/\\/g, '/');
    const relativePath =
      prefix && normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
    if (relativePath.toUpperCase() === SKILL_MD.toUpperCase()) {
      continue;
    }
    results.push({
      path: relativePath || normalized,
      status: 'error',
      reason: 'archive_too_large',
      limitMb,
      error: 'Not processed: cumulative decompressed size exceeded limit',
    });
  }
}

async function scanArchiveFiles(
  zip: JSZip,
  prefix: string,
  limits: ImportLimits,
  callbacks: ArchiveScanCallbacks = {},
  initialDecompressedBytes = 0,
  maxDecompressedBytes = limits.maxDecompressedBytes,
): Promise<ArchiveScan> {
  const files: ArchiveFileDescriptor[] = [];
  const results: ImportFileResult[] = [];
  let totalDecompressed = initialDecompressedBytes;
  let cumulativeLimitExceeded = false;

  const entries = Object.entries(zip.files);
  const budgetMb = bytesToMb(maxDecompressedBytes);

  for (let index = 0; index < entries.length; index++) {
    const [entryPath, zipEntry] = entries[index];
    if (zipEntry.dir) {
      continue;
    }
    const normalized = entryPath.replace(/\\/g, '/');
    const relativePath =
      prefix && normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
    if (relativePath.toUpperCase() === SKILL_MD.toUpperCase()) {
      continue;
    }
    if (callbacks.onName?.(relativePath || normalized) === true) {
      return { files, results, blocked: true, cumulativeLimitExceeded };
    }
    if (validateRelativePath(relativePath).length > 0) {
      results.push({
        path: relativePath,
        status: 'error',
        reason: 'invalid_path',
        error: 'Invalid path',
      });
      continue;
    }

    try {
      const cumulativeLimit = maxDecompressedBytes - totalDecompressed;
      const effectiveLimit = Math.min(limits.maxSingleFileBytes, cumulativeLimit);
      if (effectiveLimit <= 0) {
        cumulativeLimitExceeded = true;
        pushUnprocessedEntries(results, entries, index, prefix, budgetMb);
        break;
      }

      const { buffer, bytesRead } = await readZipEntry(zipEntry, effectiveLimit);
      totalDecompressed += bytesRead;
      if (buffer == null) {
        if (bytesRead > cumulativeLimit) {
          cumulativeLimitExceeded = true;
          pushUnprocessedEntries(results, entries, index, prefix, budgetMb);
          break;
        }
        results.push({
          path: relativePath,
          status: 'error',
          reason: 'file_too_large',
          limitMb: bytesToMb(limits.maxSingleFileBytes),
          error: `File too large (max ${limits.maxSingleFileBytes / 1024 / 1024}MB)`,
        });
        continue;
      }

      const filename = path.basename(relativePath);
      const fileDescriptor: ArchiveFileDescriptor = {
        entryPath,
        relativePath,
        filename,
        mimeType: guessMimeType(filename),
        bytes: buffer.length,
      };
      if ((await callbacks.onFile?.(fileDescriptor, buffer)) === true) {
        return { files, results, blocked: true, cumulativeLimitExceeded };
      }
      files.push(fileDescriptor);
      results.push({ path: relativePath, status: 'ok' });
    } catch (error) {
      logger.error(`[importSkill] Failed to read file ${relativePath}:`, error);
      results.push({
        path: relativePath,
        status: 'error',
        reason: 'persistence_failed',
        error: (error as Error).message,
      });
    }
  }

  return { files, results, blocked: false, cumulativeLimitExceeded };
}

function preflightArchiveNames(
  zip: JSZip,
  prefix: string,
  onName: (name: string) => boolean,
): boolean {
  for (const [entryPath, zipEntry] of Object.entries(zip.files)) {
    if (zipEntry.dir) {
      continue;
    }
    const normalized = entryPath.replace(/\\/g, '/');
    const relativePath =
      prefix && normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
    if (relativePath.toUpperCase() === SKILL_MD.toUpperCase()) {
      continue;
    }
    if (onName(relativePath || normalized)) {
      return true;
    }
  }
  return false;
}

/** A blob that reached storage, kept so a failed import can delete it again. */
interface PersistedArchiveBlob {
  readonly relativePath: string;
  readonly filepath: string;
  readonly source: string;
  readonly storageKey?: string;
  readonly storageRegion?: string;
  /** Whether a SkillFile row can still reference this blob. */
  readonly rowPersisted: boolean;
}

interface ArchivePersistenceContext {
  readonly userId: string;
  readonly skillId: Types.ObjectId;
  readonly authorId: Types.ObjectId;
  readonly tenantId?: string;
  /**
   * Blobs written so far, in archive order. An import that loses any bundled
   * file is rolled back whole (`rollbackArchiveImport`), and the storage writes
   * are the only part of that no database cascade can undo.
   */
  readonly persisted: PersistedArchiveBlob[];
}

async function persistArchiveFile(
  req: ServerRequest,
  deps: ImportSkillDeps,
  file: ArchiveFileDescriptor,
  buffer: Buffer,
  context: ArchivePersistenceContext,
): Promise<void> {
  const fileId = crypto.randomUUID();
  const storageFileName = `${fileId}__${file.filename}`;
  const { filepath, source, storageKey, storageRegion } = await deps.saveBuffer(req, {
    userId: context.userId,
    buffer,
    fileName: storageFileName,
    basePath: 'uploads',
    isImage: file.mimeType.startsWith('image/'),
    tenantId: context.tenantId,
  });
  const persistedBlob: PersistedArchiveBlob = {
    relativePath: file.relativePath,
    filepath,
    source,
    storageKey,
    storageRegion,
    rowPersisted: false,
  };

  try {
    await deps.upsertSkillFile({
      skillId: context.skillId,
      relativePath: file.relativePath,
      file_id: fileId,
      filename: file.filename,
      filepath,
      storageKey,
      storageRegion,
      source,
      mimeType: file.mimeType,
      bytes: buffer.length,
      isExecutable: false,
      author: context.authorId,
      tenantId: context.tenantId,
    });
  } catch (dbError) {
    let blobRemoved = false;
    if (deps.deleteFile) {
      await deps
        .deleteFile(req, {
          filepath,
          storageKey,
          storageRegion,
          source,
          user: context.authorId,
          tenantId: context.tenantId,
        })
        .then(() => {
          blobRemoved = true;
        })
        .catch((error) =>
          logger.error(`[importSkill] Orphan cleanup failed for ${file.relativePath}:`, error),
        );
    }
    if (!blobRemoved) {
      context.persisted.push(persistedBlob);
    }
    throw dbError;
  }

  context.persisted.push({ ...persistedBlob, rowPersisted: true });
}

async function cleanupArchiveBlobs(
  req: ServerRequest,
  deps: ImportSkillDeps,
  context: ArchivePersistenceContext,
  blobs: PersistedArchiveBlob[],
): Promise<boolean> {
  const { deleteFile } = deps;
  if (blobs.length === 0) {
    return true;
  }
  if (deleteFile == null) {
    return false;
  }

  const limit = createConcurrencyLimiter(
    req.config?.fileConfig?.skills?.importCleanupConcurrency ??
      DEFAULT_SKILL_IMPORT_CLEANUP_CONCURRENCY,
  );
  const results = await Promise.allSettled(
    blobs.map((blob) =>
      limit(() =>
        deleteFile(req, {
          filepath: blob.filepath,
          storageKey: blob.storageKey,
          storageRegion: blob.storageRegion,
          source: blob.source,
          user: context.authorId,
          tenantId: context.tenantId,
        }),
      ),
    ),
  );
  let complete = true;
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      complete = false;
      logger.error(
        `[importSkill] Rollback blob cleanup failed for ${blobs[index].relativePath}:`,
        result.reason,
      );
    }
  }
  return complete;
}

/**
 * Undo an archive import that could not persist every bundled file.
 *
 * `deleteSkill` cascades to the SkillFile rows, the agent allowlists and the
 * ACL grant, so only the storage blobs written by `persistArchiveFile` need
 * explicit cleanup.
 *
 * Order matters: the blobs are deleted only once the cascade has confirmed the
 * skill is gone. If the delete throws or finds nothing, the SkillFile rows may
 * still reference those blobs, and deleting them anyway would leave a visible,
 * shareable skill whose files 404 — a worse version of the bug this rollback
 * exists to prevent. Unreferenced storage is reclaimable; a broken skill is
 * not, so the blobs stay and the caller reports the rollback as incomplete.
 */
async function rollbackArchiveImport(
  req: ServerRequest,
  deps: ImportSkillDeps,
  context: ArchivePersistenceContext,
): Promise<{ skillRemoved: boolean; cleanupComplete: boolean }> {
  const skillId = context.skillId.toString();
  let deletion: DeleteSkillResult;
  try {
    deletion = await deps.deleteSkill(skillId);
  } catch (error) {
    logger.error(`[importSkill] Rollback delete failed for skill ${skillId}:`, error);
    logger.error(
      `[importSkill] Rollback incomplete for skill ${skillId}: retaining row-backed files because the skill row was not removed`,
    );
    await cleanupArchiveBlobs(
      req,
      deps,
      context,
      context.persisted.filter((blob) => !blob.rowPersisted),
    );
    return { skillRemoved: false, cleanupComplete: false };
  }

  if (deletion.skillAbsent && !deletion.cleanupComplete) {
    try {
      deletion = mergeDeleteSkillResults(deletion, await deps.deleteSkill(skillId));
    } catch (error) {
      logger.error(`[importSkill] Rollback cleanup retry failed for skill ${skillId}:`, error);
    }
  }

  if (!deletion.skillAbsent) {
    logger.error(`[importSkill] Rollback could not confirm removal of skill ${skillId}`);
    await cleanupArchiveBlobs(
      req,
      deps,
      context,
      context.persisted.filter((blob) => !blob.rowPersisted),
    );
    return { skillRemoved: false, cleanupComplete: false };
  }
  const databaseCleanupComplete = deletion.cleanupComplete;
  if (!deletion.cleanupComplete) {
    logger.error(
      `[importSkill] Rollback database cleanup incomplete for skill ${skillId}: ${deletion.failedCleanupSteps.join(', ')}`,
    );
    /** If SkillFile cleanup failed, those rows can still reference the stored
     * blobs, so retain them for the idempotent database retry. When only an
     * independent cleanup step failed, the captured records are now the last
     * blob references and must be consumed before returning the 500. */
  }

  const skillFileCleanupIncomplete = deletion.failedCleanupSteps.includes('skill_files');
  const blobsToDelete = skillFileCleanupIncomplete
    ? context.persisted.filter((blob) => !blob.rowPersisted)
    : context.persisted;

  const blobCleanupComplete = await cleanupArchiveBlobs(req, deps, context, blobsToDelete);
  return {
    skillRemoved: true,
    cleanupComplete: databaseCleanupComplete && blobCleanupComplete,
  };
}

async function persistPreflightedArchiveFiles(
  req: ServerRequest,
  deps: ImportSkillDeps,
  zip: JSZip,
  files: readonly ArchiveFileDescriptor[],
  limits: ImportLimits,
  context: ArchivePersistenceContext,
  initialDecompressedBytes = 0,
): Promise<ImportFileResult[]> {
  const results: ImportFileResult[] = [];
  let totalDecompressed = initialDecompressedBytes;
  const budgetMb = bytesToMb(limits.maxDecompressedBytes);

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    try {
      const zipEntry = zip.file(file.entryPath);
      if (zipEntry == null) {
        throw new Error('Archive entry is no longer available');
      }
      const cumulativeLimit = limits.maxDecompressedBytes - totalDecompressed;
      const effectiveLimit = Math.min(limits.maxSingleFileBytes, cumulativeLimit);
      if (effectiveLimit <= 0) {
        /** Same reasoning as `pushUnprocessedEntries`: the remaining files were
         *  never attempted, and omitting them would understate the failure set
         *  the user has to fix before a retry can succeed. */
        for (const skipped of files.slice(index)) {
          results.push({
            path: skipped.relativePath,
            status: 'error',
            reason: 'archive_too_large',
            limitMb: budgetMb,
            error: 'Not processed: cumulative decompressed size exceeded limit',
          });
        }
        break;
      }
      const { buffer, bytesRead } = await readZipEntry(zipEntry, effectiveLimit);
      totalDecompressed += bytesRead;
      if (buffer == null) {
        results.push({
          path: file.relativePath,
          status: 'error',
          reason: 'archive_entry_changed',
          error: 'Archive entry changed after content inspection',
        });
        continue;
      }
      if (buffer.length !== file.bytes) {
        throw new Error('Archive entry changed after content inspection');
      }
      await persistArchiveFile(req, deps, file, buffer, context);
      results.push({ path: file.relativePath, status: 'ok' });
    } catch (error) {
      logger.error(`[importSkill] Failed to process file ${file.relativePath}:`, error);
      results.push({
        path: file.relativePath,
        status: 'error',
        reason: 'persistence_failed',
        error: (error as Error).message,
      });
    }
  }

  return results;
}

async function handleZip(
  req: ServerRequest,
  res: Response,
  deps: ImportSkillDeps,
  file: Express.Multer.File,
) {
  const userId = req.user.id;
  const limits = getImportLimits(resolveImportLimits(deps.limits, req));

  const zipBuffer = file.buffer;

  if (zipBuffer.length > limits.maxZipBytes) {
    return res
      .status(400)
      .json({ error: `File too large (max ${limits.maxZipBytes / 1024 / 1024}MB)` });
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBuffer);
  } catch {
    return res.status(400).json({ error: 'Invalid or corrupt archive' });
  }
  const entries = Object.keys(zip.files);

  if (entries.length > limits.maxEntries) {
    return res.status(400).json({ error: `Too many files in archive (max ${limits.maxEntries})` });
  }

  // Find SKILL.md — at root or one level deep
  let skillMdPath: string | null = null;
  let prefix = '';
  for (const p of entries) {
    if (zip.files[p].dir) {
      continue;
    }
    const normalized = p.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    const basename = segments[segments.length - 1];
    if (basename?.toUpperCase() === SKILL_MD.toUpperCase() && segments.length <= 2) {
      skillMdPath = p;
      if (segments.length === 2) {
        prefix = segments[0] + '/';
      }
      break;
    }
  }

  if (!skillMdPath) {
    return res.status(400).json({ error: 'Archive must contain a SKILL.md file' });
  }

  const skillMdEntry = zip.file(skillMdPath);
  if (skillMdEntry == null) {
    return res.status(400).json({ error: 'Could not read SKILL.md from archive' });
  }
  const declaredSize =
    (skillMdEntry as unknown as { _data?: { uncompressedSize?: number } })?._data
      ?.uncompressedSize ?? 0;
  if (declaredSize > limits.maxSingleFileBytes) {
    return res
      .status(400)
      .json({ error: `SKILL.md too large (${Math.round(declaredSize / 1024 / 1024)}MB)` });
  }
  const skillMdLimit = Math.min(limits.maxSingleFileBytes, limits.maxDecompressedBytes);
  const { buffer: skillMdBuffer } = await readZipEntry(skillMdEntry, skillMdLimit);
  if (skillMdBuffer == null) {
    return res.status(400).json({ error: 'SKILL.md exceeds maximum file size' });
  }
  if (isBinaryBuffer(skillMdBuffer) && blockUninspectableImportFile(req, res)) {
    return res;
  }
  const skillMdBytes = skillMdBuffer.length;
  const skillMdContent = skillMdBuffer.toString('utf-8');
  if (!skillMdContent) {
    return res.status(400).json({ error: 'Could not read SKILL.md from archive' });
  }

  const { parsed, inspectionFrontmatter } = parseFrontmatterForImport(skillMdContent);
  const frontmatterError = sendFrontmatterIssues(res, parsed);
  if (frontmatterError) {
    return frontmatterError;
  }
  const { name, description, alwaysApply, frontmatter } = parsed;
  const inferredName =
    name ||
    file.originalname
      .replace(/\.(zip|skill)$/i, '')
      .replace(/[^a-z0-9-]/gi, '-')
      .replace(/^-+/, '')
      .toLowerCase();

  if (!inferredName) {
    return res.status(400).json({ error: 'Could not determine skill name' });
  }

  const skillPii = req.config?.filters?.skills?.pii;
  const hasRelevantFilters =
    hasActivePiiPatterns(skillPii) || hasActiveFilePolicy(req.config?.filters);
  const inspectArchiveNames =
    hasActivePiiFields(skillPii, ['file_name']) ||
    hasActiveFileFieldPolicy(req.config?.filters, ['name']);
  const inspectArchiveText =
    hasActivePiiFields(skillPii, ['file_text']) ||
    hasActiveFileFieldPolicy(req.config?.filters, ['content', 'extracted_text']);
  const contentInspectionLimit = Math.min(
    limits.maxContentInspectionBytes,
    limits.maxDecompressedBytes,
  );

  let preflight: ArchiveScan | null = null;
  if (hasRelevantFilters) {
    if (inspectArchiveText && skillMdBytes > contentInspectionLimit) {
      if (blockUninspectableImportFile(req, res)) {
        return res;
      }
    }
    if (
      blockFilteredImportContent(
        req,
        res,
        {
          name: inferredName,
          description: description || inferredName,
          body: skillMdContent,
          importedText: skillMdContent,
          frontmatter: inspectionFrontmatter,
        },
        [{ filename: file.originalname }, { filename: skillMdPath, text: skillMdContent }],
      )
    ) {
      return res;
    }
    if (
      inspectArchiveNames &&
      preflightArchiveNames(zip, prefix, (filename) =>
        blockFilteredImportContent(req, res, {}, [{ filename }]),
      )
    ) {
      return res;
    }
    if (inspectArchiveText) {
      preflight = await scanArchiveFiles(
        zip,
        prefix,
        limits,
        {
          onFile: (archiveFile, buffer) => {
            const isBinary = isBinaryBuffer(buffer);
            if (isBinary && blockUninspectableImportFile(req, res)) {
              return true;
            }
            const text = isBinary ? undefined : buffer.toString('utf-8');
            return blockFilteredImportContent(req, res, {}, [
              { filename: archiveFile.relativePath, text },
            ]);
          },
        },
        skillMdBytes,
        contentInspectionLimit,
      );
      if (preflight.blocked) {
        return res;
      }
      if (preflight.cumulativeLimitExceeded) {
        if (blockUninspectableImportFile(req, res)) {
          return res;
        }
        /** Compatibility mode: names and the in-budget prefix were inspected,
         *  while the regular persistence pass below streams every archive
         *  entry. `uninspectable: block` takes the branch above. */
        preflight = null;
      }
    }
  }

  const { authorId, authorName, tenantId } = getAuthorInfo(req);
  const result = await deps.createSkill({
    name: inferredName,
    description: description || inferredName,
    body: skillMdContent,
    frontmatter,
    author: authorId,
    authorName,
    alwaysApply,
    tenantId,
  });

  const skill = result.skill as ISkill & { _id: Types.ObjectId };

  // Grant ownership — rolls back skill on failure
  const grant = await grantOwnership(deps, userId, skill._id);
  if (!grant.ok) {
    return res.status(500).json({ error: grant.error });
  }

  const persistenceContext: ArchivePersistenceContext = {
    userId,
    skillId: skill._id,
    authorId,
    tenantId,
    persisted: [],
  };
  let fileResults: ImportFileResult[];
  if (preflight == null) {
    const processing = await scanArchiveFiles(
      zip,
      prefix,
      limits,
      {
        onFile: async (archiveFile, buffer) => {
          await persistArchiveFile(req, deps, archiveFile, buffer, persistenceContext);
          return false;
        },
      },
      skillMdBytes,
    );
    fileResults = processing.results;
  } else {
    const preflightErrors = preflight.results.filter((result) => result.status === 'error');
    const persisted = await persistPreflightedArchiveFiles(
      req,
      deps,
      zip,
      preflight.files,
      limits,
      persistenceContext,
      skillMdBytes,
    );
    fileResults = [...preflightErrors, ...persisted];
  }

  const errors: typeof fileResults = [];
  let successCount = 0;
  for (const r of fileResults) {
    if (r.status === 'ok') {
      successCount++;
    } else {
      errors.push(r);
    }
  }

  /**
   * A skill whose bundled files did not all persist is broken in a way the
   * uploader cannot see: it lists, shares and attaches normally while an agent
   * that follows `SKILL.md` cannot find the resources it names. Import is
   * therefore atomic — any failed file rolls the whole skill back and the
   * response says which paths failed and why.
   */
  if (errors.length > 0) {
    logger.warn(
      `[importSkill] Rolling back skill "${inferredName}" (${skill._id.toString()}): ${errors.length} of ${fileResults.length} files failed`,
    );
    const { skillRemoved, cleanupComplete } = await rollbackArchiveImport(
      req,
      deps,
      persistenceContext,
    );
    /** Reasons are codes, not prose: the client localizes them, and the
     *  underlying storage and database messages stay in the server log where
     *  they cannot leak infrastructure detail to the uploader. */
    const failedFiles = errors.map((entry) => ({
      path: entry.path,
      reason: entry.reason ?? 'persistence_failed',
      ...(entry.limitMb == null ? {} : { limitMb: entry.limitMb }),
    }));
    if (!skillRemoved) {
      const rollbackFailure: TSkillImportFailedResponse = {
        error: 'skill_import_rollback_failed',
        message: `Import failed for ${errors.length} of ${fileResults.length} files and the partially created skill could not be removed automatically.`,
        failedFiles,
        skillId: skill._id.toString(),
      };
      return res.status(500).json(rollbackFailure);
    }
    if (!cleanupComplete) {
      const cleanupFailure: TSkillImportFailedResponse = {
        error: 'skill_import_cleanup_incomplete',
        message: `Import failed for ${errors.length} of ${fileResults.length} files. The skill was removed, but automatic cleanup did not finish.`,
        failedFiles,
      };
      return res.status(500).json(cleanupFailure);
    }
    const failure: TSkillImportFailedResponse = {
      error: 'skill_import_incomplete',
      message: `Import canceled: ${errors.length} of ${fileResults.length} files in the archive could not be imported.`,
      failedFiles,
    };
    return res.status(422).json(failure);
  }

  logger.info(`[importSkill] Imported skill "${inferredName}" with ${successCount} files`);

  // Re-read the skill to get the current version/fileCount (bumped by each upsertSkillFile)
  const refreshed = (await deps.getSkillById(skill._id)) ?? skill;

  return res.status(201).json({
    ...refreshed,
    _importSummary: {
      filesProcessed: fileResults.length,
      filesSucceeded: successCount,
      filesFailed: 0,
      errors,
    },
  });
}

const MIME_MAP: Record<string, string> = {
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

const TEXT_FILE_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.json',
  '.yaml',
  '.yml',
  '.py',
  '.sh',
  '.css',
  '.html',
  '.xml',
  '.csv',
  '.toml',
  '.ini',
  '.svg',
]);

const TEXT_APPLICATION_MIMES = new Set([
  'application/json',
  'application/javascript',
  'application/xml',
  'application/x-sh',
  'application/yaml',
  'application/toml',
  'image/svg+xml',
]);

export function isTextLikeSkillFile(filename: string, mimeType?: string): boolean {
  const normalizedMime = mimeType?.split(';', 1)[0]?.trim().toLowerCase();
  if (normalizedMime?.startsWith('text/') === true) {
    return true;
  }
  if (normalizedMime != null && TEXT_APPLICATION_MIMES.has(normalizedMime)) {
    return true;
  }
  return TEXT_FILE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

export function guessMimeType(filename: string): string {
  return MIME_MAP[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}
