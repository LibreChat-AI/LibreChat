const undici = require('undici');
const { get } = require('lodash');
const passport = require('passport');
const client = require('openid-client');
const jwtDecode = require('jsonwebtoken/decode');
const { hashToken, logger, tenantStorage } = require('@librechat/data-schemas');
const { Strategy: OpenIDStrategy } = require('openid-client/passport');
const { CacheKeys, ErrorTypes, SystemRoles } = require('librechat-data-provider');
const {
  isEnabled,
  logHeaders,
  logOpenIdRequestBody,
  findOpenIDUser,
  getOpenIdEmail,
  getOpenIdIssuer,
  getBalanceConfig,
  selectOpenIdRole,
  getTokenCacheTtlMs,
  getAvatarSaveParams,
  isEmailDomainAllowed,
  getAvatarFileStrategy,
  resolveAppConfigForUser,
  getOpenIdProxyDispatcher,
  getOpenIdRoleSyncOptions,
  getOpenIdRolesForOpenIdSync,
  getLibreChatRolesForOpenIdSync,
  DEFAULT_OAUTH_TOKEN_TTL_SECONDS,
} = require('@librechat/api');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { resizeAvatar } = require('~/server/services/Files/images/avatar');
const { findUser, createUser, updateUser, findRolesByNames } = require('~/models');
const { getAppConfig } = require('~/server/services/Config');
const getLogStores = require('~/cache/getLogStores');

/**
 * @typedef {import('openid-client').ClientMetadata} ClientMetadata
 * @typedef {import('openid-client').Configuration} Configuration
 **/

/**
 * @param {string} url
 * @param {client.CustomFetchOptions} options
 */
