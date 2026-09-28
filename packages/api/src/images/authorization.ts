import { createHash } from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { PermissionBits, PrincipalType, ResourceType } from 'librechat-data-provider';
import {
  ResourceCapabilityMap,
  SystemCapabilities,
  logger,
  runAsSystem,
  tenantStorage,
} from '@librechat/data-schemas';
import type { IAgent, IAssistant, AssistantQuery, SystemCapability } from '@librechat/data-schemas';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { FilterQuery, ProjectionType, Types } from 'mongoose';

const MAX_URL_LENGTH = 2048;
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;
const AGENT_AVATAR_PATTERN = /^agent-(.+)-avatar-\d+\.[^/]+$/;

type Principal = {
  principalType: PrincipalType;
  principalId?: string | Types.ObjectId;
};

type ImageUser = {
  role?: string | null;
  tenantId?: string;
  idOnTheSource?: string | null;
  avatar?: string | null;
};

type AssistantConfig = {
  endpoint: string;
  privateAssistants?: boolean;
  supportedIds?: string[];
  excludedIds?: string[];
};

type ImagePath = {
  ownerId: string;
  filename: string;
  canonicalPath: string;
  agentId?: string;
};

type AssistantImageRecord = Pick<IAssistant, '_id' | 'assistant_id'> & {
  endpoint?: string;
};

type ResolvedImageConfig = {
  secureImageLinks: boolean;
  assistantEndpoints: AssistantConfig[];
};

type CookieAuthResult =
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'authenticated'; userId: string };

type OpenIdCookieAuthResult =
  | { status: 'invalid' }
  | { status: 'legacy'; userId: string }
  | { status: 'authenticated'; userId: string };

export interface ImageAuthorizationDeps {
  parseCookies: (cookieHeader: string) => Record<string, string | undefined>;
  isOpenIdReuseEnabled: () => boolean;
  getBasePath: () => string;
  findSession: (query: { userId: string; refreshToken: string }) => Promise<unknown | null>;
  getUserById: (userId: string, select: string) => Promise<ImageUser | null>;
  getAgent: (
    query: FilterQuery<IAgent>,
    projection?: ProjectionType<IAgent>,
  ) => Promise<Pick<IAgent, '_id'> | null>;
  getAssistant: (
    query: AssistantQuery,
    projection?: ProjectionType<IAssistant>,
  ) => Promise<AssistantImageRecord | null>;
  getImageConfig?: (params: { userId: string; user: ImageUser }) => Promise<{
    secureImageLinks?: boolean;
    assistantEndpoints?: AssistantConfig[];
  }>;
  getUserPrincipals: (params: {
    userId: string;
    role?: string | null;
    idOnTheSource?: string | null;
  }) => Promise<Principal[]>;
  hasCapabilityForPrincipals: (params: {
    principals: Principal[];
    capability: SystemCapability;
    tenantId?: string;
  }) => Promise<boolean>;
  hasPermission: (
    principals: Principal[],
    resourceType: ResourceType,
    resourceId: string | Types.ObjectId,
    permissionBit: number,
  ) => Promise<boolean>;
}

export interface ImageAuthorizationOptions {
  secureImageLinks?: boolean;
  assistantEndpoints?: AssistantConfig[];
}

