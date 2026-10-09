import { logger } from '@librechat/data-schemas';
import {
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  PermissionBits,
} from 'librechat-data-provider';
import type {
  TSkill,
  TSkillFile,
  TSkillSummary,
  TSkillWarning,
  TCreateSkill,
  TUpdateSkillPayload,
  TListSkillFilesResponse,
  TDeleteSkillResponse,
  TDeleteSkillFileResponse,
  TSkillConflictResponse,
  TSkillFileContentResponse,
} from 'librechat-data-provider';
import type {
  ISkill,
  ISkillFile,
  ISkillSummary,
  CreateSkillInput,
  CreateSkillResult,
  UpdateSkillInput,
  ListSkillsByAccessResult,
  ListSkillsByAccessParams,
  UpdateSkillResult,
  ValidationIssue,
  DeleteSkillResult,
} from '@librechat/data-schemas';
import type { Response } from 'express';
import type { Types } from 'mongoose';
import type { ServerRequest, StrategyFunctions } from '~/types';
import { extractSkillContent, inspectContentWithTraversal } from '~/protection';
import { deleteSkillWithRetry, mergeDeleteSkillResults } from './cleanup';
import { contentFilterBlockResponse } from '~/middleware/contentFilter';
import { getDeploymentSkillIds } from './deployment';
import { resolveDownloadPath } from '~/storage/path';
import { resolveSkillFilePathParam } from './path';
import { parseSkillMarkdown } from './parse';
import { isBinaryBuffer } from './binary';

/** Thin error shape the skill methods throw on validation failure. */
type SkillValidationError = Error & { code?: string; issues?: ValidationIssue[] };

/** Mongo duplicate-key shape. */
type DuplicateKeyError = Error & { code?: number | string };

/**
 * All dependencies required to serve skill HTTP requests. Every dep is resolved
 * from the legacy api layer (`~/models`, `PermissionService`) so the TS handlers
 * stay pure — no direct imports of mongoose, no direct filesystem I/O.
 */
export interface SkillsHandlersDeps {
  /** Skill CRUD — from `@librechat/data-schemas` `createMethods` output. */
  createSkill: (data: CreateSkillInput) => Promise<CreateSkillResult>;
  getSkillById: (id: string | Types.ObjectId) => Promise<(ISkill & { _id: Types.ObjectId }) | null>;
  listSkillsByAccess: (params: ListSkillsByAccessParams) => Promise<ListSkillsByAccessResult>;
  updateSkill: (params: {
    id: string;
    expectedVersion: number;
    update: UpdateSkillInput;
  }) => Promise<UpdateSkillResult>;
  deleteSkill: (id: string) => Promise<DeleteSkillResult>;
  listSkillFiles: (
    skillId: string | Types.ObjectId,
  ) => Promise<Array<ISkillFile & { _id: Types.ObjectId }>>;
  deleteSkillFile: (
    skillId: string | Types.ObjectId,
    relativePath: string,
  ) => Promise<{ deleted: boolean }>;

  /** Access-control primitives from PermissionService. */
  findAccessibleResources: (params: {
    userId: string;
    role?: string | null;
    resourceType: string;
    requiredPermissions: number;
  }) => Promise<Types.ObjectId[]>;
  findPubliclyAccessibleResources: (params: {
    resourceType: string;
    requiredPermissions: number;
  }) => Promise<Types.ObjectId[]>;
  hasPublicPermission: (params: {
    resourceType: string;
    resourceId: string | Types.ObjectId;
    requiredPermissions: number;
  }) => Promise<boolean>;
  grantPermission: (params: {
    principalType: string;
    principalId: string | Types.ObjectId;
    resourceType: string;
    resourceId: string | Types.ObjectId;
    accessRoleId: string;
    grantedBy: string | Types.ObjectId;
  }) => Promise<unknown>;

