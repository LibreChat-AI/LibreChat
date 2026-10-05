import {
  ArtifactAppDeletedError,
  ArtifactAppRestoreNotFoundError,
  ArtifactSyncConflictError,
  logger,
} from '@librechat/data-schemas';
import {
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  PermissionBits,
  publishArtifactAppSchema,
  syncArtifactAppSchema,
  artifactAppListRequestSchema,
  artifactVersionListRequestSchema,
  artifactAppsConfigSchema,
  updateArtifactAppSchema,
} from 'librechat-data-provider';
import type {
  ArtifactAppRecord,
  ArtifactVersionRecord,
  ArtifactVersionSummaryRecord,
  ArtifactAppQuery,
  ArtifactVersionQuery,
  ArtifactAppWithVersion,
  ArtifactAppSourceQuery,
  SyncArtifactAppResult,
  CreateArtifactAppInput,
  CreateArtifactVersionInput,
  RecordAuditEntryInput,
  ArtifactAppListOptions,
  ArtifactAppListPage,
  ArtifactAppListEntry,
  ArtifactVersionListOptions,
  ArtifactVersionListPage,
  ArtifactAppUpdate,
  ArtifactAppSyncOptions,
} from '@librechat/data-schemas';
import type {
  TArtifactApp,
  TArtifactVersion,
  TArtifactVersionSummary,
  ArtifactRuntimeType,
  ArtifactRuntimeConfig,
  ArtifactPreview,
  ArtifactAppsConfig,
} from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';

/**
 * All dependencies required to serve Artifact App HTTP requests. Every dep is
 * resolved from the legacy api layer (`~/models`, `PermissionService`) so the
 * handlers stay pure — no direct mongoose access, no direct filesystem I/O.
 */
export interface ArtifactAppHandlersDeps {
  createArtifactAppWithVersion: (input: CreateArtifactAppInput) => Promise<ArtifactAppWithVersion>;
  syncArtifactAppWithVersion: (
    input: CreateArtifactAppInput,
    options?: Partial<ArtifactAppSyncOptions> & {
      assertSourceAvailable?: () => Promise<void>;
      basedOnVersionNumber?: number;
      legacySourceKey?: string;
    },
  ) => Promise<SyncArtifactAppResult>;
  restoreArtifactAppWithVersion: (
    input: CreateArtifactAppInput,
    options?: Partial<ArtifactAppSyncOptions> & {
      assertSourceAvailable?: () => Promise<void>;
    },
  ) => Promise<SyncArtifactAppResult>;
  getArtifactAppByAppId: (query: ArtifactAppQuery) => Promise<ArtifactAppRecord | null>;
  getArtifactAppBySource: (query: ArtifactAppSourceQuery) => Promise<ArtifactAppRecord | null>;
  getDeletedArtifactAppBySource: (
    query: ArtifactAppSourceQuery,
  ) => Promise<ArtifactAppRecord | null>;
  listArtifactApps: (options: ArtifactAppListOptions) => Promise<ArtifactAppListPage>;
  getArtifactAppsByIds: (ids: string[]) => Promise<ArtifactAppRecord[]>;
  updateArtifactApp: (
    query: ArtifactAppQuery,
    update: ArtifactAppUpdate,
  ) => Promise<ArtifactAppRecord | null>;
  deleteArtifactApp: (
    query: ArtifactAppQuery,
  ) => Promise<{ deletedApp: boolean; deletedVersions: number }>;
  prepareArtifactAppDeletion: (
    query: ArtifactAppQuery,
    requestedBy: string,
  ) => Promise<{ found: boolean; resourceId?: string; deletedVersions: number }>;
  finalizeArtifactAppDeletion: (query: ArtifactAppQuery, requestedBy: string) => Promise<boolean>;
  getArtifactVersion: (query: ArtifactVersionQuery) => Promise<ArtifactVersionRecord | null>;
  listArtifactVersions: (options: ArtifactVersionListOptions) => Promise<ArtifactVersionListPage>;
  releaseArtifactVersion: (
    query: ArtifactVersionQuery,
    releasedBy: string,
  ) => Promise<ArtifactVersionRecord | null>;
  activateArtifactVersion: (query: ArtifactVersionQuery) => Promise<ArtifactAppWithVersion | null>;
  withdrawArtifactVersion: (query: ArtifactVersionQuery) => Promise<ArtifactVersionRecord | null>;

