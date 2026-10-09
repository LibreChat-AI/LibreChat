/**
 * Reimplemented here so `@librechat/api` (emitted as CommonJS) never statically
 * imports the ESM-only `@modelcontextprotocol/ext-apps` package.
 */

import { logger } from '@librechat/data-schemas';
import { MCP_APP_MIME_TYPE } from 'librechat-data-provider';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { PluginAuthMethods, TokenMethods, IUser } from '@librechat/data-schemas';
import type { TMCPAppOperationLimits } from 'librechat-data-provider';
import type { UpstreamTokenProvider } from './oauth/obo';
import type { FlowStateManager } from '~/flow/manager';
import type { MCPOAuthTokens } from './oauth';
import type * as t from './types';
import { MCPAuthenticationRefreshError, MCPAuthenticationRejectedError } from './errors';
import { getServerCustomUserVars, getUserMCPAuthMap } from './auth';
import { OpenIDReauthRequiredError } from '~/utils/oidc';
import { MCPAppBudgetError } from './apps/budget';

export interface ToolWithMeta {
  _meta?: Record<string, unknown> | null;
}

type McpUiToolVisibility = 'model' | 'app';

interface McpUiToolMeta {
  resourceUri?: string;
  visibility?: McpUiToolVisibility[];
}

export const RESOURCE_URI_META_KEY = 'ui/resourceUri';

export const RESOURCE_MIME_TYPE: string = MCP_APP_MIME_TYPE;

export type AuthenticatedMCPAppUser = IUser & { id: string };

export interface MCPAppValidationContext {
  serverName: string;
  serverBinding: string;
  user: AuthenticatedMCPAppUser;
  connectionTarget: t.MCPConnectionTarget;
  customUserVars?: Record<string, string>;
  signal?: AbortSignal;
}

export interface MCPAppAllowlists {
  allowedDomains?: string[] | null;
  allowedAddresses?: string[] | null;
  useSSRFProtection: boolean;
}

export interface MCPAppOperationContext extends MCPAppValidationContext {
  operationLimits?: TMCPAppOperationLimits;
  allowlists: MCPAppAllowlists;
  flowManager: FlowStateManager<MCPOAuthTokens | null>;
  tokenMethods?: TokenMethods;
  upstreamTokenProvider?: UpstreamTokenProvider;
  onOAuthCredentialsChanging: NonNullable<t.UserConnectionContext['onOAuthCredentialsChanging']>;
}

export function getToolUiResourceUri(tool: ToolWithMeta): string | undefined {
  const uiMeta = tool._meta?.ui as McpUiToolMeta | undefined;
  let uri: unknown = uiMeta?.resourceUri;

  if (uri === undefined) {
    uri = tool._meta?.[RESOURCE_URI_META_KEY];
  }

  if (typeof uri === 'string' && uri.startsWith('ui://')) {
    return uri;
  } else if (uri !== undefined) {
    throw new Error(`Invalid UI resource URI: ${JSON.stringify(uri)}`);
  }
  return undefined;
}

/**
 * Visibility defaults to both scopes only when the field is absent. Once a server sends an explicit
 * array, a scope is granted only if the array includes it, so an empty or future-scoped array (e.g.
 * `[]`, `['model','internal']`) hides the tool from whichever scope it omits.
 */
export function isToolHiddenFromApp(tool: ToolWithMeta): boolean {
  const visibility = (tool._meta?.ui as McpUiToolMeta | undefined)?.visibility;
  return Array.isArray(visibility) && !visibility.includes('app');
}

export function isToolHiddenFromModel(tool: ToolWithMeta): boolean {
  const visibility = (tool._meta?.ui as McpUiToolMeta | undefined)?.visibility;
  return Array.isArray(visibility) && !visibility.includes('model');
}

/** Declared here rather than importing MCPManager to avoid a circular import. */
export interface MCPAppsProxyManager {
  validateAppBinding(args: MCPAppValidationContext): Promise<{ valid: true }>;
  readResource(args: MCPAppOperationContext & { uri: string }): Promise<unknown>;
  listResources(args: MCPAppOperationContext & { cursor?: string }): Promise<unknown>;
  listResourceTemplates(args: MCPAppOperationContext & { cursor?: string }): Promise<unknown>;
  appToolCall(
    args: MCPAppOperationContext & {
      toolName: string;
      toolArguments: Record<string, unknown>;
    },
  ): Promise<unknown>;
}

export type MCPAppRequestContext = MCPAppOperationContext;