async function customFetch(url, options) {
  const urlStr = url.toString();
  logger.debug(`[openidStrategy] Request to: ${urlStr}`);
  const debugOpenId = isEnabled(process.env.DEBUG_OPENID_REQUESTS);
  if (debugOpenId) {
    logger.debug(`[openidStrategy] Request method: ${options.method || 'GET'}`);
    logger.debug(`[openidStrategy] Request headers: ${logHeaders(options.headers)}`);
    if (options.body) {
      logger.debug(`[openidStrategy] Request body: ${logOpenIdRequestBody(options.body)}`);
    }
  }

  try {
    /** @type {undici.RequestInit} */
    let fetchOptions = options;
    const dispatcher = getOpenIdProxyDispatcher();
    if (dispatcher) {
      logger.info('[openidStrategy] proxy dispatcher configured');
      fetchOptions = {
        ...options,
        dispatcher,
      };
    }

    const response = await undici.fetch(url, fetchOptions);

    if (debugOpenId) {
      logger.debug(`[openidStrategy] Response status: ${response.status} ${response.statusText}`);
      logger.debug(`[openidStrategy] Response headers: ${logHeaders(response.headers)}`);
    }

    if (response.status === 200 && response.headers.has('www-authenticate')) {
      const wwwAuth = response.headers.get('www-authenticate');
      logger.warn(`[openidStrategy] Non-standard WWW-Authenticate header found in successful response (200 OK): ${wwwAuth}.
This violates RFC 7235 and may cause issues with strict OAuth clients. Removing header for compatibility.`);

      /** Cloned response without the WWW-Authenticate header */
      const responseBody = await response.arrayBuffer();
      const newHeaders = new Headers();
      for (const [key, value] of response.headers.entries()) {
        if (key.toLowerCase() !== 'www-authenticate') {
          newHeaders.append(key, value);
        }
      }

      return new Response(responseBody, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    return response;
  } catch (error) {
    logger.error(`[openidStrategy] Fetch error: ${error.message}`);
    throw error;
  }
}

/** @typedef {Configuration | null}  */
let openidConfig = null;

const getOpenIdAuthorizationAudience = () =>
  (process.env.OPENID_AUDIENCE ?? '')
    .split(',')
    .map((value) => value.trim())
    .find(Boolean);

/**
 * Custom OpenID Strategy
 *
 * Note: Originally overrode currentUrl() to work around Express 4's req.host not including port.
 * With Express 5, req.host now includes the port by default, but we continue to use DOMAIN_SERVER
 * for consistency and explicit configuration control.
 * More info: https://github.com/panva/openid-client/pull/713
 */
class CustomOpenIDStrategy extends OpenIDStrategy {
  currentUrl(req) {
    const hostAndProtocol = process.env.DOMAIN_SERVER;
    return new URL(`${hostAndProtocol}${req.originalUrl ?? req.url}`);
  }

  authorizationRequestParams(req, options) {
    const params = super.authorizationRequestParams(req, options);
    if (options?.state && !params.has('state')) {
      params.set('state', options.state);
    }

    const authorizationAudience = getOpenIdAuthorizationAudience();
    if (authorizationAudience) {
      params.set('audience', authorizationAudience);
      logger.debug(
        `[openidStrategy] Adding audience to authorization request: ${authorizationAudience}`,
      );
    }

    /** Generate nonce for federated providers that require it */
    const shouldGenerateNonce = isEnabled(process.env.OPENID_GENERATE_NONCE);
    if (shouldGenerateNonce && !params.has('nonce') && this._sessionKey) {
      const crypto = require('crypto');
      const nonce = crypto.randomBytes(16).toString('hex');
      params.set('nonce', nonce);
      logger.debug('[openidStrategy] Generated nonce for federated provider:', nonce);
    }

    return params;
  }
}

/**
 * Exchange the access token for a new access token using the on-behalf-of flow if required.
 * @param {Configuration} config
 * @param {string} accessToken access token to be exchanged if necessary
 * @param {string} sub - The subject identifier of the user. usually found as "sub" in the claims of the token
 * @param {boolean} fromCache - Indicates whether to use cached tokens.
 * @returns {Promise<string>} The new access token if exchanged, otherwise the original access token.
 */
const exchangeAccessTokenIfNeeded = async (config, accessToken, sub, fromCache = false) => {
  const tokensCache = getLogStores(CacheKeys.OPENID_EXCHANGED_TOKENS);
  const onBehalfFlowRequired = isEnabled(process.env.OPENID_ON_BEHALF_FLOW_FOR_USERINFO_REQUIRED);
  if (onBehalfFlowRequired) {
    if (fromCache) {
      const cachedToken = await tokensCache.get(sub);
      if (cachedToken) {
        return cachedToken.access_token;
      }
    }
    const grantResponse = await client.genericGrantRequest(
      config,
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
      {
        scope: process.env.OPENID_ON_BEHALF_FLOW_USERINFO_SCOPE || 'user.read',
        assertion: accessToken,
        requested_token_use: 'on_behalf_of',
      },
    );
    await tokensCache.set(
      sub,
      {
        access_token: grantResponse.access_token,
      },
      getTokenCacheTtlMs(grantResponse.expires_in, DEFAULT_OAUTH_TOKEN_TTL_SECONDS),
    );
    return grantResponse.access_token;
  }
  return accessToken;
};

/**
 * get user info from openid provider
 * @param {Configuration} config
 * @param {string} accessToken access token
 * @param {string} sub - The subject identifier of the user. usually found as "sub" in the claims of the token
 * @returns {Promise<Object|null>}
 */
const getUserInfo = async (config, accessToken, sub) => {
  try {
    const exchangedAccessToken = await exchangeAccessTokenIfNeeded(config, accessToken, sub);
    return await client.fetchUserInfo(config, exchangedAccessToken, sub);
  } catch (error) {
    logger.error('[openidStrategy] getUserInfo: Error fetching user info:', error);
    return null;
  }
};

function getUrlOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getOpenIDAvatarAuthorizedOrigins(config) {
  const metadata = config?.serverMetadata?.() ?? {};
  const metadataOrigins = [metadata.issuer, metadata.userinfo_endpoint]
    .map(getUrlOrigin)
    .filter(Boolean);
  const configuredOrigins = (process.env.OPENID_AVATAR_AUTHORIZED_ORIGINS ?? '')
    .split(/[\s,]+/)
    .map(getUrlOrigin)
    .filter(Boolean);

  return new Set([...metadataOrigins, ...configuredOrigins]);
}

function shouldAuthorizeOpenIDAvatar(url, config) {
  const origin = getUrlOrigin(url);
  if (!origin) {
    return false;
  }

  return getOpenIDAvatarAuthorizedOrigins(config).has(origin);
}

async function getOpenIDAvatarFetchOptions(url, config, accessToken, sub) {
  if (!shouldAuthorizeOpenIDAvatar(url, config)) {
    return undefined;
  }

  const exchangedAccessToken = await exchangeAccessTokenIfNeeded(config, accessToken, sub, true);
  return {
    headers: {
      Authorization: `Bearer ${exchangedAccessToken}`,
    },
  };
}

const resizeIdentityProviderAvatar = async (url, userId, config, accessToken, sub) => {
  if (!url) {
    return '';
  }

  try {
    const fetchOptions = await getOpenIDAvatarFetchOptions(url, config, accessToken, sub);
    const avatarParams = { userId, input: url };
    if (fetchOptions) {
      avatarParams.fetchOptions = fetchOptions;
    }
    return await resizeAvatar(avatarParams);
  } catch (error) {
    logger.error(
      `[openidStrategy] resizeIdentityProviderAvatar: Error processing avatar at URL "${url}": ${error}`,
    );
    return '';
  }
};

/**
 * Determines the full name of a user based on OpenID userinfo and environment configuration.
 *
 * @param {Object} userinfo - The user information object from OpenID Connect
 * @param {string} [userinfo.given_name] - The user's first name
 * @param {string} [userinfo.family_name] - The user's last name
 * @param {string} [userinfo.username] - The user's username
 * @param {string} [userinfo.email] - The user's email address
 * @returns {string} The determined full name of the user
 */
function getFullName(userinfo) {
  if (process.env.OPENID_NAME_CLAIM) {
    return userinfo[process.env.OPENID_NAME_CLAIM];
  }

  if (userinfo.given_name && userinfo.family_name) {
    return `${userinfo.given_name} ${userinfo.family_name}`;
  }

  if (userinfo.given_name) {
    return userinfo.given_name;
  }

  if (userinfo.family_name) {
    return userinfo.family_name;
  }

  return userinfo.username || userinfo.email;
}

/**
 * Converts an input into a string suitable for a username.
 * If the input is a string, it will be returned as is.
 * If the input is an array, elements will be joined with underscores.
 * In case of undefined or other falsy values, a default value will be returned.
 *
 * @param {string | string[] | undefined} input - The input value to be converted into a username.
 * @param {string} [defaultValue=''] - The default value to return if the input is falsy.
 * @returns {string} The processed input as a string suitable for a username.
 */
function convertToUsername(input, defaultValue = '') {
  if (typeof input === 'string') {
    return input;
  } else if (Array.isArray(input)) {
    return input.join('_');
  }

  return defaultValue;
}

/**
 * Exchange the access token for a Graph-scoped token using the On-Behalf-Of (OBO) flow.
 *
 * The original access token has the app's own audience (api://<client-id>), which Microsoft Graph
 * rejects. This exchange produces a token with audience https://graph.microsoft.com and the
 * minimum delegated scope (User.Read) required by /me/getMemberObjects.
 *
 * Uses a dedicated cache key (`${sub}:overage`) to avoid collisions with other OBO exchanges
 * in the codebase (userinfo, Graph principal search).
 *
 * @param {string} accessToken - The original access token from the OpenID tokenset
 * @param {string} sub - The subject identifier for cache keying
 * @returns {Promise<string>} A Graph-scoped access token
 * @see https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-on-behalf-of-flow
 */
async function exchangeTokenForOverage(accessToken, sub) {
  if (!openidConfig) {
    throw new Error('[openidStrategy] OpenID config not initialized; cannot exchange OBO token');
  }

  const tokensCache = getLogStores(CacheKeys.OPENID_EXCHANGED_TOKENS);
  const cacheKey = `${sub}:overage`;

  const cached = await tokensCache.get(cacheKey);
  if (cached?.access_token) {
    logger.debug('[openidStrategy] Using cached Graph token for overage resolution');
    return cached.access_token;
  }

  const grantResponse = await client.genericGrantRequest(
    openidConfig,
    'urn:ietf:params:oauth:grant-type:jwt-bearer',
    {
      scope: 'https://graph.microsoft.com/User.Read',
      assertion: accessToken,
      requested_token_use: 'on_behalf_of',
    },
  );

  if (!grantResponse.access_token) {
    throw new Error(
      '[openidStrategy] OBO exchange succeeded but returned no access_token; cannot call Graph API',
    );
  }

  await tokensCache.set(
    cacheKey,
    { access_token: grantResponse.access_token },
    getTokenCacheTtlMs(grantResponse.expires_in, DEFAULT_OAUTH_TOKEN_TTL_SECONDS),
  );

  return grantResponse.access_token;
}

/**
 * Resolve Azure AD groups when group overage is in effect (groups moved to _claim_names/_claim_sources).
 *
 * NOTE: Microsoft recommends treating _claim_names/_claim_sources as a signal only and using Microsoft Graph
 * to resolve group membership instead of calling the endpoint in _claim_sources directly.
 *
 * Before calling Graph, the access token is exchanged via the OBO flow to obtain a token with the
 * correct audience (https://graph.microsoft.com) and User.Read scope.
 *
 * @param {string} accessToken - Access token from the OpenID tokenset (app audience)
 * @param {string} sub - The subject identifier of the user (for OBO exchange and cache keying)
 * @returns {Promise<string[] | null>} Resolved group IDs or null on failure
 * @see https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference#groups-overage-claim
 * @see https://learn.microsoft.com/en-us/graph/api/directoryobject-getmemberobjects
 */
async function resolveGroupsFromOverage(accessToken, sub) {
  try {
    if (!accessToken) {
      logger.error('[openidStrategy] Access token missing; cannot resolve group overage');
      return null;
    }

    const graphToken = await exchangeTokenForOverage(accessToken, sub);

    // Use /me/getMemberObjects so least-privileged delegated permission User.Read is sufficient
    // when resolving the signed-in user's group membership.
    const url = 'https://graph.microsoft.com/v1.0/me/getMemberObjects';

    logger.debug(
      `[openidStrategy] Detected group overage, resolving groups via Microsoft Graph getMemberObjects: ${url}`,
    );

    const fetchOptions = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${graphToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ securityEnabledOnly: false }),
    };

    const dispatcher = getOpenIdProxyDispatcher();
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher;
    }

    const response = await undici.fetch(url, fetchOptions);
    if (!response.ok) {
      logger.error(
        `[openidStrategy] Failed to resolve groups via Microsoft Graph getMemberObjects: HTTP ${response.status} ${response.statusText}`,
      );
      return null;
    }

    const data = await response.json();

    const values = Array.isArray(data?.value) ? data.value : null;
    if (!values) {
      logger.error(
        '[openidStrategy] Unexpected response format when resolving groups via Microsoft Graph getMemberObjects',
      );
      return null;
    }
    const groupIds = values.filter((id) => typeof id === 'string');

    logger.debug(
      `[openidStrategy] Successfully resolved ${groupIds.length} groups via Microsoft Graph getMemberObjects`,
    );
    return groupIds;
  } catch (err) {
    logger.error(
      '[openidStrategy] Error resolving groups via Microsoft Graph getMemberObjects:',
      err,
    );
    return null;
  }
}

