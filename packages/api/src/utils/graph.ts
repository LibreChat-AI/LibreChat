import { logger } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import {
  GRAPH_TOKEN_PLACEHOLDER,
  DEFAULT_GRAPH_SCOPES,
  extractOpenIDTokenInfo,
  isOpenIDTokenValid,
} from './oidc';

/**
 * Pre-computed regex for matching the Graph token placeholder.
 * Escapes curly braces in the placeholder string for safe regex use.
 */
const GRAPH_TOKEN_REGEX = new RegExp(GRAPH_TOKEN_PLACEHOLDER.replace(/[{}]/g, '\\$&'), 'g');

type GraphTokenResolvable =
  | string
  | string[]
  | boolean
  | number
  | null
  | undefined
  | Record<string, string | string[] | boolean | number | null | undefined>;

/**
 * Response from a Graph API token exchange.
 */
export interface GraphTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

/**
 * Function type for resolving Graph API tokens via OBO flow.
 * This function is injected from the main API layer since it requires
 * access to OpenID configuration and caching services.
 */
export type GraphTokenResolver = (
  user: IUser,
  accessToken: string,
  scopes: string,
  fromCache?: boolean,
) => Promise<GraphTokenResponse>;

/**
 * Options for processing Graph token placeholders.
 */
export interface GraphTokenOptions {
  user?: IUser;
  graphTokenResolver?: GraphTokenResolver;
  scopes?: string;
}

/**
 * Checks if a string contains the Graph token placeholder.
 * @param value - The string to check
 * @returns True if the placeholder is present
 */
export function containsGraphTokenPlaceholder(value: string): boolean {
  return typeof value === 'string' && value.includes(GRAPH_TOKEN_PLACEHOLDER);
}

/**
 * Checks if any value in a record contains the Graph token placeholder.
 * @param record - The record to check (e.g., headers, env vars)
 * @returns True if any value contains the placeholder
 */
export function recordContainsGraphTokenPlaceholder(
  record: Record<string, string> | undefined,
): boolean {
  if (!record || typeof record !== 'object') {
    return false;
  }
  return Object.values(record).some(containsGraphTokenPlaceholder);
}

function valueContainsGraphTokenPlaceholder(value: GraphTokenResolvable): boolean {
  if (typeof value === 'string') {
    return containsGraphTokenPlaceholder(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsGraphTokenPlaceholder);
  }
  if (value == null || typeof value !== 'object') {
    return false;
  }
  return Object.values(value).some(valueContainsGraphTokenPlaceholder);
}

/**
 * Checks if MCP options contain the Graph token placeholder in connection fields.
 * @param options - The MCP options object
 * @returns True if any field contains the placeholder
 */
export function mcpOptionsContainGraphTokenPlaceholder(options: {
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
  oauth?: Record<string, string | string[] | boolean | number | null | undefined>;
  oauth_headers?: Record<string, string>;
  url?: string;
}): boolean {
  if (options.url && containsGraphTokenPlaceholder(options.url)) {
    return true;
  }
  if (options.args?.some(containsGraphTokenPlaceholder)) {
    return true;
  }
  if (recordContainsGraphTokenPlaceholder(options.headers)) {
    return true;
  }
  if (recordContainsGraphTokenPlaceholder(options.env)) {
    return true;
  }
  if (recordContainsGraphTokenPlaceholder(options.oauth_headers)) {
    return true;
  }
  return valueContainsGraphTokenPlaceholder(options.oauth);
}

/**
 * Asynchronously resolves Graph token placeholders in a string.
 * This function must be called before the synchronous processMCPEnv pipeline.
 *
 * @param value - The string containing the placeholder
 * @param options - Options including user and graph token resolver
 * @returns The string with Graph token placeholder replaced
 */
