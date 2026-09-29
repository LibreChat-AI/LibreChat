import { logger } from '@librechat/data-schemas';
import {
  Constants,
  MCPOptionsSchema,
  extractEnvVariable,
  normalizeServerName,
  normalizeMCPToolKey,
  buildServerNameAliases,
} from 'librechat-data-provider';
import type { AgentToolOptions, MCPOptions } from 'librechat-data-provider';
import type { ParsedServerConfig } from '~/mcp/types';
import type { RequestBody } from '~/types';
import { isDirectOpenIDBearerRecoveryEnabled } from '~/mcp/openid';
import { ALLOWED_BODY_FIELDS, isPluginSourced } from '~/utils/env';
import { isApiKeyHeaderOverridden } from './headers';
import { isEnabled } from '~/utils/common';

export const mcpToolPattern: RegExp = new RegExp(`^.+${Constants.mcp_delimiter}.+$`);

function isMCPServerConfig(config: unknown): config is ParsedServerConfig {
  return MCPOptionsSchema.safeParse(config).success;
}

/** Validates an effective MCP config without stripping its server-managed metadata. */
export function validateMCPServerConfig(config: unknown): ParsedServerConfig {
  if (!isMCPServerConfig(config)) {
    throw new Error('Invalid effective MCP server configuration');
  }
  return config;
}

/**
 * Prefix of the lazily-expanded MCP placeholder `mcp_all<delim><server>`,
 * pushed into an agent's `tools` for overlay/user-connection servers whose
 * tool names are not known until the definitions loader expands them.
 *
 * The name is reserved by that convention: the definitions loader treats ANY
 * matching entry as "expand every tool on this server", so a remote tool
 * literally named `mcp_all` cannot be addressed individually anywhere in the
 * pipeline. Kept here as the one definition of the prefix.
 */
export const MCP_ALL_PLACEHOLDER_PREFIX: string = `${Constants.mcp_all}${Constants.mcp_delimiter}`;

/** Whether a tool entry is the lazily-expanded `mcp_all` placeholder. */
export function isMCPAllPlaceholder(toolName: string): boolean {
  return toolName.startsWith(MCP_ALL_PLACEHOLDER_PREFIX);
}

/** Server-pin token (`sys__server__sys<delim><server>`) that keeps a server
 *  attached to an agent independent of its tool selection. */
const MCP_SERVER_TOKEN_PREFIX: string = `${Constants.mcp_server}${Constants.mcp_delimiter}`;

/**
 * Later-configured server names whose normalized form is already claimed by an
 * earlier different name. Such a pair produces IDENTICAL model-facing tool
 * keys, so tool selection and execution cannot tell the servers apart —
 * `buildServerNameAliases` deterministically routes to the first name, and
 * the shadowed later server must be EXCLUDED from tool exposure entirely:
 * offering its tools would let a user select a tool that silently executes
 * against the first server's configuration.
 */
/**
 * Whether a resolved server name is normalization-sensitive — its own name
 * needs normalizing, or it EQUALS the normalized form of some configured
 * special-character name. Under an incomplete collision audit these are the
 * references whose routing cannot be proven unambiguous, so they fail closed.
 */
export function isNormalizationSensitiveName(
  serverName: string,
  rawServerNames: readonly string[],
): boolean {
  if (normalizeServerName(serverName) !== serverName) {
    return true;
  }
  return rawServerNames.some(
    (raw) => raw !== serverName && normalizeServerName(raw) === serverName,
  );
}

export function findShadowedServerNames(rawServerNames: readonly string[]): Set<string> {
  /** Derived from `buildServerNameAliases` so shadow detection can never
   *  diverge from the tie-break routing actually uses (identity entries
   *  first, then configuration order). */
  const aliases = buildServerNameAliases(rawServerNames);
  const shadowed = new Set<string>();
  for (const raw of rawServerNames) {
    if (raw && aliases.get(normalizeServerName(raw)) !== raw) {
      shadowed.add(raw);
    }
  }
  return shadowed;
}

