import axios from 'axios';
import { logger, encryptV2 } from '@librechat/data-schemas';
import { TokenExchangeMethodEnum } from 'librechat-data-provider';
import type { IToken, TokenMethods } from '@librechat/data-schemas';
import type { AxiosError } from 'axios';
import { DEFAULT_OAUTH_TOKEN_TTL_SECONDS, normalizeExpiresIn } from './expiry';
import { validateActionOAuthEndpoint } from './validation';
import { decryptSensitiveValue } from '~/actions/crypto';
import { createSSRFSafeAgents } from '~/auth';
import { logAxiosError } from '~/utils';

const actionOAuthAgents = createSSRFSafeAgents();
const actionOAuthAgentsByAddress = new Map<string, ReturnType<typeof createSSRFSafeAgents>>();

function getActionOAuthAgents(allowedAddresses?: string[] | null) {
  if (!Array.isArray(allowedAddresses) || allowedAddresses.length === 0) {
    return actionOAuthAgents;
  }

  const cacheKey = allowedAddresses.join('\n');
  const cachedAgents = actionOAuthAgentsByAddress.get(cacheKey);
  if (cachedAgents) {
    return cachedAgents;
  }

  const agents = createSSRFSafeAgents(allowedAddresses);
  actionOAuthAgentsByAddress.set(cacheKey, agents);
  return agents;
}

export function createHandleOAuthToken({
  findToken,
  updateToken,
  createToken,
}: {
  findToken: TokenMethods['findToken'];
  updateToken: TokenMethods['updateToken'];
  createToken: TokenMethods['createToken'];
}) {
  /**
   * Handles the OAuth token by creating or updating the token.
   * @param fields
   * @param fields.userId - The user's ID.
   * @param fields.token - The full token to store.
   * @param fields.identifier - Unique, alternative identifier for the token.
   * @param fields.expiresIn - The number of seconds until the token expires.
   * @param fields.metadata - Additional metadata to store with the token.
   * @param [fields.type="oauth"] - The type of token. Default is 'oauth'.
   */
  return async function handleOAuthToken({
    token,
    userId,
    identifier,
    expiresIn,
    metadata,
    type = 'oauth',
  }: {
    token: string;
    userId: string;
    identifier: string;
    expiresIn?: number | string | null;
    metadata?: Record<string, unknown>;
    type?: string;
  }): Promise<IToken | null> {
    const encrypedToken = await encryptV2(token);
    const expiresInNumber = normalizeExpiresIn(expiresIn) ?? DEFAULT_OAUTH_TOKEN_TTL_SECONDS;
    const tokenData = {
      type,
      userId,
      metadata,
      identifier,
      token: encrypedToken,
      expiresIn: expiresInNumber,
    };

    const existingToken = await findToken({ userId, identifier });
    if (existingToken) {
      return await updateToken({ identifier }, tokenData);
    } else {
      return await createToken(tokenData);
    }
  };
}

/**
 * Processes the access tokens and stores them in the database.
 * @param tokenData
 * @param tokenData.access_token
 * @param tokenData.expires_in
 * @param [tokenData.refresh_token]
 * @param [tokenData.refresh_token_expires_in]
 * @param metadata
 * @param metadata.userId
 * @param metadata.identifier
 */
async function processAccessTokens(
  tokenData: {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
  },
  { userId, identifier }: { userId: string; identifier: string },
  {
    findToken,
    updateToken,
    createToken,
  }: {
    findToken: TokenMethods['findToken'];
    updateToken: TokenMethods['updateToken'];
    createToken: TokenMethods['createToken'];
  },
) {
  const { access_token, expires_in = 3600, refresh_token, refresh_token_expires_in } = tokenData;
  if (!access_token) {
    logger.error('Access token not found: ', tokenData);
    throw new Error('Access token not found');
  }
  const handleOAuthToken = createHandleOAuthToken({
    findToken,
    updateToken,
    createToken,
  });
  await handleOAuthToken({
    identifier,
    token: access_token,
    expiresIn: expires_in,
    userId,
  });

  if (refresh_token != null) {
    logger.debug('Processing refresh token');
    await handleOAuthToken({
      token: refresh_token,
      type: 'oauth_refresh',
      userId,
      identifier: `${identifier}:refresh`,
      expiresIn: refresh_token_expires_in ?? null,
    });
  }
  logger.debug('Access tokens processed');
}

/**
 * Refreshes the access token using the refresh token.
 * @param fields
 * @param fields.userId - The ID of the user.
 * @param fields.client_url - The URL of the OAuth provider.
 * @param fields.identifier - The identifier for the token.
 * @param fields.refresh_token - The refresh token to use.
 * @param fields.token_exchange_method - The token exchange method ('default_post' or 'basic_auth_header').
 * @param fields.encrypted_oauth_client_id - The client ID for the OAuth provider.
 * @param fields.encrypted_oauth_client_secret - The client secret for the OAuth provider.
 */
