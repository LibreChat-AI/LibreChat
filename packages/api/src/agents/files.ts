import { randomUUID } from 'node:crypto';
import { logger, ResourceCapabilityMap } from '@librechat/data-schemas';
import {
  EToolResources,
  PermissionBits,
  Permissions,
  PermissionTypes,
  ResourceType,
} from 'librechat-data-provider';
import type { IRole, IUser, SystemCapability } from '@librechat/data-schemas';
import type { NextFunction, Request, Response } from 'express';
import type { Types } from 'mongoose';
import type { AgentManagementProjectionSource } from './management';
import { checkAccessWithRequestCache } from '../middleware/access';
import { mapAgentManagementError } from './management';

type AgentUploadPurpose =
  | EToolResources.context
  | EToolResources.file_search
  | EToolResources.execute_code;

type AgentFilePurpose = AgentUploadPurpose | EToolResources.image_edit | EToolResources.ocr;

const UPLOAD_PURPOSES: readonly AgentUploadPurpose[] = [
  EToolResources.context,
  EToolResources.file_search,
  EToolResources.execute_code,
] as const;

const FILE_PURPOSES: readonly AgentFilePurpose[] = [
  ...UPLOAD_PURPOSES,
  EToolResources.image_edit,
  EToolResources.ocr,
] as const;

type AgentManagementFileRecord = {
  file_id: string;
  filename: string;
  bytes: number;
  type: string;
  createdAt?: Date;
};
type AgentManagementFile = {
  id: string;
  object: 'agent.file';
  filename: string;
  bytes: number;
  mime_type: string;
  purposes: AgentFilePurpose[];
  created_at: string | null;
};
type AgentManagementUploadBody = {
  file_id?: string;
  filename?: string;
  bytes?: number;
  type?: string;
  createdAt?: string | Date;
};
type AgentManagementFileAgent = AgentManagementProjectionSource & {
  _id: Types.ObjectId;
  provider?: string;
  tool_resources?: Partial<Record<AgentFilePurpose, { file_ids?: string[] }>>;
};
type AgentUploadConfig = {
  endpoint: string;
  endpointType?: string;
  disabled?: boolean;
  fileSizeLimit?: number;
  fileLimit?: number;
  totalSizeLimit?: number;
};
type AgentUploadLockRedisClient = {
  set: (
    key: string,
    value: string,
    expiryMode: 'PX',
    ttlMs: number,
    condition: 'NX',
  ) => Promise<unknown>;
  eval: (
    script: string,
    numberOfKeys: number,
    key: string,
    ...args: Array<string | number>
  ) => Promise<unknown>;
};

const AGENT_UPLOAD_LOCK_TTL_MS = 10 * 60 * 1000;
const AGENT_UPLOAD_LOCK_WAIT_MS = 2 * 60 * 1000;
const AGENT_UPLOAD_LOCK_RENEW_MS = Math.floor(AGENT_UPLOAD_LOCK_TTL_MS / 3);
const releaseUploadLockScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
const renewUploadLockScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

export interface AgentManagementFileDeps {
  getRoleByName: (roleName: string, fieldsToSelect?: string | string[]) => Promise<IRole | null>;
  getAgentWithVersionCount: (search: {
    id: string;
    tenantId: string;
  }) => Promise<AgentManagementFileAgent | null>;
  getFiles: (
    filter: { file_id: { $in: string[] }; tenantId: string },
    sort?: null,
    projection?: Record<string, 0 | 1>,
  ) => Promise<AgentManagementFileRecord[] | null>;
  checkPermission: (params: {
    userId: string;
    role?: string;
    resourceType: ResourceType;
    resourceId: Types.ObjectId;
    requiredPermission: PermissionBits;
  }) => Promise<boolean>;
  hasCapability: (user: IUser, capability: SystemCapability) => Promise<boolean>;
  removeAgentResourceFiles: (params: {
    agent_id: string;
    files: Array<{ tool_resource: AgentFilePurpose; file_id: string }>;
  }) => Promise<AgentManagementFileAgent>;
  processUpload: (req: Request, res: Response) => Promise<Response | void>;
  deleteTempFile: (path: string) => Promise<void>;
  getUploadConfig: (req: Request, agent: AgentManagementFileAgent) => Promise<AgentUploadConfig>;
  isUploadPurposeEnabled: (req: Request, purpose: AgentUploadPurpose) => Promise<boolean>;
  runUploadExclusive: <T>(key: string, task: () => Promise<T>) => Promise<T>;
}

