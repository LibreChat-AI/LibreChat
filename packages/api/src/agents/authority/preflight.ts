import { randomUUID } from 'node:crypto';
import {
  AgentCapabilities,
  Constants,
  EModelEndpoint,
  Permissions,
  PermissionTypes,
  buildServerNameAliases,
  normalizeMCPToolKey,
  normalizeServerName,
  stripServerNamePrefix,
} from 'librechat-data-provider';
import type {
  RunGrant,
  RunGrantIdentity,
  ScheduleMCPStatus,
  ScheduleMCPOutcome,
  ScheduledMCPIdentity,
} from 'librechat-data-provider';
import type { IUser, AppConfig, PluginAuthMethods } from '@librechat/data-schemas';
import type {
  ParsedServerConfig,
  UserMCPConnectionOptions,
  RequestScopedMCPConnectionStore,
} from '~/mcp/types';
import type { RunGrantExecution, RunGrantExecutionFactory } from './execution';
import type { UpstreamTokenProviderResolver } from '~/mcp/oauth/obo';
import type { CheckAccessParams } from '~/middleware/access';
import type { MCPToolsSnapshot } from '~/mcp/connection';
import type { GetAppConfigOptions } from '~/app/service';
import type { RequirementDeps } from './requirements';
import {
  ScheduledMCPBearerError,
  MCPAuthenticationRejectedError,
  MCPOAuthSecretReentryRequiredError,
  isOAuthAuthenticationError,
} from '~/mcp/errors';
import {
  getMissingCustomUserVars,
  splitMCPToolKey,
  findShadowedServerNames,
  createDeadlineAbortSignal,
} from '~/mcp/utils';
import { MCPConfigInitializationCanceledError } from '~/mcp/registry/MCPServersRegistry';
import { createMCPRequestContext, cleanupMCPRequestContext } from '~/mcp/request';
import { RunGrantPolicyError, listedMCPKeys } from './policy';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { createConcurrencyLimiter } from '~/utils/promise';
import { OboTokenResolutionError } from '~/mcp/oauth/obo';
import { OpenIDReauthRequiredError } from '~/utils/oidc';
import { resolveRequirements } from './requirements';
import { formatMCPServerTools } from '~/mcp/tools';
import { checkAccess } from '~/middleware/access';
import { detachOnAbort } from '~/utils/promises';
import { getPluginAuthMap } from '~/agents/auth';

// The public schedule schema caps mcpPreflightConcurrency at 10. Keep the same
// ceiling across every preflight owned by this process so concurrent runs
// cannot multiply that per-request fan-out into an unbounded connection burst.
const MAX_SHARED_MCP_PREFLIGHT_CONCURRENCY = 10;

/** At least one MCP server a run needs is not ready. With no outcome, the owner was not found. */
export class PreflightError extends Error {
  readonly code: Exclude<ScheduleMCPStatus, 'ready'>;

  constructor(readonly outcomes: ScheduleMCPOutcome[]) {
    const code = preflightCode(outcomes);
    super(`${code}: ${JSON.stringify(outcomes)}`);
    this.code = code;
  }
}

/** One response discriminator for every admission surface. */
export function preflightCode(outcomes: ScheduleMCPOutcome[]): Exclude<ScheduleMCPStatus, 'ready'> {
  if (outcomes.some((item) => item.status === 'mcp_permission_denied'))
    return 'mcp_permission_denied';
  if (outcomes.some((item) => item.status === 'mcp_configuration_missing'))
    return 'mcp_configuration_missing';
  if (outcomes.some((item) => item.status === 'mcp_reauth_required')) return 'mcp_reauth_required';
  return 'mcp_unavailable';
}

export interface PreflightOptions<Identity extends RunGrantIdentity = ScheduledMCPIdentity> {
  concurrency: number;
  signal?: AbortSignal;
  deadlineMs?: number;
  /**
   * The subject the run acts for. With one, the check covers what its grant allows and a
   * probe connects with its credentials. Without one, it covers every MCP tool selected.
   */
  identity?: Identity;
  stage?: RunGrantExecution['stage'];
  /** Trusted host provenance, never a body-provided permission. */
  manual?: boolean;
  /**
   * A grant that is not stored yet, handed over: readiness then covers the MCP tools it
   * allows, as for a stored grant, and the grant it replaces is not consulted.
   */
  grant?: Pick<RunGrant<Identity>, 'consents' | 'everything' | 'tools'>;
}

/** Resolves with every server ready, or with nothing to make ready. Throws `PreflightError`. */
export type Preflight<Identity extends RunGrantIdentity = ScheduledMCPIdentity> = (
  agentId: string,
  principal: { readonly id: string; readonly tenantId?: string },
  options: PreflightOptions<Identity>,
) => Promise<ScheduleMCPOutcome[]>;

