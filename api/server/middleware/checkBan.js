const { Keyv } = require('keyv');
const uap = require('ua-parser-js');
const { logger } = require('@librechat/data-schemas');
const { ErrorTypes, ViolationTypes } = require('librechat-data-provider');
const { isEnabled, keyvMongo, removePorts } = require('@librechat/api');
const { getLogStores } = require('~/cache');
const { isOAuthNavigation, redirectOAuthFailure } = require('./oauthNavigation');
const denyRequest = require('./denyRequest');
const { findUser } = require('~/models');

const banCache = new Keyv({ store: keyvMongo, namespace: ViolationTypes.BAN, ttl: 0 });
const message = 'Your account has been temporarily banned due to violations of our service.';
const AGENT_CHAT_PATH = '/api/agents/chat';
const AGENT_CHAT_POST_CONTROL_ROUTES = new Set(['abort', 'steer']);

/** @returns {string} Cache key for ban lookups, prefixed for Redis or raw for MongoDB */
const getBanCacheKey = (prefix, value, useRedis) => {
  if (!value) {
    return '';
  }
  return useRedis ? `ban_cache:${prefix}:${value}` : value;
};

/** Returns whether this request starts or resumes an interactive agent chat turn. */
const isInteractiveAgentChatRequest = (req) => {
  if (req.method !== 'POST' || req.baseUrl !== '/api/agents' || req.body == null) {
    return false;
  }

  const pathname = req.originalUrl.split('?')[0].replace(/\/$/, '');
  if (pathname === AGENT_CHAT_PATH) {
    return true;
  }
  if (!pathname.startsWith(`${AGENT_CHAT_PATH}/`)) {
    return false;
  }

  const route = pathname.slice(`${AGENT_CHAT_PATH}/`.length);
  return (
    route.length > 0 &&
    !route.includes('/') &&
    !AGENT_CHAT_POST_CONTROL_ROUTES.has(route.toLowerCase())
  );
};

/**
 * Respond to the request if the user is banned.
 *
 * @async
 * @function
 * @param {Object} req - Express Request object.
 * @param {Object} res - Express Response object.
 *
 * @returns {Promise<Object>} - Returns a Promise which sends a JSON 403, unless this is an interactive browser agent chat request (`denyRequest()`) or an OAuth browser navigation (redirect to the login page).
 */
const banResponse = async (req, res) => {
  if (isOAuthNavigation(req)) {
    return redirectOAuthFailure(res, ErrorTypes.AUTH_BANNED);
  }

  const ua = uap(req.headers['user-agent']);
  if (!ua.browser.name) {
    return res.status(403).json({ message });
  } else if (isInteractiveAgentChatRequest(req)) {
    return await denyRequest(req, res, { type: ViolationTypes.BAN });
  }

  return res.status(403).json({ message });
};

/**
 * Checks if the source IP or user is banned or not.
 *
 * @async
 * @function
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @param {import('express').NextFunction} next - Next middleware function.
 *
 * @returns {Promise<function|Object>} - Returns a Promise which when resolved calls next middleware if user or source IP is not banned. Otherwise calls `banResponse()` and sets ban details in `banCache`.
 */
const checkBan = async (req, res, next = () => {}) => {
  try {
    const { BAN_VIOLATIONS } = process.env ?? {};

    if (!isEnabled(BAN_VIOLATIONS)) {
      return next();
    }

    req.ip = removePorts(req);
    let userId = req.user?.id ?? req.user?._id?.toString() ?? null;

    if (!userId && req?.body?.email) {
      const user = await findUser({ email: req.body.email }, '_id');
      userId = user?._id ? user._id.toString() : userId;
    }

    if (!userId && !req.ip) {
      return next();
    }

    const useRedis = isEnabled(process.env.USE_REDIS);
    const ipKey = getBanCacheKey('ip', req.ip, useRedis);
    const userKey = getBanCacheKey('user', userId, useRedis);

    const [cachedIPBan, cachedUserBan] = await Promise.all([
      ipKey ? banCache.get(ipKey) : undefined,
      userKey ? banCache.get(userKey) : undefined,
    ]);

    if (cachedIPBan || cachedUserBan) {
      req.banned = true;
      return await banResponse(req, res);
    }

    const banLogs = getLogStores(ViolationTypes.BAN);
    const duration = banLogs.opts.ttl;

    if (duration <= 0) {
      return next();
    }

    const [ipBan, userBan] = await Promise.all([
      req.ip ? banLogs.get(req.ip) : undefined,
      userId ? banLogs.get(userId) : undefined,
    ]);

    const banData = ipBan || userBan;

    if (!banData) {
      return next();
    }

    const expiresAt = Number(banData.expiresAt);
    if (!banData.expiresAt || isNaN(expiresAt)) {
      req.banned = true;
      return await banResponse(req, res);
    }

    const timeLeft = expiresAt - Date.now();

    if (timeLeft <= 0) {
      const cleanups = [];
      if (ipBan) {
        cleanups.push(banLogs.delete(req.ip));
      }
      if (userBan) {
        cleanups.push(banLogs.delete(userId));
      }
      await Promise.all(cleanups);
      return next();
    }

    const cacheWrites = [];
    if (ipKey) {
      cacheWrites.push(banCache.set(ipKey, banData, timeLeft));
    }
    if (userKey) {
      cacheWrites.push(banCache.set(userKey, banData, timeLeft));
    }
    await Promise.all(cacheWrites).catch((err) =>
      logger.warn('[checkBan] Failed to write ban cache:', err),
    );

    req.banned = true;
    return await banResponse(req, res);
  } catch (error) {
    logger.error('Error in checkBan middleware:', error);
    return next(error);
  }
};

module.exports = checkBan;
