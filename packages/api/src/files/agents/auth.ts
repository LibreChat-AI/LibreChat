import { logger } from '@librechat/data-schemas';
import {
  SystemRoles,
  ResourceType,
  PermissionBits,
  isMessageFileUpload,
  isEphemeralAgentId,
} from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { Types } from 'mongoose';
import type { ServerRequest } from '~/types';

export type AgentUploadAuthResult =
  | { allowed: true }
  | { allowed: false; status: number; error: string; message: string };

export interface AgentUploadAuthParams {
  userId: string;
  userRole: string;
  agentId?: string;
  toolResource?: string | null;
  messageFile?: boolean | string;
}

export interface AgentUploadAuthDeps {
  getAgent: (params: { id: string }) => Promise<{
    _id: string | Types.ObjectId;
    author?: string | Types.ObjectId | null;
  } | null>;
  checkPermission: (params: {
    userId: string;
    role: string;
    resourceType: ResourceType;
    resourceId: string | Types.ObjectId;
    requiredPermission: number;
  }) => Promise<boolean>;
}

export async function checkAgentUploadAuth(
  params: AgentUploadAuthParams,
  deps: AgentUploadAuthDeps,
): Promise<AgentUploadAuthResult> {
  const { userId, userRole, agentId, messageFile } = params;
  const { getAgent, checkPermission } = deps;

  const isMessageAttachment = isMessageFileUpload(messageFile);
  /* Any permanent upload against an agent can mutate that agent's resources, so it needs
   * edit permission whether or not the request names a tool resource: unified uploads
   * omit it and are promoted to a context resource during processing. A message
   * attachment belongs to the conversation rather than the agent, so it needs only the
   * access a conversation already implies, but it cannot skip the check outright: the
   * upload is validated under the named agent's provider, and those responses describe a
   * record the caller may not be allowed to see. */
  /* An ephemeral id names no stored agent, so there is no record to authorize against and
   * none for the provider resolution to read either. Requiring view access there refuses
   * every attachment in an ephemeral conversation. Saved ids keep the check. */
  if (!agentId || (isMessageAttachment && isEphemeralAgentId(agentId))) {
    return { allowed: true };
  }
  const requiredPermission = isMessageAttachment ? PermissionBits.VIEW : PermissionBits.EDIT;

  /* Privilege can waive an ACL check, but it cannot make a missing agent valid. */
  const agent = await getAgent({ id: agentId });
  if (!agent) {
    return { allowed: false, status: 404, error: 'Not Found', message: 'Agent not found' };
  }

  if (userRole === SystemRoles.ADMIN) {
    return { allowed: true };
  }

  if (agent.author?.toString() === userId) {
    return { allowed: true };
  }

  const hasPermission = await checkPermission({
    userId,
    role: userRole,
    resourceType: ResourceType.AGENT,
    resourceId: agent._id,
    requiredPermission,
  });

  if (hasPermission) {
    return { allowed: true };
  }

  logger.warn(
    `[agentUploadAuth] User ${userId} denied upload to agent ${agentId} (insufficient permissions)`,
  );
  return {
    allowed: false,
    status: 403,
    error: 'Forbidden',
    message: 'Insufficient permissions to upload files to this agent',
  };
}

/** @returns true if denied (response already sent), false if allowed */
export async function verifyAgentUploadPermission({
  req,
  res,
  metadata,
  getAgent,
  checkPermission,
  hasUploadBypass,
}: {
  req: ServerRequest;
  res: Response;
  metadata: { agent_id?: string; tool_resource?: string | null; message_file?: boolean | string };
  getAgent: AgentUploadAuthDeps['getAgent'];
  checkPermission: AgentUploadAuthDeps['checkPermission'];
  /** Global capability that permits agent writes regardless of the per-agent grant. Held
   *  here rather than at each route so the two upload routes cannot answer differently. */
  hasUploadBypass?: () => Promise<boolean>;
}): Promise<boolean> {
  const user = req.user as IUser;
  const result = await checkAgentUploadAuth(
    {
      userId: user.id,
      userRole: user.role ?? '',
      agentId: metadata.agent_id,
      toolResource: metadata.tool_resource,
      messageFile: metadata.message_file,
    },
    { getAgent, checkPermission },
  );

  if (!result.allowed) {
    /* The capability waives the per-agent grant, not the agent's existence. */
    if (result.status !== 404 && hasUploadBypass) {
      try {
        if (await hasUploadBypass()) {
          return false;
        }
      } catch (error) {
        logger.warn('[agentUploadAuth] capability check failed, denying bypass:', error);
      }
    }
    res.status(result.status).json({ error: result.error, message: result.message });
    return true;
  }
  return false;
}
