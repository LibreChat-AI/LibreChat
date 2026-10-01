import { resolveMCPAppsPolicy, resolveMCPAppOperationLimits } from 'librechat-data-provider';
import type { MCPAppCspLimits, TMCPAppOperationLimits } from 'librechat-data-provider';
import type { PluginAuthMethods, TokenMethods } from '@librechat/data-schemas';
import type { Request, RequestHandler, Response } from 'express';
import type { MCPAppAllowlists, MCPAppsProxyManager, AuthenticatedMCPAppUser } from '../apps';
import type { UpstreamTokenProvider } from '../oauth/obo';
import type { FlowStateManager } from '~/flow/manager';
import type { MCPAppOperationBudget } from './budget';
import type { MCPOAuthTokens } from '../oauth';
import type * as t from '../types';
import {
  readAppResource,
  listAppResources,
  listAppResourceTemplates,
  callAppTool,
  validateAppServerBinding,
  buildAppProxyErrorResponse,
  isDeniedAppRequest,
  resolveAppRequestContext,
  resolveAppValidationContext,
  resolveEffectiveAppServerConfig,
} from '../apps';
import { assertMCPAppResultFits } from './budget';
import { buildSandboxResponse } from '../sandbox';

interface MCPAppsBody {
  serverName?: unknown;
  serverBinding?: unknown;
  uri?: unknown;
  cursor?: unknown;
  toolName?: unknown;
  arguments?: unknown;
}

interface MCPAppsConfig {
  mcpAppSandbox?: { operationLimits?: Partial<TMCPAppOperationLimits> };
  mcpSettings?: {
    apps?: boolean;
    allowedDomains?: string[] | null;
    allowedAddresses?: string[] | null;
  };
  mcpConfig?: Record<string, t.MCPOptions>;
}

type MCPAppsRequest = Request<object, object, MCPAppsBody> & {
  user?: AuthenticatedMCPAppUser;
  config?: MCPAppsConfig;
};

interface Logger {
  error(message: string, error?: unknown): void;
}

export interface MCPAppsControllerDependencies {
  logger: Logger;
  sandboxPath: string;
  sandboxFrameAncestors?: string;
  readSandboxFile: (path: string, encoding: 'utf8') => string;
  getManager: () => MCPAppsProxyManager;
  getOperationBudget: () => MCPAppOperationBudget;
  getFlowManager: () => FlowStateManager<MCPOAuthTokens | null>;
  getAppConfig: (request: MCPAppsRequest) => Promise<MCPAppsConfig | undefined>;
  getSandboxCspLimits: () => Promise<MCPAppCspLimits>;
  ensureConfigServers: (
    mcpConfig: Record<string, t.MCPOptions>,
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
  resolveCachedAppServerConfig: (args: {
    serverName: string;
    userId: string;
    role?: string;
    mcpConfig: Record<string, t.MCPOptions>;
    allowedDomains?: string[] | null;
    allowedAddresses?: string[] | null;
  }) => Promise<t.MCPConnectionTarget | undefined>;
  findPluginAuthsByKeys: PluginAuthMethods['findPluginAuthsByKeys'];
  tokenMethods: TokenMethods;
  createOAuthCredentialsChanging: (
    request: MCPAppsRequest,
  ) => NonNullable<t.UserConnectionContext['onOAuthCredentialsChanging']>;
  createUpstreamTokenProvider: (
    request: MCPAppsRequest,
    response: Response,
    user: AuthenticatedMCPAppUser,
  ) => UpstreamTokenProvider;
}

type AppProxy = (
  manager: MCPAppsProxyManager,
  context: Awaited<ReturnType<typeof resolveAppRequestContext>>,
  body: MCPAppsBody,
) => Promise<unknown>;

interface AppProxyOptions {
  label: string;
  fallback: string;
  proxy: AppProxy;
  logExpectedErrors?: boolean;
}

function getServerName(body: MCPAppsBody): string {
  if (typeof body.serverName !== 'string' || body.serverName.length === 0) {
    return '';
  }
  return body.serverName;
}

function attachCancellation(
  request: MCPAppsRequest,
  response: Response,
): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('MCP App request cancelled'));
    }
  };
  request.once('aborted', abort);
  response.once('close', abort);
  if (
    request.aborted ||
    (request.destroyed && !request.complete) ||
    response.destroyed ||
    response.writableEnded
  ) {
    abort();
  }
  return {
    signal: controller.signal,
    dispose: () => {
      request.off('aborted', abort);
      response.off('close', abort);
    },
  };
}

