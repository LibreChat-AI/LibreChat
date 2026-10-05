const { Keyv } = require('keyv');
const uap = require('ua-parser-js');
const { logger } = require('@librechat/data-schemas');
const { ErrorTypes, ViolationTypes } = require('librechat-data-provider');
const { createBanCheck, keyvMongo } = require('@librechat/api');
const { getLogStores } = require('~/cache');
const { isOAuthNavigation, redirectOAuthFailure } = require('./oauthNavigation');
const denyRequest = require('./denyRequest');
const { findUser } = require('~/models');

const banCache = new Keyv({ store: keyvMongo, namespace: ViolationTypes.BAN, ttl: 0 });
const message = 'Your account has been temporarily banned due to violations of our service.';
const AGENT_CHAT_PATH = '/api/agents/chat';
const AGENT_CHAT_POST_CONTROL_ROUTES = new Set(['abort', 'steer']);

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

const checkBan = createBanCheck({
  getEnvironment: () => process.env,
  banCache,
  getBanLogs: () => getLogStores(ViolationTypes.BAN),
  findUser,
  banResponse,
  logger,
});

module.exports = checkBan;
