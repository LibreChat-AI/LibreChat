import { logger } from '@librechat/data-schemas';
import {
  ResourceType,
  PermissionBits,
  hasPermissions,
  TWO_FACTOR_ENROLLMENT_REQUIRED_CODE,
} from 'librechat-data-provider';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { IUser, AgentApiKeyBinding } from '@librechat/data-schemas';
import type { Types } from 'mongoose';
import type { RemoteModelTarget } from '~/agents/openai/models';
import { isTwoFactorEnrollmentRequired } from '~/auth/twoFactor';
import { stripCallerToggles } from '~/agents/openai/models';
import { getRemoteAgentPermissions } from './service';
import { getSafeErrorMetadata } from '~/utils/errors';
import { getBalanceConfig } from '~/app/config';

export interface ApiKeyAuthDependencies {
  validateAgentApiKey: (apiKey: string) => Promise<{
    userId: Types.ObjectId;
    keyId: Types.ObjectId;
    binding?: AgentApiKeyBinding;
  } | null>;
  validateBoundAgentApiKey?: (apiKey: string) => Promise<{
    userId: string;
    keyId: string;
    binding: AgentApiKeyBinding;
  } | null>;
  findUser: (query: { _id: string | Types.ObjectId }) => Promise<IUser | null>;
  isPrincipalActive: (userId: string) => Promise<boolean>;
  enrollmentRequired?: typeof isTwoFactorEnrollmentRequired;
  /** Required for any bound key. Missing or unknown grant handlers deny access. */
  authorizeBinding?: (input: {
    keyId: string;
    binding: AgentApiKeyBinding;
    user: IUser;
    request: Request;
  }) => Promise<boolean>;
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
  /**
   * When set, a `model` that names no agent is offered to this resolver before
   * the 404 (a model spec or `endpoint/model` the key's owner can use; see
   * `resolveRemoteModel`). Only routes that can run such a target pass it.
   */
  resolveRemoteModel?: (
    req: RemoteAgentAccessRequest,
    model: string,
  ) => Promise<RemoteModelTarget | null>;
}

export interface ApiKeyAuthRequest extends Request {
  user?: IUser & { id: string };
  apiKeyId?: string;
  /** Set for a key issued to an integration. Such a key is not the owner's personal key. */
  apiKeyBound?: boolean;
}

export interface RemoteAgentAccessRequest extends ApiKeyAuthRequest {
  agent?: { _id: Types.ObjectId; [key: string]: unknown };
  agentPermissions?: number;
  /** Set instead of `agent` when `model` resolved to a non-agent model. */
  remoteModel?: RemoteModelTarget;
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
      const keyValidation =
        (await deps.validateAgentApiKey(apiKey)) ??
        (deps.authorizeBinding ? await deps.validateBoundAgentApiKey?.(apiKey) : null);

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
      if (
        keyValidation.binding &&
        !(await deps.authorizeBinding?.({
          keyId: String(keyValidation.keyId),
          binding: keyValidation.binding,
          user,
          request: req,
        }))
      ) {
        return res.status(403).json({
          error: {
            message: 'API key authority is unavailable',
            type: 'permission_error',
            code: 'api_key_authority_changed',
          },
        });
      }
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
      req.apiKeyId = String(keyValidation.keyId);
      if (keyValidation.binding) req.apiKeyBound = true;