/**
 * Heals legacy persisted agent data whose MCP tool keys embed a RAW server
 * name: model-facing keys carry `normalizeServerName(server)` (matching cache
 * keys, definition names, and runtime instance names), so an agent document
 * saved before that convention — or through the old raw-keyed cache — would
 * neither load its tools nor have its `tool_options` (defer / programmatic /
 * background / intent) honored for a server whose name needs normalizing.
 *
 * Placeholder and server-pin tokens are left untouched: they are
 * config-identity references consumed against raw config names (the client's
 * selectors, the definitions loader's expansion), never model-facing names.
 * Returns the same references when nothing needs rewriting, so the common
 * path (every server name already normalized) allocates nothing.
 */
export function normalizeAgentToolKeys(params: {
  tools: string[] | undefined;
  toolOptions: AgentToolOptions | undefined;
  rawServerNames: readonly string[];
}): { tools: string[] | undefined; toolOptions: AgentToolOptions | undefined } {
  const { tools, toolOptions, rawServerNames } = params;
  /**
   * A SHADOWED server (its normalized form claimed by an earlier different
   * name) must NOT be healed: rewriting its raw key would produce the first
   * server's key exactly, silently executing the wrong server's action. Left
   * raw, the key fails to match the (normalized-keyed) tool map and the tool
   * errors visibly — broken beats misrouted.
   */
  const shadowed = findShadowedServerNames(rawServerNames);
  const rewritableNames = rawServerNames.filter(
    (name) => normalizeServerName(name) !== name && !shadowed.has(name),
  );
  if (rewritableNames.length === 0) {
    return { tools, toolOptions };
  }

  const rewriteKey = (key: string): string => {
    if (
      !key.includes(Constants.mcp_delimiter) ||
      isMCPAllPlaceholder(key) ||
      key.startsWith(MCP_SERVER_TOKEN_PREFIX)
    ) {
      return key;
    }
    return normalizeMCPToolKey(key, rewritableNames);
  };

  let toolsChanged = false;
  let nextTools = tools?.map((key) => {
    const rewritten = rewriteKey(key);
    if (rewritten !== key) {
      toolsChanged = true;
    }
    return rewritten;
  });
  /** A document carrying BOTH spellings converges on one key after healing —
   *  collapse duplicates (order-preserving) so the loaders never build two
   *  instances with the same function name. */
  if (toolsChanged && nextTools) {
    const seen = new Set<string>();
    nextTools = nextTools.filter((key) => {
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  let optionsChanged = false;
  let nextOptions: AgentToolOptions | undefined;
  if (toolOptions) {
    nextOptions = {};
    for (const [key, options] of Object.entries(toolOptions)) {
      const rewritten = rewriteKey(key);
      if (rewritten !== key) {
        optionsChanged = true;
      }
      /** When both spellings carry options, the CURRENT (normalized) entry
       *  wins regardless of object insertion order — a legacy entry must not
       *  clobber settings a client already wrote under the new spelling. */
      nextOptions[rewritten] =
        rewritten !== key
          ? { ...options, ...nextOptions[rewritten] }
          : { ...nextOptions[key], ...options };
    }
  }

  return {
    tools: toolsChanged ? nextTools : tools,
    toolOptions: optionsChanged ? nextOptions : toolOptions,
  };
}

const RUNTIME_CONTEXT_PLACEHOLDER_PATTERN = /\{\{LIBRECHAT_(?:USER|OPENID|GRAPH)_[^}]+\}\}/;
const BODY_PLACEHOLDER_FIELDS = Object.fromEntries(
  ALLOWED_BODY_FIELDS.map((field) => [field.toUpperCase(), field]),
) as Record<string, keyof RequestBody>;
const RUNTIME_BODY_FIELD_NAMES = Object.keys(BODY_PLACEHOLDER_FIELDS).join('|');
const RUNTIME_BODY_PLACEHOLDER_PATTERN = new RegExp(
  `\\{\\{LIBRECHAT_BODY_(?:${RUNTIME_BODY_FIELD_NAMES})\\}\\}`,
);
const RUNTIME_BODY_PLACEHOLDER_CAPTURE_PATTERN = new RegExp(
  `\\{\\{LIBRECHAT_BODY_(${RUNTIME_BODY_FIELD_NAMES})\\}\\}`,
  'g',
);

type PlaceholderValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly PlaceholderValue[]
  | { readonly [key: string]: PlaceholderValue };

export interface MCPRequestScope {
  requestScoped: boolean;
  requiredBodyFields: Array<keyof RequestBody>;
}

type UserScopedConnectionConfig = Pick<
  ParsedServerConfig,
  'requiresOAuth' | 'source' | 'dbId' | 'startup'
> & {
  /** Loosened like the fields below: raw (pre-inspection) configs carry
   *  optional API-key fields, and the gating predicates only inspect them. */
  apiKey?: Partial<NonNullable<ParsedServerConfig['apiKey']>> | null;
  args?: string[];
  /** Loosened from the parsed shapes so raw (pre-inspection) configs qualify;
   *  scoping predicates only check key presence */
  obo?: { scopes?: string } | null;
  customUserVars?: Record<
    string,
    { description?: string; title?: string; sensitive?: boolean } | undefined
  >;
  env?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  /** Operator-configured headers sent only on chat-time connections. */
  requestHeaders?: Record<string, string | undefined>;
  oauth?: PlaceholderValue;
  oauth_headers?: Record<string, string | undefined>;
  url?: string;
};

function mergeHeaderMaps<T extends string | undefined>(
  headers: Record<string, T> | undefined,
  requestHeaders: Record<string, T>,
): Record<string, T> {
  const overridden = new Set(Object.keys(requestHeaders).map((name) => name.toLowerCase()));
  const merged: Record<string, T> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!overridden.has(name.toLowerCase())) {
      merged[name] = value;
    }
  }
  return { ...merged, ...requestHeaders };
}