type ImageRequest = Request & {
  session?: Request['session'] & {
    openidTokens?: { refreshToken?: string };
  };
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseImagePath(originalUrl: string, basePath: string): ImagePath | null {
  if (!originalUrl || originalUrl.length > MAX_URL_LENGTH || originalUrl.includes('\0')) {
    return null;
  }

  let decodedUrl: string;
  try {
    decodedUrl = decodeURIComponent(originalUrl);
  } catch {
    return null;
  }

  if (decodedUrl.includes('\0')) {
    return null;
  }

  const cleanPath = decodedUrl.split(/[?#]/, 1)[0];
  let decodedBasePath: string;
  try {
    decodedBasePath = decodeURIComponent(basePath);
  } catch {
    return null;
  }
  const imagesPath = `${decodedBasePath}/images`;
  const imagesPrefix = `${imagesPath}/`;
  const normalizedPath = cleanPath.startsWith(imagesPrefix)
    ? `${imagesPrefix}${cleanPath.slice(imagesPrefix.length).replace(/^\/+/, '')}`
    : cleanPath;
  const match = normalizedPath.match(
    new RegExp(`^${escapeRegExp(imagesPath)}/([a-f0-9]{24})/([^/]+)$`, 'i'),
  );
  if (!match) {
    return null;
  }

  const [, ownerId, filename] = match;
  if (filename === '.' || filename === '..' || filename.includes('\\')) {
    return null;
  }
  return {
    ownerId,
    filename,
    canonicalPath: `/images/${ownerId}/${filename}`,
    agentId: filename.match(AGENT_AVATAR_PATTERN)?.[1],
  };
}

function getSignedUserId(token: string | undefined): string | null {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!token || !secret) {
    return null;
  }
  try {
    const payload = jwt.verify(token, secret) as JwtPayload;
    return typeof payload.id === 'string' && OBJECT_ID_PATTERN.test(payload.id) ? payload.id : null;
  } catch (error) {
    logger.warn('[imageAuthorization] Invalid signed user token', error);
    return null;
  }
}

function getSignedOpenIdUserId(
  token: string | undefined,
  refreshToken: string,
): OpenIdCookieAuthResult {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!token || !secret) {
    return { status: 'invalid' };
  }
  try {
    const payload = jwt.verify(token, secret) as JwtPayload;
    if (typeof payload.id !== 'string' || !OBJECT_ID_PATTERN.test(payload.id)) {
      return { status: 'invalid' };
    }
    if (typeof payload.refreshTokenHash !== 'string') {
      return { status: 'legacy', userId: payload.id };
    }
    const refreshTokenHash = createHash('sha256').update(refreshToken).digest('base64url');
    return payload.refreshTokenHash === refreshTokenHash
      ? { status: 'authenticated', userId: payload.id }
      : { status: 'invalid' };
  } catch (error) {
    logger.warn('[imageAuthorization] Invalid signed OpenID user token', error);
    return { status: 'invalid' };
  }
}

function getStoredPathCandidates(canonicalPath: string): string[] {
  return [canonicalPath, `${canonicalPath}?manual=false`, `${canonicalPath}?manual=true`];
}

async function authenticateRequest(
  req: ImageRequest,
  deps: ImageAuthorizationDeps,
): Promise<CookieAuthResult> {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) {
    return { status: 'missing' };
  }

  let parsed: Record<string, string | undefined>;
  try {
    parsed = deps.parseCookies(cookieHeader);
  } catch {
    return { status: 'invalid' };
  }

  const refreshToken = parsed.refreshToken;
  if (!refreshToken) {
    return { status: 'missing' };
  }

  if (parsed.token_provider === 'openid' && deps.isOpenIdReuseEnabled()) {
    const openIdAuth = getSignedOpenIdUserId(parsed.openid_user_id, refreshToken);
    if (openIdAuth.status === 'invalid') {
      return { status: 'invalid' };
    }
    if (openIdAuth.status === 'legacy') {
      return refreshToken === req.session?.openidTokens?.refreshToken
        ? { status: 'authenticated', userId: openIdAuth.userId }
        : { status: 'invalid' };
    }
    const session = await runAsSystem(() =>
      deps.findSession({ userId: openIdAuth.userId, refreshToken }),
    );
    return session ? openIdAuth : { status: 'invalid' };
  }

  const userId = getSignedUserId(refreshToken);
  if (!userId) {
    return { status: 'invalid' };
  }
  const session = await runAsSystem(() => deps.findSession({ userId, refreshToken }));
  return session ? { status: 'authenticated', userId } : { status: 'invalid' };
}

function isSharedAssistant(assistant: AssistantImageRecord, configs: AssistantConfig[]): boolean {
  let matchingConfigs: AssistantConfig[] = [];
  if (assistant.endpoint) {
    matchingConfigs = configs.filter((config) => config.endpoint === assistant.endpoint);
  } else if (configs.length === 1) {
    matchingConfigs = configs;
  }

  return matchingConfigs.some((config) => {
    if (config.privateAssistants) {
      return false;
    }
    if (config.supportedIds?.length) {
      return config.supportedIds.includes(assistant.assistant_id);
    }
    if (config.excludedIds?.length) {
      return !config.excludedIds.includes(assistant.assistant_id);
    }
    return true;
  });
}