export async function refreshAccessToken(
  {
    userId,
    client_url,
    identifier,
    refresh_token,
    token_exchange_method,
    encrypted_oauth_client_id,
    encrypted_oauth_client_secret,
    allowedAddresses,
  }: {
    userId: string;
    client_url: string;
    identifier: string;
    refresh_token: string;
    token_exchange_method: TokenExchangeMethodEnum;
    encrypted_oauth_client_id: string;
    encrypted_oauth_client_secret: string;
    allowedAddresses?: string[] | null;
  },
  {
    findToken,
    updateToken,
    createToken,
  }: {
    findToken: TokenMethods['findToken'];
    updateToken: TokenMethods['updateToken'];
    createToken: TokenMethods['createToken'];
  },
): Promise<{
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}> {
  await validateActionOAuthEndpoint(client_url, 'client_url', allowedAddresses);

  try {
    const oauth_client_id = await decryptSensitiveValue(encrypted_oauth_client_id);
    const oauth_client_secret = await decryptSensitiveValue(encrypted_oauth_client_secret);

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token,
    });

    if (token_exchange_method === TokenExchangeMethodEnum.BasicAuthHeader) {
      const basicAuth = Buffer.from(`${oauth_client_id}:${oauth_client_secret}`).toString('base64');
      headers['Authorization'] = `Basic ${basicAuth}`;
    } else {
      params.append('client_id', oauth_client_id);
      params.append('client_secret', oauth_client_secret);
    }

    const response = await axios({
      method: 'POST',
      url: client_url,
      headers,
      maxRedirects: 0,
      httpsAgent: getActionOAuthAgents(allowedAddresses).httpsAgent,
      data: params.toString(),
    });
    await processAccessTokens(
      response.data,
      {
        userId,
        identifier,
      },
      {
        findToken,
        updateToken,
        createToken,
      },
    );
    logger.debug(`Access token refreshed successfully for ${identifier}`);
    return response.data;
  } catch (error) {
    const message = 'Error refreshing OAuth tokens';
    throw new Error(
      logAxiosError({
        message,
        error: error as AxiosError,
      }),
    );
  }
}

/**
 * Handles the OAuth callback and exchanges the authorization code for tokens.
 * @param {object} fields
 * @param {string} fields.code - The authorization code returned by the provider.
 * @param {string} fields.userId - The ID of the user.
 * @param {string} fields.identifier - The identifier for the token.
 * @param {string} fields.client_url - The URL of the OAuth provider.
 * @param {string} fields.redirect_uri - The redirect URI for the OAuth provider.
 * @param {string} fields.token_exchange_method - The token exchange method ('default_post' or 'basic_auth_header').
 * @param {string} fields.encrypted_oauth_client_id - The client ID for the OAuth provider.
 * @param {string} fields.encrypted_oauth_client_secret - The client secret for the OAuth provider.
 */
export async function getAccessToken(
  {
    code,
    userId,
    identifier,
    client_url,
    redirect_uri,
    token_exchange_method,
    encrypted_oauth_client_id,
    encrypted_oauth_client_secret,
    allowedAddresses,
  }: {
    code: string;
    userId: string;
    identifier: string;
    client_url: string;
    redirect_uri: string;
    token_exchange_method: TokenExchangeMethodEnum;
    encrypted_oauth_client_id: string;
    encrypted_oauth_client_secret: string;
    allowedAddresses?: string[] | null;
  },
  {
    findToken,
    updateToken,
    createToken,
  }: {
    findToken: TokenMethods['findToken'];
    updateToken: TokenMethods['updateToken'];
    createToken: TokenMethods['createToken'];
  },
): Promise<{
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}> {
  await validateActionOAuthEndpoint(client_url, 'client_url', allowedAddresses);

  const oauth_client_id = await decryptSensitiveValue(encrypted_oauth_client_id);
  const oauth_client_secret = await decryptSensitiveValue(encrypted_oauth_client_secret);

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  const params = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    redirect_uri,
  });

  if (token_exchange_method === TokenExchangeMethodEnum.BasicAuthHeader) {
    const basicAuth = Buffer.from(`${oauth_client_id}:${oauth_client_secret}`).toString('base64');
    headers['Authorization'] = `Basic ${basicAuth}`;
  } else {
    params.append('client_id', oauth_client_id);
    params.append('client_secret', oauth_client_secret);
  }

  try {
    const response = await axios({
      method: 'POST',
      url: client_url,
      headers,
      maxRedirects: 0,
      httpsAgent: getActionOAuthAgents(allowedAddresses).httpsAgent,
      data: params.toString(),
    });

    await processAccessTokens(
      response.data,
      {
        userId,
        identifier,
      },
      {
        findToken,
        updateToken,
        createToken,
      },
    );
    logger.debug(`Access tokens successfully created for ${identifier}`);
    return response.data;
  } catch (error) {
    const message = 'Error exchanging OAuth code';
    throw new Error(
      logAxiosError({
        message,
        error: error as AxiosError,
      }),
    );
  }
}