export interface PreflightDeps<Identity extends RunGrantIdentity = ScheduledMCPIdentity>
  extends RequirementDeps {
  getRoleByName: CheckAccessParams['getRoleByName'];
  getUser: (id: string) => Promise<IUser | null>;
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig | undefined>;
  ensureConfigServers: (
    config: NonNullable<AppConfig['mcpConfig']>,
    limit?: <T>(task: () => Promise<T>) => Promise<T>,
  ) => Promise<Record<string, ParsedServerConfig>>;
  getServerConfigs: (
    userId: string,
    config: Record<string, ParsedServerConfig>,
    role?: string,
  ) => Promise<Record<string, ParsedServerConfig>>;
  findPluginAuthsByKeys: PluginAuthMethods['findPluginAuthsByKeys'];
  /** Reads the subject's stored grant. Absent, nothing narrows what the agents select. */
  execution?: RunGrantExecutionFactory<Identity>;
  connect: (options: UserMCPConnectionOptions) => Promise<{
    fetchToolsSnapshot: (deadlineMs?: number, signal?: AbortSignal) => Promise<MCPToolsSnapshot>;
  }>;
}

/** The credentials a subject's probes connect with. A subject with neither supplies nothing. */
export interface PreflightCredentials<Identity extends RunGrantIdentity = ScheduledMCPIdentity> {
  /** Renewable upstream credentials, bound to the owner and to the check's signal. */
  tokens?: (
    user: IUser,
    identity: Identity | undefined,
    signal?: AbortSignal,
  ) => UpstreamTokenProviderResolver | undefined;
  /** Binds the subject's bearer to one probe's connection scope. */
  attach?: (
    context: RequestScopedMCPConnectionStore,
    identity: Identity,
    stage: RunGrantExecution['stage'],
    signal: AbortSignal | undefined,
    options: { manual: boolean },
  ) => void;
}

/**
 * Probes the MCP servers a run needs with isolated user connections and no interactive OAuth
 * wait. It asks nothing of the subject but its identity: the stored grant is read through
 * `deps.execution`, and what a probe authenticates with comes from `credentials`.
 */