function placeholderBearingFields(config: UserScopedConnectionConfig): PlaceholderValue[] {
  return [
    isApiKeyHeaderOverridden(config.apiKey, config.requestHeaders) ? undefined : config.apiKey?.key,
    config.args,
    config.env,
    config.requestHeaders == null
      ? config.headers
      : mergeHeaderMaps(config.headers, config.requestHeaders),
    config.oauth,
    config.oauth_headers,
    config.url,
  ];
}

/** Whether a server should use MCP OAuth handling. */
export function isOAuthServer(
  config: Pick<ParsedServerConfig, 'requiresOAuth' | 'oauth'>,
): boolean {
  if (config.requiresOAuth === false) {
    return false;
  }
  return config.requiresOAuth === true || config.oauth != null;
}

/**
 * Whether a server needs the OAuth-style connection wiring (flow manager,
 * token methods, OBO/OAuth resolvers). Distinct from `isOAuthServer`: OBO
 * servers reuse the same wiring even though they don't run an OAuth handshake,
 * because the runtime needs `oboTokenResolver`/`oboTrustChecker` plumbed through.
 *
 * Without this, an OBO server with `requiresOAuth: false` would land in the
 * non-OAuth branch of MCPManager.discoverServerTools / UserConnectionManager,
 * which omits the OBO resolver — `usesObo` then evaluates to false in the
 * factory and the connection sends a bare request that the upstream rejects.
 */
export function requiresOAuthMachinery(config: ParsedServerConfig): boolean {
  if (isDirectOpenIDBearerRecoveryEnabled(config)) {
    return false;
  }
  return isOAuthServer(config) || config.obo != null;
}

/** Required chat credentials, retaining explicit variables and any still-used generated key. */
function requiredCustomUserVars(config: UserScopedConnectionConfig): string[] {
  const keys = Object.keys(config.customUserVars ?? {});
  if (
    config.apiKey?.source !== 'user' ||
    !isApiKeyHeaderOverridden(config.apiKey, config.requestHeaders) ||
    placeholderBearingFields(config).some((value) => hasPlaceholder(value, /\{\{MCP_API_KEY\}\}/))
  ) {
    return keys;
  }
  return keys.filter((key) => key !== 'MCP_API_KEY');
}

/** Checks the effective chat requirements, without weakening catalog-only credentials. */
export function hasCustomUserVars(config: UserScopedConnectionConfig): boolean {
  return requiredCustomUserVars(config).length > 0;
}

function hasRuntimeContextPlaceholder(value: PlaceholderValue): boolean {
  return (
    hasPlaceholder(value, RUNTIME_CONTEXT_PLACEHOLDER_PATTERN) ||
    hasPlaceholder(value, RUNTIME_BODY_PLACEHOLDER_PATTERN)
  );
}

function hasPlaceholder(value: PlaceholderValue, pattern: RegExp): boolean {
  if (typeof value === 'string') {
    return pattern.test(value) || pattern.test(extractEnvVariable(value));
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasPlaceholder(item, pattern));
  }

  if (value == null || typeof value !== 'object') {
    return false;
  }

  return Object.values(value).some((item) => hasPlaceholder(item, pattern));
}

