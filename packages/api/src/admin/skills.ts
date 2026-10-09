import { SystemCapabilities } from '@librechat/data-schemas';
import { skillSyncConfigSchema } from 'librechat-data-provider';
import type {
  TGitHubSkillSyncStatusResponse,
  TGitHubSkillSyncSourceStatus,
  TGitHubSkillSyncCredentialSummary,
  TGitHubSkillSyncManualRunResponse,
  SkillSyncConfig,
} from 'librechat-data-provider';
import type {
  ISkillSyncStatus,
  SkillSyncProvider,
  SkillSyncCredentialSummary,
  UpsertSkillSyncCredentialInput,
  SystemCapability,
} from '@librechat/data-schemas';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Types } from 'mongoose';
import type { GitHubSkillSyncRunner } from '~/skills/sync';

export type AdminSkillsRequest = Request & {
  user?: {
    _id?: Types.ObjectId;
    id?: string;
    tenantId?: string;
  };
  skillSyncAllowServerCredentials?: boolean;
  skillSyncCanReadCredentials?: boolean;
};

type SkillSyncConfigContainer = {
  skillSync?: unknown;
  config?: {
    skillSync?: unknown;
  } & Record<string, unknown>;
} & Record<string, unknown>;

type AdminSkillSyncAccessRequest = Request & {
  user?: {
    _id?: Types.ObjectId | { toString(): string };
    id?: string;
    role?: string;
    tenantId?: string;
  };
  config?: SkillSyncConfigContainer;
  skillSyncAllowServerCredentials?: boolean;
  skillSyncCanReadCredentials?: boolean;
};

type SkillSyncCapabilityUser = {
  id: string;
  role: string;
  tenantId?: string;
};

export type AdminSkillSyncDeps = {
  runner?: GitHubSkillSyncRunner;
  getRunner?: (req: Request) => GitHubSkillSyncRunner;
  upsertCredential: (input: UpsertSkillSyncCredentialInput) => Promise<SkillSyncCredentialSummary>;
  deleteCredential: (
    provider: SkillSyncProvider,
    credentialKey: string,
  ) => Promise<{ deleted: boolean }>;
};

export type AdminSkillSyncAccessDeps = {
  getAppConfig: (options: { baseOnly: true }) => Promise<{ skillSync?: unknown } | undefined>;
  hasCapability: (user: SkillSyncCapabilityUser, capability: SystemCapability) => Promise<boolean>;
};

type AdminSkillsSyncHandler = (req: AdminSkillsRequest, res: Response) => Promise<Response>;

export type AdminSkillsSyncHandlers = {
  getSyncStatus: AdminSkillsSyncHandler;
  runSync: AdminSkillsSyncHandler;
  setCredential: AdminSkillsSyncHandler;
  deleteCredential: (req: Request, res: Response) => Promise<Response>;
};

export type AdminSkillsSyncAccess = {
  attachBaseSkillSyncConfig: RequestHandler;
  attachCredentialReadAccess: RequestHandler;
  requireReadSkills: RequestHandler;
  requirePlatformManageSkills: RequestHandler;
  requireSyncRunCapability: RequestHandler;
};

const CREDENTIAL_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function toIso(date: Date | undefined): string | undefined {
  return date ? date.toISOString() : undefined;
}

function serializeCredential(
  credential: SkillSyncCredentialSummary,
): TGitHubSkillSyncCredentialSummary {
  return {
    provider: credential.provider,
    credentialKey: credential.credentialKey,
    credentialPresent: credential.credentialPresent,
    tokenFingerprint: credential.tokenFingerprint,
    createdAt: toIso(credential.createdAt),
    updatedAt: toIso(credential.updatedAt),
  };
}

function isCredentialError(status: ISkillSyncStatus): boolean {
  if (status.errorCode === 'MISSING_CREDENTIAL') {
    return true;
  }
  return /credential|token environment variable|server github credentials/i.test(
    status.errorMessage ?? '',
  );
}

function isPromotedSkippedSkillError(status: ISkillSyncStatus): boolean {
  const firstSkippedSkill = status.skippedSkills?.[0];
  return Boolean(
    firstSkippedSkill &&
      status.errorCode === firstSkippedSkill.errorCode &&
      status.errorMessage === firstSkippedSkill.errorMessage,
  );
}

function serializeErrorMessage(
  status: ISkillSyncStatus,
  { includeCredentialMetadata }: { includeCredentialMetadata: boolean },
): string | undefined {
  if (includeCredentialMetadata) {
    return status.errorMessage;
  }
  if (isPromotedSkippedSkillError(status)) {
    return 'One or more GitHub skills could not be synchronized';
  }
  if (isCredentialError(status)) {
    return 'GitHub skill sync credentials are not available';
  }
  return status.errorMessage;
}