async function loadPrincipals(
  userId: string,
  user: ImageUser,
  deps: ImageAuthorizationDeps,
): Promise<Principal[]> {
  return deps.getUserPrincipals({
    userId,
    role: user.role,
    idOnTheSource: user.idOnTheSource ?? null,
  });
}

async function canViewAgentAvatar(
  imagePath: ImagePath,
  viewerId: string | undefined,
  owner: ImageUser,
  deps: ImageAuthorizationDeps,
): Promise<boolean> {
  const agent = await deps.getAgent(
    {
      id: imagePath.agentId,
      'avatar.filepath': { $in: getStoredPathCandidates(imagePath.canonicalPath) },
    },
    { _id: 1 },
  );
  if (!agent) {
    return false;
  }

  const publicPrincipal: Principal[] = [{ principalType: PrincipalType.PUBLIC }];
  if (!viewerId) {
    return deps.hasPermission(publicPrincipal, ResourceType.AGENT, agent._id, PermissionBits.VIEW);
  }

  const viewer = await runAsSystem(() => deps.getUserById(viewerId, 'role tenantId idOnTheSource'));
  if (!viewer || viewer.tenantId !== owner.tenantId) {
    return deps.hasPermission(publicPrincipal, ResourceType.AGENT, agent._id, PermissionBits.VIEW);
  }

  const principals = await loadPrincipals(viewerId, viewer, deps);
  let managesAgents = false;
  try {
    managesAgents = await deps.hasCapabilityForPrincipals({
      principals,
      capability: ResourceCapabilityMap[ResourceType.AGENT],
      tenantId: owner.tenantId,
    });
  } catch (error) {
    logger.warn('[imageAuthorization] Agent capability check failed', error);
  }
  return (
    managesAgents ||
    (await deps.hasPermission(principals, ResourceType.AGENT, agent._id, PermissionBits.VIEW))
  );
}

async function canViewAssistantAvatar(
  imagePath: ImagePath,
  viewerId: string | undefined,
  owner: ImageUser,
  configs: AssistantConfig[],
  deps: ImageAuthorizationDeps,
): Promise<boolean> {
  const assistant = await deps.getAssistant(
    { avatarFilepath: getStoredPathCandidates(imagePath.canonicalPath) },
    { _id: 1, assistant_id: 1, endpoint: 1 },
  );
  if (!assistant) {
    return false;
  }
  if (!viewerId) {
    return false;
  }

  const viewer = await runAsSystem(() => deps.getUserById(viewerId, 'role tenantId idOnTheSource'));
  if (!viewer || viewer.tenantId !== owner.tenantId) {
    return false;
  }
  if (isSharedAssistant(assistant, configs)) {
    return true;
  }
  const principals = await loadPrincipals(viewerId, viewer, deps);
  try {
    return await deps.hasCapabilityForPrincipals({
      principals,
      capability: SystemCapabilities.MANAGE_ASSISTANTS,
      tenantId: owner.tenantId,
    });
  } catch (error) {
    logger.warn('[imageAuthorization] Assistant capability check failed', error);
    return false;
  }
}

async function resolveImageConfig(
  ownerId: string,
  owner: ImageUser,
  options: ImageAuthorizationOptions,
  deps: ImageAuthorizationDeps,
): Promise<ResolvedImageConfig> {
  if (!deps.getImageConfig) {
    return {
      secureImageLinks: options.secureImageLinks !== false,
      assistantEndpoints: options.assistantEndpoints ?? [],
    };
  }
  try {
    const config = await deps.getImageConfig({ userId: ownerId, user: owner });
    return {
      secureImageLinks: config.secureImageLinks !== false,
      assistantEndpoints: config.assistantEndpoints ?? [],
    };
  } catch (error) {
    logger.warn('[imageAuthorization] Image config resolution failed', error);
    return { secureImageLinks: true, assistantEndpoints: [] };
  }
}

