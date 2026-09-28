import { logger } from '@librechat/data-schemas';
import { extractEnvVariable } from 'librechat-data-provider';
import type { MCPOptions } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { RequestBody } from '~/types';
import {
  OPENID_TOKEN_FIELDS,
  isOpenIDTokenValid,
  extractOpenIDTokenInfo,
  processOpenIDPlaceholders,
  OpenIDReauthRequiredError,
} from './oidc';
import { getAdminApiKeyHeader } from '~/mcp/headers';

/**
 * Provenance marker for MCP servers contributed by an Agent Plugins package.
 * Applied by the plugin loader, never by a plugin-authored `mcp.json` — that
 * schema is closed, so a package declaring this field is rejected outright.
 */
export const MCP_PLUGIN_SOURCE = 'plugin';

/**
 * True when a server configuration came from an Agent Plugins package, and so
 * must reach the transport with every placeholder it declared left literal.
 */
export function isPluginSourced(config?: { source?: string } | null): boolean {
  return config?.source === MCP_PLUGIN_SOURCE;
}

/**
 * List of allowed user fields that can be used in MCP environment variables.
 * These are non-sensitive string/boolean fields from the IUser interface.
 */
const ALLOWED_USER_FIELDS = [
  'id',
  'name',
  'username',
  'email',
  'provider',
  'role',
  'googleId',
  'facebookId',
  'openidId',
  'samlId',
  'ldapId',
  'githubId',
  'discordId',
  'appleId',
  'emailVerified',
  'twoFactorEnabled',
  'termsAccepted',
  'termsAcceptedAt',
] as const;

type AllowedUserField = (typeof ALLOWED_USER_FIELDS)[number];
type SafeUser = Pick<IUser, AllowedUserField>;

/**
 * Encodes a string value to be safe for HTTP headers.
 * HTTP headers are restricted to ASCII characters (0-255) per the Fetch API standard.
 * Non-ASCII characters with Unicode values > 255 are Base64 encoded with 'b64:' prefix.
 *
 * NOTE: This is a LibreChat-specific encoding scheme to work around Fetch API limitations.
 * MCP servers receiving headers with the 'b64:' prefix should:
 * 1. Detect the 'b64:' prefix in header values
 * 2. Remove the prefix and Base64-decode the remaining string
 * 3. Use the decoded UTF-8 string as the actual value
 *
 * Example decoding (Node.js):
 *   if (headerValue.startsWith('b64:')) {
 *     const decoded = Buffer.from(headerValue.slice(4), 'base64').toString('utf8');
 *   }
 *
 * @param value - The string value to encode
 * @returns ASCII-safe string (encoded if necessary)
 *
 * @example
 * encodeHeaderValue("José")   // Returns "José" (é = 233, safe)
 * encodeHeaderValue("Marić")  // Returns "b64:TWFyacSH" (ć = 263, needs encoding)
 */
export function encodeHeaderValue(value: string): string {
  // Handle non-string or empty values
  if (!value || typeof value !== 'string') {
    return '';
  }

  // Check if string contains extended Unicode characters (> 255)
  // Characters 0-255 (ASCII + Latin-1) are safe and don't need encoding
  // Characters > 255 (e.g., ć=263, đ=272, ł=322) need Base64 encoding
  // eslint-disable-next-line no-control-regex
  const hasExtendedUnicode = /[^\u0000-\u00FF]/.test(value);

  if (!hasExtendedUnicode) {
    return value; // Safe to pass through
  }

  // Encode to Base64 for extended Unicode characters
  const base64 = Buffer.from(value, 'utf8').toString('base64');
  return `b64:${base64}`;
}

/**
 * Creates a safe user object containing only allowed fields.
 * Preserves federatedTokens for OpenID token template variable resolution.
 *
 * @param user - The user object to extract safe fields from
 * @returns A new object containing only allowed fields plus federatedTokens if present
 */