export async function resolveAppValidationContext({
  serverName,
  serverBinding,
  user,
  resolveServerConfig,
  findPluginAuthsByKeys,
  signal,
}: {
  user: AuthenticatedMCPAppUser;
  serverName: string;
  serverBinding: unknown;
  resolveServerConfig: () => Promise<t.MCPConnectionTarget | undefined>;
  findPluginAuthsByKeys: PluginAuthMethods['findPluginAuthsByKeys'];
  signal?: AbortSignal;
}): Promise<MCPAppValidationContext> {
  const userId = user.id;
  if (typeof serverBinding !== 'string' || serverBinding.length === 0) {
    throw new McpError(ErrorCode.InvalidRequest, 'serverBinding must be a non-empty string');
  }
  const [connectionTarget, userMCPAuthMap] = await Promise.all([
    resolveServerConfig(),
    getUserMCPAuthMap({
      userId,
      servers: [serverName],
      findPluginAuthsByKeys,
      throwOnError: true,
    }).catch((error) => {
      logger.error(
        `[resolveAppValidationContext] Failed to resolve MCP auth values for user ${userId}, server ${serverName}; failing closed`,
        error,
      );
      throw error;
    }),
  ]);
  if (!connectionTarget) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Configuration for MCP server "${serverName}" is not available to this user.`,
    );
  }
  signal?.throwIfAborted();
  return {
    serverName,
    serverBinding,
    user,
    connectionTarget,
    customUserVars: getServerCustomUserVars(userMCPAuthMap, serverName),
    signal,
  };
}

export async function resolveEffectiveAppServerConfig({
  serverName,
  user,
  mcpConfig,
  ensureConfigServers,
  getAllServerConfigs,
  recoverServerConfig,
  isAppServerConfig,
}: {
  serverName: string;
  user: AuthenticatedMCPAppUser;
  mcpConfig: Record<string, t.MCPOptions>;
  ensureConfigServers: (
    config: Record<string, t.MCPOptions>,
  ) => Promise<Record<string, t.ParsedServerConfig>>;
  getAllServerConfigs: (
    userId: string,
    configServers: Record<string, t.ParsedServerConfig>,
    role?: string,
  ) => Promise<Record<string, t.ParsedServerConfig>>;
  recoverServerConfig: (
    serverName: string,
    config: t.ParsedServerConfig,
    userId?: string,
  ) => Promise<t.ParsedServerConfig | undefined>;
  isAppServerConfig: (serverName: string, config: t.ParsedServerConfig) => Promise<boolean>;
}): Promise<t.MCPConnectionTarget | undefined> {
  const rawConfig = mcpConfig[serverName];
  const configServers = await ensureConfigServers(rawConfig ? { [serverName]: rawConfig } : {});
  const effectiveConfigs = await getAllServerConfigs(user.id, configServers, user.role);
  const selectedConfig = effectiveConfigs[serverName];
  const serverConfig = selectedConfig?.inspectionFailed
    ? await recoverServerConfig(serverName, selectedConfig, user.id)
    : selectedConfig;
  if (!serverConfig) {
    return undefined;
  }
  return {
    serverConfig,
    connectionOwner: (await isAppServerConfig(serverName, serverConfig)) ? 'operator' : 'principal',
  };
}

/**
 * Resolves the request-scoped config and auth context so app follow-up requests can reconnect to
 * config-sourced servers even when the original tool-call connection is gone.
 *
 * Fails closed on both config and auth resolution: a transient lookup failure must reject rather
 * than fall back to the base config (wrong server) or to unresolved/stale credentials. A user who
 * genuinely has no vars still resolves to an empty map without throwing, so that path proceeds.
 * `resolveServerConfig` is supplied by the typed controller from the already admitted request
 * config, so policy admission and operation routing use one snapshot and one effective target.
 */
export async function resolveAppRequestContext({
  serverName,
  serverBinding,
  user,
  resolveServerConfig,
  findPluginAuthsByKeys,
  flowManager,
  tokenMethods,
  upstreamTokenProvider,
  onOAuthCredentialsChanging,
  allowlists,
  signal,
}: {
  user: AuthenticatedMCPAppUser;
  serverName: string;
  serverBinding: unknown;
  resolveServerConfig: () => Promise<t.MCPConnectionTarget | undefined>;
  findPluginAuthsByKeys: PluginAuthMethods['findPluginAuthsByKeys'];
  flowManager: FlowStateManager<MCPOAuthTokens | null>;
  tokenMethods?: TokenMethods;
  upstreamTokenProvider?: UpstreamTokenProvider;
  onOAuthCredentialsChanging: NonNullable<t.UserConnectionContext['onOAuthCredentialsChanging']>;
  allowlists: MCPAppAllowlists;
  signal?: AbortSignal;
}): Promise<MCPAppRequestContext> {
  const validationContext = await resolveAppValidationContext({
    serverName,
    serverBinding,
    user,
    resolveServerConfig,
    findPluginAuthsByKeys,
    signal,
  });
  return {
    ...validationContext,
    allowlists,
    flowManager,
    tokenMethods,
    upstreamTokenProvider,
    onOAuthCredentialsChanging,
    signal,
  };
}

export async function validateAppServerBinding(
  manager: MCPAppsProxyManager,
  ctx: MCPAppValidationContext,
): Promise<{ valid: true }> {
  return manager.validateAppBinding(ctx);
}

/** A denied app request is an expected client error, not a host fault. */
export function isDeniedAppRequest(error: unknown): boolean {
  return (
    error instanceof MCPAppBudgetError ||
    error instanceof OpenIDReauthRequiredError ||
    error instanceof MCPAuthenticationRejectedError ||
    error instanceof MCPAuthenticationRefreshError ||
    (error != null &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === ErrorCode.InvalidRequest)
  );
}

export function buildAppProxyErrorResponse(
  error: unknown,
  fallbackMessage: string,
): { status: number; body: Record<string, unknown> } {
  if (error instanceof MCPAppBudgetError) {
    return { status: error.status, body: { error: error.code, message: error.message } };
  }
  if (
    error != null &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === ErrorCode.InvalidRequest
  ) {
    return { status: 400, body: { error: (error as Error).message } };
  }
  if (error instanceof OpenIDReauthRequiredError) {
    return {
      status: error.statusCode,
      body: { error: 'invalid_token', message: error.message },
    };
  }
  if (error instanceof MCPAuthenticationRejectedError) {
    return {
      status: error.statusCode,
      body: {
        error: 'invalid_token',
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        connectionRefreshed: error.connectionRefreshed,
      },
    };
  }
  if (error instanceof MCPAuthenticationRefreshError) {
    return {
      status: error.statusCode,
      body: { code: error.code, message: error.message, retryable: error.retryable },
    };
  }
  return { status: 500, body: { error: fallbackMessage } };
}

export async function readAppResource(
  manager: MCPAppsProxyManager,
  ctx: MCPAppRequestContext,
  uri: unknown,
): Promise<unknown> {
  if (!ctx.serverName) {
    throw new McpError(ErrorCode.InvalidRequest, 'serverName and uri are required');
  }
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new McpError(ErrorCode.InvalidRequest, 'uri must be a non-empty string');
  }
  return manager.readResource({
    ...ctx,
    uri,
  });
}

export async function listAppResources(
  manager: MCPAppsProxyManager,
  ctx: MCPAppRequestContext,
  cursor: unknown,
): Promise<unknown> {
  if (!ctx.serverName) {
    throw new McpError(ErrorCode.InvalidRequest, 'serverName is required');
  }
  if (cursor !== undefined && typeof cursor !== 'string') {
    throw new McpError(ErrorCode.InvalidRequest, 'cursor must be a string');
  }
  return manager.listResources({
    ...ctx,
    cursor,
  });
}

export async function listAppResourceTemplates(
  manager: MCPAppsProxyManager,
  ctx: MCPAppRequestContext,
  cursor: unknown,
): Promise<unknown> {
  if (!ctx.serverName) {
    throw new McpError(ErrorCode.InvalidRequest, 'serverName is required');
  }
  if (cursor !== undefined && typeof cursor !== 'string') {
    throw new McpError(ErrorCode.InvalidRequest, 'cursor must be a string');
  }
  return manager.listResourceTemplates({
    ...ctx,
    cursor,
  });
}

export async function callAppTool(
  manager: MCPAppsProxyManager,
  ctx: MCPAppRequestContext,
  toolName: unknown,
  toolArguments: unknown,
): Promise<unknown> {
  if (!ctx.serverName || typeof toolName !== 'string' || toolName.length === 0) {
    throw new McpError(ErrorCode.InvalidRequest, 'serverName and toolName are required');
  }
  if (
    toolArguments !== undefined &&
    toolArguments !== null &&
    (typeof toolArguments !== 'object' || Array.isArray(toolArguments))
  ) {
    throw new McpError(ErrorCode.InvalidRequest, 'arguments must be an object');
  }
  return manager.appToolCall({
    ...ctx,
    toolName,
    toolArguments: (toolArguments as Record<string, unknown>) || {},
  });
}