  /** Single-file lookup + cache update for the download handler. */
  getSkillFileByPath: (
    skillId: string | Types.ObjectId,
    relativePath: string,
  ) => Promise<(ISkillFile & { _id: Types.ObjectId; content?: string; isBinary?: boolean }) | null>;
  updateSkillFileContent: (
    skillId: string | Types.ObjectId,
    relativePath: string,
    update: { content?: string; isBinary?: boolean },
    expectedFileId?: string,
  ) => Promise<void>;

  /** Storage strategy resolver — returns stream/URL helpers keyed by source. */
  getStrategyFunctions: (source: string) => Partial<StrategyFunctions>;

  /** ObjectId validation helper from data-schemas. */
  isValidObjectIdString: (value: unknown) => boolean;
}

/**
 * Narrow an opaque `Record<string, unknown>` frontmatter (as stored in Mongoose
 * `Mixed`) to the wire type. Returns `undefined` for empty/missing frontmatter
 * so clients see a clear absence instead of an empty `{}`.
 */
function serializeFrontmatter(
  frontmatter: Record<string, unknown> | undefined,
): TSkill['frontmatter'] {
  if (!frontmatter || typeof frontmatter !== 'object' || Object.keys(frontmatter).length === 0) {
    return undefined;
  }
  return frontmatter as TSkill['frontmatter'];
}

function serializeSourceMetadata(
  metadata: Record<string, unknown> | undefined,
): TSkill['sourceMetadata'] {
  if (!metadata || typeof metadata !== 'object' || Object.keys(metadata).length === 0) {
    return undefined;
  }
  return metadata as TSkill['sourceMetadata'];
}

/** Converts a skill document to the wire format returned by the API. */
function serializeSkill(
  skill: ISkill & { _id: Types.ObjectId },
  isPublic: boolean | Set<string>,
): TSkill {
  const pub = typeof isPublic === 'boolean' ? isPublic : isPublic.has(skill._id.toString());
  return {
    _id: skill._id.toString(),
    name: skill.name,
    displayTitle: skill.displayTitle,
    description: skill.description,
    body: skill.body,
    frontmatter: serializeFrontmatter(skill.frontmatter),
    category: skill.category,
    disableModelInvocation: skill.disableModelInvocation,
    userInvocable: skill.userInvocable,
    allowedTools: skill.allowedTools,
    author: skill.author.toString(),
    authorName: skill.authorName,
    version: skill.version,
    source: skill.source ?? 'inline',
    sourceMetadata: serializeSourceMetadata(skill.sourceMetadata),
    fileCount: skill.fileCount,
    alwaysApply: skill.alwaysApply,
    isPublic: pub,
    tenantId: skill.tenantId,
    createdAt: (skill.createdAt ?? new Date()).toISOString(),
    updatedAt: (skill.updatedAt ?? new Date()).toISOString(),
  };
}

function serializeSkillSummary(
  skill: ISkillSummary & { _id: Types.ObjectId },
  isPublic: boolean | Set<string>,
): TSkillSummary {
  const pub = typeof isPublic === 'boolean' ? isPublic : isPublic.has(skill._id.toString());
  return {
    _id: skill._id.toString(),
    name: skill.name,
    displayTitle: skill.displayTitle,
    description: skill.description,
    category: skill.category,
    disableModelInvocation: skill.disableModelInvocation,
    userInvocable: skill.userInvocable,
    allowedTools: skill.allowedTools,
    author: skill.author.toString(),
    authorName: skill.authorName,
    version: skill.version,
    source: skill.source ?? 'inline',
    sourceMetadata: serializeSourceMetadata(skill.sourceMetadata),
    fileCount: skill.fileCount,
    alwaysApply: skill.alwaysApply,
    isPublic: pub,
    tenantId: skill.tenantId,
    createdAt: (skill.createdAt ?? new Date()).toISOString(),
    updatedAt: (skill.updatedAt ?? new Date()).toISOString(),
  };
}