  getResourcePermissionsMap: (params: {
    userId: string;
    role?: string | null;
    resourceType: string;
    resourceIds: string[];
  }) => Promise<Map<string, number>>;
  grantPermission: (params: {
    principalType: string;
    principalId: string;
    resourceType: string;
    resourceId: string;
    accessRoleId: string;
    grantedBy: string;
  }) => Promise<void>;
  removeAllPermissions: (params: { resourceType: string; resourceId: string }) => Promise<unknown>;
  hasResourceManagementCapability?: (user: NonNullable<ServerRequest['user']>) => Promise<boolean>;
  recordAuditEntry: (input: RecordAuditEntryInput) => Promise<void>;
  sourceConversationExists?: (params: {
    userId: string;
    conversationId: string;
  }) => Promise<boolean>;
  getConfig?: (req: ServerRequest) => Partial<ArtifactAppsConfig> | undefined;
}

function toIso(value: Date | undefined): string {
  return (value ?? new Date()).toISOString();
}

function toIsoOptional(value: Date | undefined): string | undefined {
  return value ? value.toISOString() : undefined;
}

function serializeApp(
  app: ArtifactAppRecord,
  viewerId: string,
  permissionBits?: number,
): TArtifactApp {
  return {
    id: app.id,
    artifactAppId: app.artifactAppId,
    tenantId: app.tenantId,
    title: app.title,
    description: app.description,
    icon: app.icon,
    category: app.category,
    tags: app.tags,
    createdBy: app.createdBy,
    activeVersionId: app.activeVersionId,
    latestVersionNumber: app.latestVersionNumber,
    status: app.status,
    visibility: app.visibility,
    allowEmbed: app.allowEmbed,
    allowFork: app.allowFork,
    allowAnonymousView: app.allowAnonymousView,
    toolPolicy: {
      enabled: app.toolPolicy.enabled,
      allowedServers: app.toolPolicy.allowedServers,
      allowedTools: app.toolPolicy.allowedTools,
      requireConfirmationForWrites: app.toolPolicy.requireConfirmationForWrites,
    },
    marketplace: {
      listed: app.marketplace.listed,
      featured: app.marketplace.featured,
      summary: app.marketplace.summary,
      riskClass: app.marketplace.riskClass,
      costClass: app.marketplace.costClass,
    },
    preview: app.preview,
    sourceMetadata:
      app.createdBy === viewerId && app.sourceMetadata
        ? {
            conversationId: app.sourceMetadata.conversationId,
            messageId: app.sourceMetadata.messageId,
            originalArtifactId: app.sourceMetadata.originalArtifactId,
            sourceKey: app.sourceMetadata.sourceKey,
          }
        : undefined,
    review: app.review
      ? {
          submittedAt: toIsoOptional(app.review.submittedAt),
          submittedBy: app.review.submittedBy,
          reviewedAt: toIsoOptional(app.review.reviewedAt),
          reviewedBy: app.review.reviewedBy,
          result: app.review.result,
          comment: app.review.comment,
        }
      : undefined,
    createdAt: toIso(app.createdAt),
    updatedAt: toIso(app.updatedAt),
    archivedAt: toIsoOptional(app.archivedAt),
    ...(permissionBits !== undefined ? { permissionBits } : {}),
  };
}

function serializeVersion(version: ArtifactVersionRecord): TArtifactVersion {
  const runtimeConfig = version.runtimeConfig ?? {};
  return {
    artifactVersionId: version.artifactVersionId,
    artifactAppId: version.artifactAppId,
    tenantId: version.tenantId,
    versionNumber: version.versionNumber,
    versionLabel: version.versionLabel,
    changelog: version.changelog,
    artifactType: version.artifactType,
    sourceSnapshot: version.sourceSnapshot,
    runtimeConfig: {
      dependencies: runtimeConfig.dependencies,
      entryPoint: runtimeConfig.entryPoint,
      renderMode: runtimeConfig.renderMode,
    },
    preview: version.preview,
    integrity: {
      sourceHash: version.integrity.sourceHash,
      schemaVersion: version.integrity.schemaVersion,
    },
    createdBy: version.createdBy,
    createdAt: toIso(version.createdAt),
    publication: {
      state: version.publication.state,
      releasedBy: version.publication.releasedBy,
      releasedAt: toIsoOptional(version.publication.releasedAt),
    },
  };
}

function serializeVersionSummary(version: ArtifactVersionSummaryRecord): TArtifactVersionSummary {
  return {
    artifactVersionId: version.artifactVersionId,
    artifactAppId: version.artifactAppId,
    tenantId: version.tenantId,
    versionNumber: version.versionNumber,
    versionLabel: version.versionLabel,
    changelog: version.changelog,
    artifactType: version.artifactType,
    preview: version.preview,
    createdBy: version.createdBy,
    createdAt: toIso(version.createdAt),
    publication: {
      state: version.publication.state,
      releasedBy: version.publication.releasedBy,
      releasedAt: toIsoOptional(version.publication.releasedAt),
    },
  };
}