/** Serialize an Agent purpose's aggregate-limit check and upload across API replicas. */
export function createAgentUploadLock({
  redisClient,
}: {
  redisClient: AgentUploadLockRedisClient | null;
}): AgentManagementFileDeps['runUploadExclusive'] {
  return async function withAgentUploadLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    if (!redisClient) {
      return await task();
    }
    const lockKey = `agent-management:file-upload:${key}`;
    const token = randomUUID();
    const deadline = Date.now() + AGENT_UPLOAD_LOCK_WAIT_MS;
    while ((await redisClient.set(lockKey, token, 'PX', AGENT_UPLOAD_LOCK_TTL_MS, 'NX')) !== 'OK') {
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for Agent file upload lock');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    let stopped = false;
    let renewalTimer: ReturnType<typeof setTimeout>;
    const renewLease = async () => {
      try {
        const renewed = await redisClient.eval(
          renewUploadLockScript,
          1,
          lockKey,
          token,
          AGENT_UPLOAD_LOCK_TTL_MS,
        );
        if (renewed !== 1) {
          logger.warn('[AgentManagement] Lost Agent file upload lock before processing completed');
        }
      } catch (error) {
        logger.warn('[AgentManagement] Failed to renew Agent file upload lock', error);
      } finally {
        if (!stopped) {
          renewalTimer = setTimeout(renewLease, AGENT_UPLOAD_LOCK_RENEW_MS);
          renewalTimer.unref?.();
        }
      }
    };
    renewalTimer = setTimeout(renewLease, AGENT_UPLOAD_LOCK_RENEW_MS);
    renewalTimer.unref?.();

    try {
      return await task();
    } finally {
      stopped = true;
      clearTimeout(renewalTimer);
      try {
        await redisClient.eval(releaseUploadLockScript, 1, lockKey, token);
      } catch (error) {
        logger.warn('[AgentManagement] Failed to release Agent file upload lock', error);
      }
    }
  };
}

function sendError(res: Response, code: Parameters<typeof mapAgentManagementError>[0]) {
  const mapped = mapAgentManagementError(code);
  return res.status(mapped.status).json(mapped.body);
}

function sendFileNotFound(res: Response) {
  return res.status(404).json({ error: { code: 'not_found', message: 'File not found' } });
}

function getUploadErrorCode(status: number): Parameters<typeof mapAgentManagementError>[0] {
  if (status === 403) {
    return 'permission_denied';
  }
  if (status === 404) {
    return 'not_found';
  }
  if (status >= 400 && status < 500) {
    return 'invalid_request';
  }
  return 'internal_error';
}

function getUploadCreatedAt(value: string | Date | undefined): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return value;
  }
  return null;
}

/** Restrict the shared browser uploader's response to the management file contract. */
export function createAgentManagementUploadResponse(
  res: Response,
  file: Express.Multer.File,
  purpose: AgentUploadPurpose,
): Response {
  let status = 200;
  const response = Object.create(res) as Response;
  response.status = (code: number) => {
    status = code;
    return response;
  };
  response.json = (body: AgentManagementUploadBody) => {
    if (status < 200 || status >= 300) {
      return sendError(res, getUploadErrorCode(status));
    }
    if (typeof body.file_id !== 'string' || body.file_id.length === 0) {
      return sendError(res, 'internal_error');
    }
    return res.status(status).json({
      id: body.file_id,
      object: 'agent.file',
      filename: body.filename ?? file.originalname,
      bytes: body.bytes ?? file.size,
      mime_type: body.type ?? file.mimetype,
      purposes: [purpose],
      created_at: getUploadCreatedAt(body.createdAt),
    });
  };
  return response;
}

async function canUseAgents(
  req: Request,
  user: IUser,
  permissions: Permissions[],
  deps: AgentManagementFileDeps,
) {
  return await checkAccessWithRequestCache({
    req,
    user,
    permissionType: PermissionTypes.AGENTS,
    permissions,
    getRoleByName: deps.getRoleByName,
  });
}

async function hasManageAgentsCapability(user: IUser, deps: AgentManagementFileDeps) {
  const capability = ResourceCapabilityMap[ResourceType.AGENT];
  try {
    return capability != null && (await deps.hasCapability(user, capability));
  } catch (error) {
    logger.warn(
      `[AgentManagement] Agent capability check failed, denying file access bypass: ${(error as Error).message}`,
    );
    return false;
  }
}

async function canEditAgentFiles(
  user: IUser,
  agent: AgentManagementFileAgent,
  deps: AgentManagementFileDeps,
) {
  if (await hasManageAgentsCapability(user, deps)) {
    return true;
  }
  return await deps.checkPermission({
    userId: user.id,
    role: user.role,
    resourceType: ResourceType.AGENT,
    resourceId: agent._id,
    requiredPermission: PermissionBits.EDIT,
  });
}