function isStoredUserAvatar(
  imagePath: ImagePath,
  owner: ImageUser,
  deps: ImageAuthorizationDeps,
): boolean {
  if (typeof owner.avatar !== 'string') {
    return false;
  }
  const storedAvatar =
    parseImagePath(owner.avatar, deps.getBasePath()) ?? parseImagePath(owner.avatar, '');
  return storedAvatar?.canonicalPath === imagePath.canonicalPath;
}

async function canViewUserAvatar(
  viewerId: string | undefined,
  owner: ImageUser,
  deps: ImageAuthorizationDeps,
): Promise<boolean> {
  if (!viewerId) {
    return false;
  }
  const viewer = await runAsSystem(() => deps.getUserById(viewerId, 'tenantId'));
  return viewer != null && viewer.tenantId === owner.tenantId;
}

function denyRequest(res: Response, auth: CookieAuthResult): void {
  if (auth.status === 'missing') {
    res.status(401).send('Unauthorized');
    return;
  }
  res.status(403).send('Access Denied');
}

export function createImageAuthorizationMiddleware(
  options: ImageAuthorizationOptions,
  deps: ImageAuthorizationDeps,
): RequestHandler {
  if (!deps.getImageConfig && options.secureImageLinks === false) {
    return (_req: Request, _res: Response, next: NextFunction): void => next();
  }

  return async function authorizeImageRequest(
    req: ImageRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const imagePath = parseImagePath(req.originalUrl, deps.getBasePath());
      if (!imagePath) {
        if (options.secureImageLinks === false) {
          next();
          return;
        }
        const auth = await authenticateRequest(req, deps);
        denyRequest(res, auth);
        return;
      }

      const owner = await runAsSystem(() =>
        deps.getUserById(imagePath.ownerId, 'role tenantId idOnTheSource avatar'),
      );
      if (!owner) {
        if (options.secureImageLinks === false) {
          next();
          return;
        }
        const auth = await authenticateRequest(req, deps);
        denyRequest(res, auth);
        return;
      }

      const authPromise = authenticateRequest(req, deps);
      void authPromise.catch(() => undefined);
      const loadImageConfig = (): Promise<ResolvedImageConfig> =>
        resolveImageConfig(imagePath.ownerId, owner, options, deps);
      const imageConfig = owner.tenantId
        ? await tenantStorage.run(
            { tenantId: owner.tenantId, userId: imagePath.ownerId },
            loadImageConfig,
          )
        : await runAsSystem(loadImageConfig);
      if (!imageConfig.secureImageLinks) {
        next();
        return;
      }

      res.locals.privateImageCache = true;
      const auth = await authPromise;
      const viewerId = auth.status === 'authenticated' ? auth.userId : undefined;
      if (viewerId === imagePath.ownerId) {
        next();
        return;
      }

      const authorizeSpecialAvatar = async (): Promise<boolean> => {
        if (imagePath.agentId) {
          return canViewAgentAvatar(imagePath, viewerId, owner, deps);
        }
        if (isStoredUserAvatar(imagePath, owner, deps)) {
          return canViewUserAvatar(viewerId, owner, deps);
        }
        if (imageConfig.assistantEndpoints.length > 0) {
          const canViewAssistant = await canViewAssistantAvatar(
            imagePath,
            viewerId,
            owner,
            imageConfig.assistantEndpoints,
            deps,
          );
          if (canViewAssistant) {
            return true;
          }
        }
        return false;
      };
      const allowed = owner.tenantId
        ? await tenantStorage.run(
            { tenantId: owner.tenantId, userId: viewerId ?? imagePath.ownerId },
            authorizeSpecialAvatar,
          )
        : await runAsSystem(authorizeSpecialAvatar);
      if (allowed) {
        next();
        return;
      }

      denyRequest(res, auth);
    } catch (error) {
      logger.error('[imageAuthorization] Error authorizing image request', error);
      res.status(500).send('Internal Server Error');
    }
  };
}