export function createPreflight<Identity extends RunGrantIdentity = ScheduledMCPIdentity>(
  deps: PreflightDeps<Identity>,
  credentials: PreflightCredentials<Identity> = {},
): Preflight<Identity> {
  const sharedProbeLimit = createConcurrencyLimiter(MAX_SHARED_MCP_PREFLIGHT_CONCURRENCY);
  const runPreflight: Preflight<Identity> = async (agentId, principal, options) => {
    const signal = options.signal;
    const identity = options.identity;
    let execution: RunGrantExecution<Identity> | undefined;
    try {
      // A grant handed over stands in for whatever is stored, which the write it comes
      // with replaces.
      execution =
        identity && deps.execution && !options.grant
          ? await deps.execution.resolve(identity, options.stage ?? 'invoke', {
              manual: options.manual === true,
            })
          : undefined;
    } catch (error) {
      if (error instanceof RunGrantPolicyError) throw new PreflightError(error.outcomes);
      throw error;
    }
    const throwIfAborted = () => {
      if (signal?.aborted) throw signal.reason ?? new Error('MCP preflight aborted');
    };
    throwIfAborted();
    const user = await deps.getUser(principal.id);
    throwIfAborted();
    if (!user || user.tenantId !== principal.tenantId) throw new PreflightError([]);
    user.id = principal.id;
    let appConfig: AppConfig | undefined;
    const loadAppConfig = async (): Promise<AppConfig | undefined> => {
      appConfig ??= await deps.getAppConfig({
        ...getAppConfigOptionsFromUser(user),
        failClosed: true,
      });
      return appConfig;
    };
    const { tools, serverHints } = await resolveRequirements(
      agentId,
      user,
      deps,
      loadAppConfig,
      signal,
    );
    const selectedTools = tools.filter(
      ({ name }) =>
        name.includes(Constants.mcp_delimiter) &&
        !name.startsWith(`${Constants.mcp_server}${Constants.mcp_delimiter}`),
    );
    // Nothing to make ready. A grant may allow the agents' other tools and no MCP tool at all,
    // and the ones a grant leaves out are not loaded.
    if (selectedTools.length === 0) return [];

    const effectiveConfig = await loadAppConfig();
    const rawConfig = effectiveConfig?.mcpConfig ?? {};
    const configNames = Object.keys(rawConfig);
    const candidateNames = Array.from(new Set([...configNames, ...serverHints]));
    // Authoritative config names claim normalized aliases before persisted hints.
    // A hint is often already normalized (for example `Sales_Force` for the real
    // config name `Sales Force`) and must not shadow that registry identity.
    const aliases = buildServerNameAliases(configNames);
    for (const hint of serverHints) {
      if (!aliases.has(hint)) aliases.set(hint, hint);
      const normalized = normalizeServerName(hint);
      if (!aliases.has(normalized)) aliases.set(normalized, hint);
    }
    const collectSelected = (
      rawNames: string[],
      nameAliases: Map<string, string>,
      exactNames: Set<string>,
    ) => {
      const candidates = [...rawNames, ...nameAliases.keys()];
      const selected = new Map<string, string[]>();
      const serverAgentIds = new Map<string, Set<string>>();
      const toolAgentIds = new Map<string, Map<string, Set<string>>>();
      for (const { name: tool, agentId: toolAgentId } of selectedTools) {
        const [, name] = splitMCPToolKey(tool, candidates);
        if (!name) continue;
        const server = exactNames.has(name) ? name : (nameAliases.get(name) ?? name);
        const owners = serverAgentIds.get(server) ?? new Set<string>();
        owners.add(toolAgentId);
        serverAgentIds.set(server, owners);
        const required = selected.get(server) ?? [];
        if (!tool.startsWith(`${Constants.mcp_all}${Constants.mcp_delimiter}`)) {
          const normalizedTool = normalizeMCPToolKey(tool, rawNames);
          required.push(normalizedTool);
          const serverTools = toolAgentIds.get(server) ?? new Map<string, Set<string>>();
          const toolOwners = serverTools.get(normalizedTool) ?? new Set<string>();
          toolOwners.add(toolAgentId);
          serverTools.set(normalizedTool, toolOwners);
          toolAgentIds.set(server, serverTools);
        }
        selected.set(server, required);
      }
      return { selected, serverAgentIds, toolAgentIds };
    };
    let { selected, serverAgentIds, toolAgentIds } = collectSelected(
      candidateNames,
      aliases,
      new Set(configNames),
    );
    const outcomesForOwners = (
      server: string,
      status: ScheduleMCPStatus,
      preferredOwners?: Set<string>,
    ): ScheduleMCPOutcome[] => {
      const owners = preferredOwners ?? serverAgentIds.get(server);
      if (!owners || owners.size === 0) return [{ server, status }];
      if (status === 'ready') {
        const ownerId = owners.has(agentId) ? agentId : owners.values().next().value;
        return [{ server, status, ...(ownerId !== agentId ? { agentId: ownerId } : {}) }];
      }
      return [...owners].map((ownerId) => ({
        server,
        status,
        ...(ownerId !== agentId ? { agentId: ownerId } : {}),
      }));
    };
    const capabilities = effectiveConfig?.endpoints?.[EModelEndpoint.agents]?.capabilities ?? [];
    if (!capabilities.includes(AgentCapabilities.tools)) {
      throw new PreflightError(
        [...selected.keys()].flatMap((server) =>
          outcomesForOwners(server, 'mcp_configuration_missing'),
        ),
      );
    }
    const permitted = await checkAccess({
      user,
      permissionType: PermissionTypes.MCP_SERVERS,
      permissions: [Permissions.USE],
      getRoleByName: deps.getRoleByName,
    });
    const refuse = (): never => {
      throw new PreflightError(
        [...selected.keys()].flatMap((server) =>
          outcomesForOwners(server, 'mcp_permission_denied'),
        ),
      );
    };
    /** The MCP tools a grant allows: the stored grant's, or the one handed over. */
    const pending =
      options.grant &&
      new Map(
        options.grant.consents.map(({ resource, permittedTools }) => [
          resource.serverName,
          new Map(permittedTools.map(({ agentId: owner, tools }) => [owner, new Set(tools)])),
        ]),
      );
    /** MCP tools the pending grant lists among the other tools: on a server with no consent. */
    const listed = new Map(
      (options.grant?.tools ?? []).map(({ agentId: owner, tools }) => [owner, new Set(tools)]),
    );
    const grants: RunGrantExecution<Identity>['grants'] | undefined = execution?.enrolled
      ? execution.grants
      : pending &&
        ((owner, server, tool) =>
          options.grant?.everything === true ||
          pending.get(server)?.get(owner)?.has(tool) === true ||
          listedMCPKeys(server, tool).some((key) => listed.get(owner)?.has(key) === true));
    // A run under a grant needs the permission only for the MCP tools the grant allows, so
    // it is held to it below, once the tools the owner left out are set aside.
    if (!permitted && !grants) refuse();
    // Resolve once more against the ACL-filtered registry before initializing config.
    // Exact accessible identities must beat normalized aliases from another tier, just
    // as they do in the interactive runtime.
    const accessibleServers = await deps.getServerConfigs(user.id, {}, user.role);
    const authoritativeNames = Array.from(
      new Set([...Object.keys(accessibleServers), ...configNames]),
    );
    const authoritativeCandidates = Array.from(new Set([...authoritativeNames, ...serverHints]));
    const authoritativeAliases = buildServerNameAliases(authoritativeNames);
    for (const hint of serverHints) {
      if (!authoritativeAliases.has(hint)) authoritativeAliases.set(hint, hint);
      const normalized = normalizeServerName(hint);
      if (!authoritativeAliases.has(normalized)) authoritativeAliases.set(normalized, hint);
    }
    ({ selected, serverAgentIds, toolAgentIds } = collectSelected(
      authoritativeCandidates,
      authoritativeAliases,
      new Set([...Object.keys(accessibleServers), ...configNames]),
    ));
    if (grants) {
      // The owner may have allowed only some of what the agents select. Readiness is about
      // what the run is allowed to use: a tool or a whole server left out of the grant is
      // refused when called, and must not keep the run from starting.
      const isGranted = (server: string, toolKey: string, owner: string): boolean =>
        grants(owner, server, splitMCPToolKey(toolKey, authoritativeCandidates)[0]);
      for (const [server, serverTools] of toolAgentIds) {
        for (const [toolKey, owners] of serverTools) {
          for (const owner of owners) if (!isGranted(server, toolKey, owner)) owners.delete(owner);
          if (owners.size === 0) serverTools.delete(toolKey);
        }
        if (serverTools.size === 0) toolAgentIds.delete(server);
      }
      for (const [server, required] of selected) {
        const serverTools = toolAgentIds.get(server);
        if (!serverTools) {
          // No tool is named there: the agents select the server as a whole. It is made
          // ready for the agents the grant allows that for, which a grant of the whole agent
          // does and a grant that lists its tools does not.
          const owners = [...(serverAgentIds.get(server) ?? [])].filter((owner) =>
            grants(owner, server, Constants.mcp_all),
          );
          if (owners.length > 0) {
            serverAgentIds.set(server, new Set(owners));
            continue;
          }
          selected.delete(server);
          serverAgentIds.delete(server);
          continue;
        }
        selected.set(
          server,
          required.filter((toolKey) => serverTools.has(toolKey)),
        );
        serverAgentIds.set(
          server,
          new Set([...serverTools.values()].flatMap((owners) => [...owners])),
        );
      }
      // The owner allowed none of the MCP tools selected: the other tools, or none still
      // selected. Nothing to connect to, and the run is not held back for it.
      if (selected.size === 0) return [];
      if (!permitted) refuse();
    }
    const selectedRawConfig = Object.fromEntries(
      Object.entries(rawConfig).filter(([serverName]) => selected.has(serverName)),
    );
    const requestProbeLimit = createConcurrencyLimiter(options.concurrency);
    const config = await deps.ensureConfigServers(selectedRawConfig, (task) =>
      requestProbeLimit(() => {
        if (signal?.aborted) throw new MCPConfigInitializationCanceledError();
        return sharedProbeLimit(async () => {
          if (signal?.aborted) throw new MCPConfigInitializationCanceledError();
          return task();
        });
      }),
    );
    const servers = await deps.getServerConfigs(user.id, config, user.role);
    const shadowed = findShadowedServerNames(
      Array.from(new Set([...configNames, ...Object.keys(servers)])),
    );
    throwIfAborted();
    const auth = await getPluginAuthMap({
      userId: user.id,
      pluginKeys: [...selected.keys()].map((server) => `${Constants.mcp_prefix}${server}`),
      throwError: true,
      findPluginAuthsByKeys: deps.findPluginAuthsByKeys,
    });
    const upstreamTokenProviderResolver = credentials.tokens?.(user, identity, signal);
    throwIfAborted();
    const requestBody = {
      messageId: randomUUID(),
      conversationId: randomUUID(),
      parentMessageId: String(Constants.NO_PARENT),
    };
    const outcomes = (
      await Promise.all(
        [...selected].map(([server, required]) =>
          requestProbeLimit(() =>
            sharedProbeLimit(async (): Promise<ScheduleMCPOutcome[]> => {
              const context = createMCPRequestContext();
              if (identity)
                credentials.attach?.(context, identity, options.stage ?? 'invoke', signal, {
                  manual: options.manual === true,
                });
              try {
                throwIfAborted();
                const serverConfig = servers[server];
                const customUserVars = auth[`${Constants.mcp_prefix}${server}`];
                if (
                  !serverConfig ||
                  shadowed.has(server) ||
                  getMissingCustomUserVars(serverConfig, customUserVars).length > 0
                ) {
                  return outcomesForOwners(server, 'mcp_configuration_missing');
                }
                let reauth = false;
                try {
                  const connection = await deps.connect({
                    user,
                    serverName: server,
                    serverConfig,
                    customUserVars,
                    requestBody,
                    requestScopedConnections: context,
                    upstreamTokenProviderResolver,
                    ephemeralConnection: true,
                    returnOnOAuth: true,
                    oauthStart: async () => {
                      reauth = true;
                    },
                    signal,
                  });
                  const snapshot = await connection.fetchToolsSnapshot(options.deadlineMs, signal);
                  if (snapshot.authenticationError) throw snapshot.authenticationError;
                  if (execution) {
                    const authorizations: Array<Promise<unknown>> = [];
                    for (const [toolKey, owners] of toolAgentIds.get(server) ?? []) {
                      const [selectionName] = splitMCPToolKey(toolKey, authoritativeCandidates);
                      const definitions = snapshot.tools.filter(
                        (tool) =>
                          tool.name === selectionName ||
                          stripServerNamePrefix(tool.name, normalizeServerName(server)) ===
                            selectionName,
                      );
                      for (const ownerId of owners) {
                        authorizations.push(
                          execution.bind(ownerId, selectionName).authorize({
                            user,
                            serverName: server,
                            serverConfig,
                            toolName: definitions.length === 1 ? definitions[0].name : '',
                            loadTools: async () => snapshot,
                            signal,
                            readiness: true,
                          }),
                        );
                      }
                    }
                    await Promise.all(authorizations);
                  }
                  const available = new Set(
                    Object.keys(formatMCPServerTools(server, snapshot.tools)),
                  );
                  for (const tool of snapshot.tools) {
                    available.add(
                      `${tool.name}${Constants.mcp_delimiter}${normalizeServerName(server)}`,
                    );
                  }
                  let status: ScheduleMCPStatus = 'ready';
                  if (reauth) {
                    status = 'mcp_reauth_required';
                  } else if (!snapshot.complete) {
                    status = 'mcp_unavailable';
                  } else if (
                    available.size === 0 ||
                    !required.every((tool) => available.has(tool))
                  ) {
                    status = 'mcp_configuration_missing';
                  }
                  const missingTools =
                    status === 'mcp_configuration_missing'
                      ? required.filter((tool) => !available.has(tool))
                      : [];
                  const missingOwners = new Set<string>();
                  for (const missingTool of missingTools) {
                    for (const ownerId of toolAgentIds.get(server)?.get(missingTool) ?? []) {
                      missingOwners.add(ownerId);
                    }
                  }
                  return outcomesForOwners(
                    server,
                    status,
                    missingOwners.size > 0 ? missingOwners : undefined,
                  );
                } catch (error) {
                  if (
                    error instanceof ScheduledMCPBearerError ||
                    error instanceof RunGrantPolicyError
                  )
                    return error.outcomes;
                  if (
                    error instanceof OboTokenResolutionError &&
                    error.reason === 'missing_upstream_provider'
                  ) {
                    return outcomesForOwners(server, 'mcp_configuration_missing').map(
                      (outcome) => ({
                        ...outcome,
                        detail: 'unattended_auth_required' as const,
                      }),
                    );
                  }
                  return outcomesForOwners(
                    server,
                    reauth ||
                      error instanceof MCPAuthenticationRejectedError ||
                      error instanceof OpenIDReauthRequiredError ||
                      (error instanceof OboTokenResolutionError && !error.retryable) ||
                      error instanceof MCPOAuthSecretReentryRequiredError ||
                      isOAuthAuthenticationError(error)
                      ? 'mcp_reauth_required'
                      : 'mcp_unavailable',
                  );
                }
              } finally {
                // The shared slot bounds live transports, not only tools/list calls.
                // Dispose this probe's isolated connection before releasing the slot.
                await cleanupMCPRequestContext(context);
              }
            }),
          ),
        ),
      )
    ).flat();
    if (outcomes.some((item) => item.status !== 'ready')) throw new PreflightError(outcomes);
    return outcomes;
  };
  return (agentId, principal, options) => {
    const signal = createDeadlineAbortSignal(options.deadlineMs, options.signal);
    return detachOnAbort(runPreflight(agentId, principal, { ...options, signal }), signal);
  };
}