function getFilePurposes(agent: AgentManagementFileAgent): Map<string, AgentFilePurpose[]> {
  const purposes = new Map<string, AgentFilePurpose[]>();
  for (const purpose of FILE_PURPOSES) {
    for (const fileId of agent.tool_resources?.[purpose]?.file_ids ?? []) {
      purposes.set(fileId, [...(purposes.get(fileId) ?? []), purpose]);
    }
  }
  return purposes;
}

/** Machine-authenticated Agent file listing and unlink handlers. */
export function createAgentManagementFileHandlers(deps: AgentManagementFileDeps): {
  authorizeUpload: (req: Request, res: Response, next: NextFunction) => Promise<Response | void>;
  getUploadConfig: (
    req: Request,
  ) => Pick<AgentUploadConfig, 'endpoint' | 'endpointType'> | undefined;
  upload: (req: Request, res: Response) => Promise<Response>;
  list: (req: Request, res: Response) => Promise<Response>;
  remove: (req: Request, res: Response) => Promise<Response>;
} {
  const authorizedUploads = new WeakMap<
    Request,
    {
      agent: AgentManagementFileAgent;
      tenantId: string;
      uploadConfig: AgentUploadConfig;
    }
  >();
  const uploadQueues = new Map<string, Promise<void>>();

  async function getAuthorizedAgent(req: Request, permissions: Permissions[]) {
    const user = req.user as IUser | undefined;
    if (!user?.id || !user.tenantId) {
      return { allowed: false as const, code: 'permission_denied' as const };
    }

    if (!(await canUseAgents(req, user, permissions, deps))) {
      return { allowed: false as const, code: 'permission_denied' as const };
    }

    const agent = await deps.getAgentWithVersionCount({
      id: req.params.id,
      tenantId: user.tenantId,
    });
    if (!agent) {
      return { allowed: false as const, code: 'not_found' as const };
    }
    if (!(await canEditAgentFiles(user, agent, deps))) {
      return { allowed: false as const, code: 'permission_denied' as const };
    }
    return { allowed: true as const, agent, user, tenantId: user.tenantId };
  }

  async function authorizeUpload(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<Response | void> {
    try {
      const authorized = await getAuthorizedAgent(req, [Permissions.USE, Permissions.CREATE]);
      if (!authorized.allowed) {
        return sendError(res, authorized.code);
      }
      const uploadConfig = await deps.getUploadConfig(req, authorized.agent);
      if (uploadConfig.disabled === true) {
        return sendError(res, 'invalid_request');
      }
      authorizedUploads.set(req, {
        agent: authorized.agent,
        tenantId: authorized.tenantId,
        uploadConfig,
      });
      next();
    } catch (error) {
      logger.error('[AgentManagement] Error authorizing Agent file upload', error);
      return sendError(res, 'internal_error');
    }
  }

  function getAuthorizedUploadConfig(req: Request) {
    const config = authorizedUploads.get(req)?.uploadConfig;
    if (!config) {
      return undefined;
    }
    return { endpoint: config.endpoint, endpointType: config.endpointType };
  }

  async function withUploadQueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = uploadQueues.get(key) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    uploadQueues.set(key, queued);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (uploadQueues.get(key) === queued) {
        uploadQueues.delete(key);
      }
    }
  }

  async function isWithinAggregateLimits(
    req: Request,
    purpose: AgentUploadPurpose,
    tenantId: string,
    config: AgentUploadConfig,
  ): Promise<boolean> {
    const currentAgent = await deps.getAgentWithVersionCount({
      id: req.params.id,
      tenantId,
    });
    if (!currentAgent) {
      return false;
    }
    const fileIds = [...new Set(currentAgent.tool_resources?.[purpose]?.file_ids ?? [])];
    if (!config.fileLimit && !config.totalSizeLimit) {
      return true;
    }
    const files =
      fileIds.length === 0
        ? []
        : ((await deps.getFiles({ file_id: { $in: fileIds }, tenantId }, null, { text: 0 })) ?? []);
    const persistedFileCount = new Set(files.map((file) => file.file_id)).size;
    if (config.fileLimit && persistedFileCount + 1 > config.fileLimit) {
      return false;
    }
    if (!config.totalSizeLimit) {
      return true;
    }
    const currentBytes = files.reduce((total, file) => total + file.bytes, 0);
    return currentBytes + (req.file?.size ?? 0) <= config.totalSizeLimit;
  }

  async function isValidUpload(
    req: Request,
    purpose: AgentUploadPurpose,
    config: AgentUploadConfig,
  ): Promise<boolean> {
    if (req.file?.size === 0) {
      return false;
    }
    if (config.fileSizeLimit && (req.file?.size ?? 0) > config.fileSizeLimit) {
      return false;
    }
    if (purpose === EToolResources.file_search && req.file?.mimetype?.startsWith('image')) {
      return false;
    }
    return await deps.isUploadPurposeEnabled(req, purpose);
  }

  async function cleanupRejectedUpload(req: Request): Promise<boolean> {
    if (!req.file?.path) {
      return true;
    }
    try {
      await deps.deleteTempFile(req.file.path);
      return true;
    } catch (error) {
      logger.error('[AgentManagement] Error cleaning up rejected Agent file upload', error);
      return false;
    }
  }

  async function upload(req: Request & { file_id?: string }, res: Response): Promise<Response> {
    try {
      const purpose = req.body?.purpose as string | undefined;
      if (!req.file || !UPLOAD_PURPOSES.includes(purpose as AgentUploadPurpose)) {
        const cleaned = await cleanupRejectedUpload(req);
        return sendError(res, cleaned ? 'invalid_request' : 'internal_error');
      }

      const authorized = authorizedUploads.get(req);
      if (!authorized) {
        const cleaned = await cleanupRejectedUpload(req);
        return sendError(res, cleaned ? 'permission_denied' : 'internal_error');
      }

      const queueKey = `${authorized.tenantId}:${req.params.id}:${purpose}`;
      return await deps.runUploadExclusive(queueKey, async () =>
        withUploadQueue(queueKey, async () => {
          if (!(await isValidUpload(req, purpose as AgentUploadPurpose, authorized.uploadConfig))) {
            const cleaned = await cleanupRejectedUpload(req);
            return sendError(res, cleaned ? 'invalid_request' : 'internal_error');
          }
          if (
            !(await isWithinAggregateLimits(
              req,
              purpose as AgentUploadPurpose,
              authorized.tenantId,
              authorized.uploadConfig,
            ))
          ) {
            const cleaned = await cleanupRejectedUpload(req);
            return sendError(res, cleaned ? 'invalid_request' : 'internal_error');
          }

          req.body = {
            file_id: req.file_id,
            endpoint: authorized.uploadConfig.endpoint,
            endpointType: authorized.uploadConfig.endpointType,
            agent_id: req.params.id,
            tool_resource: purpose,
          };
          req.headers.accept = 'application/json';
          await deps.processUpload(req, res);
          return res;
        }),
      );
    } catch (error) {
      logger.error('[AgentManagement] Error preparing Agent file upload', error);
      await cleanupRejectedUpload(req);
      return sendError(res, 'internal_error');
    }
  }

  async function list(req: Request, res: Response): Promise<Response> {
    try {
      const authorized = await getAuthorizedAgent(req, [Permissions.USE]);
      if (!authorized.allowed) {
        return sendError(res, authorized.code);
      }

      const purposes = getFilePurposes(authorized.agent);
      const fileIds = [...purposes.keys()];
      const records =
        fileIds.length === 0
          ? []
          : ((await deps.getFiles(
              { file_id: { $in: fileIds }, tenantId: authorized.tenantId },
              null,
              { text: 0 },
            )) ?? []);
      const data: AgentManagementFile[] = records.map((file) => ({
        id: file.file_id,
        object: 'agent.file',
        filename: file.filename,
        bytes: file.bytes,
        mime_type: file.type,
        purposes: purposes.get(file.file_id) ?? [],
        created_at: file.createdAt?.toISOString() ?? null,
      }));

      return res.status(200).json({ object: 'list', data });
    } catch (error) {
      logger.error('[AgentManagement] Error listing Agent files', error);
      return sendError(res, 'internal_error');
    }
  }

  async function remove(req: Request, res: Response): Promise<Response> {
    try {
      const fileId = req.params.fileId;
      if (!fileId) {
        return sendError(res, 'invalid_request');
      }
      const authorized = await getAuthorizedAgent(req, [Permissions.USE, Permissions.CREATE]);
      if (!authorized.allowed) {
        return sendError(res, authorized.code);
      }

      const purposes = getFilePurposes(authorized.agent).get(fileId) ?? [];
      if (purposes.length === 0) {
        return sendFileNotFound(res);
      }
      await deps.removeAgentResourceFiles({
        agent_id: req.params.id,
        files: purposes.map((purpose) => ({
          tool_resource: purpose,
          file_id: fileId,
        })),
      });

      return res.status(200).json({ id: fileId, deleted: true });
    } catch (error) {
      logger.error('[AgentManagement] Error unlinking Agent file', error);
      return sendError(res, 'internal_error');
    }
  }

  return {
    authorizeUpload,
    getUploadConfig: getAuthorizedUploadConfig,
    upload,
    list,
    remove,
  };
}