export function createSafeUser(
  user: IUser | null | undefined,
): Partial<SafeUser> & { federatedTokens?: IUser['federatedTokens'] } {
  if (!user) {
    return {};
  }

  const safeUser: Partial<SafeUser> & { federatedTokens?: IUser['federatedTokens'] } = {};
  for (const field of ALLOWED_USER_FIELDS) {
    if (field in user) {
      /**
       * Indexed write through a union-typed key would otherwise fail strict
       * checking — TS computes the LHS type as the *intersection* of all
       * field write types (which collapses to `undefined` when fields have
       * mixed types). `Object.assign` widens the assignment so each field
       * preserves its concrete type at runtime.
       */
      Object.assign(safeUser, { [field]: user[field] });
    }
  }

  // Fall back to `_id` when the mongoose virtual `id` is absent (e.g. lean/plain
  // user objects), so `{{LIBRECHAT_USER_ID}}` placeholders still resolve.
  if (!safeUser.id && '_id' in user) {
    const _id = (user as unknown as { _id: { toString?: () => string } | string })._id;
    safeUser.id = typeof _id === 'string' ? _id : _id?.toString?.();
  }

  if ('federatedTokens' in user) {
    safeUser.federatedTokens = user.federatedTokens;
  }

  return safeUser;
}

/**
 * List of allowed request body fields that can be used in header placeholders.
 * These are common fields from the request body that are safe to expose in headers.
 */
export const ALLOWED_BODY_FIELDS = ['conversationId', 'parentMessageId', 'messageId'] as const;

const OPENID_PLACEHOLDER_NAMES = `LIBRECHAT_OPENID_(?:${OPENID_TOKEN_FIELDS.join('|')}|TOKEN)`;

/**
 * Matches every placeholder this module knows how to resolve: the enumerated
 * `{{LIBRECHAT_USER_*}}`, `{{LIBRECHAT_BODY_*}}`, and `{{LIBRECHAT_OPENID_*}}`
 * names. Deliberately excludes unknown names (a typo'd placeholder staying
 * literal is diagnosable) and `{{LIBRECHAT_GRAPH_ACCESS_TOKEN}}`, which is
 * resolved asynchronously via the OBO flow outside this pipeline.
 */
const RESOLVABLE_PLACEHOLDER_PATTERN = new RegExp(
  [
    `LIBRECHAT_USER_(?:${ALLOWED_USER_FIELDS.map((field) => field.toUpperCase()).join('|')})`,
    `LIBRECHAT_BODY_(?:${ALLOWED_BODY_FIELDS.map((field) => field.toUpperCase()).join('|')})`,
    OPENID_PLACEHOLDER_NAMES,
  ]
    .map((names) => `\\{\\{(?:${names})\\}\\}`)
    .join('|'),
  'g',
);

/**
 * The subset of OpenID placeholders that cannot resolve without a usable token
 * set. Identity metadata (`USER_ID`, `USER_EMAIL`, `USER_NAME`) comes from the
 * user document and `EXPIRES_AT` is only ever a hint, so those must keep their
 * pre-existing literal-then-strip behaviour when the token set is invalid
 * rather than raising re-auth. Non-global so `exec` stays stateless, and
 * unknown names are excluded so a typo stays literal and diagnosable.
 */
const OPENID_CREDENTIAL_PLACEHOLDER_PATTERN =
  /\{\{LIBRECHAT_OPENID_(?:ACCESS_TOKEN|ID_TOKEN|TOKEN)\}\}/;

/**
 * The credential placeholders that specifically need a usable *access* token, which is all
 * `isOpenIDTokenValid` reports on. `ID_TOKEN` is absent because `processOpenIDPlaceholders`
 * validates the ID token's own expiry, so an ID-token header still resolves while no access
 * token is stored. Non-global so `exec` stays stateless.
 */
