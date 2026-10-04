import type { NextFunction, Request, Response } from 'express';
import { removePorts } from '../utils/ports';
import { isEnabled } from '../utils/common';

type BanData = { expiresAt?: unknown };
type BanRequest = Request & {
  user?: { id?: unknown; _id?: unknown };
  banned?: boolean;
  _isAgentTrigger?: boolean;
};
type BanStore = {
  get(key: string): Promise<BanData | undefined>;
  set(key: string, value: BanData, ttl: number): Promise<unknown>;
};

export interface BanCheckDependencies {
  getEnvironment(): { BAN_VIOLATIONS?: string; USE_REDIS?: string };
  banCache: BanStore;
  getBanLogs(): Pick<BanStore, 'get'> & {
    opts: { ttl: number };
    delete(key: string): Promise<unknown>;
  };
  findUser(filter: { email: string }, projection: string): Promise<{ _id?: unknown } | null>;
  banResponse(req: Request, res: Response): Promise<unknown>;
  logger: {
    warn(message: string, error: unknown): void;
    error(message: string, error: unknown): void;
  };
}

/** Only the router-verified trigger identity exempts the shared delivery transport from IP bans. */
export function getBanIp(
  req: Pick<Request, 'ip'> & { _isAgentTrigger?: boolean },
): string | undefined {
  return req._isAgentTrigger === true ? undefined : req.ip;
}

/** Ban lookups use a normalized address without mutating Express's read-only request.ip. */
export function createBanCheck(deps: BanCheckDependencies) {
  return async (
    req: BanRequest,
    res: Response,
    next: NextFunction = () => {},
  ): Promise<unknown> => {
    try {
      const environment = deps.getEnvironment();
      if (!isEnabled(environment.BAN_VIOLATIONS)) {
        return next();
      }
      const ip = getBanIp({ ip: removePorts(req), _isAgentTrigger: req._isAgentTrigger });
      const rawId = req.user?.id ?? req.user?._id;
      let userId = rawId == null ? undefined : String(rawId);
      if (!userId && req.body?.email) {
        const user = await deps.findUser({ email: req.body.email }, '_id');
        userId = user?._id == null ? undefined : String(user._id);
      }
      if (!userId && !ip) {
        return next();
      }
      const cacheKey = (prefix: string, value?: string) => {
        if (!value) return '';
        return isEnabled(environment.USE_REDIS) ? `ban_cache:${prefix}:${value}` : value;
      };
      const ipKey = cacheKey('ip', ip);
      const userKey = cacheKey('user', userId);
      const [cachedIPBan, cachedUserBan] = await Promise.all([
        ipKey ? deps.banCache.get(ipKey) : undefined,
        userKey ? deps.banCache.get(userKey) : undefined,
      ]);
      if (cachedIPBan || cachedUserBan) {
        req.banned = true;
        return await deps.banResponse(req, res);
      }

      const banLogs = deps.getBanLogs();
      if (banLogs.opts.ttl <= 0) {
        return next();
      }
      const [ipBan, userBan] = await Promise.all([
        ip ? banLogs.get(ip) : undefined,
        userId ? banLogs.get(userId) : undefined,
      ]);
      const banData = ipBan || userBan;
      if (!banData) {
        return next();
      }
      const expiresAt = Number(banData.expiresAt);
      if (!banData.expiresAt || Number.isNaN(expiresAt)) {
        req.banned = true;
        return await deps.banResponse(req, res);
      }
      const timeLeft = expiresAt - Date.now();
      if (timeLeft <= 0) {
        await Promise.all([
          ipBan && ip ? banLogs.delete(ip) : undefined,
          userBan && userId ? banLogs.delete(userId) : undefined,
        ]);
        return next();
      }
      await Promise.all([
        ipKey ? deps.banCache.set(ipKey, banData, timeLeft) : undefined,
        userKey ? deps.banCache.set(userKey, banData, timeLeft) : undefined,
      ]).catch((error) => deps.logger.warn('[checkBan] Failed to write ban cache:', error));
      req.banned = true;
      return await deps.banResponse(req, res);
    } catch (error) {
      deps.logger.error('Error in checkBan middleware:', error);
      return next(error);
    }
  };
}