/**
 * Resolve the source object (decoded token or userinfo) for a role check
 * based on the configured token kind. Throws on invalid configuration so
 * misconfiguration surfaces loudly instead of silently denying every login.
 *
 * @param {string} kind - One of 'access', 'id', or 'userinfo'
 * @param {string} label - Human-readable label for error messages (e.g. 'required role')
 * @param {Object} tokenset - The OpenID tokenset
 * @param {Object} userinfo - Merged userinfo (id-token claims + UserInfo endpoint response)
 */
function getRoleSource(kind, label, tokenset, userinfo) {
  if (kind === 'access') {
    return jwtDecode(tokenset.access_token);
  }
  if (kind === 'id') {
    return jwtDecode(tokenset.id_token);
  }
  if (kind === 'userinfo') {
    return userinfo;
  }
  logger.error(
    `[openidStrategy] Invalid ${label} token kind: ${kind}. Must be one of 'access', 'id', or 'userinfo'.`,
  );
  throw new Error(`Invalid ${label} token kind`);
}

/**
 * Applies generic OpenID role sync to the request-local user before the existing final update.
 */
async function applyOpenIdRoleSync({
  user,
  username,
  tokenset,
  claims,
  userinfo,
  resolvedOverageGroups,
}) {
  const options = getOpenIdRoleSyncOptions();
  if (!options.enabled) {
    return;
  }

  if (user.role === SystemRoles.ADMIN) {
    logger.info(
      `[openidStrategy] OpenID role sync skipped for ${username}; existing ADMIN role is not managed by generic role sync`,
    );
    return;
  }

  const resolveGroupOverage = async () =>
    resolvedOverageGroups || (await resolveGroupsFromOverage(tokenset.access_token, claims.sub));

  const openIdRoleValues = await getOpenIdRolesForOpenIdSync({
    options,
    accessToken: tokenset.access_token,
    idToken: tokenset.id_token,
    claims,
    userinfo,
    decodeToken: jwtDecode,
    resolveGroupOverage,
  });
  if (openIdRoleValues === undefined) {
    logger.warn(
      `[openidStrategy] OpenID role sync skipped; claim '${options.claim}' was not found, invalid, or unresolved`,
    );
    return;
  }

  const libreChatRoles = {
    getRolesByNames: findRolesByNames,
    rolePriority: options.rolePriority,
    fallbackRole: options.fallbackRole,
    logPrefix: '[openidStrategy]',
  };

  /** Role definitions are tenant-scoped, so validate configured roles in the matched user's tenant. */
  const { rolePriority, fallbackRole } = user?.tenantId
    ? await tenantStorage.run({ tenantId: user.tenantId }, async () =>
        getLibreChatRolesForOpenIdSync(libreChatRoles),
      )
    : await getLibreChatRolesForOpenIdSync(libreChatRoles);
  const result = selectOpenIdRole({
    currentRole: user.role,
    openIdRoleValues,
    rolePriority,
    fallbackRole,
  });

  if (!result.selectedRole || result.selectedRole === user.role) {
    return;
  }

  logger.info(
    `[openidStrategy] OpenID role sync updated role for ${username}: ${user.role || 'unset'} -> ${result.selectedRole}`,
  );
  user.role = result.selectedRole;
}