const OPENID_ACCESS_CREDENTIAL_PLACEHOLDER_PATTERN =
  /\{\{LIBRECHAT_OPENID_(?:ACCESS_TOKEN|TOKEN)\}\}/;

/**
 * Replaces resolvable-but-unresolved placeholders with an empty string so
 * LibreChat's internal template syntax is never sent upstream as if it were
 * real user data (e.g. a gateway trusting a literal
 * `{{LIBRECHAT_USER_OPENIDID}}` as an account identity would pool unrelated
 * users under that one string). Only for final resolution passes — staged
 * flows that resolve again later with more context must not strip.
 */
export function stripUnresolvedPlaceholders(value: string): string {
  return value.replace(RESOLVABLE_PLACEHOLDER_PATTERN, '');
}

/**
 * Processes a string value to replace user field placeholders.
 * When isHeader is true, non-ASCII characters in certain fields are Base64 encoded.
 *
 * @param value - The string value to process
 * @param user - The user object
 * @param isHeader - Whether this value will be used in an HTTP header
 * @returns The processed string with placeholders replaced (and encoded if necessary)
 */
function processUserPlaceholders(
  value: string,
  user?: Partial<IUser>,
  isHeader: boolean = false,
): string {
  if (!user || typeof value !== 'string') {
    return value;
  }

  for (const field of ALLOWED_USER_FIELDS) {
    const placeholder = `{{LIBRECHAT_USER_${field.toUpperCase()}}}`;

    if (typeof value !== 'string' || !value.includes(placeholder)) {
      continue;
    }

    const fieldValue = user[field as keyof IUser];

    // Skip replacement if field doesn't exist in user object
    if (!(field in user)) {
      continue;
    }

    // Special case for 'id' field: skip if undefined or empty
    if (field === 'id' && (fieldValue === undefined || fieldValue === '')) {
      continue;
    }

    let replacementValue = fieldValue == null ? '' : String(fieldValue);

    // Encode non-ASCII characters when used in headers
    // Fields like name, username, email can contain non-ASCII characters
    // that would cause ByteString conversion errors in the Fetch API
    if (isHeader) {
      const fieldsToEncode = ['name', 'username', 'email'];
      if (fieldsToEncode.includes(field)) {
        replacementValue = encodeHeaderValue(replacementValue);
      }
    }

    value = value.replace(new RegExp(placeholder, 'g'), replacementValue);
  }

  return value;
}

/**
 * Replaces request body field placeholders within a string.
 * Recognized placeholders: `{{LIBRECHAT_BODY_<FIELD>}}` where `<FIELD>` ∈ ALLOWED_BODY_FIELDS.
 * If a body field is absent or null/undefined, it is replaced with an empty string.
 *
 * @param value - The string value to process
 * @param body - The request body object
 * @returns The processed string with placeholders replaced
 */
function processBodyPlaceholders(value: string, body: RequestBody): string {
  // Type guard: ensure value is a string
  if (typeof value !== 'string') {
    return value;
  }

  for (const field of ALLOWED_BODY_FIELDS) {
    const placeholder = `{{LIBRECHAT_BODY_${field.toUpperCase()}}}`;
    if (!value.includes(placeholder)) {
      continue;
    }

    const fieldValue = body[field];
    const replacementValue = fieldValue == null ? '' : String(fieldValue);
    value = value.replace(new RegExp(placeholder, 'g'), replacementValue);
  }

  return value;
}

/**
 * Processes a single string value by replacing various types of placeholders
 *
 * @param originalValue - The original string value to process
 * @param customUserVars - Optional custom user variables to replace placeholders
 * @param user - Optional user object for replacing user field placeholders
 * @param body - Optional request body object for replacing body field placeholders
 * @param isHeader - Whether this value will be used in an HTTP header (enables encoding)
 * @returns The processed string with all placeholders replaced
 */