function serializeSourceStatus(
  status: ISkillSyncStatus & { credentialPresent?: boolean },
  { includeCredentialMetadata = true }: { includeCredentialMetadata?: boolean } = {},
): TGitHubSkillSyncSourceStatus {
  const includePrivateSourceMetadata = includeCredentialMetadata;
  return {
    provider: status.provider,
    sourceId: status.sourceId,
    tenantId: status.tenantId,
    status: status.status,
    credentialKey: includeCredentialMetadata ? status.credentialKey : undefined,
    credentialPresent: includeCredentialMetadata ? (status.credentialPresent ?? false) : false,
    owner: includePrivateSourceMetadata ? status.owner : undefined,
    repo: includePrivateSourceMetadata ? status.repo : undefined,
    ref: includePrivateSourceMetadata ? status.ref : undefined,
    paths: includePrivateSourceMetadata ? status.paths : undefined,
    startedAt: toIso(status.startedAt),
    finishedAt: toIso(status.finishedAt),
    lastSuccessAt: toIso(status.lastSuccessAt),
    lastFailureAt: toIso(status.lastFailureAt),
    errorCode: status.errorCode,
    errorMessage: serializeErrorMessage(status, { includeCredentialMetadata }),
    syncedSkillCount: status.syncedSkillCount,
    syncedFileCount: status.syncedFileCount,
    deletedSkillCount: status.deletedSkillCount,
    deletedFileCount: status.deletedFileCount,
    skippedSkillCount: status.skippedSkillCount ?? 0,
    /* The per-skill entries name repository paths, so they follow the same
       visibility rule as owner/repo/paths rather than the bare count. */
    skippedSkills: includePrivateSourceMetadata ? status.skippedSkills : undefined,
    skippedFileCount: status.skippedFileCount ?? 0,
    /* Same rule: `path`/`skillPath` name repository paths, unlike the count. */
    skippedFiles: includePrivateSourceMetadata ? status.skippedFiles : undefined,
    createdAt: toIso(status.createdAt),
    updatedAt: toIso(status.updatedAt),
  };
}

function getRequestTenantId(req: AdminSkillsRequest): string | undefined {
  const tenantId = req.user?.tenantId;
  return typeof tenantId === 'string' && tenantId ? tenantId : undefined;
}

function getVisibleSourceStatuses<T extends ISkillSyncStatus>(
  req: AdminSkillsRequest,
  sources: T[],
): T[] {
  if (req.skillSyncCanReadCredentials !== false) {
    return sources;
  }
  const tenantId = getRequestTenantId(req);
  if (!tenantId) {
    return [];
  }
  return sources.filter((source) => !source.tenantId || source.tenantId === tenantId);
}

function isCredentialKey(value: unknown): value is string {
  return typeof value === 'string' && CREDENTIAL_KEY_PATTERN.test(value);
}

function getUserObjectId(req: AdminSkillsRequest): Types.ObjectId | undefined {
  return req.user?._id;
}

function getCapabilityUser(
  req: AdminSkillSyncAccessRequest,
  { platformOnly = false }: { platformOnly?: boolean } = {},
): SkillSyncCapabilityUser | null {
  const id = req.user?.id ?? req.user?._id?.toString?.();
  if (!id) {
    return null;
  }
  return {
    id,
    role: req.user?.role ?? '',
    ...(platformOnly ? {} : { tenantId: req.user?.tenantId }),
  };
}

function parseSkillSyncConfig(raw: unknown): SkillSyncConfig | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const parsed = skillSyncConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function isSameSkillSyncConfig(left: SkillSyncConfig, right: SkillSyncConfig): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function hasResolvedSkillSyncOverride(req: AdminSkillSyncAccessRequest): boolean {
  const resolved = parseSkillSyncConfig(req.config?.skillSync);
  const base = parseSkillSyncConfig(req.config?.config?.skillSync);
  return Boolean(resolved?.github && !isSameSkillSyncConfig(resolved, base));
}

function sendInternalServerError(res: Response): void {
  res.status(500).json({ message: 'Internal Server Error' });
}