/**
 * Process OpenID authentication tokenset and userinfo
 * This is the core logic extracted from the passport strategy callback
 * Can be reused by both the passport strategy and proxy authentication
 *
 * @param {Object} tokenset - The OpenID tokenset containing access_token, id_token, etc.
 * @param {boolean} existingUsersOnly - If true, only existing users will be processed
 * @returns {Promise<Object>} The authenticated user object with tokenset
 */
async function processOpenIDAuth(tokenset, existingUsersOnly = false) {
  const claims = tokenset.claims ? tokenset.claims() : tokenset;
  const userinfo = {
    ...claims,
  };

  if (tokenset.access_token) {
    const providerUserinfo = await getUserInfo(openidConfig, tokenset.access_token, claims.sub);
    Object.assign(userinfo, providerUserinfo);
  }

  const email = getOpenIdEmail(userinfo);
  const openidIssuer = getOpenIdIssuer(claims, openidConfig);

  const baseConfig = await getAppConfig({ baseOnly: true });
  if (!isEmailDomainAllowed(email, baseConfig?.registration?.allowedDomains)) {
    logger.error(
      `[OpenID Strategy] Authentication blocked - email domain not allowed [Identifier: ${email}]`,
    );
    throw new Error('Email domain not allowed');
  }

  const result = await findOpenIDUser({
    findUser,
    email: email,
    openidId: claims.sub || userinfo.sub,
    openidIssuer,
    idOnTheSource: claims.oid || userinfo.oid,
    strategyName: 'openidStrategy',
  });
  let user = result.user;
  const error = result.error;

  if (error) {
    throw new Error(ErrorTypes.AUTH_FAILED);
  }

  const appConfig = user?.tenantId ? await resolveAppConfigForUser(getAppConfig, user) : baseConfig;

  if (!isEmailDomainAllowed(email, appConfig?.registration?.allowedDomains)) {
    logger.error(
      `[OpenID Strategy] Authentication blocked - email domain not allowed [Identifier: ${email}]`,
    );
    throw new Error('Email domain not allowed');
  }

  const fullName = getFullName(userinfo);

  const requiredRole = process.env.OPENID_REQUIRED_ROLE;
  let resolvedOverageGroups = null;

  if (requiredRole) {
    const requiredRoles = requiredRole
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean);
    const requiredRoleParameterPath = process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH;
    const requiredRoleTokenKind = process.env.OPENID_REQUIRED_ROLE_TOKEN_KIND;

    const decodedToken = getRoleSource(requiredRoleTokenKind, 'required role', tokenset, userinfo);

    let roles = get(decodedToken, requiredRoleParameterPath);

    // Handle Azure AD group overage for ID token groups: when hasgroups or _claim_* indicate overage,
    // resolve groups via Microsoft Graph instead of relying on token group values.
    const hasOverage =
      decodedToken?.hasgroups ||
      (decodedToken?._claim_names?.groups &&
        decodedToken?._claim_sources?.[decodedToken._claim_names.groups]);

    if (
      requiredRoleTokenKind === 'id' &&
      requiredRoleParameterPath === 'groups' &&
      decodedToken &&
      hasOverage
    ) {
      const overageGroups = await resolveGroupsFromOverage(tokenset.access_token, claims.sub);
      if (overageGroups) {
        roles = overageGroups;
        resolvedOverageGroups = overageGroups;
      }
    }

    if (!roles || (!Array.isArray(roles) && typeof roles !== 'string')) {
      logger.error(
        `[openidStrategy] Key '${requiredRoleParameterPath}' not found in ${requiredRoleTokenKind} token!`,
      );
      const rolesList =
        requiredRoles.length === 1
          ? `"${requiredRoles[0]}"`
          : `one of: ${requiredRoles.map((r) => `"${r}"`).join(', ')}`;
      throw new Error(`You must have ${rolesList} role to log in.`);
    }

    const roleValues = Array.isArray(roles) ? roles : roles.split(/[\s,]+/).filter(Boolean);

    if (!requiredRoles.some((role) => roleValues.includes(role))) {
      const rolesList =
        requiredRoles.length === 1
          ? `"${requiredRoles[0]}"`
          : `one of: ${requiredRoles.map((r) => `"${r}"`).join(', ')}`;
      throw new Error(`You must have ${rolesList} role to log in.`);
    }
  }

  let username = '';
  if (process.env.OPENID_USERNAME_CLAIM) {
    username = userinfo[process.env.OPENID_USERNAME_CLAIM];
  } else {
    username = convertToUsername(
      userinfo.preferred_username || userinfo.username || userinfo.email,
    );
  }

  if (existingUsersOnly && !user) {
    throw new Error('User does not exist');
  }

  if (!user) {
    user = {
      provider: 'openid',
      openidId: userinfo.sub,
      username,
      email: email || '',
      emailVerified: userinfo.email_verified || false,
      name: fullName,
      idOnTheSource: userinfo.oid,
      openidIssuer,
    };

    const balanceConfig = getBalanceConfig(appConfig);
    user = await createUser(user, balanceConfig, true, true);
  } else {
    user.provider = 'openid';
    user.openidId = userinfo.sub;
    if (openidIssuer) {
      user.openidIssuer = openidIssuer;
    }
    user.username = username;
    user.name = fullName;
    user.idOnTheSource = userinfo.oid;
    if (email && email !== user.email) {
      user.email = email;
      user.emailVerified = userinfo.email_verified || false;
    }
  }

  const adminRole = process.env.OPENID_ADMIN_ROLE;
  const adminRoleParameterPath = process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH;
  const adminRoleTokenKind = process.env.OPENID_ADMIN_ROLE_TOKEN_KIND;
  let adminRoleGranted = false;

  if (adminRole && adminRoleParameterPath && adminRoleTokenKind) {
    const adminRoleObject = getRoleSource(adminRoleTokenKind, 'admin role', tokenset, userinfo);

    let adminRoles = get(adminRoleObject, adminRoleParameterPath);

    // Handle Azure AD group overage for admin role when using ID token groups
    if (adminRoleTokenKind === 'id' && adminRoleParameterPath === 'groups' && adminRoleObject) {
      const hasAdminOverage =
        adminRoleObject.hasgroups ||
        (adminRoleObject._claim_names?.groups &&
          adminRoleObject._claim_sources?.[adminRoleObject._claim_names.groups]);

      if (hasAdminOverage) {
        const overageGroups =
          resolvedOverageGroups ||
          (await resolveGroupsFromOverage(tokenset.access_token, claims.sub));
        if (overageGroups) {
          adminRoles = overageGroups;
        }
      }
    }

    let adminRoleValues = [];
    if (Array.isArray(adminRoles)) {
      adminRoleValues = adminRoles;
    } else if (typeof adminRoles === 'string') {
      adminRoleValues = adminRoles.split(/[\s,]+/).filter(Boolean);
    }

    if (adminRoles && (adminRoles === true || adminRoleValues.includes(adminRole))) {
      user.role = SystemRoles.ADMIN;
      adminRoleGranted = true;
      logger.info(`[openidStrategy] User ${username} is an admin based on role: ${adminRole}`);
    } else if (user.role === SystemRoles.ADMIN) {
      user.role = SystemRoles.USER;
      logger.info(
        `[openidStrategy] User ${username} demoted from admin - role no longer present in token`,
      );
    }
  }

  if (!adminRoleGranted) {
    const roleBeforeSync = user.role;
    await applyOpenIdRoleSync({
      user,
      username,
      tokenset,
      claims,
      userinfo,
      resolvedOverageGroups,
    });
    /**
     * The earlier login-policy check ran with the pre-sync role. If role sync moved a
     * tenant user into a different role, re-resolve the tenant config and re-enforce
     * `allowedDomains` so role-scoped overrides for the new role are honored and a token
     * cannot complete login under the previous role's looser policy.
     */
    if (user?.tenantId && user.role !== roleBeforeSync) {
      const postSyncConfig = await resolveAppConfigForUser(getAppConfig, user);
      if (!isEmailDomainAllowed(email, postSyncConfig?.registration?.allowedDomains)) {
        logger.error(
          `[OpenID Strategy] Authentication blocked after role sync - email domain not allowed [Identifier: ${email}]`,
        );
        throw new Error('Email domain not allowed');
      }
    }
  }

  if (!!userinfo && userinfo.picture && !user.avatar?.includes('manual=true')) {
    /** @type {string | undefined} */
    const imageUrl = userinfo.picture;

    let fileName;
    if (crypto) {
      fileName = (await hashToken(userinfo.sub)) + '.png';
    } else {
      fileName = userinfo.sub + '.png';
    }

    const userId = user._id.toString();
    const imageBuffer = await resizeIdentityProviderAvatar(
      imageUrl,
      userId,
      openidConfig,
      tokenset.access_token,
      userinfo.sub,
    );
    if (imageBuffer) {
      const fileStrategy = getAvatarFileStrategy(appConfig, process.env.CDN_PROVIDER);
      const { saveBuffer } = getStrategyFunctions(fileStrategy);
      const imagePath = await saveBuffer(
        getAvatarSaveParams(fileStrategy, {
          fileName,
          userId,
          buffer: imageBuffer,
          tenantId: user.tenantId,
        }),
      );
      user.avatar = imagePath ?? '';
    }
  }

  user = await updateUser(user._id, user);

  logger.info(
    `[openidStrategy] login success openidId: ${user.openidId} | email: ${user.email} | username: ${user.username} `,
    {
      user: {
        openidId: user.openidId,
        username: user.username,
        email: user.email,
        name: user.name,
      },
    },
  );

  return {
    ...user,
    tokenset,
    federatedTokens: {
      access_token: tokenset.access_token,
      id_token: tokenset.id_token,
      refresh_token: tokenset.refresh_token,
      expires_at: tokenset.expires_at,
    },
  };
}