function processSingleValue({
  originalValue,
  customUserVars,
  user,
  body = undefined,
  isHeader = false,
  dbSourced = false,
}: {
  originalValue: string;
  customUserVars?: Record<string, string>;
  user?: Partial<IUser>;
  body?: RequestBody;
  isHeader?: boolean;
  /** When true, only resolve customUserVars — skip env vars, user/OpenID/body placeholders */
  dbSourced?: boolean;
}): string {
  // Type guard: ensure we're working with a string
  if (typeof originalValue !== 'string') {
    return String(originalValue);
  }

  let value = originalValue;

  /**
   * SECURITY INVARIANT — ordering matters:
   * Resolve env vars on the admin-authored template BEFORE any user-controlled
   * data is substituted (customUserVars, user fields, OIDC tokens, body placeholders).
   * This prevents second-order injection where user values containing ${VAR}
   * patterns would otherwise be expanded against process.env.
   */
  if (!dbSourced) {
    value = extractEnvVariable(value);
  }

  /** Runs for both dbSourced and non-dbSourced — it is the only resolution DB-stored servers get */
  if (customUserVars) {
    for (const [varName, varVal] of Object.entries(customUserVars)) {
      const escapedVarName = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const placeholderRegex = new RegExp(`\\{\\{${escapedVarName}\\}\\}`, 'g');
      value = value.replace(placeholderRegex, varVal);
    }
  }

  if (dbSourced) {
    return value;
  }

  value = processUserPlaceholders(value, user, isHeader);

  const openidTokenInfo = extractOpenIDTokenInfo(user);
  if (openidTokenInfo && isOpenIDTokenValid(openidTokenInfo)) {
    value = processOpenIDPlaceholders(value, openidTokenInfo);
  } else if (openidTokenInfo) {
    const unresolvable = OPENID_ACCESS_CREDENTIAL_PLACEHOLDER_PATTERN.exec(value);
    if (unresolvable) {
      logger.warn(
        `OpenID token is expired or unavailable; cannot resolve ${unresolvable[0]} for the current request`,
      );
      throw new OpenIDReauthRequiredError(
        `OpenID token is expired or unavailable; re-authentication is required to resolve ${unresolvable[0]}`,
      );
    }
    /**
     * `isOpenIDTokenValid` reports on the access token alone, so an ID token placeholder is not
     * its to refuse: `processOpenIDPlaceholders` validates the ID token's own expiry and raises
     * if it is stale. Every other placeholder keeps its literal-then-strip behaviour here.
     */
    value = processOpenIDPlaceholders(value, openidTokenInfo, ['ID_TOKEN']);
  }

  if (body) {
    value = processBodyPlaceholders(value, body);
  }

  return value;
}

function processAdminValue(originalValue: string, dbSourced: boolean): string {
  if (typeof originalValue !== 'string') {
    return String(originalValue);
  }
  return dbSourced ? originalValue : extractEnvVariable(originalValue);
}

/**
 * Recursively processes an object to replace environment variables in string values
 * @param params - Processing parameters
 * @param params.options - The MCP options to process
 * @param params.user - The user object containing all user fields
 * @param params.customUserVars - vars that user set in settings
 * @param params.body - the body of the request that is being processed
 * @returns - The processed object with environment variables replaced
 */