      next();
    } catch (error) {
      logger.error('[requireApiKeyAuth] Error validating API key:', getSafeErrorMetadata(error));
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

      /** Model access belongs to personal API keys; OIDC integrations stay agent-only. */
      /** `agent_` ids are saved agents only: they skip the pre-resolution guards
       *  (`onlyForModelNames`), so they must never resolve to a model either. */
      if (!agent && deps.resolveRemoteModel && req.apiKeyId && !isSavedAgentId(agentId)) {
        const remoteModel = await deps.resolveRemoteModel(req, agentId);
        if (remoteModel) {
          req.remoteModel = remoteModel;
          stripCallerToggles(req.body);
          next();
          return;
        }
      }

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

/**
 * Runs `handler` only for requests whose `model` resolved to a remote model
 * (`req.remoteModel`); agent requests pass straight through, unchanged.
 */
export function onlyForRemoteModel(handler: RequestHandler): RequestHandler {
  return (req, res, next) =>
    (req as RemoteAgentAccessRequest).remoteModel ? handler(req, res, next) : next();
}

/**
 * Background Responses re-authorize a stored saved agent when they run, resume or
 * are reviewed, and a remote model has none to check, so a model request asks for
 * an immediate response instead. Agent requests pass through unchanged.
 */
export const rejectBackgroundForRemoteModel: RequestHandler = (req, res, next) => {
  const background = (req.body as { background?: unknown } | undefined)?.background;
  if ((req as RemoteAgentAccessRequest).remoteModel && background === true) {
    res.status(400).json({
      error: {
        type: 'invalid_request',
        message: 'Background responses accept agents only. Send this model without "background".',
        code: 'background_requires_agent',
        param: 'background',
      },
    });
    return;
  }
  next();
};

export interface RemoteModelBalanceGateDeps {
  findBalanceByUser: (userId: string) => Promise<{ tokenCredits?: number | null } | null>;
}

/**
 * With balances enabled, refuses a remote model run before inference when the
 * owner has no credits left (a missing record counts its configured start
 * balance), as the chat does at admission. Cost reservation for remote runs is
 * separate work; this only keeps an exhausted balance from starting new runs.
 */
export function createRemoteModelBalanceGate(deps: RemoteModelBalanceGateDeps): RequestHandler {
  return async (baseReq, res, next): Promise<void> => {
    const req = baseReq as RemoteAgentAccessRequest & {
      config?: Parameters<typeof getBalanceConfig>[0];
    };
    const balanceConfig = getBalanceConfig(req.config);
    if (!balanceConfig?.enabled || !req.user?.id) {
      next();
      return;
    }
    try {
      const balance = await deps.findBalanceByUser(req.user.id);
      const credits = balance ? (balance.tokenCredits ?? 0) : (balanceConfig.startBalance ?? 0);
      if (credits > 0) {
        next();
        return;
      }
      res.status(429).json({
        error: {
          message: 'Your balance is used up. Add credits to keep using models through the API.',
          type: 'insufficient_quota',
          code: 'insufficient_quota',
          param: null,
        },
      });
    } catch (error) {
      next(error);
    }
  };
}

/** Saved agents are minted as `agent_<id>`; any other `model` may name a remote model. */
export function isSavedAgentId(model: unknown): boolean {
  return typeof model === 'string' && model.startsWith('agent_');
}

/**
 * Runs `handler` before model resolution for requests whose `model` is not a saved
 * agent id, so ban checks, rate limits and strict config apply before any catalog
 * work. Agent requests pass straight through, unchanged. Extra checks are all a
 * misclassified id can get.
 */
export function onlyForModelNames(handler: RequestHandler): RequestHandler {
  return (req, res, next) =>
    isSavedAgentId((req.body as { model?: unknown } | undefined)?.model)
      ? next()
      : handler(req, res, next);
}

const PRIVILEGED_ROLES = new Set(['system', 'developer']);

function hasPrivilegedMessage(items: unknown): boolean {
  return (
    Array.isArray(items) &&
    items.some(
      (item) =>
        item != null &&
        typeof item === 'object' &&
        PRIVILEGED_ROLES.has(String((item as { role?: unknown }).role)),
    )
  );
}

/**
 * Under `modelSpecs.enforce`, a chat user cannot supply system instructions next to
 * a spec's own; an API caller cannot either. Applies to spec targets only, on Chat
 * Completions (`messages`) and Responses (`input`).
 */
export const rejectCallerSystemPromptForEnforcedSpec: RequestHandler = (req, res, next) => {
  const remoteModel = (req as RemoteAgentAccessRequest).remoteModel;
  const enforced =
    (req as { config?: { modelSpecs?: { enforce?: boolean } } }).config?.modelSpecs?.enforce ===
    true;
  const body = req.body as { messages?: unknown; input?: unknown } | undefined;
  if (
    remoteModel?.kind === 'model_spec' &&
    enforced &&
    (hasPrivilegedMessage(body?.messages) || hasPrivilegedMessage(body?.input))
  ) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        message: 'This model applies its own instructions. Send user and assistant messages only.',
        code: 'system_prompt_not_allowed',
        param: 'messages',
      },
    });
    return;
  }
  next();
};
