const crypto = require('node:crypto');
const client = require('openid-client');
const { logger } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const {
  createOpenIDOboIdentityTuple,
  getSkewedTokenCacheTtlMs,
  getTokenExpiresAtMs,
  hasUsableTokenExpiry,
  normalizeExpiresIn,
  serializeAuthIdentityTuple,
  DEFAULT_OAUTH_TOKEN_TTL_SECONDS,
} = require('@librechat/api');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');
const getLogStores = require('~/cache/getLogStores');

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND']);
const OBO_RETRY_DELAY_MS = 300;

/**
 * In-flight OBO exchanges keyed by identity tuple, scopes, and upstream assertion hash.
 *
 * Without coalescing, parallel tool calls that arrive on a cache miss each issue
 * their own jwt-bearer request to the IdP. Under fan-out, Entra intermittently
 * returns errors that look non-retryable, surfacing as "identity provider
 * rejected the OBO token exchange." A user retry then hits the populated cache
 * and succeeds, which matches the observed flakiness. Sharing a single upstream
 * exchange per key removes the thundering herd.
 */
const inFlightExchanges = new Map();

function getErrorStatus(error) {
  return error?.status ?? error?.statusCode ?? error?.response?.status;
}

function getErrorCode(error) {
  return typeof error?.code === 'string' ? error.code.toUpperCase() : undefined;
}

function isRetryableOboExchangeError(error) {
  const status = getErrorStatus(error);
  if (status != null && RETRYABLE_STATUS_CODES.has(status)) {
    return true;
  }

  const code = getErrorCode(error);
  if (code != null && RETRYABLE_ERROR_CODES.has(code)) {
    return true;
  }

  const message = String(error?.message ?? '').toLowerCase();
  return (
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('temporarily unavailable') ||
    message.includes('too many requests') ||
    message.includes('service unavailable')
  );
}

function tagOboExchangeError(error, retryable) {
  if (error && typeof error === 'object') {
    error.retryable = retryable;
    error.oboFailureReason = 'exchange_failed';
  }
  return error;
}

function createEmptyOboExchangeResponseError() {
  const error = new Error('The identity provider returned no access token for the OBO exchange');
  error.retryable = false;
  error.oboFailureReason = 'empty_exchange_response';
  return error;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function buildOboCacheKey({ user, accessToken, scopes, identityContext }) {
  const tuple = createOpenIDOboIdentityTuple({ user, identityContext });
  if (!tuple) {
    return null;
  }

  return [serializeAuthIdentityTuple(tuple), scopes, sha256(accessToken)].join('\x1f');
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function performOboExchange({ user, accessToken, scopes, config, tokensCache, cacheKey }) {
  const requestGrant = async () =>
    client.genericGrantRequest(config, 'urn:ietf:params:oauth:grant-type:jwt-bearer', {
      scope: scopes,
      assertion: accessToken,
      requested_token_use: 'on_behalf_of',
    });

  let grantResponse;
  try {
    grantResponse = await requestGrant();
  } catch (error) {
    const retryable = isRetryableOboExchangeError(error);
    if (!retryable) {
      throw tagOboExchangeError(error, false);
    }

    logger.warn(
      `[OboTokenService] Transient OBO exchange failure for user: ${user.openidId}, retrying once`,
      error,
    );
    await delay(OBO_RETRY_DELAY_MS);

    try {
      grantResponse = await requestGrant();
    } catch (retryError) {
      throw tagOboExchangeError(retryError, isRetryableOboExchangeError(retryError));
    }
  }

  if (!grantResponse?.access_token) {
    throw createEmptyOboExchangeResponseError();
  }

  const expiresIn = normalizeExpiresIn(grantResponse.expires_in) ?? DEFAULT_OAUTH_TOKEN_TTL_SECONDS;
  const now = Date.now();
  const expiresAt = getTokenExpiresAtMs({ expiresIn, now });
  const tokenResponse = {
    access_token: grantResponse.access_token,
    token_type: 'Bearer',
    expires_in: expiresIn,
    expires_at: expiresAt,
    scope: scopes,
  };

  await tokensCache.set(cacheKey, tokenResponse, getSkewedTokenCacheTtlMs(expiresAt, now));

  logger.debug(
    `[OboTokenService] Successfully obtained and cached OBO token for user: ${user.openidId}`,
  );
  return tokenResponse;
}

/**
 * Exchange a user's access token for a downstream-scoped token via the
 * OAuth 2.0 On-Behalf-Of (jwt-bearer) grant.
 *
 * Concurrent callers for the same identity/scopes/assertion key share a single
 * upstream exchange (see `inFlightExchanges`) so a fan-out of tool calls right
 * after a cache miss does not produce N parallel requests to the IdP.
 *
 * @param {Object} user - User object with OpenID information
 * @param {string} accessToken - Federated access token used as OBO assertion
 * @param {string} scopes - Scopes to request for the downstream service
 * @param {boolean} [fromCache=true] - When true, read from cache and join any
 *   in-flight exchange. When false, bypass both and force a fresh exchange.
 * @param {import('@librechat/api').AuthIdentityContext} [identityContext] - Real request identity
 *   context used to scope OBO cache keys without exposing tenant/issuer placeholders.
 * @returns {Promise<Object>} Token response with access_token and expires_in
 */
async function exchangeOboToken(user, accessToken, scopes, fromCache = true, identityContext) {
  if (!accessToken) {
    throw new Error('Access token is required for OBO exchange');
  }

  if (!scopes) {
    throw new Error('Scopes are required for OBO exchange');
  }

  const config = getOpenIdConfig();
  if (!config) {
    throw new Error('OpenID configuration not available');
  }

  const cacheKey = buildOboCacheKey({
    user,
    accessToken,
    scopes,
    identityContext,
  });
  if (!cacheKey) {
    throw new Error('User must be authenticated via OpenID to perform OBO token exchange');
  }
  const tokensCache = getLogStores(CacheKeys.OPENID_EXCHANGED_TOKENS);

  if (fromCache) {
    const cachedToken = await tokensCache.get(cacheKey);
    if (cachedToken) {
      if (hasUsableTokenExpiry(cachedToken.expires_at)) {
        logger.debug(`[OboTokenService] Using cached token for user: ${user.openidId}`);
        return cachedToken;
      }
      logger.debug(
        `[OboTokenService] Ignoring cached OBO token without usable expiry for user: ${user.openidId}`,
      );
    }

    const inFlight = inFlightExchanges.get(cacheKey);
    if (inFlight) {
      logger.debug(`[OboTokenService] Joining in-flight OBO exchange for user: ${user.openidId}`);
      return inFlight;
    }
  }

  logger.debug(
    `[OboTokenService] Requesting new OBO token for user: ${user.openidId}, scopes: ${scopes}`,
  );

  const exchangePromise = performOboExchange({
    user,
    accessToken,
    scopes,
    config,
    tokensCache,
    cacheKey,
  });

  if (fromCache) {
    inFlightExchanges.set(cacheKey, exchangePromise);
    exchangePromise
      .finally(() => {
        if (inFlightExchanges.get(cacheKey) === exchangePromise) {
          inFlightExchanges.delete(cacheKey);
        }
      })
      .catch(() => {
        /* The original rejection is delivered to the awaiting caller; this
         * chain exists only to run cleanup, so swallow it here to avoid an
         * unhandled-rejection warning on the cleanup promise. */
      });
  }

  return exchangePromise;
}

module.exports = {
  exchangeOboToken,
  __internals: {
    buildOboCacheKey,
  },
};
