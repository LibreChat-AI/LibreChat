import { Types } from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { createMethods, getTenantId, logger } from '@librechat/data-schemas';
import {
  AccessRoleIds,
  PermissionBits,
  PrincipalType,
  ResourceType,
  isSecureCodeEnvironmentControlURL,
} from 'librechat-data-provider';
import type { CodeEnvironmentUserSettings } from 'librechat-data-provider';
import type { ResolvedPrincipal } from '~/types/principal';
import { AccessControlService } from '~/acl/accessControlService';

export type CodeEnvironmentPrincipalContext = {
  userId: string | Types.ObjectId;
  role?: string | null;
  idOnTheSource?: string | null;
  principals?: ResolvedPrincipal[];
};

export type CodeEnvironmentSummary = {
  resourceId: string;
  id: string;
  name: string;
  type: 'managed' | 'attached';
  canEdit?: boolean;
  canDelete: boolean;
  settings?: CodeEnvironmentUserSettings;
};

export type CodeEnvironmentRegistration = {
  id: string;
  name: string;
  type: 'managed' | 'attached';
  baseURL: string;
  controlPlaneId: string;
  workerId?: string;
  revocationTokenEnv?: string;
  workerPrincipal?: {
    type: 'deployment' | 'tenant' | 'user' | 'role' | 'group';
    id: string;
  };
};

export type AccessibleCodeEnvironmentConfiguration = {
  id: string;
  name: string;
  type: 'managed' | 'attached';
  baseURL: string;
  controlPlaneId: string;
  owner: 'principal';
  workerId?: string;
  settings?: CodeEnvironmentUserSettings;
};

export type AccessibleCodeEnvironmentDetails = {
  summaries: CodeEnvironmentSummary[];
  configurations: AccessibleCodeEnvironmentConfiguration[];
};

type CachedAccessibleCodeEnvironmentConfiguration = AccessibleCodeEnvironmentConfiguration & {
  resourceId: string;
};

export type CodeEnvironmentLifecycleTarget = CodeEnvironmentSummary & {
  baseURL: string;
  workerId?: string;
  controlPlaneId?: string;
  revocationTokenEnv?: string;
  workerPrincipal?: CodeEnvironmentRegistration['workerPrincipal'];
};

function agentReferenceFilter(environmentId: string, tenantId?: string) {
  return {
    code_environment_id: environmentId,
    ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
  };
}

const ENVIRONMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKER_PRINCIPAL_ID_PATTERN = /^\S(?:.{0,254}\S)?$/;
const CONFIGURATION_CACHE_TTL_MS = 5_000;
const CONFIGURATION_CACHE_REVISION_PREFIX = 'revision';
const CONFIGURATION_CACHE_REGISTERED_PREFIX = 'registered';
const CONFIGURATION_CACHE_USER_PREFIX = 'user';

type CodeEnvironmentConfigurationCache = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, ttl?: number) => Promise<unknown>;
};

type CodeEnvironmentRegistryOptions = {
  /** Shared cache only. Omit this dependency when Redis is unavailable so ACL reads stay live. */
  configurationCache?: CodeEnvironmentConfigurationCache;
};

export function normalizeCodeEnvironmentName(input: string): string {
  const name = input.trim();
  if (name.length < 1 || name.length > 100) {
    throw new Error('Code environment name must contain between 1 and 100 characters');
  }
  return name;
}

export class CodeEnvironmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeEnvironmentValidationError';
  }
}

export class CodeEnvironmentLimitError extends Error {
  constructor() {
    super('Personal code environment limit reached');
    this.name = 'CodeEnvironmentLimitError';
  }
}

function normalizeRegistration(input: CodeEnvironmentRegistration): CodeEnvironmentRegistration {
  const id = input.id.trim();
  const name = normalizeCodeEnvironmentName(input.name);
  const baseURL = input.baseURL.trim().replace(/\/+$/, '');
  const controlPlaneId = input.controlPlaneId.trim();
  const workerId = input.workerId?.trim();
  if (!ENVIRONMENT_ID_PATTERN.test(id)) {
    throw new CodeEnvironmentValidationError('Code environment id is invalid');
  }
  if (name.length < 1 || name.length > 100) {
    throw new CodeEnvironmentValidationError(
      'Code environment name must contain between 1 and 100 characters',
    );
  }
  if (!isSecureCodeEnvironmentControlURL(baseURL)) {
    throw new CodeEnvironmentValidationError('Code environment control requires secure transport');
  }
  if (!ENVIRONMENT_ID_PATTERN.test(controlPlaneId)) {
    throw new CodeEnvironmentValidationError('Code environment control plane id is invalid');
  }
  if (workerId != null && !WORKER_ID_PATTERN.test(workerId)) {
    throw new CodeEnvironmentValidationError('Code environment worker id is invalid');
  }
  if (
    input.workerPrincipal != null &&
    !WORKER_PRINCIPAL_ID_PATTERN.test(input.workerPrincipal.id)
  ) {
    throw new CodeEnvironmentValidationError('Code environment worker principal is invalid');
  }
  return { ...input, id, name, baseURL, controlPlaneId, workerId };
}