function requireUser(req: ServerRequest, res: Response): ServerRequest['user'] | null {
  const user = req.user;
  if (!user || !user.id) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return user;
}

/**
 * Builds the `sourceConversationExists` check `sync`/`restore` use to gate automatic
 * registration. Artifact apps/versions have no expiration, so a temporary chat's source must
 * not auto-register — it would outlive the conversation it was minted from.
 */
export function createSourceConversationExistsCheck(
  getConvo: (userId: string, conversationId: string) => Promise<{ isTemporary?: boolean } | null>,
): (params: { userId: string; conversationId: string }) => Promise<boolean> {
  return async ({ userId, conversationId }) => {
    const conversation = await getConvo(userId, conversationId);
    if (conversation == null) {
      return false;
    }
    return !conversation.isTemporary;
  };
}

/**
 * Factory for the typed Express handlers served at `/api/artifact-apps`.
 * The legacy route file passes in concrete deps from `~/models` and
 * `PermissionService`; §8.7 mandates the server derives actor identity and
 * tenant strictly from the authenticated session, never from the request body.
 */
export function createArtifactAppHandlers(deps: ArtifactAppHandlersDeps): {
  publish: (req: ServerRequest, res: Response) => Promise<Response>;
  sync: (req: ServerRequest, res: Response) => Promise<Response>;
  restore: (req: ServerRequest, res: Response) => Promise<Response>;
  list: (req: ServerRequest, res: Response) => Promise<Response>;
  getBySource: (req: ServerRequest, res: Response) => Promise<Response>;
  get: (req: ServerRequest, res: Response) => Promise<Response>;
  update: (req: ServerRequest, res: Response) => Promise<Response>;
  remove: (req: ServerRequest, res: Response) => Promise<Response>;
  listVersions: (req: ServerRequest, res: Response) => Promise<Response>;
  getVersion: (req: ServerRequest, res: Response) => Promise<Response>;
  releaseVersion: (req: ServerRequest, res: Response) => Promise<Response>;
  activateVersion: (req: ServerRequest, res: Response) => Promise<Response>;
  withdrawVersion: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  const {
    createArtifactAppWithVersion,
    syncArtifactAppWithVersion,
    restoreArtifactAppWithVersion,
    getArtifactAppByAppId,
    getArtifactAppBySource,
    getDeletedArtifactAppBySource,
    listArtifactApps,
    getArtifactAppsByIds,
    updateArtifactApp,
    deleteArtifactApp,
    prepareArtifactAppDeletion,
    finalizeArtifactAppDeletion,
    getArtifactVersion,
    listArtifactVersions,
    releaseArtifactVersion,
    activateArtifactVersion,
    withdrawArtifactVersion,
    getResourcePermissionsMap,
    grantPermission,
    removeAllPermissions,
    hasResourceManagementCapability,
    recordAuditEntry,
    sourceConversationExists,
    getConfig,
  } = deps;

  function audit(input: RecordAuditEntryInput): void {
    recordAuditEntry(input).catch((err) =>
      logger.error(`[artifactApps] audit write failed for ${input.action}`, err),
    );
  }

  /**
   * A viewer with only VIEW access must not be able to fetch a withdrawn version by id even
   * though it once existed — that endpoint is what `activateArtifactVersion`'s pointer clear
   * cannot reach on its own. EDIT is the bit that already gates release/activate/withdraw, so
   * anyone who could have withdrawn this version can also still inspect it.
   */
  async function canManageArtifactVersion(
    user: NonNullable<ServerRequest['user']>,
    artifactAppId: string,
  ): Promise<boolean> {
    try {
      if ((await hasResourceManagementCapability?.(user)) === true) {
        return true;
      }
    } catch (error) {
      logger.warn(`[artifactApps] capability check failed for ${user.id as string}`, error);
    }
    const app = await getArtifactAppByAppId({ artifactAppId });
    if (!app) {
      return false;
    }
    if (app.createdBy === user.id) {
      return true;
    }
    const permissions = await getResourcePermissionsMap({
      userId: user.id as string,
      role: user.role,
      resourceType: ResourceType.ARTIFACT_APP,
      resourceIds: [app.id],
    });
    const permissionBits = permissions.get(app.id) ?? 0;
    return (permissionBits & PermissionBits.EDIT) === PermissionBits.EDIT;
  }

  async function serializeDetail(app: ArtifactAppRecord, viewerId: string) {
    const version = app.activeVersionId
      ? await getArtifactVersion({
          artifactAppId: app.artifactAppId,
          artifactVersionId: app.activeVersionId,
        })
      : null;
    return {
      app: serializeApp(app, viewerId),
      version: version ? serializeVersion(version) : null,
    };
  }

  function toVersionInput(
    artifact: {
      type: ArtifactRuntimeType;
      content: string;
      title?: string;
      language?: string;
      runtimeConfig?: ArtifactRuntimeConfig;
      preview?: ArtifactPreview;
    },
    label: string | undefined,
    changelog: string | undefined,
    createdBy: string,
  ): CreateArtifactVersionInput {
    return {
      artifactType: artifact.type,
      sourceSnapshot: artifact.content,
      runtimeConfig: artifact.runtimeConfig,
      preview: artifact.preview,
      versionLabel: label,
      changelog,
      createdBy,
    };
  }

  async function publish(req: ServerRequest, res: Response) {
    try {
      const user = requireUser(req, res);
      if (!user) {
        return res as Response;
      }

      const parsed = publishArtifactAppSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
      }
      const data = parsed.data;

      const userId = user.id as string;
      const input: CreateArtifactAppInput = {
        tenantId: user.tenantId,
        createdBy: userId,
        title: data.title,
        description: data.description,
        icon: data.icon,
        category: data.category,
        tags: data.tags,
        visibility: data.visibility,
        allowEmbed: data.allowEmbed,
        allowFork: data.allowFork,
        allowAnonymousView: data.allowAnonymousView,
        toolPolicy: data.toolPolicy,
        marketplace: data.marketplace,
        sourceMetadata: data.source,
        version: toVersionInput(data.artifact, data.versionLabel, data.changelog, userId),
      };

      const { app, version } = await createArtifactAppWithVersion(input);

      try {
        await grantPermission({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: ResourceType.ARTIFACT_APP,
          resourceId: app.id,
          accessRoleId: AccessRoleIds.ARTIFACT_APP_OWNER,
          grantedBy: userId,
        });
      } catch (permissionError) {
        logger.error(
          `[POST /artifact-apps] Failed to grant owner permission for ${app.artifactAppId}, rolling back:`,
          permissionError,
        );
        try {
          await deleteArtifactApp({ artifactAppId: app.artifactAppId });
        } catch (rollbackError) {
          logger.error(
            `[POST /artifact-apps] Compensating delete failed for ${app.artifactAppId}:`,
            rollbackError,
          );
        }
        return res.status(500).json({ error: 'Failed to initialize artifact app permissions' });
      }

      audit({
        tenantId: user.tenantId,
        action: 'artifact_app.created',
        actor: { type: 'user', id: userId, name: user.name ?? user.username ?? userId },
        target: { type: ResourceType.ARTIFACT_APP, id: app.artifactAppId, name: app.title },
        metadata: { versionNumber: version.versionNumber },
      });

      return res
        .status(201)
        .json({ app: serializeApp(app, userId), version: serializeVersion(version) });
    } catch (error) {
      logger.error('[POST /artifact-apps] Error publishing artifact app', error);
      return res.status(500).json({ error: 'Error publishing artifact app' });
    }
  }

  async function sync(req: ServerRequest, res: Response) {
    try {
      const user = requireUser(req, res);
      if (!user) {
        return res as Response;
      }
      const parsed = syncArtifactAppSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
      }

      const userId = user.id as string;
      const data = parsed.data;
      const assertSourceAvailable = async () => {
        if (
          sourceConversationExists &&
          !(await sourceConversationExists({
            userId,
            conversationId: data.source.conversationId,
          }))
        ) {
          throw new ArtifactAppDeletedError();
        }
      };
      await assertSourceAvailable();
      const config = artifactAppsConfigSchema.parse(getConfig?.(req));
      const { legacySourceKey, ...sourceMetadata } = data.source;
      const result = await syncArtifactAppWithVersion(
        {
          tenantId: user.tenantId,
          createdBy: userId,
          title: data.title,
          visibility: 'private',
          marketplace: { listed: true },
          sourceMetadata,
          version: toVersionInput(data.artifact, undefined, undefined, userId),
        },
        {
          ...config,
          assertSourceAvailable,
          basedOnVersionNumber: data.basedOnVersionNumber,
          legacySourceKey,
        },
      );

      try {
        await grantPermission({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: ResourceType.ARTIFACT_APP,
          resourceId: result.app.id,
          accessRoleId: AccessRoleIds.ARTIFACT_APP_OWNER,
          grantedBy: userId,
        });
      } catch (permissionError) {
        logger.error(
          `[POST /artifact-apps/sync] Failed to ensure owner permission for ${result.app.artifactAppId}:`,
          permissionError,
        );
        return res.status(500).json({ error: 'Failed to initialize artifact permissions' });
      }

      if (result.created || result.versionCreated) {
        audit({
          tenantId: user.tenantId,
          action: result.created ? 'artifact_app.created' : 'artifact_version.created',
          actor: { type: 'user', id: userId, name: user.name ?? user.username ?? userId },
          target: {
            type: ResourceType.ARTIFACT_APP,
            id: result.app.artifactAppId,
            name: result.app.title,
          },
          metadata: { versionNumber: result.version.versionNumber, automatic: true },
        });
      }

      return res.status(result.created ? 201 : 200).json({
        app: serializeApp(result.app, userId),
        version: serializeVersion(result.version),
        created: result.created,
        versionCreated: result.versionCreated,
      });
    } catch (error) {
      if (error instanceof ArtifactAppDeletedError) {
        return res.status(410).json({ error: 'Artifact was deleted and will not be synchronized' });
      }
      if (error instanceof ArtifactSyncConflictError) {
        return res.status(409).json({ error: error.message });
      }
      logger.error('[POST /artifact-apps/sync] Error syncing artifact', error);
      return res.status(500).json({ error: 'Error syncing artifact' });
    }
  }

  async function restore(req: ServerRequest, res: Response) {
    try {
      const user = requireUser(req, res);
      if (!user) {
        return res as Response;
      }
      const parsed = syncArtifactAppSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
      }

      const userId = user.id as string;
      const data = parsed.data;
      const assertSourceAvailable = async () => {
        if (
          sourceConversationExists &&
          !(await sourceConversationExists({
            userId,
            conversationId: data.source.conversationId,
          }))
        ) {
          throw new ArtifactAppDeletedError();
        }
      };
      const config = artifactAppsConfigSchema.parse(getConfig?.(req));
      const result = await restoreArtifactAppWithVersion(
        {
          tenantId: user.tenantId,
          createdBy: userId,
          title: data.title,
          visibility: 'private',
          marketplace: { listed: true },
          sourceMetadata: data.source,
          version: toVersionInput(data.artifact, undefined, undefined, userId),
        },
        { ...config, assertSourceAvailable },
      );

      try {
        await grantPermission({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: ResourceType.ARTIFACT_APP,
          resourceId: result.app.id,
          accessRoleId: AccessRoleIds.ARTIFACT_APP_OWNER,
          grantedBy: userId,
        });
      } catch (permissionError) {
        logger.error(
          `[POST /artifact-apps/restore] Failed to restore owner permission for ${result.app.artifactAppId}:`,
          permissionError,
        );
        const prepared = await prepareArtifactAppDeletion(
          { artifactAppId: result.app.artifactAppId },
          userId,
        );
        if (prepared.resourceId) {
          await removeAllPermissions({
            resourceType: ResourceType.ARTIFACT_APP,
            resourceId: prepared.resourceId,
          });
        }
        await finalizeArtifactAppDeletion({ artifactAppId: result.app.artifactAppId }, userId);
        return res.status(500).json({ error: 'Failed to restore artifact permissions' });
      }

      audit({
        tenantId: user.tenantId,
        action: 'artifact_app.updated',
        actor: { type: 'user', id: userId, name: user.name ?? user.username ?? userId },
        target: {
          type: ResourceType.ARTIFACT_APP,
          id: result.app.artifactAppId,
          name: result.app.title,
        },
        metadata: { versionNumber: result.version.versionNumber, restored: true },
      });
      return res.status(200).json({
        app: serializeApp(result.app, userId),
        version: serializeVersion(result.version),
        created: result.created,
        versionCreated: result.versionCreated,
      });
    } catch (error) {
      if (error instanceof ArtifactAppRestoreNotFoundError) {
        return res.status(404).json({ error: 'Deleted artifact was not found' });
      }
      if (error instanceof ArtifactAppDeletedError) {
        return res.status(410).json({ error: 'The source conversation is no longer available' });
      }
      logger.error('[POST /artifact-apps/restore] Error restoring artifact', error);
      return res.status(500).json({ error: 'Error restoring artifact' });
    }
  }

  async function list(req: ServerRequest, res: Response) {
    try {
      const user = requireUser(req, res);
      if (!user) {
        return res as Response;
      }
      const config = artifactAppsConfigSchema.parse(getConfig?.(req));
      const parsed = artifactAppListRequestSchema.safeParse({
        ...req.query,
        limit: req.query.limit ?? config.catalogPageSize,
      });
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid artifact list request' });
      }
      let scanCursor = parsed.data.cursor;
      const userId = user.id as string;
      let isManager = false;
      try {
        isManager = (await hasResourceManagementCapability?.(user)) === true;
      } catch (error) {
        logger.warn(
          `[GET /artifact-apps] Capability check failed for ${userId}; falling back to ACL`,
          error,
        );
      }
      const ownership: Pick<ArtifactAppListOptions, 'createdBy' | 'excludeCreatedBy'> = {};
      if (parsed.data.scope === 'personal') {
        ownership.createdBy = userId;
      } else if (parsed.data.scope === 'shared') {
        ownership.excludeCreatedBy = userId;
      }
      const accessibleEntries: ArtifactAppListEntry[] = [];
      const permissionById = new Map<string, number>();
      let exhausted = false;

      for (
        let batch = 0;
        batch < config.maxScanBatches && accessibleEntries.length <= parsed.data.limit;
        batch++
      ) {
        let candidatePage: ArtifactAppListPage;
        try {
          candidatePage = await listArtifactApps({
            ...ownership,
            cursor: scanCursor,
            limit: config.scanBatchSize,
            search: parsed.data.search,
          });
        } catch (error) {
          if (error instanceof Error && error.message === 'Invalid artifact app cursor') {
            return res.status(400).json({ error: 'Invalid artifact cursor' });
          }
          throw error;
        }
        if (candidatePage.entries.length === 0) {
          exhausted = true;
          break;
        }

        for (
          let offset = 0;
          offset < candidatePage.entries.length && accessibleEntries.length <= parsed.data.limit;
          offset += config.aclBatchSize
        ) {
          const aclEntries = candidatePage.entries.slice(offset, offset + config.aclBatchSize);
          if (isManager) {
            for (const entry of aclEntries) {
              accessibleEntries.push(entry);
              permissionById.set(
                entry.id,
                PermissionBits.VIEW |
                  PermissionBits.EDIT |
                  PermissionBits.DELETE |
                  PermissionBits.SHARE,
              );
              if (accessibleEntries.length > parsed.data.limit) {
                break;
              }
            }
            continue;
          }
          const permissions = await getResourcePermissionsMap({
            userId,
            role: user.role,
            resourceType: ResourceType.ARTIFACT_APP,
            resourceIds: aclEntries.map(({ id }) => id),
          });
          for (const entry of aclEntries) {
            const permissionBits = permissions.get(entry.id) ?? 0;
            if ((permissionBits & PermissionBits.VIEW) === PermissionBits.VIEW) {
              accessibleEntries.push(entry);
              permissionById.set(entry.id, permissionBits);
              if (accessibleEntries.length > parsed.data.limit) {
                break;
              }
            }
          }
        }

        scanCursor = candidatePage.after ?? undefined;
        if (!candidatePage.hasMore) {
          exhausted = true;
          break;
        }
      }

      const entries = accessibleEntries.slice(0, parsed.data.limit);
      const apps = await getArtifactAppsByIds(entries.map(({ id }) => id));
      const hasMore = accessibleEntries.length > parsed.data.limit || !exhausted;
      let after: string | null = null;
      if (hasMore) {
        after =
          accessibleEntries.length > parsed.data.limit
            ? (entries[entries.length - 1]?.cursor ?? null)
            : (scanCursor ?? null);
      }
      return res.status(200).json({
        apps: apps.map((app) => serializeApp(app, userId, permissionById.get(app.id) ?? 0)),
        has_more: hasMore,
        after,
      });
    } catch (error) {
      logger.error('[GET /artifact-apps] Error listing artifact apps', error);
      return res.status(500).json({ error: 'Error listing artifact apps' });
    }
  }

  async function getBySource(req: ServerRequest, res: Response) {
    try {
      const user = requireUser(req, res);
      if (!user) {
        return res as Response;
      }
      const conversationId =
        typeof req.query.conversationId === 'string' ? req.query.conversationId : '';
      const sourceKey = typeof req.query.sourceKey === 'string' ? req.query.sourceKey : '';
      if (!conversationId || !sourceKey) {
        return res.status(400).json({ error: 'conversationId and sourceKey are required' });
      }
      const app = await getArtifactAppBySource({
        tenantId: user.tenantId,
        createdBy: user.id as string,
        conversationId,
        sourceKey,
      });
      if (!app) {
        const deletedApp = await getDeletedArtifactAppBySource({
          tenantId: user.tenantId,
          createdBy: user.id as string,
          conversationId,
          sourceKey,
        });
        if (deletedApp) {
          return res.status(410).json({ error: 'Artifact was deleted' });
        }
        return res.status(404).json({ error: 'Artifact not found' });
      }
      return res.status(200).json(await serializeDetail(app, user.id as string));
    } catch (error) {
      logger.error('[GET /artifact-apps/source] Error fetching artifact', error);
      return res.status(500).json({ error: 'Error fetching artifact' });
    }
  }

  async function get(req: ServerRequest, res: Response) {
    try {
      const user = requireUser(req, res);
      if (!user) {
        return res as Response;
      }
      const { id } = req.params as { id: string };
      const app = await getArtifactAppByAppId({ artifactAppId: id });
      if (!app) {
        return res.status(404).json({ error: 'Artifact app not found' });
      }
      return res.status(200).json(await serializeDetail(app, user.id as string));
    } catch (error) {
      logger.error('[GET /artifact-apps/:id] Error fetching artifact app', error);
      return res.status(500).json({ error: 'Error fetching artifact app' });
    }
  }

  async function update(req: ServerRequest, res: Response) {
    try {
      const user = requireUser(req, res);
      if (!user) {
        return res as Response;
      }
      const { id } = req.params as { id: string };
      const parsed = updateArtifactAppSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
      }
      if (Object.keys(parsed.data).length === 0) {
        return res.status(400).json({ error: 'At least one field must be provided for update' });
      }

      const updated = await updateArtifactApp({ artifactAppId: id }, parsed.data);
      if (!updated) {
        return res.status(404).json({ error: 'Artifact app not found' });
      }
      audit({
        tenantId: user.tenantId,
        action: 'artifact_app.updated',
        actor: { type: 'user', id: user.id as string, name: user.name ?? user.username ?? '' },
        target: { type: ResourceType.ARTIFACT_APP, id: updated.artifactAppId, name: updated.title },
      });
      return res.status(200).json(serializeApp(updated, user.id as string));
    } catch (error) {
      logger.error('[PATCH /artifact-apps/:id] Error updating artifact app', error);
      return res.status(500).json({ error: 'Error updating artifact app' });
    }
  }

  async function remove(req: ServerRequest, res: Response) {
    try {
      const user = requireUser(req, res);
      if (!user) {
        return res as Response;
      }
      const { id } = req.params as { id: string };
      const userId = user.id as string;
      const app = await getArtifactAppByAppId({ artifactAppId: id });
      if (!app) {
        return res.status(200).json({ success: true });
      }
      let hasManagementCapability = false;
      if (app.createdBy !== userId && app.deletion?.requestedBy !== userId) {
        try {
          hasManagementCapability = (await hasResourceManagementCapability?.(user)) === true;
        } catch (error) {
          logger.warn(
            `[DELETE /artifact-apps/:id] Capability check failed for ${userId}; falling back to ACL`,
            error,
          );
        }
      }
      if (
        app.createdBy !== userId &&
        app.deletion?.requestedBy !== userId &&
        !hasManagementCapability
      ) {
        const permissions = await getResourcePermissionsMap({
          userId,
          role: user.role,
          resourceType: ResourceType.ARTIFACT_APP,
          resourceIds: [app.id],
        });
        const permissionBits = permissions.get(app.id) ?? 0;
        if ((permissionBits & PermissionBits.DELETE) !== PermissionBits.DELETE) {
          return res.status(403).json({ error: 'Forbidden' });
        }
      }
      if (app.deletion?.finalizedAt) {
        return res.status(200).json({ success: true });
      }
      const prepared = await prepareArtifactAppDeletion({ artifactAppId: id }, userId);
      if (!prepared.found) {
        return res.status(200).json({ success: true });
      }
      if (!prepared.resourceId) {
        throw new Error('Prepared artifact deletion has no resource id');
      }
      await removeAllPermissions({
        resourceType: ResourceType.ARTIFACT_APP,
        resourceId: prepared.resourceId,
      });
      if (!(await finalizeArtifactAppDeletion({ artifactAppId: id }, userId))) {
        throw new Error('Failed to finalize artifact deletion');
      }
      audit({
        tenantId: user.tenantId,
        action: 'artifact_app.archived',
        actor: { type: 'user', id: userId, name: user.name ?? user.username ?? '' },
        target: { type: ResourceType.ARTIFACT_APP, id },
        metadata: { deletedVersions: prepared.deletedVersions },
      });
      return res.status(200).json({ success: true });
    } catch (error) {
      logger.error('[DELETE /artifact-apps/:id] Error deleting artifact app', error);
      return res.status(500).json({ error: 'Error deleting artifact app' });
    }
  }

  async function listVersions(req: ServerRequest, res: Response) {
    try {
      const { id } = req.params as { id: string };
      const user = requireUser(req, res);
      if (!user) {
        return res as Response;
      }
      const config = artifactAppsConfigSchema.parse(getConfig?.(req));
      const parsed = artifactVersionListRequestSchema.safeParse({
        ...req.query,
        limit: req.query.limit ?? config.versionPageSize,
      });
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid artifact version list request' });
      }
      const canManage = await canManageArtifactVersion(user, id);
      let page: ArtifactVersionListPage;
      try {
        page = await listArtifactVersions({
          artifactAppId: id,
          ...parsed.data,
          excludeWithdrawn: !canManage,
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'Invalid artifact version cursor') {
          return res.status(400).json({ error: 'Invalid artifact version cursor' });
        }
        throw error;
      }
      return res.status(200).json({
        versions: page.versions.map(serializeVersionSummary),
        has_more: page.hasMore,
        after: page.after,
      });
    } catch (error) {
      logger.error('[GET /artifact-apps/:id/versions] Error listing versions', error);
      return res.status(500).json({ error: 'Error listing artifact app versions' });
    }
  }

  async function getVersion(req: ServerRequest, res: Response) {
    try {
      const { id, versionId } = req.params as { id: string; versionId: string };
      const version = await getArtifactVersion({
        artifactAppId: id,
        artifactVersionId: versionId,
      });
      if (!version) {
        return res.status(404).json({ error: 'Artifact version not found' });
      }
      if (version.publication.state === 'withdrawn') {
        const user = requireUser(req, res);
        if (!user) {
          return res as Response;
        }
        if (!(await canManageArtifactVersion(user, id))) {
          return res.status(404).json({ error: 'Artifact version not found' });
        }
      }
      return res.status(200).json(serializeVersion(version));
    } catch (error) {
      logger.error('[GET /artifact-apps/:id/versions/:versionId] Error fetching version', error);
      return res.status(500).json({ error: 'Error fetching artifact app version' });
    }
  }

  async function releaseVersion(req: ServerRequest, res: Response) {
    try {
      const user = requireUser(req, res);
      if (!user) {
        return res as Response;
      }
      const { id, versionId } = req.params as { id: string; versionId: string };
      const version = await releaseArtifactVersion(
        { artifactAppId: id, artifactVersionId: versionId },
        user.id as string,
      );
      if (!version) {
        return res.status(404).json({ error: 'Artifact version not found' });
      }
      audit({
        tenantId: user.tenantId,
        action: 'artifact_version.released',
        actor: { type: 'user', id: user.id as string, name: user.name ?? user.username ?? '' },
        target: { type: ResourceType.ARTIFACT_APP, id, name: version.artifactVersionId },
        metadata: { versionNumber: version.versionNumber },
      });
      return res.status(200).json(serializeVersion(version));
    } catch (error) {
      logger.error('[POST /artifact-apps/:id/versions/:versionId/release] Error', error);
      return res.status(500).json({ error: 'Error releasing artifact app version' });
    }
  }

  async function activateVersion(req: ServerRequest, res: Response) {
    try {
      const user = requireUser(req, res);
      if (!user) {
        return res as Response;
      }
      const { id, versionId } = req.params as { id: string; versionId: string };
      let result: ArtifactAppWithVersion | null;
      try {
        result = await activateArtifactVersion({
          artifactAppId: id,
          artifactVersionId: versionId,
        });
      } catch (error) {
        if ((error as Error).message?.includes('released')) {
          return res.status(409).json({ error: 'Only released versions can be activated' });
        }
        throw error;
      }
      if (!result) {
        return res.status(404).json({ error: 'Artifact version not found' });
      }
      audit({
        tenantId: user.tenantId,
        action: 'artifact_version.activated',
        actor: { type: 'user', id: user.id as string, name: user.name ?? user.username ?? '' },
        target: { type: ResourceType.ARTIFACT_APP, id, name: result.version.artifactVersionId },
        metadata: { versionNumber: result.version.versionNumber },
      });
      return res.status(200).json(serializeApp(result.app, user.id as string));
    } catch (error) {
      logger.error('[POST /artifact-apps/:id/versions/:versionId/activate] Error', error);
      return res.status(500).json({ error: 'Error activating artifact app version' });
    }
  }

  async function withdrawVersion(req: ServerRequest, res: Response) {
    try {
      const user = requireUser(req, res);
      if (!user) {
        return res as Response;
      }
      const { id, versionId } = req.params as { id: string; versionId: string };
      const version = await withdrawArtifactVersion({
        artifactAppId: id,
        artifactVersionId: versionId,
      });
      if (!version) {
        return res.status(404).json({ error: 'Artifact version not found' });
      }
      audit({
        tenantId: user.tenantId,
        action: 'artifact_version.withdrawn',
        actor: { type: 'user', id: user.id as string, name: user.name ?? user.username ?? '' },
        target: { type: ResourceType.ARTIFACT_APP, id, name: version.artifactVersionId },
        metadata: { versionNumber: version.versionNumber },
      });
      return res.status(200).json(serializeVersion(version));
    } catch (error) {
      logger.error('[POST /artifact-apps/:id/versions/:versionId/withdraw] Error', error);
      return res.status(500).json({ error: 'Error withdrawing artifact app version' });
    }
  }

  return {
    publish,
    sync,
    restore,
    list,
    getBySource,
    get,
    update,
    remove,
    listVersions,
    getVersion,
    releaseVersion,
    activateVersion,
    withdrawVersion,
  };
}

export type ArtifactAppHandlers = ReturnType<typeof createArtifactAppHandlers>;