/**
 * @param {boolean | undefined} [existingUsersOnly]
 */
function createOpenIDCallback(existingUsersOnly) {
  return async (tokenset, done) => {
    try {
      const user = await processOpenIDAuth(tokenset, existingUsersOnly);
      done(null, user);
    } catch (err) {
      if (err.message === 'Email domain not allowed') {
        return done(null, false, { message: err.message });
      }
      if (err.message === ErrorTypes.AUTH_FAILED) {
        return done(null, false, { message: err.message });
      }
      if (err.message && err.message.includes('role to log in')) {
        return done(null, false, { message: err.message });
      }
      logger.error('[openidStrategy] login failed', err);
      done(err);
    }
  };
}

/**
 * Sets up the OpenID strategy specifically for admin authentication.
 * @param {Configuration} openidConfig
 */
const setupOpenIdAdmin = (openidConfig) => {
  try {
    if (!openidConfig) {
      throw new Error('OpenID configuration not initialized');
    }

    const openidAdminLogin = new CustomOpenIDStrategy(
      {
        config: openidConfig,
        scope: process.env.OPENID_SCOPE,
        usePKCE: isEnabled(process.env.OPENID_USE_PKCE),
        clockTolerance: process.env.OPENID_CLOCK_TOLERANCE || 300,
        callbackURL: process.env.DOMAIN_SERVER + '/api/admin/oauth/openid/callback',
      },
      createOpenIDCallback(true),
    );

    passport.use('openidAdmin', openidAdminLogin);
  } catch (err) {
    logger.error('[openidStrategy] setupOpenIdAdmin', err);
  }
};