function toSummary(
  environment: {
    _id: Types.ObjectId;
    environmentId: string;
    name: string;
    type: 'managed' | 'attached';
    settings?: CodeEnvironmentUserSettings;
  },
  canDelete = false,
  canEdit = false,
): CodeEnvironmentSummary {
  return {
    resourceId: environment._id.toString(),
    id: environment.environmentId,
    name: environment.name,
    type: environment.type,
    canEdit,
    canDelete,
    ...(environment.settings != null ? { settings: environment.settings } : {}),
  };
}

export function createCodeEnvironmentRegistry(
  mongoose: typeof import('mongoose'),
  options: CodeEnvironmentRegistryOptions = {},
): {
  register: (params: {
    actor: CodeEnvironmentPrincipalContext;
    environment: CodeEnvironmentRegistration;
    maxOwned?: number;
  }) => Promise<CodeEnvironmentSummary>;
  listAccessible: (actor: CodeEnvironmentPrincipalContext) => Promise<CodeEnvironmentSummary[]>;
  listAccessibleDetails: (
    actor: CodeEnvironmentPrincipalContext,
  ) => Promise<AccessibleCodeEnvironmentDetails>;
  listAccessibleConfigurations: (
    actor: CodeEnvironmentPrincipalContext,
  ) => Promise<AccessibleCodeEnvironmentConfiguration[]>;
  resolvePrincipals: (actor: CodeEnvironmentPrincipalContext) => Promise<ResolvedPrincipal[]>;
  listRegisteredIds: () => Promise<string[]>;
  invalidateAccessibleConfigurations: (tenantId?: string) => Promise<void>;
  markRevocationPending: (environmentId: string) => Promise<void>;
  remove: (params: {
    actor: CodeEnvironmentPrincipalContext;
    environmentId: string;
    beforeDelete?: (target: CodeEnvironmentLifecycleTarget) => Promise<void>;
  }) => Promise<CodeEnvironmentSummary | null>;
  updateSettings: (params: {
    actor: CodeEnvironmentPrincipalContext;
    environmentId: string;
    settings: CodeEnvironmentUserSettings;
  }) => Promise<CodeEnvironmentSummary | null>;
} {
  const methods = createMethods(mongoose);
  const access = new AccessControlService(mongoose);
  const configurationCache = options.configurationCache;

  function tenantCacheKey(tenantId?: string): string {
    return encodeURIComponent(tenantId ?? getTenantId() ?? '__default__');
  }

  function revisionKey(tenantId?: string): string {
    return `${CONFIGURATION_CACHE_REVISION_PREFIX}:${tenantCacheKey(tenantId)}`;
  }

  async function invalidateAccessibleConfigurations(tenantId?: string): Promise<void> {
    if (configurationCache == null) return;
    await configurationCache.set(revisionKey(tenantId), randomUUID());
  }

  async function listRegisteredIds(): Promise<string[]> {
    if (configurationCache == null) return await methods.listCodeEnvironmentIds();

    const tenant = tenantCacheKey();
    const revision = String((await configurationCache.get(revisionKey())) ?? '0');
    const key = `${CONFIGURATION_CACHE_REGISTERED_PREFIX}:${tenant}:${revision}`;
    const cached = await configurationCache.get(key);
    if (
      Array.isArray(cached) &&
      cached.every((environmentId) => typeof environmentId === 'string')
    ) {
      return cached;
    }

    const environmentIds = await methods.listCodeEnvironmentIds();
    const currentRevision = String((await configurationCache.get(revisionKey())) ?? '0');
    if (currentRevision !== revision) {
      return await listRegisteredIds();
    }
    await configurationCache.set(key, environmentIds, CONFIGURATION_CACHE_TTL_MS);
    return environmentIds;
  }

  async function register({
    actor,
    environment: input,
    maxOwned,
  }: {
    actor: CodeEnvironmentPrincipalContext;
    environment: CodeEnvironmentRegistration;
    maxOwned?: number;
  }): Promise<CodeEnvironmentSummary> {
    const environment = normalizeRegistration(input);
    const createInput = {
      environmentId: environment.id,
      name: environment.name,
      type: environment.type,
      baseURL: environment.baseURL,
      controlPlaneId: environment.controlPlaneId,
      workerId: environment.workerId,
      revocationTokenEnv: environment.revocationTokenEnv,
      workerPrincipal: environment.workerPrincipal,
      createdBy: new Types.ObjectId(actor.userId),
    };
    const created =
      maxOwned == null
        ? await methods.createCodeEnvironment(createInput)
        : await methods.createCodeEnvironmentWithinOwnerLimit(createInput, maxOwned);
    if (created == null) {
      throw new CodeEnvironmentLimitError();
    }
    try {
      const permission = await access.grantPermission({
        principalType: PrincipalType.USER,
        principalId: actor.userId,
        resourceType: ResourceType.CODE_ENVIRONMENT,
        resourceId: created._id,
        accessRoleId: AccessRoleIds.CODE_ENVIRONMENT_OWNER,
        grantedBy: actor.userId,
      });
      if (permission == null) {
        throw new Error('Unable to grant code environment ownership');
      }
      const summary = toSummary(created, true, true);
      await invalidateAccessibleConfigurations();
      await methods.completeCodeEnvironmentRegistration(created._id);
      return summary;
    } catch (error) {
      let permissionsRemoved = false;
      try {
        await access.removeAllPermissions({
          resourceType: ResourceType.CODE_ENVIRONMENT,
          resourceId: created._id,
        });
        permissionsRemoved = true;
      } catch (cleanupError) {
        logger.error('[codeEnvironments] registration ACL rollback failed:', cleanupError);
      }
      if (permissionsRemoved) {
        try {
          await methods.discardCodeEnvironmentById(created._id);
        } catch (cleanupError) {
          logger.error('[codeEnvironments] registration record rollback failed:', cleanupError);
        }
      }
      throw error;
    }
  }

  async function findAccessibleResourceIds(principals: ResolvedPrincipal[]) {
    return await access.findAccessibleResourcesForPrincipals({
      principalsList: principals,
      resourceType: ResourceType.CODE_ENVIRONMENT,
      requiredPermissions: PermissionBits.VIEW,
    });
  }

  async function resolvePrincipals(
    actor: CodeEnvironmentPrincipalContext,
  ): Promise<ResolvedPrincipal[]> {
    return actor.principals ?? (await methods.getUserPrincipals(actor));
  }

  async function findAccessible(actor: CodeEnvironmentPrincipalContext) {
    const principals = await resolvePrincipals(actor);
    const ids = await findAccessibleResourceIds(principals);
    const environments = await methods.findCodeEnvironmentsByIds(ids);
    const userId = actor.userId.toString();
    return {
      principals,
      environments: environments.filter(
        (environment) =>
          environment.registrationPendingAt == null &&
          environment.deletionStartedAt == null &&
          environment.deletionCommittedAt == null &&
          (environment.workerPrincipal?.type !== 'user' ||
            environment.workerPrincipal.id === userId),
      ),
    };
  }

  async function listAccessible(
    actor: CodeEnvironmentPrincipalContext,
  ): Promise<CodeEnvironmentSummary[]> {
    return (await listAccessibleDetails(actor)).summaries;
  }

  async function listAccessibleDetails(
    actor: CodeEnvironmentPrincipalContext,
  ): Promise<AccessibleCodeEnvironmentDetails> {
    const { environments, principals } = await findAccessible(actor);
    const permissions = await access.getResourcePermissionsMapForPrincipals({
      principalsList: principals,
      resourceType: ResourceType.CODE_ENVIRONMENT,
      resourceIds: environments.map((environment) => environment._id),
    });
    return {
      summaries: environments.map((environment) => {
        const permission = permissions.get(environment._id.toString()) ?? 0;
        return toSummary(
          environment,
          (permission & PermissionBits.DELETE) === PermissionBits.DELETE,
          (permission & PermissionBits.EDIT) === PermissionBits.EDIT,
        );
      }),
      configurations: environments.map((environment) => ({
        id: environment.environmentId,
        name: environment.name,
        type: environment.type,
        baseURL: environment.baseURL,
        controlPlaneId: environment.controlPlaneId,
        owner: 'principal',
        workerId: environment.workerId,
        settings: environment.settings,
      })),
    };
  }

  async function markRevocationPending(environmentId: string): Promise<void> {
    const CodeEnvironment = mongoose.models.CodeEnvironment;
    const result = await CodeEnvironment.updateOne(
      { environmentId, deletionCommittedAt: { $exists: false } },
      {
        $set: { revocationPendingAt: new Date() },
        $inc: { revocationAttempts: 1 },
        $unset: { revocationLastError: 1, revocationReconcileAfter: 1 },
      },
    );
    if (result.matchedCount !== 1) {
      throw new Error('Code environment cleanup target is unavailable');
    }
    await invalidateAccessibleConfigurations();
  }

  async function listAccessibleConfigurations(
    actor: CodeEnvironmentPrincipalContext,
  ): Promise<AccessibleCodeEnvironmentConfiguration[]> {
    const principals = actor.principals ?? (await methods.getUserPrincipals(actor));
    const principalFingerprint = createHash('sha256')
      .update(
        principals
          .map(
            ({ principalType, principalId }) => `${principalType}:${principalId?.toString() ?? ''}`,
          )
          .sort()
          .join('\n'),
      )
      .digest('base64url');
    const toPublicConfiguration = ({
      resourceId: _resourceId,
      ...configuration
    }: CachedAccessibleCodeEnvironmentConfiguration): AccessibleCodeEnvironmentConfiguration =>
      configuration;
    const load = async (): Promise<{
      configurations: CachedAccessibleCodeEnvironmentConfiguration[];
      hasPendingRegistration: boolean;
    }> => {
      const ids = await findAccessibleResourceIds(principals);
      const environments = await methods.findCodeEnvironmentsByIds(ids);
      const userId = actor.userId.toString();
      return {
        hasPendingRegistration: environments.some(
          (environment) => environment.registrationPendingAt != null,
        ),
        configurations: environments
          .filter(
            (environment) =>
              environment.registrationPendingAt == null &&
              environment.deletionStartedAt == null &&
              environment.deletionCommittedAt == null &&
              (environment.workerPrincipal?.type !== 'user' ||
                environment.workerPrincipal.id === userId),
          )
          .map((environment) => ({
            resourceId: environment._id.toString(),
            id: environment.environmentId,
            name: environment.name,
            type: environment.type,
            baseURL: environment.baseURL,
            controlPlaneId: environment.controlPlaneId,
            owner: 'principal',
            workerId: environment.workerId,
            settings: environment.settings,
          })),
      };
    };
    if (configurationCache == null) {
      return (await load()).configurations.map(toPublicConfiguration);
    }

    const tenant = tenantCacheKey();
    const revision = String((await configurationCache.get(revisionKey())) ?? '0');
    const key =
      `${CONFIGURATION_CACHE_USER_PREFIX}:${tenant}:${actor.userId.toString()}:` +
      `${principalFingerprint}:${revision}`;
    const cached = await configurationCache.get(key);
    if (
      Array.isArray(cached) &&
      cached.every(
        (configuration) =>
          configuration != null &&
          typeof configuration === 'object' &&
          typeof (configuration as { resourceId?: unknown }).resourceId === 'string',
      )
    ) {
      // The cache accelerates configuration lookup, not authorization. Re-check the current
      // ACL on every use so a failed revision write can delay grants but can never preserve a
      // revocation. Entries written before resourceId was cached are deliberately treated as
      // misses during rolling upgrades.
      const cachedConfigurations = cached as CachedAccessibleCodeEnvironmentConfiguration[];
      const [accessibleResourceIds, liveEnvironments] = await Promise.all([
        findAccessibleResourceIds(principals),
        methods.findCodeEnvironmentsByIds(cachedConfigurations.map(({ resourceId }) => resourceId)),
      ]);
      const accessibleIds = new Set(accessibleResourceIds.map((id) => id.toString()));
      const userId = actor.userId.toString();
      const liveByResourceId = new Map(
        liveEnvironments
          .filter(
            (environment) =>
              environment.registrationPendingAt == null &&
              environment.deletionStartedAt == null &&
              environment.deletionCommittedAt == null &&
              (environment.workerPrincipal?.type !== 'user' ||
                environment.workerPrincipal.id === userId),
          )
          .map((environment) => [environment._id.toString(), environment]),
      );
      return cachedConfigurations.flatMap((configuration) => {
        const live = liveByResourceId.get(configuration.resourceId);
        if (!accessibleIds.has(configuration.resourceId) || live == null) return [];
        return [toPublicConfiguration({ ...configuration, settings: live.settings })];
      });
    }

    const { configurations, hasPendingRegistration } = await load();
    const currentRevision = String((await configurationCache.get(revisionKey())) ?? '0');
    if (currentRevision !== revision) {
      return await listAccessibleConfigurations(actor);
    }
    // Registration commits after its first revision write so a failed rollback remains hidden and
    // recoverable. Do not cache that transient empty view under the new revision.
    if (hasPendingRegistration) {
      return configurations.map(toPublicConfiguration);
    }
    await configurationCache.set(key, configurations, CONFIGURATION_CACHE_TTL_MS);
    return configurations.map(toPublicConfiguration);
  }

  async function remove({
    actor,
    environmentId,
    beforeDelete,
  }: {
    actor: CodeEnvironmentPrincipalContext;
    environmentId: string;
    beforeDelete?: (target: CodeEnvironmentLifecycleTarget) => Promise<void>;
  }): Promise<CodeEnvironmentSummary | null> {
    const environment = await methods.findCodeEnvironmentByEnvironmentId(environmentId);
    if (environment == null) return null;
    if (
      environment.workerPrincipal?.type === 'user' &&
      environment.workerPrincipal.id !== actor.userId.toString()
    ) {
      return null;
    }
    const allowed = await access.checkPermission({
      userId: actor.userId.toString(),
      role: actor.role,
      resourceType: ResourceType.CODE_ENVIRONMENT,
      resourceId: environment._id,
      requiredPermission: PermissionBits.DELETE,
    });
    if (!allowed) return null;
    const removal = await methods.beginCodeEnvironmentRemoval(environment._id);
    if (removal == null) {
      throw new CodeEnvironmentInUseError(environmentId);
    }
    const removalLeaseId = removal.deletionLeaseId;
    if (removalLeaseId == null) {
      throw new Error('Code environment removal lease is unavailable');
    }
    let deletionCommitted = false;
    let externalLifecycleStarted = false;
    try {
      const Agent = mongoose.models.Agent;
      if (
        Agent != null &&
        (await Agent.exists(agentReferenceFilter(environmentId, environment.tenantId))) != null
      ) {
        throw new CodeEnvironmentInUseError(environmentId);
      }
      if (beforeDelete != null) {
        // From this point onward the remote outcome may be committed even if the request fails.
        // Keep the local fence for idempotent reconciliation instead of reopening a dead worker.
        externalLifecycleStarted = true;
        await beforeDelete({
          ...toSummary(environment),
          baseURL: environment.baseURL,
          workerId: environment.workerId,
          controlPlaneId: environment.controlPlaneId,
          revocationTokenEnv: environment.revocationTokenEnv,
          workerPrincipal: environment.workerPrincipal,
        });
      }
      await methods.commitCodeEnvironmentRemoval(environment._id, removalLeaseId);
      deletionCommitted = true;
      await access.removeAllPermissions({
        resourceType: ResourceType.CODE_ENVIRONMENT,
        resourceId: environment._id,
      });
      const deleted = await methods.deleteCodeEnvironmentById(environment._id);
      if (deleted == null) return null;
      await invalidateAccessibleConfigurations();
      return toSummary(deleted, true, true);
    } catch (error) {
      if (!deletionCommitted && !externalLifecycleStarted) {
        await methods.cancelCodeEnvironmentRemoval(environment._id, removalLeaseId);
      }
      throw error;
    }
  }

  async function updateSettings({
    actor,
    environmentId,
    settings,
  }: {
    actor: CodeEnvironmentPrincipalContext;
    environmentId: string;
    settings: CodeEnvironmentUserSettings;
  }): Promise<CodeEnvironmentSummary | null> {
    const environment = await methods.findCodeEnvironmentByEnvironmentId(environmentId);
    if (environment == null) return null;
    if (
      environment.workerPrincipal?.type === 'user' &&
      environment.workerPrincipal.id !== actor.userId.toString()
    ) {
      return null;
    }
    const principals = await resolvePrincipals(actor);
    const permissions = await access.getResourcePermissionsMapForPrincipals({
      principalsList: principals,
      resourceType: ResourceType.CODE_ENVIRONMENT,
      resourceIds: [environment._id],
    });
    const permission = permissions.get(environment._id.toString()) ?? 0;
    if ((permission & PermissionBits.EDIT) !== PermissionBits.EDIT) return null;
    const updated = await methods.updateCodeEnvironmentSettings(environmentId, settings);
    if (updated == null) return null;
    await invalidateAccessibleConfigurations();
    return toSummary(updated, (permission & PermissionBits.DELETE) === PermissionBits.DELETE, true);
  }

  return {
    register,
    markRevocationPending,
    listAccessible,
    listAccessibleDetails,
    listAccessibleConfigurations,
    resolvePrincipals,
    listRegisteredIds,
    invalidateAccessibleConfigurations,
    remove,
    updateSettings,
  };
}

export class CodeEnvironmentInUseError extends Error {
  constructor(public readonly environmentId: string) {
    super(`Code environment is still referenced by an agent: ${environmentId}`);
    this.name = 'CodeEnvironmentInUseError';
  }
}