function canWriteResponse(response: Response): boolean {
  return !response.headersSent && !response.writableEnded && !response.destroyed;
}

function getAdmittedMCPConfig(request: MCPAppsRequest): Record<string, t.MCPOptions> {
  if (request.config == null) {
    throw new Error('MCP App request configuration was not admitted');
  }
  return request.config.mcpConfig ?? {};
}

function getAdmittedMCPAllowlists(request: MCPAppsRequest): MCPAppAllowlists {
  if (request.config == null) {
    throw new Error('MCP App request configuration was not admitted');
  }
  const { allowedDomains, allowedAddresses } = request.config.mcpSettings ?? {};
  return {
    allowedDomains,
    allowedAddresses,
    useSSRFProtection: !Array.isArray(allowedDomains) || allowedDomains.length === 0,
  };
}

export function createMCPAppsController(dependencies: MCPAppsControllerDependencies): {
  readMCPResource: RequestHandler;
  listMCPResources: RequestHandler;
  listMCPResourceTemplates: RequestHandler;
  appToolCall: RequestHandler;
  validateMCPApp: RequestHandler;
  serveMCPSandbox: RequestHandler;
  requireMCPAppsEnabled: RequestHandler;
} {
  let sandboxHtml: string | undefined;
  const loadSandboxHtml = (): string => {
    sandboxHtml ??= dependencies.readSandboxFile(dependencies.sandboxPath, 'utf8');
    return sandboxHtml;
  };

  const sendError = (
    response: Response,
    error: unknown,
    options: Omit<AppProxyOptions, 'proxy'>,
  ) => {
    if (options.logExpectedErrors || !isDeniedAppRequest(error)) {
      dependencies.logger.error(`[${options.label}] Error:`, error);
    }
    if (!canWriteResponse(response)) {
      return;
    }
    const { status, body } = buildAppProxyErrorResponse(error, options.fallback);
    response.status(status).json(body);
  };

  const createProxyHandler =
    (options: AppProxyOptions): RequestHandler =>
    async (baseRequest, response): Promise<void> => {
      const request = baseRequest as MCPAppsRequest;
      const user = request.user;
      if (!user?.id) {
        response.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const cancellation = attachCancellation(request, response);
      try {
        cancellation.signal.throwIfAborted();
        const limits = resolveMCPAppOperationLimits(request.config?.mcpAppSandbox?.operationLimits);
        const result = await dependencies.getOperationBudget().run(
          cancellation.signal,
          async (signal) => {
            const body = request.body ?? {};
            const serverName = getServerName(body);
            const context = await resolveAppRequestContext({
              user,
              serverName,
              serverBinding: body.serverBinding,
              resolveServerConfig: () =>
                resolveEffectiveAppServerConfig({
                  serverName,
                  user,
                  mcpConfig: getAdmittedMCPConfig(request),
                  ensureConfigServers: dependencies.ensureConfigServers,
                  getAllServerConfigs: dependencies.getAllServerConfigs,
                  recoverServerConfig: dependencies.recoverServerConfig,
                  isAppServerConfig: dependencies.isAppServerConfig,
                }),
              findPluginAuthsByKeys: dependencies.findPluginAuthsByKeys,
              flowManager: dependencies.getFlowManager(),
              tokenMethods: dependencies.tokenMethods,
              onOAuthCredentialsChanging: dependencies.createOAuthCredentialsChanging(request),
              upstreamTokenProvider: dependencies.createUpstreamTokenProvider(
                request,
                response,
                user,
              ),
              allowlists: getAdmittedMCPAllowlists(request),
              signal,
            });
            signal.throwIfAborted();
            const result = await options.proxy(
              dependencies.getManager(),
              { ...context, operationLimits: limits },
              body,
            );
            signal.throwIfAborted();
            assertMCPAppResultFits(result, limits);
            return result;
          },
          limits,
        );
        if (canWriteResponse(response)) {
          response.json(result);
        }
      } catch (error) {
        if (!cancellation.signal.aborted) {
          sendError(response, error, options);
        }
      } finally {
        cancellation.dispose();
      }
    };

  const readMCPResource = createProxyHandler({
    label: 'readMCPResource',
    fallback: 'Failed to read resource',
    proxy: (manager, context, body) => readAppResource(manager, context, body.uri),
  });
  const validateMCPApp: RequestHandler = async (baseRequest, response): Promise<void> => {
    const request = baseRequest as MCPAppsRequest;
    const user = request.user;
    if (!user?.id) {
      response.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const cancellation = attachCancellation(request, response);
    try {
      cancellation.signal.throwIfAborted();
      const limits = resolveMCPAppOperationLimits(request.config?.mcpAppSandbox?.operationLimits);
      const result = await dependencies.getOperationBudget().run(
        cancellation.signal,
        async (signal) => {
          const body = request.body ?? {};
          const serverName = getServerName(body);
          const allowlists = getAdmittedMCPAllowlists(request);
          const context = await resolveAppValidationContext({
            user,
            serverName,
            serverBinding: body.serverBinding,
            resolveServerConfig: () =>
              dependencies.resolveCachedAppServerConfig({
                serverName,
                userId: user.id,
                role: user.role,
                mcpConfig: getAdmittedMCPConfig(request),
                allowedDomains: allowlists.allowedDomains,
                allowedAddresses: allowlists.allowedAddresses,
              }),
            findPluginAuthsByKeys: dependencies.findPluginAuthsByKeys,
            signal,
          });
          signal.throwIfAborted();
          const result = await validateAppServerBinding(dependencies.getManager(), context);
          signal.throwIfAborted();
          assertMCPAppResultFits(result, limits);
          return result;
        },
        limits,
      );
      if (canWriteResponse(response)) {
        response.json(result);
      }
    } catch (error) {
      if (!cancellation.signal.aborted) {
        sendError(response, error, {
          label: 'validateMCPApp',
          fallback: 'Failed to validate MCP App',
        });
      }
    } finally {
      cancellation.dispose();
    }
  };
  const listMCPResources = createProxyHandler({
    label: 'listMCPResources',
    fallback: 'Failed to list resources',
    proxy: (manager, context, body) => listAppResources(manager, context, body.cursor),
  });
  const listMCPResourceTemplates = createProxyHandler({
    label: 'listMCPResourceTemplates',
    fallback: 'Failed to list resource templates',
    proxy: (manager, context, body) => listAppResourceTemplates(manager, context, body.cursor),
  });
  const appToolCall = createProxyHandler({
    label: 'appToolCall',
    fallback: 'Failed to execute tool',
    logExpectedErrors: true,
    proxy: (manager, context, body) => callAppTool(manager, context, body.toolName, body.arguments),
  });

  const serveMCPSandbox: RequestHandler = async (request, response): Promise<void> => {
    try {
      const limits = await dependencies.getSandboxCspLimits();
      const { headers, body } = buildSandboxResponse({
        sandboxHtml: loadSandboxHtml(),
        frameAncestors: dependencies.sandboxFrameAncestors,
        csp: typeof request.query.csp === 'string' ? request.query.csp : undefined,
        limits,
      });
      for (const [name, value] of Object.entries(headers)) {
        response.setHeader(name, value);
      }
      response.send(body);
    } catch (error) {
      dependencies.logger.error('[serveMCPSandbox] Error:', error);
      if (response.headersSent) {
        response.end();
        return;
      }
      response.status(500).json({ error: 'Failed to load MCP sandbox' });
    }
  };

  const requireMCPAppsEnabled: RequestHandler = async (
    baseRequest,
    response,
    next,
  ): Promise<void> => {
    const request = baseRequest as MCPAppsRequest;
    try {
      const appConfig = request.config ?? (await dependencies.getAppConfig(request));
      request.config = appConfig;
      if (!resolveMCPAppsPolicy(appConfig?.mcpSettings?.apps).enabled) {
        response.status(403).json({ error: 'MCP Apps are disabled' });
        return;
      }
      next();
    } catch (error) {
      dependencies.logger.error('[requireMCPAppsEnabled] Error:', error);
      response.status(500).json({ error: 'Failed to resolve MCP Apps configuration' });
    }
  };

  return {
    readMCPResource,
    listMCPResources,
    listMCPResourceTemplates,
    appToolCall,
    validateMCPApp,
    serveMCPSandbox,
    requireMCPAppsEnabled,
  };
}