function serializeSkillFile(file: ISkillFile & { _id: Types.ObjectId }): TSkillFile {
  return {
    _id: file._id.toString(),
    skillId: file.skillId.toString(),
    relativePath: file.relativePath,
    file_id: file.file_id,
    filename: file.filename,
    filepath: file.filepath,
    storageKey: file.storageKey,
    storageRegion: file.storageRegion,
    source: file.source as TSkillFile['source'],
    sourceMetadata: file.sourceMetadata as TSkillFile['sourceMetadata'],
    mimeType: file.mimeType,
    bytes: file.bytes,
    category: file.category,
    isExecutable: file.isExecutable,
    author: file.author.toString(),
    tenantId: file.tenantId,
    createdAt: (file.createdAt ?? new Date()).toISOString(),
    updatedAt: (file.updatedAt ?? new Date()).toISOString(),
  };
}

/**
 * Attach non-blocking coaching warnings to a serialized skill response.
 * Called from `createHandler` and `patchHandler` so clients can show inline
 * feedback (e.g. "description too short") without the write being rejected.
 * Only warning-severity issues come through here — errors are thrown by
 * `createSkill`/`updateSkill` before we reach this point.
 */
function attachWarnings(skill: TSkill, warnings: ValidationIssue[]): TSkill {
  if (!warnings || warnings.length === 0) {
    return skill;
  }
  return {
    ...skill,
    warnings: warnings.map((w) => ({
      field: w.field,
      code: w.code,
      message: w.message,
      severity: 'warning' as const,
    })) satisfies TSkillWarning[],
  };
}

function isValidationError(error: unknown): error is SkillValidationError {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === 'SKILL_VALIDATION_FAILED' || code === 'SKILL_FILE_VALIDATION_FAILED';
}

function isDuplicateKeyError(error: unknown): error is DuplicateKeyError {
  if (!error || typeof error !== 'object') {
    return false;
  }
  return (error as { code?: unknown }).code === 11000;
}

function parseLimit(raw: unknown): number {
  const parsed = parseInt(String(raw ?? '20'), 10);
  if (Number.isNaN(parsed)) {
    return 20;
  }
  return Math.min(Math.max(1, parsed), 100);
}

function blockFilteredSkillContent(
  req: ServerRequest,
  res: Response,
  input: TCreateSkill | TUpdateSkillPayload,
): boolean {
  if (req.config?.filters == null) {
    return false;
  }
  const inlineFrontmatter =
    typeof input.body === 'string' ? parseSkillMarkdown(input.body).frontmatter : undefined;
  const { finding, traversalError } = inspectContentWithTraversal(
    () =>
      extractSkillContent({
        name: input.name,
        displayTitle: input.displayTitle,
        description: input.description,
        body: input.body,
        frontmatter: {
          ...inlineFrontmatter,
          ...(input.frontmatter as Record<string, unknown> | undefined),
        },
        category: input.category,
      }),
    { filters: req.config?.filters },
  );
  if (finding != null) {
    res.status(400).json(contentFilterBlockResponse(finding));
    return true;
  }
  if (traversalError != null) {
    res.status(traversalError.statusCode).json(traversalError.body);
    return true;
  }
  return false;
}

type SkillResponseOptions = { includePublicStatus?: boolean };

type SkillListOptions = Pick<ListSkillsByAccessParams, 'manageTenantId' | 'limit' | 'cursor'>;

/**
 * Factory for the typed Express handlers served at `/api/skills`.
 * The legacy `api/server/routes/skills.js` imports this, passes in concrete
 * deps from `~/models` + `PermissionService`, and wires the returned handlers
 * onto the Express router.
 */
