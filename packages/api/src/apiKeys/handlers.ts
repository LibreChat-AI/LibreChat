import { logger } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { Types } from 'mongoose';

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
}

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    _id: Types.ObjectId;
  };
}

export function createApiKeyHandlers(deps: ApiKeyHandlerDependencies): {
  createApiKey: (req: AuthenticatedRequest, res: Response) => Promise<Response | undefined>;
  listApiKeys: (req: AuthenticatedRequest, res: Response) => Promise<void>;
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

  async function listApiKeys(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const keys = await deps.listAgentApiKeys(req.user?.id || '');
      res.status(200).json({ keys });
    } catch (error) {
      logger.error('[listApiKeys] Error listing API keys:', error);
      res.status(500).json({ error: 'Failed to list API keys' });
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
    getApiKey,
    deleteApiKey,
  };
}