export function createAdminSkillsSyncAccess(deps: AdminSkillSyncAccessDeps): AdminSkillsSyncAccess {
  async function hasSkillCapability(
    req: AdminSkillSyncAccessRequest,
    capability: SystemCapability,
    { platformOnly = false }: { platformOnly?: boolean } = {},
  ): Promise<boolean> {
    const user = getCapabilityUser(req, { platformOnly });
    if (!user) {
      return false;
    }
    return deps.hasCapability(user, capability);
  }

  function requireSkillCapability(
    capability: SystemCapability,
    { platformOnly = false }: { platformOnly?: boolean } = {},
  ): RequestHandler {
    return async (
      req: AdminSkillSyncAccessRequest,
      res: Response,
      next: NextFunction,
    ): Promise<void> => {
      try {
        const user = getCapabilityUser(req, { platformOnly });
        if (!user) {
          res.status(401).json({ message: 'Authentication required' });
          return;
        }
        if (await deps.hasCapability(user, capability)) {
          next();
          return;
        }
        res.status(403).json({ message: 'Forbidden' });
      } catch {
        sendInternalServerError(res);
      }
    };
  }

  const attachBaseSkillSyncConfig: RequestHandler = async (
    req: AdminSkillSyncAccessRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const baseConfig = await deps.getAppConfig({ baseOnly: true });
      const existingConfig = req.config ?? {};
      req.config = {
        ...existingConfig,
        config: {
          ...(existingConfig.config ?? {}),
          skillSync: baseConfig?.skillSync,
        },
      };
      next();
    } catch {
      sendInternalServerError(res);
    }
  };

  const attachCredentialReadAccess: RequestHandler = async (
    req: AdminSkillSyncAccessRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const canReadCredentials = await hasSkillCapability(req, SystemCapabilities.READ_SKILLS, {
        platformOnly: true,
      });
      req.skillSyncCanReadCredentials = canReadCredentials;
      req.skillSyncAllowServerCredentials = canReadCredentials;
      next();
    } catch {
      sendInternalServerError(res);
    }
  };

  const requireSyncRunCapability: RequestHandler = async (
    req: AdminSkillSyncAccessRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const canManagePlatform = await hasSkillCapability(req, SystemCapabilities.MANAGE_SKILLS, {
        platformOnly: true,
      });
      if (canManagePlatform) {
        req.skillSyncAllowServerCredentials = true;
        req.skillSyncCanReadCredentials = true;
        next();
        return;
      }
      if (
        hasResolvedSkillSyncOverride(req) &&
        (await hasSkillCapability(req, SystemCapabilities.MANAGE_SKILLS))
      ) {
        res.status(403).json({
          message: 'Tenant-scoped manual skill sync requires platform credential access',
        });
        return;
      }
      res.status(403).json({ message: 'Forbidden' });
    } catch {
      sendInternalServerError(res);
    }
  };

  return {
    attachBaseSkillSyncConfig,
    attachCredentialReadAccess,
    requireReadSkills: requireSkillCapability(SystemCapabilities.READ_SKILLS),
    requirePlatformManageSkills: requireSkillCapability(SystemCapabilities.MANAGE_SKILLS, {
      platformOnly: true,
    }),
    requireSyncRunCapability,
  };
}

export function createAdminSkillsSyncHandlers(deps: AdminSkillSyncDeps): AdminSkillsSyncHandlers {
  function getRunner(req: Request): GitHubSkillSyncRunner {
    const runner = deps.getRunner?.(req) ?? deps.runner;
    if (!runner) {
      throw new Error('GitHub skill sync runner is not configured');
    }
    return runner;
  }

  async function getSyncStatus(req: AdminSkillsRequest, res: Response) {
    const includeCredentialMetadata = req.skillSyncCanReadCredentials !== false;
    const status = await getRunner(req).getStatus();
    const response: TGitHubSkillSyncStatusResponse = {
      enabled: status.enabled,
      intervalMinutes: status.intervalMinutes,
      runOnStartup: status.runOnStartup,
      sources: getVisibleSourceStatuses(req, status.sources).map((source) =>
        serializeSourceStatus(source, { includeCredentialMetadata }),
      ),
      credentials: includeCredentialMetadata ? status.credentials.map(serializeCredential) : [],
      fineGrainedTokenRecommendation: status.fineGrainedTokenRecommendation,
    };
    return res.status(200).json(response);
  }

  async function runSync(req: AdminSkillsRequest, res: Response) {
    const includeCredentialMetadata = req.skillSyncCanReadCredentials === true;
    const result = await getRunner(req).runOnce();
    const response: TGitHubSkillSyncManualRunResponse = {
      status: result.status,
      message: result.message,
      sources: result.sources.map((source) =>
        serializeSourceStatus(source, { includeCredentialMetadata }),
      ),
    };
    return res.status(result.status === 'skipped' ? 202 : 200).json(response);
  }

  async function setCredential(req: AdminSkillsRequest, res: Response) {
    const { credentialKey } = req.params;
    if (!isCredentialKey(credentialKey)) {
      return res.status(400).json({ error: 'Invalid credential key' });
    }
    const token = (req.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string' || token.trim().length === 0) {
      return res.status(400).json({ error: 'GitHub token is required' });
    }
    const credential = await deps.upsertCredential({
      provider: 'github',
      credentialKey,
      token: token.trim(),
      userId: getUserObjectId(req),
    });
    return res.status(200).json(serializeCredential(credential));
  }

  async function deleteCredential(req: Request, res: Response) {
    const { credentialKey } = req.params;
    if (!isCredentialKey(credentialKey)) {
      return res.status(400).json({ error: 'Invalid credential key' });
    }
    const result = await deps.deleteCredential('github', credentialKey);
    return res.status(200).json({ credentialKey, deleted: result.deleted });
  }

  return {
    getSyncStatus,
    runSync,
    setCredential,
    deleteCredential,
  };
}
