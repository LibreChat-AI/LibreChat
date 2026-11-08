import { logger, ResourceCapabilityMap } from '@librechat/data-schemas';
import {
  PermissionBits,
  Permissions,
  PermissionTypes,
  ResourceType,
} from 'librechat-data-provider';
import type { IAgent, IRole, IUser, SystemCapability } from '@librechat/data-schemas';
import type { AgentToolResources } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import type { AgentManagementProjectionSource } from './management';
import type { FileDeletionOutcome } from '../files/deletion';
import { agentManagementDeleteResponseSchema, mapAgentManagementError } from './management';
import { checkAccessWithRequestCache } from '../middleware/access';
import { deleteAgentAttachedFiles } from '../files/deletion';
import { collectToolResourceFileIds } from './orphans';
import { getSafeErrorText } from '~/utils/errors';

type AgentManagementRecord = AgentManagementProjectionSource & {
  _id: Types.ObjectId;
  tool_resources?: AgentToolResources;
  avatar?: { filepath?: string; source?: string } | string | null;
};

export type AgentAvatarRef = {
  filepath: string;
  source: string;
};

export type CascadeDeleteAgentResourcesDeps<TFile extends { file_id: string }> = {
  getFiles: (fileIds: string[]) => Promise<TFile[] | null | undefined>;
  getSharedResourceFileIds: (params: {
    file_ids: string[];
    excludeAgentObjectId: string;
  }) => Promise<string[]>;
  deleteFiles: (files: TFile[]) => Promise<FileDeletionOutcome>;
  /** Optional avatar storage + metadata cleanup; failures are logged, not thrown. */
  deleteAvatar?: (avatar: AgentAvatarRef) => Promise<void>;
};

export type CascadeDeleteAgentResourcesInput = {
  agentObjectId: string;
  tool_resources?: AgentToolResources | null;
  avatar?: { filepath?: string; source?: string } | string | null;
};

/**
 * Best-effort cleanup of sole-referenced tool-resource files and the agent avatar
 * before the agent document is removed. Shared files (held by another agent) and
 * cleanup failures are logged and never block agent deletion.
 */
export async function cascadeDeleteAgentResources<TFile extends { file_id: string }>(
  agent: CascadeDeleteAgentResourcesInput,
  deps: CascadeDeleteAgentResourcesDeps<TFile>,
): Promise<void> {
  const fileIds = collectToolResourceFileIds(agent.tool_resources);
  if (fileIds.length > 0) {
    try {
      const files = (await deps.getFiles(fileIds)) ?? [];
      const result = await deleteAgentAttachedFiles(
        {
          agentObjectId: agent.agentObjectId,
          fileIds,
          files,
        },
        {
          getSharedResourceFileIds: deps.getSharedResourceFileIds,
          deleteFiles: deps.deleteFiles,
        },
      );
      if ((result.outcome?.failedFileIds?.length ?? 0) > 0) {
        logger.warn('[cascadeDeleteAgentResources] Some agent files could not be deleted', {
          agentObjectId: agent.agentObjectId,
          failedFileIds: result.outcome?.failedFileIds,
        });
      }
    } catch (error) {
      logger.error(
        `[cascadeDeleteAgentResources] Error deleting agent tool-resource files: ${getSafeErrorText(error)}`,
      );
    }
  }

  const avatar =
    agent.avatar != null && typeof agent.avatar === 'object' ? agent.avatar : undefined;
  if (
    deps.deleteAvatar != null &&
    typeof avatar?.filepath === 'string' &&
    avatar.filepath.length > 0 &&
    typeof avatar.source === 'string' &&
    avatar.source.length > 0
  ) {
    try {
      await deps.deleteAvatar({ filepath: avatar.filepath, source: avatar.source });
    } catch (error) {
      logger.error(
        `[cascadeDeleteAgentResources] Error deleting agent avatar: ${getSafeErrorText(error)}`,
      );
    }
  }
}

export interface AgentManagementDeleteDeps<
  TFile extends { file_id: string } = { file_id: string },
