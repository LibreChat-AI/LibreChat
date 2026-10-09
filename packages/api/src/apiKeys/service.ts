import { createMethods } from '@librechat/data-schemas';
import { ResourceType, PermissionBits, hasPermissions } from 'librechat-data-provider';
import type {
  AgentApiKeyListItem,
  AgentApiKeyCreateResult,
  AllMethods,
  IUser,
} from '@librechat/data-schemas';
import type { Types } from 'mongoose';

export interface ApiKeyServiceDependencies {
  validateAgentApiKey: AllMethods['validateAgentApiKey'];
  createAgentApiKey: AllMethods['createAgentApiKey'];
  listAgentApiKeys: AllMethods['listAgentApiKeys'];
  deleteAgentApiKey: AllMethods['deleteAgentApiKey'];
  getAgentApiKeyById: AllMethods['getAgentApiKeyById'];
  findUser: (query: { _id: string | Types.ObjectId }) => Promise<IUser | null>;
}

export interface RemoteAgentAccessResult {
  hasAccess: boolean;
  permissions: number;
  agent: { _id: Types.ObjectId; [key: string]: unknown } | null;
}

export class AgentApiKeyService {
  private deps: ApiKeyServiceDependencies;

  constructor(deps: ApiKeyServiceDependencies) {
    this.deps = deps;
  }

  async validateApiKey(apiKey: string): Promise<{
    userId: Types.ObjectId;
    keyId: Types.ObjectId;
  } | null> {
    return this.deps.validateAgentApiKey(apiKey);
  }

  async createApiKey(params: {
    userId: string | Types.ObjectId;
    name: string;
    expiresAt?: Date | null;
  }): Promise<AgentApiKeyCreateResult> {
    return this.deps.createAgentApiKey(params);
  }

  async listApiKeys(userId: string | Types.ObjectId): Promise<AgentApiKeyListItem[]> {
    return this.deps.listAgentApiKeys(userId);
  }

  async deleteApiKey(
    keyId: string | Types.ObjectId,
    userId: string | Types.ObjectId,
  ): Promise<boolean> {
    return this.deps.deleteAgentApiKey(keyId, userId);
  }

  async getApiKeyById(
    keyId: string | Types.ObjectId,
    userId: string | Types.ObjectId,
  ): Promise<AgentApiKeyListItem | null> {
    return this.deps.getAgentApiKeyById(keyId, userId);
  }

  async getUserFromApiKey(apiKey: string): Promise<IUser | null> {
    const keyValidation = await this.validateApiKey(apiKey);
    if (!keyValidation) {
      return null;
    }

    return this.deps.findUser({ _id: keyValidation.userId });
  }
}

export function createApiKeyServiceDependencies(
  mongoose: typeof import('mongoose'),
): ApiKeyServiceDependencies {
  const methods = createMethods(mongoose);
  return {
    validateAgentApiKey: methods.validateAgentApiKey,
    createAgentApiKey: methods.createAgentApiKey,
    listAgentApiKeys: methods.listAgentApiKeys,
    deleteAgentApiKey: methods.deleteAgentApiKey,
    getAgentApiKeyById: methods.getAgentApiKeyById,
    findUser: methods.findUser,
  };
}

export interface GetRemoteAgentPermissionsDeps {
  getEffectivePermissions: (params: {
    userId: string;
    role?: string;
    resourceType: ResourceType;
    resourceId: string | Types.ObjectId;
  }) => Promise<number>;
}

/** AGENT owners automatically have full REMOTE_AGENT permissions */
export async function getRemoteAgentPermissions(
  deps: GetRemoteAgentPermissionsDeps,
  userId: string,
  role: string | undefined,
  resourceId: string | Types.ObjectId,
): Promise<number> {
  const agentPerms = await deps.getEffectivePermissions({
    userId,
    role,
    resourceType: ResourceType.AGENT,
    resourceId,
  });

  if (hasPermissions(agentPerms, PermissionBits.SHARE)) {
    return PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE;
  }

  return deps.getEffectivePermissions({
    userId,
    role,
    resourceType: ResourceType.REMOTE_AGENT,
    resourceId,
  });
}

export async function checkRemoteAgentAccess(params: {
  userId: string;
  role?: string;
  agentId: string;
  getAgent: (query: {
    id: string;
  }) => Promise<{ _id: Types.ObjectId; [key: string]: unknown } | null>;
  getEffectivePermissions: (params: {
    userId: string;
    role?: string;
    resourceType: ResourceType;
    resourceId: string | Types.ObjectId;
  }) => Promise<number>;
}): Promise<RemoteAgentAccessResult> {
  const { userId, role, agentId, getAgent, getEffectivePermissions } = params;

  const agent = await getAgent({ id: agentId });

  if (!agent) {
    return { hasAccess: false, permissions: 0, agent: null };
  }

  const permissions = await getRemoteAgentPermissions(
    { getEffectivePermissions },
    userId,
    role,
    agent._id,
  );

  const hasAccess = hasPermissions(permissions, PermissionBits.VIEW);

  return { hasAccess, permissions, agent };
}
