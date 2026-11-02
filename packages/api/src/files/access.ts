import { logger } from '@librechat/data-schemas';
import { PermissionBits, ResourceType, hasPermissions } from 'librechat-data-provider';

type Stringable = string | { toString(): string };

export interface FileAccessAgent {
  _id?: Stringable;
  id?: string;
  author?: Stringable | null;
}

export interface AgentFileAccessDeps {
  getAgents: (filter: Record<string, unknown>) => Promise<FileAccessAgent[] | null | undefined>;
  getResourcePermissionsMap: (params: {
    userId: string;
    role?: string;
    resourceType: ResourceType;
    resourceIds: Stringable[];
  }) => Promise<Map<string, number>>;
}

export interface AgentFileAccessParams {
  userId: string;
  role?: string;
  fileId: string;
  fileOwner?: Stringable | null;
}

/**
 * Whether a user reaches a file through an agent it is attached to: as the agent's author, or
 * with VIEW on the agent. Every attached agent's permissions come from one batched ACL read
 * rather than a principal lookup and ACL read per agent. Fails closed.
 */
export async function hasAgentBasedFileAccess(
  { userId, role, fileId, fileOwner }: AgentFileAccessParams,
  deps: AgentFileAccessDeps,
): Promise<boolean> {
  try {
    if (!fileOwner?.toString()) {
      return false;
    }

    const agentsWithFile = await deps.getAgents({
      $or: [
        { 'tool_resources.execute_code.file_ids': fileId },
        { 'tool_resources.file_search.file_ids': fileId },
        { 'tool_resources.image_edit.file_ids': fileId },
        { 'tool_resources.context.file_ids': fileId },
        { 'tool_resources.ocr.file_ids': fileId },
      ],
    });
    if (!agentsWithFile || agentsWithFile.length === 0) {
      return false;
    }

    const userIdStr = userId.toString();
    const sharedAgents: Array<{ agent: FileAccessAgent; resourceId: Stringable }> = [];
    for (const agent of agentsWithFile) {
      const agentAuthorId = agent.author?.toString();
      if (!agentAuthorId) {
        continue;
      }
      if (agentAuthorId === userIdStr) {
        logger.debug(`[fileAccess] User is author of agent ${agent.id}`);
        return true;
      }
      const resourceId = agent._id || agent.id;
      if (resourceId) {
        sharedAgents.push({ agent, resourceId });
      }
    }
    if (sharedAgents.length === 0) {
      return false;
    }

    let permissions: Map<string, number>;
    try {
      permissions = await deps.getResourcePermissionsMap({
        userId,
        role,
        resourceType: ResourceType.AGENT,
        resourceIds: sharedAgents.map(({ resourceId }) => resourceId),
      });
    } catch (permissionError) {
      logger.warn(
        '[fileAccess] Permission check failed for attached agents:',
        permissionError instanceof Error ? permissionError.message : String(permissionError),
      );
      return false;
    }

    const viewable = sharedAgents.find(({ resourceId }) =>
      hasPermissions(permissions.get(resourceId.toString()) ?? 0, PermissionBits.VIEW),
    );
    if (viewable) {
      logger.debug(
        `[fileAccess] User ${userId} has VIEW permissions on agent ${viewable.agent.id}`,
      );
      return true;
    }
    return false;
  } catch (error) {
    logger.error('[fileAccess] Error checking agent-based access:', error);
    return false;
  }
}
