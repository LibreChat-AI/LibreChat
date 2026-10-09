const express = require('express');
const jwt = require('jsonwebtoken');
const { logger } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const {
  getBasePath,
  getAccessToken,
  setOAuthSession,
  validateOAuthCsrf,
  OAUTH_CSRF_COOKIE,
  setOAuthCsrfCookie,
  validateOAuthSession,
  OAUTH_SESSION_COOKIE,
} = require('@librechat/api');
const { findToken, updateToken, createToken } = require('~/models');
const { requireJwtAuth } = require('~/server/middleware');
const { getActionFlowStateManager } = require('~/config');
const { getLogStores } = require('~/cache');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
const OAUTH_CSRF_COOKIE_PATH = '/api/actions';

/**
 * Sets a CSRF cookie binding the action OAuth flow to the current browser session.
 * Must be called before the user opens the IdP authorization URL.
 *
 * @route POST /actions/:action_id/oauth/bind
 */
router.post('/:action_id/oauth/bind', requireJwtAuth, setOAuthSession, async (req, res) => {
  try {
    const { action_id } = req.params;
    const user = req.user;
    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const flowId = `${user.id}:${action_id}`;
    setOAuthCsrfCookie(res, flowId, OAUTH_CSRF_COOKIE_PATH);
    res.json({ success: true });
  } catch (error) {
    logger.error('[Action OAuth] Failed to set CSRF binding cookie', error);
    res.status(500).json({ error: 'Failed to bind OAuth flow' });
  }
});

/**
 * Handles the OAuth callback and exchanges the authorization code for tokens.
 *
 * @route GET /actions/:action_id/oauth/callback
 * @param {string} req.params.action_id - The ID of the action.
 * @param {string} req.query.code - The authorization code returned by the provider.
 * @param {string} req.query.state - The state token to verify the authenticity of the request.
 * @returns {void} Sends a success message after updating the action with OAuth tokens.
 */
router.get('/:action_id/oauth/callback', async (req, res) => {
  const { action_id } = req.params;
  const { code, state } = req.query;
  const flowsCache = getLogStores(CacheKeys.FLOWS);
  const flowManager = getActionFlowStateManager(flowsCache);
  const basePath = getBasePath();
  let identifier = action_id;
  try {
    let decodedState;
    try {
      decodedState = jwt.verify(state, JWT_SECRET);
    } catch (err) {
      logger.error('Error verifying state parameter:', err);
      await flowManager.failFlow(identifier, 'oauth', 'Invalid or expired state parameter');
      return res.redirect(`${basePath}/oauth/error?error=invalid_state`);
    }

    if (decodedState.action_id !== action_id) {
      await flowManager.failFlow(identifier, 'oauth', 'Mismatched action ID in state parameter');
      return res.redirect(`${basePath}/oauth/error?error=invalid_state`);
    }

    if (!decodedState.user) {
      await flowManager.failFlow(identifier, 'oauth', 'Invalid user ID in state parameter');
      return res.redirect(`${basePath}/oauth/error?error=invalid_state`);
    }

    identifier = `${decodedState.user}:${action_id}`;

    if (
      !validateOAuthCsrf(req, res, identifier, OAUTH_CSRF_COOKIE_PATH) &&
      !validateOAuthSession(req, decodedState.user)
    ) {
      logger.error('[Action OAuth] CSRF validation failed: no valid CSRF or session cookie', {
        identifier,
        hasCsrfCookie: !!req.cookies?.[OAUTH_CSRF_COOKIE],
        hasSessionCookie: !!req.cookies?.[OAUTH_SESSION_COOKIE],
      });
      await flowManager.failFlow(identifier, 'oauth', 'CSRF validation failed');
      return res.redirect(`${basePath}/oauth/error?error=csrf_validation_failed`);
    }

    const flowState = await flowManager.getFlowState(identifier, 'oauth');
    if (!flowState) {
      throw new Error('OAuth flow not found');
    }

    const tokenData = await getAccessToken(
      {
        code,
        userId: decodedState.user,
        identifier,
        client_url: flowState.metadata.client_url,
        redirect_uri: flowState.metadata.redirect_uri,
        token_exchange_method: flowState.metadata.token_exchange_method,
        allowedAddresses: flowState.metadata.allowedAddresses,
        /** Encrypted values */
        encrypted_oauth_client_id: flowState.metadata.encrypted_oauth_client_id,
        encrypted_oauth_client_secret: flowState.metadata.encrypted_oauth_client_secret,
      },
      {
        findToken,
        updateToken,
        createToken,
      },
    );
    await flowManager.completeFlow(identifier, 'oauth', tokenData);

    const serverName = flowState.metadata?.action_name || `Action ${action_id}`;
    const redirectUrl = `${basePath}/oauth/success?serverName=${encodeURIComponent(serverName)}`;
    res.redirect(redirectUrl);
  } catch (error) {
    logger.error('Error in OAuth callback:', error);
    await flowManager.failFlow(identifier, 'oauth', error);
    res.redirect(`${basePath}/oauth/error?error=callback_failed`);
  }
});

module.exports = router;