/**
 * Sets up the OpenID strategy for authentication.
 * This function configures the OpenID client, handles proxy settings,
 * and defines the OpenID strategy for Passport.js.
 *
 * @async
 * @function setupOpenId
 * @returns {Promise<Configuration | null>} A promise that resolves when the OpenID strategy is set up and returns the openid client config object.
 * @throws {Error} If an error occurs during the setup process.
 */
async function setupOpenId() {
  try {
    const usePKCE = isEnabled(process.env.OPENID_USE_PKCE);
    const shouldGenerateNonce = isEnabled(process.env.OPENID_GENERATE_NONCE);

    /** @type {ClientMetadata} */
    const clientMetadata = {
      client_id: process.env.OPENID_CLIENT_ID,
      response_types: ['code'],
      grant_types: ['authorization_code'],
    };

    const clientSecret = process.env.OPENID_CLIENT_SECRET?.trim();

    if (clientSecret) {
      clientMetadata.client_secret = clientSecret;
      if (shouldGenerateNonce) {
        clientMetadata.token_endpoint_auth_method = 'client_secret_post';
      }
    } else if (usePKCE) {
      clientMetadata.token_endpoint_auth_method = 'none';
    }

    /** @type {Configuration} */
    openidConfig = await client.discovery(
      new URL(process.env.OPENID_ISSUER),
      process.env.OPENID_CLIENT_ID,
      clientMetadata,
      undefined,
      {
        [client.customFetch]: customFetch,
      },
    );

    logger.info(`[openidStrategy] OpenID authentication configuration`, {
      usePKCE,
      hasClientSecret: !!clientSecret,
      tokenEndpointAuthMethod: clientMetadata.token_endpoint_auth_method ?? '(library default)',
      generateNonce: shouldGenerateNonce,
    });

    const openidLogin = new CustomOpenIDStrategy(
      {
        config: openidConfig,
        scope: process.env.OPENID_SCOPE,
        callbackURL: process.env.DOMAIN_SERVER + process.env.OPENID_CALLBACK_URL,
        clockTolerance: process.env.OPENID_CLOCK_TOLERANCE || 300,
        usePKCE,
      },
      createOpenIDCallback(),
    );
    passport.use('openid', openidLogin);
    setupOpenIdAdmin(openidConfig);
    return openidConfig;
  } catch (err) {
    logger.error('[openidStrategy]', err);
    return null;
  }
}

/**
 * @function getOpenIdConfig
 * @description Returns the OpenID client instance.
 * @throws {Error} If the OpenID client is not initialized.
 * @returns {Configuration}
 */
function getOpenIdConfig() {
  if (!openidConfig) {
    throw new Error('OpenID client is not initialized. Please call setupOpenId first.');
  }
  return openidConfig;
}

module.exports = {
  setupOpenId,
  getOpenIdConfig,
  getOpenIdEmail,
  getRoleSource,
};