export async function resolveGraphTokenPlaceholder(
  value: string,
  options: GraphTokenOptions,
): Promise<string> {
  if (!containsGraphTokenPlaceholder(value)) {
    return value;
  }

  const { user, graphTokenResolver, scopes } = options;

  if (!user || !graphTokenResolver) {
    logger.warn(
      '[resolveGraphTokenPlaceholder] User or graphTokenResolver not provided, cannot resolve Graph token',
    );
    return value;
  }

  const tokenInfo = extractOpenIDTokenInfo(user);
  if (!tokenInfo || !isOpenIDTokenValid(tokenInfo)) {
    logger.warn(
      '[resolveGraphTokenPlaceholder] No valid OpenID token available for Graph token exchange',
    );
    return value;
  }

  if (!tokenInfo.accessToken) {
    logger.warn('[resolveGraphTokenPlaceholder] No access token available for OBO exchange');
    return value;
  }

  try {
    const graphScopes = scopes || process.env.GRAPH_API_SCOPES || DEFAULT_GRAPH_SCOPES;
    const graphTokenResponse = await graphTokenResolver(
      user,
      tokenInfo.accessToken,
      graphScopes,
      true, // Use cache
    );

    if (graphTokenResponse?.access_token) {
      return value.replace(GRAPH_TOKEN_REGEX, graphTokenResponse.access_token);
    }

    logger.warn(
      '[resolveGraphTokenPlaceholder] Graph token exchange did not return an access token',
    );
    return value;
  } catch (error) {
    logger.error('[resolveGraphTokenPlaceholder] Failed to exchange token for Graph API:', error);
    return value;
  }
}

/**
 * Asynchronously resolves Graph token placeholders in a record of string values.
 *
 * @param record - The record containing placeholders (e.g., headers)
 * @param options - Options including user and graph token resolver
 * @returns The record with Graph token placeholders replaced
 */
export async function resolveGraphTokensInRecord(
  record: Record<string, string> | undefined,
  options: GraphTokenOptions,
): Promise<Record<string, string> | undefined> {
  if (!record || typeof record !== 'object') {
    return record;
  }

  if (!recordContainsGraphTokenPlaceholder(record)) {
    return record;
  }

  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    resolved[key] = await resolveGraphTokenPlaceholder(value, options);
  }
  return resolved;
}

async function resolveGraphTokensInArray(
  values: string[] | undefined,
  options: GraphTokenOptions,
): Promise<string[] | undefined> {
  if (!values || !values.some(containsGraphTokenPlaceholder)) {
    return values;
  }

  const resolved: string[] = [];
  for (const value of values) {
    resolved.push(await resolveGraphTokenPlaceholder(value, options));
  }
  return resolved;
}

async function resolveGraphTokensInOAuth(
  oauth: Record<string, string | string[] | boolean | number | null | undefined> | undefined,
  options: GraphTokenOptions,
): Promise<Record<string, string | string[] | boolean | number | null | undefined> | undefined> {
  if (!oauth || !valueContainsGraphTokenPlaceholder(oauth)) {
    return oauth;
  }

  const resolved: Record<string, string | string[] | boolean | number | null | undefined> = {};
  for (const [key, value] of Object.entries(oauth)) {
    if (typeof value === 'string') {
      resolved[key] = await resolveGraphTokenPlaceholder(value, options);
    } else if (Array.isArray(value)) {
      resolved[key] = await resolveGraphTokensInArray(value, options);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Pre-processes MCP options to resolve Graph token placeholders.
 * This must be called before processMCPEnv since Graph token resolution is async.
 *
 * @param options - The MCP options object
 * @param graphOptions - Options for Graph token resolution
 * @returns The options with Graph token placeholders resolved
 */
export async function preProcessGraphTokens<
  T extends {
    args?: string[];
    headers?: Record<string, string>;
    env?: Record<string, string>;
    oauth?: Record<string, string | string[] | boolean | number | null | undefined>;
    oauth_headers?: Record<string, string>;
    url?: string;
  },
>(options: T, graphOptions: GraphTokenOptions): Promise<T> {
  if (!mcpOptionsContainGraphTokenPlaceholder(options)) {
    return options;
  }

  const result = { ...options };

  if (result.url && containsGraphTokenPlaceholder(result.url)) {
    result.url = await resolveGraphTokenPlaceholder(result.url, graphOptions);
  }

  if (result.args) {
    result.args = await resolveGraphTokensInArray(result.args, graphOptions);
  }

  if (result.headers) {
    result.headers = await resolveGraphTokensInRecord(result.headers, graphOptions);
  }

  if (result.env) {
    result.env = await resolveGraphTokensInRecord(result.env, graphOptions);
  }

  if (result.oauth_headers) {
    result.oauth_headers = await resolveGraphTokensInRecord(result.oauth_headers, graphOptions);
  }

  if (result.oauth) {
    result.oauth = await resolveGraphTokensInOAuth(result.oauth, graphOptions);
  }

  return result;
}