export function createSkillsHandlers(deps: SkillsHandlersDeps): {
  list: (req: ServerRequest, res: Response, options?: SkillListOptions) => Promise<Response>;
  create: (req: ServerRequest, res: Response) => Promise<Response>;
  get: (req: ServerRequest, res: Response, options?: SkillResponseOptions) => Promise<Response>;
  patch: (req: ServerRequest, res: Response, options?: SkillResponseOptions) => Promise<Response>;
  delete: (req: ServerRequest, res: Response) => Promise<Response>;
  listFiles: (req: ServerRequest, res: Response) => Promise<Response>;
  downloadFile: (req: ServerRequest, res: Response) => Promise<Response | undefined>;
  deleteFile: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  const {
    createSkill,
    getSkillById,
    listSkillsByAccess,
    updateSkill,
    deleteSkill,
    listSkillFiles,
    deleteSkillFile,
    getSkillFileByPath,
    updateSkillFileContent,
    getStrategyFunctions,
    findAccessibleResources,
    findPubliclyAccessibleResources,
    hasPublicPermission,
    grantPermission,
    isValidObjectIdString,
  } = deps;

  /** O(1) public check for a single skill (avoids fetching all public IDs). */
  async function isSkillPublic(skillId: string | Types.ObjectId): Promise<boolean> {
    try {
      return await hasPublicPermission({
        resourceType: ResourceType.SKILL,
        resourceId: skillId,
        requiredPermissions: PermissionBits.VIEW,
      });
    } catch {
      return false;
    }
  }

  async function listHandler(req: ServerRequest, res: Response, options?: SkillListOptions) {
    try {
      const user = req.user;
      if (!user || !user.id) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const { category, search, limit, cursor } = req.query as {
        category?: string;
        search?: string;
        limit?: string;
        cursor?: string;
      };
      const parsedLimit = parseLimit(limit);

      const [accessibleIds, publicIds] = options?.manageTenantId
        ? [getDeploymentSkillIds(), []]
        : await Promise.all([
            findAccessibleResources({
              userId: user.id,
              role: user.role,
              resourceType: ResourceType.SKILL,
              requiredPermissions: PermissionBits.VIEW,
            }),
            findPubliclyAccessibleResources({
              resourceType: ResourceType.SKILL,
              requiredPermissions: PermissionBits.VIEW,
            }),
          ]);

      const mergedIds = Array.from(
        new Map([...accessibleIds, ...publicIds].map((id) => [id.toString(), id])).values(),
      );

      const result = await listSkillsByAccess({
        accessibleIds: mergedIds,
        category: typeof category === 'string' && category.length > 0 ? category : undefined,
        search: typeof search === 'string' && search.length > 0 ? search : undefined,
        manageTenantId: options?.manageTenantId,
        limit: options?.limit ?? parsedLimit,
        cursor:
          options?.cursor ?? (typeof cursor === 'string' && cursor.length > 0 ? cursor : null),
      });

      const publicSet = new Set(publicIds.map((id) => id.toString()));
      const skills = result.skills.map((s) => serializeSkillSummary(s, publicSet));

      return res.status(200).json({
        skills,
        has_more: result.has_more,
        after: result.after,
      });
    } catch (error) {
      logger.error('[GET /skills] Error listing skills', error);
      return res.status(500).json({ error: 'Error listing skills' });
    }
  }

  async function createHandler(req: ServerRequest, res: Response) {
    try {
      const user = req.user;
      if (!user || !user.id) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const body = (req.body ?? {}) as TCreateSkill;

      if (!body.name || typeof body.name !== 'string') {
        return res.status(400).json({ error: 'Skill name is required' });
      }
      if (!body.description || typeof body.description !== 'string') {
        return res.status(400).json({ error: 'Skill description is required' });
      }
      if (blockFilteredSkillContent(req, res, body)) {
        return res;
      }

      const authorId = (user._id ?? user.id) as unknown as Types.ObjectId;
      const authorName = user.name ?? user.username ?? 'Unknown';

      let createResult: CreateSkillResult;
      try {
        createResult = await createSkill({
          name: body.name,
          displayTitle: body.displayTitle,
          description: body.description,
          body: body.body,
          frontmatter: body.frontmatter as Record<string, unknown> | undefined,
          category: body.category,
          alwaysApply: body.alwaysApply,
          author: authorId,
          authorName,
          tenantId: user.tenantId,
        });
      } catch (error) {
        if (isValidationError(error)) {
          return res.status(400).json({ error: 'Validation failed', issues: error.issues });
        }
        if (isDuplicateKeyError(error)) {
          return res.status(409).json({ error: 'A skill with this name already exists' });
        }
        throw error;
      }

      const { skill, warnings } = createResult;

      try {
        await grantPermission({
          principalType: PrincipalType.USER,
          principalId: user.id,
          resourceType: ResourceType.SKILL,
          resourceId: skill._id,
          accessRoleId: AccessRoleIds.SKILL_OWNER,
          grantedBy: user.id,
        });
      } catch (permissionError) {
        logger.error(
          `[POST /skills] Failed to grant owner permission for skill ${skill._id.toString()}, rolling back:`,
          permissionError,
        );
        try {
          const deletion = await deleteSkillWithRetry(deleteSkill, skill._id.toString());
          if (!deletion.cleanupComplete) {
            logger.error(
              `[POST /skills] Compensating delete incomplete for orphaned skill ${skill._id.toString()}: ${deletion.failedCleanupSteps.join(', ')}`,
            );
          }
        } catch (rollbackError) {
          logger.error(
            `[POST /skills] Compensating delete failed for orphaned skill ${skill._id.toString()}:`,
            rollbackError,
          );
        }
        return res.status(500).json({ error: 'Failed to initialize skill permissions' });
      }

      // A freshly created skill has no PUBLIC ACL entry, so `isPublic` is
      // always false. Skip the DB round-trip.
      return res
        .status(201)
        .json(attachWarnings(serializeSkill(skill, new Set<string>()), warnings));
    } catch (error) {
      logger.error('[POST /skills] Error creating skill', error);
      return res.status(500).json({ error: 'Error creating skill' });
    }
  }

  async function getHandler(req: ServerRequest, res: Response, options?: SkillResponseOptions) {
    try {
      const { id } = req.params as { id: string };
      // The canAccessSkillResource middleware already resolved the skill via
      // getSkillById as its idResolver and stashed it on req.resourceAccess.resourceInfo.
      // Reuse it to avoid a second DB round-trip.
      const resolved = (
        req as ServerRequest & {
          resourceAccess?: { resourceInfo?: ISkill & { _id: Types.ObjectId } };
        }
      ).resourceAccess?.resourceInfo;
      const skill = resolved ?? (await getSkillById(id));
      if (!skill) {
        return res.status(404).json({ error: 'Skill not found' });
      }
      const pub = options?.includePublicStatus === false ? false : await isSkillPublic(skill._id);
      return res.status(200).json(serializeSkill(skill, pub));
    } catch (error) {
      logger.error('[GET /skills/:id] Error fetching skill', error);
      return res.status(500).json({ error: 'Error fetching skill' });
    }
  }

  async function patchHandler(req: ServerRequest, res: Response, options?: SkillResponseOptions) {
    try {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as TUpdateSkillPayload & { expectedVersion?: number };
      const { expectedVersion, ...rest } = body;
      // `typeof NaN === 'number'` is true, so we need the stricter isFinite/isInteger
      // checks below to avoid NaN passing through and triggering a misleading 409
      // (MongoDB's `{ version: NaN }` never matches, so the handler would fall
      // through to the conflict branch and leak the current skill state).
      if (
        typeof expectedVersion !== 'number' ||
        !Number.isFinite(expectedVersion) ||
        !Number.isInteger(expectedVersion) ||
        expectedVersion < 1
      ) {
        return res
          .status(400)
          .json({ error: 'expectedVersion is required and must be a positive integer' });
      }

      const update: UpdateSkillInput = {};
      if (rest.name !== undefined) update.name = rest.name;
      if (rest.displayTitle !== undefined) update.displayTitle = rest.displayTitle;
      if (rest.description !== undefined) update.description = rest.description;
      if (rest.body !== undefined) update.body = rest.body;
      if (rest.frontmatter !== undefined) {
        update.frontmatter = rest.frontmatter as Record<string, unknown>;
      }
      if (rest.category !== undefined) update.category = rest.category;
      if (rest.alwaysApply !== undefined) update.alwaysApply = rest.alwaysApply;

      if (Object.keys(update).length === 0) {
        return res.status(400).json({ error: 'At least one field must be provided for update' });
      }
      if (blockFilteredSkillContent(req, res, rest)) {
        return res;
      }

      let result: UpdateSkillResult;
      try {
        result = await updateSkill({ id, expectedVersion, update });
      } catch (error) {
        if (isValidationError(error)) {
          return res.status(400).json({ error: 'Validation failed', issues: error.issues });
        }
        if (isDuplicateKeyError(error)) {
          return res.status(409).json({ error: 'A skill with this name already exists' });
        }
        throw error;
      }

      if (result.status === 'not_found') {
        return res.status(404).json({ error: 'Skill not found' });
      }
      const pub = options?.includePublicStatus === false ? false : await isSkillPublic(id);
      if (result.status === 'conflict') {
        const conflict: TSkillConflictResponse = {
          error: 'skill_version_conflict',
          current: serializeSkill(result.current, pub),
        };
        return res.status(409).json(conflict);
      }
      return res
        .status(200)
        .json(attachWarnings(serializeSkill(result.skill, pub), result.warnings));
    } catch (error) {
      logger.error('[PATCH /skills/:id] Error updating skill', error);
      return res.status(500).json({ error: 'Error updating skill' });
    }
  }

  async function deleteHandler(req: ServerRequest, res: Response) {
    try {
      const { id } = req.params as { id: string };
      if (!isValidObjectIdString(id)) {
        return res.status(400).json({ error: 'Invalid skill id' });
      }

      // Collect file records before deletion so we can clean up storage blobs
      const files = await listSkillFiles(id);

      let result = await deleteSkill(id);
      if (result.skillAbsent && !result.cleanupComplete) {
        try {
          result = mergeDeleteSkillResults(result, await deleteSkill(id));
        } catch (error) {
          logger.error(`[deleteSkill] Cleanup retry failed for ${id}:`, error);
        }
      }
      /** Once SkillFile cleanup succeeds, the records loaded above are the
       * only remaining references to their blobs. Use them even if an
       * independent allowlist or permission cleanup step needs a retry. */
      let blobCleanupComplete = true;
      if (!result.failedCleanupSteps.includes('skill_files')) {
        const blobDeletions = files.map(async (file) => {
          const { deleteFile: deleteBlob } = getStrategyFunctions(file.source);
          if (!deleteBlob) {
            throw new Error(`No delete strategy for ${file.source}`);
          }
          await deleteBlob(req, {
            filepath: file.filepath,
            storageKey: file.storageKey,
            storageRegion: file.storageRegion,
            user: file.author?.toString?.(),
            tenantId: file.tenantId?.toString?.(),
          });
        });
        const blobResults = await Promise.allSettled(blobDeletions);
        for (const [index, blobResult] of blobResults.entries()) {
          if (blobResult.status === 'rejected') {
            blobCleanupComplete = false;
            logger.error(
              `[deleteSkill] Blob cleanup failed for ${files[index].relativePath}:`,
              blobResult.reason,
            );
          }
        }
      }

      const cleanupComplete = result.cleanupComplete && blobCleanupComplete;
      if (!cleanupComplete) {
        if (result.skillAbsent) {
          /** The client must evict the now-missing skill even though dependent
           * cleanup still needs repair. A 2xx response reaches the mutation's
           * cache reconciliation path; the flag preserves the warning. */
          const response: TDeleteSkillResponse = { id, deleted: true, cleanupComplete: false };
          return res.status(200).json(response);
        }
        return res.status(500).json({ error: 'Skill deletion cleanup did not finish' });
      }
      if (!result.deleted && files.length === 0) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      const response: TDeleteSkillResponse = { id, deleted: true, cleanupComplete };
      return res.status(200).json(response);
    } catch (error) {
      logger.error('[DELETE /skills/:id] Error deleting skill', error);
      return res.status(500).json({ error: 'Error deleting skill' });
    }
  }

  async function listFilesHandler(req: ServerRequest, res: Response) {
    try {
      const { id } = req.params as { id: string };
      const rows = await listSkillFiles(id);
      const response: TListSkillFilesResponse = { files: rows.map(serializeSkillFile) };
      return res.status(200).json(response);
    } catch (error) {
      logger.error('[GET /skills/:id/files] Error listing skill files', error);
      return res.status(500).json({ error: 'Error listing skill files' });
    }
  }

  const SAFE_INLINE_MIMES = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/avif',
    'image/bmp',
  ]);
  const MAX_TEXT_CACHE_BYTES = 512 * 1024;
  const MAX_JSON_CONTENT_BYTES = 1024 * 1024;

  async function downloadFileHandler(req: ServerRequest, res: Response) {
    try {
      const { id } = req.params as { id: string };
      const decodedPath = resolveSkillFilePathParam(
        (req.params as { relativePath?: string | string[] }).relativePath,
      );
      if (decodedPath == null) {
        return res.status(404).json({ error: 'Skill file not found' });
      }

      // SKILL.md is the skill body itself, not a SkillFile document
      if (decodedPath === 'SKILL.md') {
        const resolved = (
          req as ServerRequest & {
            resourceAccess?: { resourceInfo?: ISkill & { _id: Types.ObjectId } };
          }
        ).resourceAccess?.resourceInfo;
        const skill = resolved ?? (await getSkillById(id));
        if (!skill) {
          return res.status(404).json({ error: 'Skill not found' });
        }
        const response: TSkillFileContentResponse = {
          content: skill.body,
          mimeType: 'text/markdown',
          isBinary: false,
          relativePath: 'SKILL.md',
          filename: 'SKILL.md',
          bytes: Buffer.byteLength(skill.body, 'utf-8'),
        };
        return res.status(200).json(response);
      }

      const file = await getSkillFileByPath(id, decodedPath);
      if (!file) {
        return res.status(404).json({ error: 'Skill file not found' });
      }

      const strategy = getStrategyFunctions(file.source);
      if (!strategy.getDownloadStream) {
        return res.status(501).json({ error: 'Download not supported for this storage backend' });
      }

      // Raw mode: stream the file with its Content-Type (for images / downloads).
      // Non-image files use Content-Disposition: attachment to prevent stored XSS
      // (an uploaded .html served inline from this origin would execute scripts
      // with access to the user's session). Images stay inline for <img> rendering.
      if (req.query.raw === 'true') {
        const isImageMime = SAFE_INLINE_MIMES.has(file.mimeType);
        const safeName = file.filename.replace(/["\\\n\r]/g, '_');
        res.setHeader('Content-Type', file.mimeType);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader(
          'Content-Disposition',
          `${isImageMime ? 'inline' : 'attachment'}; filename="${safeName}"`,
        );
        const stream = await strategy.getDownloadStream(req, resolveDownloadPath(file));
        stream.on('error', (err: Error) => {
          logger.error('[downloadFile] Stream error:', err);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Error streaming file' });
          } else {
            res.destroy();
          }
        });
        stream.pipe(res);
        return;
      }

      const base: Omit<TSkillFileContentResponse, 'content' | 'isBinary'> = {
        fileId: file.file_id,
        mimeType: file.mimeType,
        relativePath: file.relativePath,
        filename: file.filename,
        bytes: file.bytes,
      };

      // Already flagged binary — skip storage entirely
      if (file.isBinary === true) {
        return res.status(200).json({ ...base, isBinary: true });
      }

      // Text content already cached in DB
      if (file.content != null) {
        return res.status(200).json({ ...base, isBinary: false, content: file.content });
      }

      // Single-loop stream read: check binary after 8 KB, then either
      // destroy (binary) or continue reading (text) in the same iteration.
      // N.B. breaking out of `for await...of` destroys the stream via
      // iterator.return(), so we must NOT use break + a second loop.
      const stream = await strategy.getDownloadStream(req, resolveDownloadPath(file));
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let binaryChecked = false;

      for await (const raw of stream) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        chunks.push(chunk);
        totalBytes += chunk.length;

        if (!binaryChecked && totalBytes >= 8192) {
          binaryChecked = true;
          if (isBinaryBuffer(Buffer.concat(chunks))) {
            updateSkillFileContent(id, decodedPath, { isBinary: true }, file.file_id).catch((e) =>
              logger.error('[downloadFile] Cache write failed:', e),
            );
            if ('destroy' in stream && typeof stream.destroy === 'function') {
              stream.destroy();
            }
            return res.status(200).json({ ...base, isBinary: true });
          }
        }

        // Cap JSON response size — files beyond this must use ?raw=true.
        // No cache write here: { isBinary: false } without content provides
        // no fast-path on subsequent reads, so we skip the DB round-trip.
        if (totalBytes > MAX_JSON_CONTENT_BYTES) {
          if ('destroy' in stream && typeof stream.destroy === 'function') {
            stream.destroy();
          }
          return res.status(200).json({ ...base, isBinary: false });
        }
      }

      const buffer = Buffer.concat(chunks);
      if (isBinaryBuffer(buffer)) {
        updateSkillFileContent(id, decodedPath, { isBinary: true }, file.file_id).catch((e) =>
          logger.error('[downloadFile] Cache write failed:', e),
        );
        return res.status(200).json({ ...base, isBinary: true });
      }

      const text = buffer.toString('utf-8');
      if (buffer.length <= MAX_TEXT_CACHE_BYTES) {
        updateSkillFileContent(
          id,
          decodedPath,
          { content: text, isBinary: false },
          file.file_id,
        ).catch((e) => logger.error('[downloadFile] Cache write failed:', e));
      }
      return res.status(200).json({ ...base, isBinary: false, content: text });
    } catch (error) {
      logger.error('[GET /skills/:id/files/*relativePath] Error', error);
      return res.status(500).json({ error: 'Error downloading skill file' });
    }
  }

  async function deleteFileHandler(req: ServerRequest, res: Response) {
    try {
      const { id } = req.params as { id: string };
      const decodedPath = resolveSkillFilePathParam(
        (req.params as { relativePath?: string | string[] }).relativePath,
      );
      if (decodedPath == null) {
        return res.status(404).json({ error: 'Skill file not found' });
      }

      // Look up the file record so we can clean up the storage blob
      const file = await getSkillFileByPath(id, decodedPath);
      if (!file) {
        return res.status(404).json({ error: 'Skill file not found' });
      }

      const result = await deleteSkillFile(id, decodedPath);
      if (!result.deleted) {
        return res.status(404).json({ error: 'Skill file not found' });
      }

      // Clean up the stored blob — fire-and-forget so the response isn't delayed
      const { deleteFile: deleteBlob } = getStrategyFunctions(file.source);
      if (deleteBlob) {
        deleteBlob(req, {
          filepath: file.filepath,
          storageKey: file.storageKey,
          storageRegion: file.storageRegion,
          user: file.author?.toString?.(),
          tenantId: file.tenantId?.toString?.(),
        }).catch((e) => logger.error('[deleteFile] Storage cleanup failed:', e));
      }

      const response: TDeleteSkillFileResponse = {
        skillId: id,
        relativePath: decodedPath,
        deleted: true,
      };
      return res.status(200).json(response);
    } catch (error) {
      logger.error('[DELETE /skills/:id/files/*relativePath] Error', error);
      return res.status(500).json({ error: 'Error deleting skill file' });
    }
  }

  return {
    list: listHandler,
    create: createHandler,
    get: getHandler,
    patch: patchHandler,
    delete: deleteHandler,
    listFiles: listFilesHandler,
    downloadFile: downloadFileHandler,
    deleteFile: deleteFileHandler,
  };
}

export type SkillsHandlers = ReturnType<typeof createSkillsHandlers>;
