import type { AppConfig } from '@librechat/data-schemas';
import type { GetAppConfigOptions } from '~/app/service';
import type { MCPOAuthFlowMetadata } from './types';
import type * as t from '~/mcp/types';
import { getMCPServerGeneration } from './cleanup';

/** What an OAuth flow recorded about the server definition that admitted it. */
export type MCPOAuthFlowServer = Partial<
  Pick<MCPOAuthFlowMetadata, 'serverName' | 'serverUrl' | 'serverGeneration' | 'oauthHeaders'>
>;

/** The registry's principal-scoped lookup by name, which returns nothing for a hidden server. */
interface MCPServerLookup {
  getServerConfig(
    serverName: string,
    userId?: string,
    configServers?: Record<string, t.ParsedServerConfig>,
    role?: string,
    options?: t.MCPServerLookupOptions,
  ): Promise<t.ParsedServerConfig | undefined>;
}

export interface MCPOAuthTargetDeps {
  /** Reads the principal's merged config; it is always called strictly (`failClosed`). */
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig | undefined>;
  /**
   * The principal's servers with the registry's tier precedence applied and the servers the
   * principal's config hides left out. May omit config-tier servers whose inspection failed.
   */
  getServerConfigs: (
    principal: t.MCPPrincipal,
  ) => Promise<Record<string, t.ParsedServerConfig> | undefined>;
  registry: MCPServerLookup;
}

/** The server an OAuth flow step may act on, as the principal's config defines it now. */
export interface MCPOAuthTarget {
  config: t.ParsedServerConfig;
  /**
   * Headers the flow's OAuth requests send: the snapshot initiation took, else the principal's
   * config. Never the librechat.yaml definition, whose headers a profile may have removed.
   */
  oauthHeaders: Record<string, string>;
  recoveryPolicy?: NonNullable<AppConfig['mcpSettings']>['catalogRecovery'];
}

/**
 * - `flow_mismatch`: the flow was admitted for another server.
 * - `server_not_found`: the principal cannot use the server: it was deleted, or their config hides it.
 * - `server_changed`: the server was redefined after the flow was admitted.
 */
export type MCPOAuthTargetErrorCode = 'flow_mismatch' | 'server_not_found' | 'server_changed';

export type MCPOAuthTargetResult =
  | { ok: true; value: MCPOAuthTarget }
  | { ok: false; error: { code: MCPOAuthTargetErrorCode } };

/** Whether a config is still the definition that admitted the flow. */
function isAdmittedDefinition(flow: MCPOAuthFlowServer, config: t.ParsedServerConfig): boolean {
  if (flow.serverGeneration) {
    return getMCPServerGeneration(config) === flow.serverGeneration;
  }
  return config.url === flow.serverUrl;
}

/**
 * Resolves the server an MCP OAuth flow step acts on, for every step that reaches the
 * authorization server: initiation before it redirects, and the callback before and while it
 * exchanges and stores tokens. The flow was admitted earlier, so each step resolves the server
 * again in the principal's current config. Hiding is an access boundary, so a server that
 * principal can no longer use, or that was redefined, ends the flow.
 *
 * The principal's config is read strictly: a failed read rejects rather than answering with
 * the base config, which still lists the servers a profile hides. Tenant comes from the ALS
 * context inside `getAppConfig`.
 */
export async function resolveMCPOAuthTarget(
  params: { serverName: string; flow: MCPOAuthFlowServer; principal: t.MCPPrincipal },
  deps: MCPOAuthTargetDeps,
): Promise<MCPOAuthTargetResult> {
  const { serverName, flow, principal } = params;
  if (flow.serverName != null && flow.serverName !== serverName) {
    return { ok: false, error: { code: 'flow_mismatch' } };
  }
  const [configs, appConfig] = await Promise.all([
    deps.getServerConfigs(principal),
    deps.getAppConfig({
      userId: principal.userId,
      role: principal.role,
      idOnTheSource: principal.idOnTheSource,
      failClosed: true,
    }),
  ]);
  /** The merged config entry, for a config-tier server the resolved catalog omits. */
  const merged = appConfig?.mcpConfig as Record<string, t.ParsedServerConfig> | null | undefined;
  const config =
    configs?.[serverName] ??
    merged?.[serverName] ??
    (await deps.registry.getServerConfig(serverName, principal.userId, undefined, principal.role, {
      idOnTheSource: principal.idOnTheSource,
    }));
  if (!config) {
    return { ok: false, error: { code: 'server_not_found' } };
  }
  if (!isAdmittedDefinition(flow, config)) {
    return { ok: false, error: { code: 'server_changed' } };
  }
  return {
    ok: true,
    value: {
      config,
      oauthHeaders: flow.oauthHeaders ?? config.oauth_headers ?? {},
      recoveryPolicy: appConfig?.mcpSettings?.catalogRecovery,
    },
  };
}