> {
  getRoleByName: (roleName: string, fieldsToSelect?: string | string[]) => Promise<IRole | null>;
  getAgentWithVersionCount: (search: {
    id: string;
    tenantId: string;
  }) => Promise<AgentManagementRecord | null>;
  checkPermission: (params: {
    userId: string;
    role?: string;
    resourceType: ResourceType;
    resourceId: Types.ObjectId;
    requiredPermission: PermissionBits;
  }) => Promise<boolean>;
  hasCapability: (user: IUser, capability: SystemCapability) => Promise<boolean>;
  deleteAgent: (search: { id: string; tenantId: string }) => Promise<IAgent | null>;
  getFiles: (fileIds: string[]) => Promise<TFile[] | null | undefined>;
  getSharedResourceFileIds: (params: {
    file_ids: string[];
    excludeAgentObjectId: string;
  }) => Promise<string[]>;
  deleteFiles: (req: Request, files: TFile[]) => Promise<FileDeletionOutcome>;
  deleteAvatar?: (req: Request, avatar: AgentAvatarRef) => Promise<void>;
}

function sendError(res: Response, code: Parameters<typeof mapAgentManagementError>[0]) {
  const mapped = mapAgentManagementError(code);
  return res.status(mapped.status).json(mapped.body);
}

async function hasManageAgentsCapability<TFile extends { file_id: string }>(
  user: IUser,
  deps: AgentManagementDeleteDeps<TFile>,
) {
  const capability = ResourceCapabilityMap[ResourceType.AGENT];
  try {
    return capability != null && (await deps.hasCapability(user, capability));
  } catch (error) {
    logger.warn(
      `[AgentManagement] Agent capability check failed, denying bypass: ${(error as Error).message}`,
    );
    return false;
  }
}

/** Authorize a tenant-scoped deletion, then reuse the Agent model's existing cleanup path. */
export function createAgentManagementDeleteHandler<TFile extends { file_id: string }>(
  deps: AgentManagementDeleteDeps<TFile>,
): (req: Request, res: Response) => Promise<Response> {
  return async function deleteAgent(req: Request, res: Response): Promise<Response> {
    try {
      const user = req.user as IUser | undefined;
      if (!user?.id || !user.tenantId) {
        return sendError(res, 'permission_denied');
      }

      const canDelete = await checkAccessWithRequestCache({
        req,
        user,
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE, Permissions.CREATE],
        getRoleByName: deps.getRoleByName,
      });
      if (!canDelete) {
        return sendError(res, 'permission_denied');
      }

      const agent = await deps.getAgentWithVersionCount({
        id: req.params.id,
        tenantId: user.tenantId,
      });
      if (!agent) {
        return sendError(res, 'not_found');
      }

      const canManageAll = await hasManageAgentsCapability(user, deps);
      if (
        !canManageAll &&
        !(await deps.checkPermission({
          userId: user.id,
          role: user.role,
          resourceType: ResourceType.AGENT,
          resourceId: agent._id,
          requiredPermission: PermissionBits.DELETE,
        }))
      ) {
        return sendError(res, 'permission_denied');
      }

      const deleteAvatar = deps.deleteAvatar;
      await cascadeDeleteAgentResources(
        {
          agentObjectId: agent._id.toString(),
          tool_resources: agent.tool_resources,
          avatar: agent.avatar,
        },
        {
          getFiles: deps.getFiles,
          getSharedResourceFileIds: deps.getSharedResourceFileIds,
          deleteFiles: (files) => deps.deleteFiles(req, files),
          deleteAvatar: deleteAvatar != null ? (avatar) => deleteAvatar(req, avatar) : undefined,
        },
      );

      const deleted = await deps.deleteAgent({ id: req.params.id, tenantId: user.tenantId });
      if (!deleted) {
        return sendError(res, 'not_found');
      }

      return res.status(200).json(
        agentManagementDeleteResponseSchema.parse({
          id: req.params.id,
          deleted: true,
        }),
      );
    } catch (error) {
      logger.error('[AgentManagement] Error deleting Agent', error);
      return sendError(res, 'internal_error');
    }
  };
}