export function processMCPEnv(params: {
  options: Readonly<MCPOptions> & { dbId?: string; source?: string };
  user?: Partial<IUser>;
  customUserVars?: Record<string, string>;
  body?: RequestBody;
  /** When true, only resolve customUserVars — skip env vars, user/OpenID/body placeholders (for DB-stored servers) */
  dbSourced?: boolean;
}): MCPOptions {
  const { options, user, customUserVars, body } = params;

  if (options === null || options === undefined) {
    return options;
  }

  /**
   * SECURITY INVARIANT — Agent Plugins configurations are returned verbatim.
   * Plugin packages are portable third-party data, and the Agent Plugins
   * specification (§7.2.1, §9.2) forbids resolving any placeholder a plugin
   * declares. Without this gate a plugin could declare a header such as
   * `Authorization: Bearer ${OPENAI_API_KEY}` and receive host credentials at
   * its own origin. The check reads the config rather than a caller-supplied
   * flag so no future call site can reintroduce the leak by omitting it.
   */
  if (isPluginSourced(options)) {
    return structuredClone(options) as MCPOptions;
  }

  /** Derive dbSourced from explicit param OR from dbId on the options (failsafe for callers that forget the flag) */
  const dbSourced = params.dbSourced ?? !!options.dbId;

  const newObj: MCPOptions = structuredClone(options);

  const adminHeader = getAdminApiKeyHeader(newObj.apiKey);
  if (adminHeader) {
    const objWithHeaders = newObj as { headers?: Record<string, string> };
    objWithHeaders.headers = {
      ...objWithHeaders.headers,
      [adminHeader.name]: adminHeader.value,
    };
  }

  if ('env' in newObj && newObj.env) {
    const processedEnv: Record<string, string> = {};
    for (const [key, originalValue] of Object.entries(newObj.env)) {
      processedEnv[key] = processSingleValue({
        user,
        body,
        dbSourced,
        originalValue,
        customUserVars,
      });
    }
    newObj.env = processedEnv;
  }

  if ('args' in newObj && newObj.args) {
    const processedArgs: string[] = [];
    for (const originalValue of newObj.args) {
      processedArgs.push(
        processSingleValue({ originalValue, customUserVars, user, body, dbSourced }),
      );
    }
    newObj.args = processedArgs;
  }

  // Process headers if they exist (for WebSocket, SSE, StreamableHTTP types)
  // Note: `env` and `headers` are on different branches of the MCPOptions union type.
  if ('headers' in newObj && newObj.headers) {
    const processedHeaders: Record<string, string> = {};
    for (const [key, originalValue] of Object.entries(newObj.headers)) {
      processedHeaders[key] = processSingleValue({
        user,
        body,
        dbSourced,
        originalValue,
        customUserVars,
        isHeader: true, // Important: Enable header encoding
      });
    }
    newObj.headers = processedHeaders;
  }

  // Process OAuth headers if they exist; sent on OAuth discovery/token requests
  if ('oauth_headers' in newObj && newObj.oauth_headers) {
    const processedOAuthHeaders: Record<string, string> = {};
    for (const [key, originalValue] of Object.entries(newObj.oauth_headers)) {
      processedOAuthHeaders[key] = processSingleValue({
        user,
        body,
        dbSourced,
        originalValue,
        customUserVars,
        isHeader: true,
      });
    }
    newObj.oauth_headers = processedOAuthHeaders;
  }

  // Process URL if it exists (for WebSocket, SSE, StreamableHTTP types)
  if ('url' in newObj && newObj.url) {
    newObj.url = processSingleValue({
      user,
      body,
      dbSourced,
      customUserVars,
      originalValue: newObj.url,
    });
  }

  // Process outbound proxy if it exists (for SSE and StreamableHTTP types)
  if ('proxy' in newObj && newObj.proxy) {
    newObj.proxy = processAdminValue(newObj.proxy, dbSourced);
  }

  // Process OAuth configuration if it exists (for all transport types)
  if ('oauth' in newObj && newObj.oauth) {
    const processedOAuth: Record<string, boolean | string | string[] | undefined> = {};
    for (const [key, originalValue] of Object.entries(newObj.oauth)) {
      // Only process string values for environment variables
      // token_exchange_method is an enum and shouldn't be processed
      if (typeof originalValue === 'string') {
        processedOAuth[key] = processSingleValue({
          user,
          body,
          dbSourced,
          originalValue,
          customUserVars,
        });
      } else {
        processedOAuth[key] = originalValue;
      }
    }
    newObj.oauth = processedOAuth;
  }

  return newObj;
}

