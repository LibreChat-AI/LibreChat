const { logger } = require('@librechat/data-schemas');
const { exchangeOboToken } = require('./OboTokenService');

/**
 * Get Microsoft Graph API token using the On-Behalf-Of flow.
 * Thin wrapper around the generic OBO exchange for Graph-specific error context.
 *
 * @param {Object} user - User object with OpenID information
 * @param {string} accessToken - Federated access token used as OBO assertion
 * @param {string} scopes - Graph API scopes for the token
 * @param {boolean} [fromCache=true] - Whether to try getting token from cache first
 * @returns {Promise<Object>} Graph API token response with access_token and expires_in
 */
async function getGraphApiToken(user, accessToken, scopes, fromCache = true) {
  try {
    return await exchangeOboToken(user, accessToken, scopes, fromCache);
  } catch (error) {
    logger.error(
      `[GraphTokenService] Failed to acquire Graph API token for user ${user.openidId}:`,
      error,
    );
    throw new Error(`Graph token acquisition failed: ${error.message}`);
  }
}

module.exports = {
  getGraphApiToken,
};
