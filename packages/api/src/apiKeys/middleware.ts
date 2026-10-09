import { logger } from '@librechat/data-schemas';
import {
  ResourceType,
  PermissionBits,
  hasPermissions,
  TWO_FACTOR_ENROLLMENT_REQUIRED_CODE,
} from 'librechat-data-provider';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { IUser } from '@librechat/data-schemas';
import type { Types } from 'mongoose';
import { isTwoFactorEnrollmentRequired } from '~/auth/twoFactor';
import { getRemoteAgentPermissions } from './service';

export interface ApiKeyAuthDependencies {
  validateAgentApiKey: (apiKey: string) => Promise<{
    userId: Types.ObjectId;
    keyId: Types.ObjectId;
  } | null>;
  findUser: (query: { _id: string | Types.ObjectId }) => Promise<IUser | null>;
  isPrincipalActive: (userId: string) => Promise<boolean>;
  enrollmentRequired?: typeof isTwoFactorEnrollmentRequired;
}

export interface RemoteAgentAccessDependencies {
  getAgent: (query: {
    id: string;
  }) => Promise<{ _id: Types.ObjectId; [key: string]: unknown } | null>;
  getEffectivePermissions: (params: {
    userId: string;
    role?: string;
    resourceType: ResourceType;
    resourceId: string | Types.ObjectId;
  }) => Promise<number>;
}

export interface ApiKeyAuthRequest extends Request {
  user?: IUser & { id: string };
  apiKeyId?: Types.ObjectId;
}

export interface RemoteAgentAccessRequest extends ApiKeyAuthRequest {
  agent?: { _id: Types.ObjectId; [key: string]: unknown };
  agentPermissions?: number;
}

type AgentIdResolver = (req: RemoteAgentAccessRequest) => string | undefined;

export function createRequireApiKeyAuth(deps: ApiKeyAuthDependencies) {
  return async (
    req: ApiKeyAuthRequest,
    res: Response,
    next: NextFunction,
  ): Promise<Response | undefined> => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: {
          message: 'Missing or invalid Authorization header. Expected: Bearer <api_key>',
          type: 'invalid_request_error',
          code: 'missing_api_key',
        },
      });
    }

    const apiKey = authHeader.slice(7);

    if (!apiKey || apiKey.trim() === '') {
      return res.status(401).json({
        error: {
          message: 'API key is required',
          type: 'invalid_request_error',
          code: 'missing_api_key',
        },
      });
    }

    try {
      const keyValidation = await deps.validateAgentApiKey(apiKey);

      if (!keyValidation) {
        return res.status(401).json({
          error: {
            message: 'Invalid API key',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        });
      }

      const userId = keyValidation.userId.toString();
      const [user, principalActive] = await Promise.all([
        deps.findUser({ _id: keyValidation.userId }),
        deps.isPrincipalActive(userId),
      ]);

      if (!user) {
        return res.status(401).json({
          error: {
            message: 'User not found for this API key',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        });
      }

      user.id = (user._id as Types.ObjectId).toString();
      if (!principalActive) {
        return res.status(409).json({
          error: {
            message: 'Account deletion is in progress',
            type: 'invalid_request_error',
            code: 'account_deletion_in_progress',
          },
        });
      }
      /** A key outlives the enforcement switch, so it waits on enrollment like the owner's session. */
      if ((deps.enrollmentRequired ?? isTwoFactorEnrollmentRequired)(user)) {
        return res.status(403).json({
          error: {
            message: 'Two-factor authentication must be enabled for this account',
            type: 'permission_error',
            code: TWO_FACTOR_ENROLLMENT_REQUIRED_CODE,
          },
        });
      }
      req.user = user as IUser & { id: string };
      req.apiKeyId = keyValidation.keyId;

      next();
    } catch (error) {
      logger.error('[requireApiKeyAuth] Error validating API key:', error);
      return res.status(500).json({
        error: {
          message: 'Internal server error during authentication',
          type: 'server_error',
          code: 'internal_error',
        },
      });
    }
  };
}

function createAgentAccessMiddleware(
  deps: RemoteAgentAccessDependencies,
  resolveAgentId: AgentIdResolver,
): RequestHandler {
  return async (baseReq, res, next): Promise<void> => {
    const req = baseReq as RemoteAgentAccessRequest;
    const agentId = resolveAgentId(req);

    if (typeof agentId !== 'string' || agentId.trim() === '') {
      res.status(400).json({
        error: {
          message: 'Model (agent ID) is required',
          type: 'invalid_request_error',
          code: 'missing_model',
        },
      });
      return;
    }

    try {
      const agent = await deps.getAgent({ id: agentId });

      if (!agent) {
        res.status(404).json({
          error: {
            message: `Agent not found: ${agentId}`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        });
        return;
      }

      const userId = req.user?.id || '';

      const permissions = await getRemoteAgentPermissions(deps, userId, req.user?.role, agent._id);

      if (!hasPermissions(permissions, PermissionBits.VIEW)) {
        res.status(403).json({
          error: {
            message: `No remote access to agent: ${agentId}`,
            type: 'permission_error',
            code: 'access_denied',
          },
        });
        return;
      }

      req.agent = agent;
      req.agentPermissions = permissions;

      next();
    } catch (error) {
      logger.error('[checkRemoteAgentAccess] Error checking agent access:', error);
      res.status(500).json({
        error: {
          message: 'Internal server error while checking agent access',
          type: 'server_error',
          code: 'internal_error',
        },
      });
    }
  };
}

export function createCheckRemoteAgentAccess(deps: RemoteAgentAccessDependencies): RequestHandler {
  return createAgentAccessMiddleware(deps, (req) => req.body?.model || req.params?.model);
}

export function createCheckAgentTriggerAccess(deps: RemoteAgentAccessDependencies): RequestHandler {
  return createAgentAccessMiddleware(deps, (req) => req.body?.target?.agentId);
}
