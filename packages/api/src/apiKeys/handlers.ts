import { logger } from '@librechat/data-schemas';
import { ResourceType, PermissionBits } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import type { GetAppConfigOptions } from '~/app/service';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { resolveRemoteIntegrations } from './grants';

export interface ApiKeyHandlerDependencies {
  createAgentApiKey: (params: {
    userId: string | Types.ObjectId;
    name: string;
    expiresAt?: Date | null;
  }) => Promise<{
    id: string;
    name: string;
    key: string;
    keyPrefix: string;
    createdAt: Date;
    expiresAt?: Date;
  }>;
  listAgentApiKeys: (userId: string | Types.ObjectId) => Promise<
    Array<{
      id: string;
      name: string;
      keyPrefix: string;
      lastUsedAt?: Date;
      expiresAt?: Date;
      createdAt: Date;
      bound?: boolean;
    }>
  >;
  deleteAgentApiKey: (
    keyId: string | Types.ObjectId,
    userId: string | Types.ObjectId,
  ) => Promise<boolean>;
  getAgentApiKeyById: (
    keyId: string | Types.ObjectId,
    userId: string | Types.ObjectId,
  ) => Promise<{
    id: string;
    name: string;
    keyPrefix: string;
    lastUsedAt?: Date;
    expiresAt?: Date;
    createdAt: Date;
  } | null>;
  /**
   * Read to tell the client whether key runs are limited to what the owner granted, so it
   * offers the dialog. Left out, the list never says so.
   */
  getAppConfig?: (options: GetAppConfigOptions) => Promise<AppConfig | undefined>;
  /** Ids of the resources of one type the caller holds a permission on. Passed on unread. */
  findAccessibleResources?: (params: {
    userId: string;
    role?: string;
    resourceType: ResourceType;
    requiredPermissions: number;
  }) => Promise<unknown[]>;
  /** The names of the agents with those ids. */
  getAgentModelSummaries?: (ids: unknown[]) => Promise<Array<{ id: string; name?: string | null }>>;
}

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    _id: Types.ObjectId;
    role?: string;
  };
}

export function createApiKeyHandlers(deps: ApiKeyHandlerDependencies): {
  createApiKey: (req: AuthenticatedRequest, res: Response) => Promise<Response | undefined>;
  listApiKeys: (req: AuthenticatedRequest, res: Response) => Promise<void>;
  listAgents: (req: AuthenticatedRequest, res: Response) => Promise<void>;
  getApiKey: (req: AuthenticatedRequest, res: Response) => Promise<Response | undefined>;
  deleteApiKey: (req: AuthenticatedRequest, res: Response) => Promise<Response | undefined>;
} {
  async function createApiKey(
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<Response | undefined> {
    try {
      const { name, expiresAt } = req.body;

      if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({
          error: 'API key name is required',
        });
      }

      const result = await deps.createAgentApiKey({
        userId: req.user?.id || '',
        name: name.trim(),
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      });

      res.status(201).json({
        id: result.id,
        name: result.name,
        key: result.key,
        keyPrefix: result.keyPrefix,
        createdAt: result.createdAt,
        expiresAt: result.expiresAt,
      });
    } catch (error) {
      logger.error('[createApiKey] Error creating API key:', error);
      res.status(500).json({ error: 'Failed to create API key' });
    }
  }

  /** Whether this owner's key runs are limited to their grants. */
  async function usesGrants(req: AuthenticatedRequest): Promise<boolean> {
    if (!deps.getAppConfig) return false;
    const appConfig = await deps.getAppConfig(getAppConfigOptionsFromUser(req.user));
    return resolveRemoteIntegrations(appConfig).mode === 'delegated';
  }

  async function listApiKeys(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const [keys, grants] = await Promise.all([
        deps.listAgentApiKeys(req.user?.id || ''),
        usesGrants(req),
      ]);
      res.status(200).json({ keys, ...(grants && { grants: true }) });
    } catch (error) {
      logger.error('[listApiKeys] Error listing API keys:', error);
      res.status(500).json({ error: 'Failed to list API keys' });
    }
  }

  /**
   * The agents a run started with one of the caller's keys can name: those shared with them
   * for remote use, and those they may share themselves. The rule `checkRemoteAgentAccess`
   * applies to one agent, asked for all of them, so a key can be granted for any agent it
   * can run and for no other.
   */
  async function listAgents(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.id || !deps.findAccessibleResources || !deps.getAgentModelSummaries) {
        res.status(200).json({ agents: [] });
        return;
      }
      const find = (resourceType: ResourceType, requiredPermissions: number) =>
        deps.findAccessibleResources!({
          userId: user.id,
          role: user.role,
          resourceType,
          requiredPermissions,
        });
      const [remote, owned] = await Promise.all([
        find(ResourceType.REMOTE_AGENT, PermissionBits.VIEW),
        find(ResourceType.AGENT, PermissionBits.SHARE),
      ]);
      const ids = [...new Map([...remote, ...owned].map((id) => [String(id), id])).values()];
      const agents = ids.length > 0 ? await deps.getAgentModelSummaries(ids) : [];
      res.status(200).json({
        agents: agents
          .map((agent) => ({ id: agent.id, name: agent.name ?? null }))
          .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id)),
      });
    } catch (error) {
      logger.error('[listAgents] Error listing agents for API keys:', error);
      res.status(500).json({ error: 'Failed to list agents' });
    }
  }

  async function getApiKey(
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<Response | undefined> {
    try {
      const key = await deps.getAgentApiKeyById(req.params.id, req.user?.id || '');

      if (!key) {
        return res.status(404).json({ error: 'API key not found' });
      }

      res.status(200).json(key);
    } catch (error) {
      logger.error('[getApiKey] Error getting API key:', error);
      res.status(500).json({ error: 'Failed to get API key' });
    }
  }

  async function deleteApiKey(
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<Response | undefined> {
    try {
      const deleted = await deps.deleteAgentApiKey(req.params.id, req.user?.id || '');

      if (!deleted) {
        return res.status(404).json({ error: 'API key not found' });
      }

      res.status(204).send();
    } catch (error) {
      logger.error('[deleteApiKey] Error deleting API key:', error);
      res.status(500).json({ error: 'Failed to delete API key' });
    }
  }

  return {
    createApiKey,
    listApiKeys,
    listAgents,
    getApiKey,
    deleteApiKey,
  };
}