/**
 * Recursively processes a value, replacing placeholders in strings while preserving structure
 * @param value - The value to process (can be string, number, boolean, array, object, etc.)
 * @param options - Processing options
 * @returns The processed value with the same structure
 */
function processValue(
  value: unknown,
  options: {
    customUserVars?: Record<string, string>;
    user?: IUser;
    body?: RequestBody;
  },
): unknown {
  if (typeof value === 'string') {
    return processSingleValue({
      originalValue: value,
      customUserVars: options.customUserVars,
      user: options.user,
      body: options.body,
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => processValue(item, options));
  }

  if (value !== null && typeof value === 'object') {
    const processed: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      processed[key] = processValue(val, options);
    }
    return processed;
  }

  return value;
}

/**
 * Recursively resolves placeholders in a nested object structure while preserving types.
 * Only processes string values - leaves numbers, booleans, arrays, and nested objects intact.
 *
 * @param options - Configuration object
 * @param options.obj - The object to process
 * @param options.user - Optional user object for replacing user field placeholders
 * @param options.body - Optional request body object for replacing body field placeholders
 * @param options.customUserVars - Optional custom user variables to replace placeholders
 * @returns The processed object with placeholders replaced in string values
 */
export function resolveNestedObject<T = unknown>(options?: {
  obj: T | undefined;
  user?: Partial<IUser> | { id: string };
  body?: RequestBody;
  customUserVars?: Record<string, string>;
}): T {
  const { obj, user, body, customUserVars } = options ?? {};

  if (!obj) {
    return obj as T;
  }

  return processValue(obj, {
    customUserVars,
    user: user as IUser,
    body,
  }) as T;
}

/**
 * Resolves header values by replacing user placeholders, body variables, custom variables, and environment variables.
 * Automatically encodes non-ASCII characters for header safety.
 *
 * @param options - Optional configuration object
 * @param options.headers - The headers object to process
 * @param options.user - Optional user object for replacing user field placeholders (can be partial with just id)
 * @param options.body - Optional request body object for replacing body field placeholders
 * @param options.customUserVars - Optional custom user variables to replace placeholders
 * @param options.stripUnresolved - When true (final resolution passes only), replaces any
 *   remaining resolvable placeholders with an empty string so internal template syntax is
 *   never forwarded upstream. Leave unset for staged flows whose values are resolved again
 *   later with more context.
 * @returns The processed headers with all placeholders replaced
 */
export function resolveHeaders(options?: {
  headers: Record<string, string> | undefined;
  user?: Partial<IUser> | { id: string };
  body?: RequestBody;
  customUserVars?: Record<string, string>;
  stripUnresolved?: boolean;
}): Record<string, string> {
  const { headers, user, body, customUserVars, stripUnresolved = false } = options ?? {};
  const inputHeaders = headers ?? {};

  const resolvedHeaders: Record<string, string> = { ...inputHeaders };

  if (inputHeaders && typeof inputHeaders === 'object' && !Array.isArray(inputHeaders)) {
    Object.keys(inputHeaders).forEach((key) => {
      const processed = processSingleValue({
        originalValue: inputHeaders[key],
        customUserVars,
        user: user as IUser,
        body,
        isHeader: true, // Important: Enable header encoding
      });
      if (!stripUnresolved) {
        resolvedHeaders[key] = processed;
        return;
      }

      /** Reached only when the credential guard did not fire, i.e. the user has no OpenID identity at all: blanking the credential would emit `Authorization: Bearer `, which RFC 6750 rejects for a missing b64token */
      const unresolvedCredential = OPENID_CREDENTIAL_PLACEHOLDER_PATTERN.exec(processed);
      if (unresolvedCredential) {
        logger.warn(
          `Omitting header "${key}": ${unresolvedCredential[0]} could not be resolved for the current request`,
        );
        delete resolvedHeaders[key];
        return;
      }

      resolvedHeaders[key] = stripUnresolvedPlaceholders(processed);
    });
  }

  return resolvedHeaders;
}