function addRuntimeBodyPlaceholderFields(
  value: PlaceholderValue,
  fields: Set<keyof RequestBody>,
): void {
  if (typeof value === 'string') {
    for (const candidate of new Set([value, extractEnvVariable(value)])) {
      for (const match of candidate.matchAll(RUNTIME_BODY_PLACEHOLDER_CAPTURE_PATTERN)) {
        const placeholderKey = match[1];
        const field = placeholderKey ? BODY_PLACEHOLDER_FIELDS[placeholderKey] : undefined;
        if (field) {
          fields.add(field);
        }
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      addRuntimeBodyPlaceholderFields(item, fields);
    }
    return;
  }

  if (value == null || typeof value !== 'object') {
    return;
  }

  for (const item of Object.values(value)) {
    addRuntimeBodyPlaceholderFields(item, fields);
  }
}

function canResolveRuntimePlaceholders(config: UserScopedConnectionConfig): boolean {
  return !isUserSourced(config) && !isPluginSourced(config);
}

/**
 * Trusted YAML/config servers may use per-user/request placeholders that can
 * only be resolved once a real request context exists. User-sourced DB servers
 * deliberately stay sandboxed and only resolve customUserVars, while plugin
 * configs preserve every placeholder literally as a security boundary.
 */
export function hasRuntimeContextPlaceholders(config: UserScopedConnectionConfig): boolean {
  if (!canResolveRuntimePlaceholders(config)) {
    return false;
  }

  return placeholderBearingFields(config).some(hasRuntimeContextPlaceholder);
}

export function hasRuntimeUrlPlaceholders(config: UserScopedConnectionConfig): boolean {
  if (!canResolveRuntimePlaceholders(config)) {
    return false;
  }

  return hasRuntimeContextPlaceholder(config.url);
}

export function getMCPRequestScope(config: UserScopedConnectionConfig): MCPRequestScope {
  if (!canResolveRuntimePlaceholders(config)) {
    return { requestScoped: false, requiredBodyFields: [] };
  }

  const requiredBodyFields = new Set<keyof RequestBody>();
  for (const value of placeholderBearingFields(config)) {
    addRuntimeBodyPlaceholderFields(value, requiredBodyFields);
  }

  const fields = Array.from(requiredBodyFields);
  return { requestScoped: fields.length > 0, requiredBodyFields: fields };
}

/**
 * Folds the operator's chat-only `requestHeaders` into `headers`, so everything
 * downstream — direct-bearer detection, Graph preprocessing, `processMCPEnv`,
 * the transports — keeps reading ONE header map and never has to learn about a
 * second one. Called at the entry of each resolution pipeline, before any
 * consumer inspects the config.
 *
 * HTTP header names are case-insensitive, so a base `Authorization` is dropped
 * when the request map declares `authorization`: keeping both would let Undici
 * join the values (`old, new`) instead of letting `requestHeaders` win.
 *
 * The field is consumed as it merges, making this idempotent for a config that
 * passes through twice (checkout joiners, direct-bearer recovery).
 */
export function applyRequestHeaders<T extends MCPOptions>(config: T): T {
  const carrier = config as T & {
    headers?: Record<string, string>;
    requestHeaders?: Record<string, string>;
  };
  if (carrier.requestHeaders == null) {
    return config;
  }

  const merged = {
    ...carrier,
    headers: mergeHeaderMaps(carrier.headers, carrier.requestHeaders),
  };
  if (carrier.apiKey && isApiKeyHeaderOverridden(carrier.apiKey, carrier.requestHeaders)) {
    /** Keep the explicit auth mode, but disarm its lower-priority header injection. */
    merged.apiKey = { ...carrier.apiKey, key: undefined };
  }
  if (carrier.customUserVars) {
    const required = new Set(requiredCustomUserVars(carrier));
    merged.customUserVars = Object.fromEntries(
      Object.entries(carrier.customUserVars).filter(([key]) => required.has(key)),
    );
  }
  delete merged.requestHeaders;
  return merged;
}

/**
 * Strips the operator's chat-only `requestHeaders` for a catalog (discovery)
 * connection. Discovery has no conversation or message to resolve a
 * `{{LIBRECHAT_BODY_*}}` placeholder against, so sending the map at all would
 * either leak a literal placeholder upstream or resolve it to an empty value.
 *
 * Returns the same reference when there is nothing to strip.
 */
export function toCatalogConnectionConfig<T extends MCPOptions>(config: T): T {
  const carrier = config as T & { requestHeaders?: Record<string, string> };
  if (carrier.requestHeaders == null) {
    return config;
  }
  const catalogConfig = { ...carrier };
  delete catalogConfig.requestHeaders;
  return catalogConfig;
}

export function getRuntimeBodyPlaceholderFields(
  config: UserScopedConnectionConfig,
): Array<keyof RequestBody> {
  return getMCPRequestScope(config).requiredBodyFields;
}

export function getMissingRuntimeBodyPlaceholderFields(
  config: UserScopedConnectionConfig,
  requestBody?: RequestBody,
): string[] {
  return getMCPRequestScope(config).requiredBodyFields.filter((field) => {
    const value = requestBody?.[field];
    return value == null || (typeof value === 'string' && value.trim() === '');
  });
}

/**
 * `BODY` placeholders vary by chat request, so the normal userId:serverName
 * cache would reuse a connection built with stale request context.
 *
 * Ephemeral connections are created and torn down per tool call — configs using
 * these placeholders pay a full connect + initialize on every invocation.
 *
 * User/OpenID/Graph placeholders still require user-scoped connections, but they
 * are not request-scoped by themselves. HTTP transports refresh resolved headers
 * before each tool call, so token/user headers can remain on the cached user
 * connection without forcing a reconnect for every invocation.
 */
export function requiresEphemeralUserConnection(config: UserScopedConnectionConfig): boolean {
  return getMCPRequestScope(config).requestScoped;
}

/**
 * Whether a resolved server config may be reached from the chat MCP picker.
 *
 * Mirrors `selectableServers` in the client's `useMCPServerManager`, which is
 * the list the dropdown offers: `chatMenu: false` is the operator hiding a
 * server from chat, and `consumeOnly` marks a server the user reaches only
 * through an agent that references it, never on its own.
 *
 * An unresolved config is selectable. A name the registry cannot resolve is
 * either request-tier (declared on the request body and never registered) or
 * genuinely unknown, and both already have their own handling downstream —
 * failing closed here would silently drop request-scoped servers instead.
 */
export function isChatSelectableMCPServer(
  config?: Pick<ParsedServerConfig, 'chatMenu' | 'consumeOnly'> | null,
): boolean {
  if (config == null) {
    return true;
  }
  return config.chatMenu !== false && config.consumeOnly !== true;
}

/**
 * Narrows a chat picker selection to the servers that picker is allowed to
 * offer, so a stale client, a replayed body, or a hand-written request cannot
 * reach a server the menu hides.
 *
 * Pass only the picker's own selection. Servers a model spec pins
 * (`modelSpec.mcpServers`) are the operator's choice and stay attached even
 * when hidden, so they must be added after this call, not through it.
 *
 * The accessible set comes from the registry — the same resolution that feeds
 * the client's catalog, with its own tier precedence already applied — rather
 * than being re-derived from the request's config overlay. A user-tier or
 * process-backed server outranks a config entry of the same name, and this must
 * agree with whatever the picker was actually offered.
 *
 * Names are deduplicated before the lookup, since the selection is
 * request-supplied, and are matched through the same normalized-name aliasing
 * that tool loading uses, built over the whole accessible set so an exact name
 * always wins over another server's normalized form. A name the registry does
 * not know is request-tier — declared on the body, never registered — and is
 * kept, as is every name if the lookup fails: this narrows an
 * already-authenticated selection and is not the authorization boundary.
 *
 * Returns the names as they were sent, so callers keep addressing servers the
 * way the rest of the request does.
 */
export async function filterChatSelectableMCPServers(
  selectedServers: string[] | null | undefined,
  {
    userId,
    role,
    getAccessibleMCPServers,
  }: {
    userId: string;
    role?: string;
    getAccessibleMCPServers?: (
      userId: string,
      role?: string,
    ) => Promise<Record<string, Pick<ParsedServerConfig, 'chatMenu' | 'consumeOnly'>>>;
  },
): Promise<string[]> {
  if (!Array.isArray(selectedServers) || selectedServers.length === 0) {
    return [];
  }
  const uniqueServers = [...new Set(selectedServers)];
  if (getAccessibleMCPServers == null) {
    return uniqueServers;
  }

  let accessible: Record<string, Pick<ParsedServerConfig, 'chatMenu' | 'consumeOnly'>>;
  try {
    accessible = await getAccessibleMCPServers(userId, role);
  } catch (error) {
    logger.warn('[MCP] Could not resolve accessible servers; keeping the chat selection', error);
    return uniqueServers;
  }

  const accessibleNames = Object.keys(accessible ?? {});
  if (accessibleNames.length === 0) {
    return uniqueServers;
  }
  const aliases = buildServerNameAliases(accessibleNames);

  return uniqueServers.filter((serverName) => {
    const resolved =
      accessible[serverName] ?? accessible[aliases.get(normalizeServerName(serverName)) ?? ''];
    return isChatSelectableMCPServer(resolved);
  });
}

/**
 * Returns true when a server requires a per-user connection instead of an
 * app-shared connection.
 */
export function requiresUserScopedConnection(config: UserScopedConnectionConfig): boolean {
  return (
    config.requiresOAuth === true ||
    config.obo != null ||
    hasCustomUserVars(config) ||
    hasRuntimeContextPlaceholders(config)
  );
}

/**
 * Whether the config declares chat-only headers. Guards against a truthy `{}`
 * the way `hasCustomUserVars` does.
 */
function hasChatOnlyHeaders(config: UserScopedConnectionConfig): boolean {
  return !!config.requestHeaders && Object.keys(config.requestHeaders).length > 0;
}

/** Whether a server can share one operator-owned connection across all users. */
export function canUseAppConnection(config: UserScopedConnectionConfig): boolean {
  return (
    config.startup !== false &&
    !isUserSourced(config) &&
    !requiresUserScopedConnection(config) &&
    /**
     * One session cannot serve both sides of `requestHeaders`: an app-shared
     * connection's own `initialize` and `tools/list` are catalog requests that
     * must omit them, while its chat tool calls must send them. Placeholder
     * values are already excluded through `requiresUserScopedConnection`; STATIC
     * values reach here, and sharing would bake chat-only headers into the
     * startup handshake every later catalog read reuses.
     */
    !hasChatOnlyHeaders(config)
  );
}

/**
 * Server instructions fetched from a connection are safe to retain in the
 * shared YAML registry only when the connection cannot vary by identity or
 * request. `startup: false` is the one context-independent reason startup
 * inspection leaves instructions unresolved; every other deferred case can
 * expose authenticated or request-specific instructions to another user.
 */
export function canBackfillSharedServerInstructions(config: UserScopedConnectionConfig): boolean {
  return (
    config.startup === false &&
    !hasChatOnlyHeaders(config) &&
    !requiresUserScopedConnection(config) &&
    /** A configured `oauth` block is identity-scoped even when `requiresOAuth`
     *  is unset or was stamped `false` by the skipped startup inspection —
     *  `requiresUserScopedConnection` alone would let it through while
     *  `isOAuthServer` still arms the OAuth machinery for the unstamped case. */
    config.oauth == null &&
    config.oauth_headers == null &&
    config.apiKey?.source !== 'user'
  );
}

/**
 * Returns the names of `customUserVars` declared on the server config for which
 * the user has not supplied a non-blank value (unset, empty, or whitespace-only
 * values count as missing, since they still fail auth). An empty array means
 * every declared variable is satisfied (or the server declares none).
 *
 * Used to gate tool exposure: a server that requires user-provided credentials
 * should not surface its tools to the model until those values are set,
 * otherwise every tool call fails authentication. See issue #10969.
 */
export function getMissingCustomUserVars(
  config: UserScopedConnectionConfig,
  providedVars?: Record<string, string> | null,
): string[] {
  if (!hasCustomUserVars(config)) {
    return [];
  }
  return requiredCustomUserVars(config).filter((key) => {
    const value = providedVars?.[key];
    return value == null || (typeof value === 'string' && value.trim() === '');
  });
}

/**
 * Determines whether a server config is user-sourced (sandboxed placeholder resolution).
 * When `source` is set, it is authoritative. When absent (pre-upgrade cached configs),
 * falls back to the legacy `dbId` heuristic for backward compatibility.
 */
export function isUserSourced(config: Pick<ParsedServerConfig, 'source' | 'dbId'>): boolean {
  return config.source != null ? config.source === 'user' : !!config.dbId;
}

/**
 * Resolves the instructions text for a server, mirroring how the inspector fills them:
 * an enabled flag resolves to the text fetched from the server, while an operator-authored
 * string is used verbatim. Anything else (`false`, unset) yields no instructions.
 */
export function resolveServerInstructions(config: ParsedServerConfig): string | undefined {
  const declared = config.serverInstructions;
  if (isEnabled(declared)) return config.resolvedInstructions;
  return typeof declared === 'string' ? declared : undefined;
}

export type RedactedServerConfig = Partial<ParsedServerConfig> & {
  /** True when this config needs chat request fields before it can connect. */
  requestScoped?: boolean;
};

/**
 * Allowlist-based sanitization for API responses. Only explicitly listed fields are included;
 * new fields added to ParsedServerConfig are excluded by default until allowlisted here.
 *
 * `url` and the oauth flow URLs (`authorization_url`, `token_url`, `revocation_endpoint`) can
 * encode internal infrastructure, so they are stripped unless `canEdit` is set: the same
 * disclosure threshold the PATCH route enforces. Callers derive `canEdit` per server (operator
 * YAML/config-tier servers from the MANAGE_MCP_SERVERS capability, user-sourced servers from
 * per-resource ACL EDIT), so a user-sourced config shared view-only does not disclose its URL
 * to the viewer.
 * DB-stored configs reject ${VAR} patterns at validation time (MCPServerUserInputSchema);
 * env variable resolution is handled at the schema/input boundary.
 */
export function redactServerSecrets(
  config: ParsedServerConfig,
  options?: { canEdit?: boolean },
): RedactedServerConfig {
  const safe: RedactedServerConfig = {
    type: config.type,
    url: config.url,
    title: config.title,
    description: config.description,
    iconPath: config.iconPath,
    chatMenu: config.chatMenu,
    requiresOAuth: config.requiresOAuth,
    capabilities: config.capabilities,
    tools: config.tools,
    toolFunctions: config.toolFunctions,
    initDuration: config.initDuration,
    updatedAt: config.updatedAt,
    dbId: config.dbId,
    /** Trust tier (yaml/config/user) — safe to expose; used by the UI for display purposes. */
    source: config.source,
    consumeOnly: config.consumeOnly,
    inspectionFailed: config.inspectionFailed,
    customUserVars: config.customUserVars,
    serverInstructions: config.serverInstructions,
    /** Safe derived metadata: it exposes no placeholder-bearing value, but lets
     *  clients attach tools that can only be discovered during a chat turn. */
    requestScoped: requiresEphemeralUserConnection(config) || undefined,
  };

  if (config.apiKey) {
    safe.apiKey = {
      source: config.apiKey.source,
      authorization_type: config.apiKey.authorization_type,
      ...(config.apiKey.custom_header && { custom_header: config.apiKey.custom_header }),
    };
  }

  if (config.oauth) {
    const { client_secret: _secret, ...safeOAuth } = config.oauth;
    safe.oauth = safeOAuth;
  }

  if (config.obo) {
    safe.obo = config.obo;
  }

  if (!options?.canEdit) {
    delete safe.url;
    if (safe.oauth) {
      const {
        authorization_url: _au,
        token_url: _tu,
        revocation_endpoint: _re,
        ...restOAuth
      } = safe.oauth;
      safe.oauth = restOAuth;
    }
  }

  return Object.fromEntries(
    Object.entries(safe).filter(([, v]) => v !== undefined),
  ) as RedactedServerConfig;
}

/** Applies allowlist-based sanitization to a map of server configs. */
export function redactAllServerSecrets(
  configs: Record<string, ParsedServerConfig>,
  options?: { canEditByServer?: ReadonlyMap<string, boolean> },
): Record<string, RedactedServerConfig> {
  const result: Record<string, RedactedServerConfig> = {};
  for (const [key, config] of Object.entries(configs)) {
    const canEdit = options?.canEditByServer?.get(key) ?? false;
    result[key] = redactServerSecrets(config, { canEdit });
  }
  return result;
}

/**
 * Builds the synthetic tool-call name used during MCP OAuth flows.
 * Format: `oauth<mcp_delimiter><normalizedServerName>`
 *
 * Guards against the caller passing a pre-wrapped name (one that already
 * starts with the oauth prefix in its original, un-normalized form) to
 * prevent double-wrapping.
 */
export function buildOAuthToolCallName(serverName: string): string {
  const oauthPrefix = `oauth${Constants.mcp_delimiter}`;
  if (serverName.startsWith(oauthPrefix)) {
    return normalizeServerName(serverName);
  }
  return `${oauthPrefix}${normalizeServerName(serverName)}`;
}

const INVALID_CLIENT_PATTERNS = [
  'invalid_client',
  'client_id mismatch',
  'client not found',
  'unknown client',
] as const;

/** Checks whether a message indicates the stored client registration is invalid/stale. */
export function isInvalidClientMessage(message: string): boolean {
  const msg = message.toLowerCase();
  return INVALID_CLIENT_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Checks whether a message indicates the OAuth client registration was rejected.
 * Superset of `isInvalidClientMessage`: also matches `unauthorized_client`
 * (grant-type refusal), which has different recovery semantics.
 */
export function isClientRejectionMessage(message: string): boolean {
  return isInvalidClientMessage(message) || message.toLowerCase().includes('unauthorized_client');
}

/**
 * Sanitizes a URL by removing query parameters to prevent credential leakage in logs.
 * @param url - The URL to sanitize (string or URL object)
 * @returns The sanitized URL string without query parameters
 */
export function sanitizeUrlForLogging(url: string | URL): string {
  try {
    const urlObj = typeof url === 'string' ? new URL(url) : url;
    return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

/**
 * Escapes special regex characters in a string so they are treated literally.
 * @param str - The string to escape
 * @returns The escaped string safe for use in a regex pattern
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generates a URL-friendly server name from a title.
 * Converts to lowercase, replaces spaces with hyphens, removes special characters.
 * @param title - The display title to convert
 * @returns A slug suitable for use as serverName (e.g., "GitHub MCP Tool" → "github-mcp-tool")
 */
/**
 * One cancellation signal for a budgeted operation: the remaining budget and the caller's own
 * signal, whichever fires first. Undefined when neither bound exists, so unbudgeted callers pay
 * nothing.
 */
export function createDeadlineAbortSignal(
  deadlineMs?: number,
  callerSignal?: AbortSignal,
): AbortSignal | undefined {
  const budget =
    deadlineMs != null ? AbortSignal.timeout(Math.max(1, deadlineMs - Date.now())) : undefined;
  if (budget != null && callerSignal != null) {
    return AbortSignal.any([budget, callerSignal]);
  }
  return budget ?? callerSignal;
}

export type DeadlineWaitResult<T> = { settled: true; value: T } | { settled: false };

/**
 * Waits for `promise` only until `deadlineMs` passes or `signal` aborts, and never cancels it:
 * shared work such as an OAuth token refresh keeps running for whoever depends on its outcome. A
 * rejection that lands first is rethrown; one that lands after the wait ended stays observed, so
 * abandoned work never surfaces as an unhandled rejection.
 */
export async function waitUntilDeadline<T>(
  promise: Promise<T>,
  deadlineMs?: number,
  signal?: AbortSignal,
): Promise<DeadlineWaitResult<T>> {
  if (deadlineMs == null && signal == null) {
    return { settled: true, value: await promise };
  }
  const settlement = promise.then((value): DeadlineWaitResult<T> => ({ settled: true, value }));
  if (signal?.aborted === true) {
    settlement.catch(() => undefined);
    return { settled: false };
  }
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<DeadlineWaitResult<T>>((resolve) => {
    if (deadlineMs != null) {
      timer = setTimeout(() => resolve({ settled: false }), Math.max(0, deadlineMs - Date.now()));
      timer.unref?.();
    }
    if (signal != null) {
      onAbort = () => resolve({ settled: false });
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([settlement, interrupted]);
  } finally {
    clearTimeout(timer);
    if (onAbort != null) {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

export function generateServerNameFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars except spaces and hyphens
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Remove consecutive hyphens
    .replace(/^-|-$/g, ''); // Trim leading/trailing hyphens

  return slug || 'mcp-server'; // Fallback if empty
}

export {
  splitMCPToolKey,
  normalizeServerName,
  normalizeMCPToolKey,
  buildServerNameAliases,
  stripServerNamePrefix,
  stripServerNamePrefixes,
} from 'librechat-data-provider';
