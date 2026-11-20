import {
  Constants,
  buildServerNameAliases,
  splitMCPToolKey,
  scheduledMCPResourceBindingSchema,
} from 'librechat-data-provider';
import type {
  TModelsConfig,
  MCPGrantIdentity,
  ScheduledMCPTarget,
  ScheduledMCPIdentity,
  ScheduledMCPToolSelection,
  ScheduledMCPResourceBinding,
} from 'librechat-data-provider';
import type {
  AgentGraphAccessContext,
  AgentGraphNode,
  IUser,
  AppConfig,
} from '@librechat/data-schemas';
import type {
  ScheduleToolsResolver,
  ScheduleServersResolver,
  ScheduleMCPEnrollmentResolver,
} from './service';
import type { GetAppConfigOptions } from '~/app/service';
import type { ParsedServerConfig } from '~/mcp/types';
import { getScheduledMCPPolicyRevision, isScheduledToolItem } from './policy';
import { getScheduledMCPConfigurationRevision } from './configuration';
import { resolveScheduledMCPRequirements } from '../requirements';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { ScheduleMCPConsentError } from './service';

export interface ScheduleMCPEnrollmentDeps {
  findUser: (id: string) => Promise<IUser | null>;
  canUseRoot: (agentId: string, user: IUser) => Promise<boolean>;
  /** Whether the owner may use MCP servers. Absent, they may. Their other tools are offered either way. */
  canUseMCP?: (user: IUser) => Promise<boolean>;
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig | undefined>;
  resolveGraphAccess: (user: IUser) => Promise<AgentGraphAccessContext>;
  getNodes: (ids: string[], access?: AgentGraphAccessContext) => Promise<AgentGraphNode[]>;
  getModelsConfig: (user: IUser) => Promise<TModelsConfig>;
  getServers: (
    user: IUser,
    config: Record<string, ParsedServerConfig>,
  ) => Promise<Record<string, ParsedServerConfig>>;
}

interface OfferOptions {
  /** Where the operator declared the servers this kind of grant may cover. */
  resources?: (
    appConfig: AppConfig | undefined,
  ) => Record<string, ScheduledMCPResourceBinding> | undefined;
  /**
   * A schedule's grant covers the whole run, so the agents' other tools are offered too, each
   * to be allowed or left out. A grant that only limits MCP use leaves them alone.
   */
  otherTools?: 'offer' | 'ignore';
}

interface Offer {
  targets: ScheduledMCPTarget[];
  tools: ScheduledMCPToolSelection[];
  /** Every MCP server the agents select a tool on, offered or not. */
  servers: string[];
}

/**
 * Resolves what the owner can be offered: the MCP tools the agent graph selects, on servers
 * whose recipient the operator declared. Does not connect or mint.
 *
 * A server whose configuration no longer matches the operator's declaration is left out, and
 * the rest is still offered. A grant that lists its tools then does not cover it; a grant of
 * the whole agent does, as the owner's own use would.
 *
 * A server the operator declared nothing for is not a target either: there is no recipient
 * to bind. Its tools are offered among the agents' other tools (see `createScheduleMCPOffer`),
 * where the grant covers those.
 */
export function createScheduleMCPEnrollmentResolver<
  Identity extends MCPGrantIdentity = ScheduledMCPIdentity,
>(
  deps: ScheduleMCPEnrollmentDeps,
  options: OfferOptions = {},
): ScheduleMCPEnrollmentResolver<Identity> {
  return createScheduleMCPOffer<Identity>(deps, options).targets;
}

/**
 * Both halves of an offer, read once: the MCP tools on declared servers, and the agents'
 * other tools. Asked for together, as the consent view does, they share one walk of the
 * agent graph.
 */
export function createScheduleMCPOffer<Identity extends MCPGrantIdentity = ScheduledMCPIdentity>(
  deps: ScheduleMCPEnrollmentDeps,
  options: OfferOptions = {},
): {
  targets: ScheduleMCPEnrollmentResolver<Identity>;
  tools: ScheduleToolsResolver<Identity>;
  servers: ScheduleServersResolver<Identity>;
} {
  const pending = new Map<string, { signal?: AbortSignal; offer: Promise<Offer> }>();
  const resolve = (identity: Identity, signal?: AbortSignal): Promise<Offer> => {
    const key = JSON.stringify(identity);
    const shared = pending.get(key);
    if (shared && shared.signal === signal) return shared.offer;
    const offer = load(identity, signal).finally(() => {
      if (pending.get(key)?.offer === offer) pending.delete(key);
    });
    pending.set(key, { signal, offer });
    return offer;
  };
  const declared =
    options.resources ??
    ((appConfig: AppConfig | undefined) => {
      const schedules = appConfig?.interfaceConfig?.schedules;
      return typeof schedules === 'object' ? schedules?.mcpConsent?.resources : undefined;
    });
  const load = async (identity: Identity, signal?: AbortSignal): Promise<Offer> => {
    signal?.throwIfAborted();
    const user = await deps.findUser(identity.ownerId);
    if (!user || (user.tenantId ?? null) !== identity.tenantId)
      throw new ScheduleMCPConsentError('consent_forbidden');
    user.id = identity.ownerId;
    if (!(await deps.canUseRoot(identity.agentId, user)))
      throw new ScheduleMCPConsentError('consent_forbidden');
    const [appConfig, mcp] = await Promise.all([
      deps.getAppConfig({ ...getAppConfigOptionsFromUser(user), failClosed: true }),
      deps.canUseMCP?.(user) ?? true,
    ]);
    const bindings = declared(appConfig) ?? {};
    /**
     * No MCP server can be offered: the operator declared none, or the owner may not use
     * one. The agents' other tools still can, where the grant covers them.
     */
    const undeclared = !mcp || Object.keys(bindings).length === 0;
    if (undeclared && options.otherTools === 'ignore')
      return { targets: [], tools: [], servers: [] };
    const [servers, { tools, candidates: candidateTools }] = await Promise.all([
      deps.getServers(user, (appConfig?.mcpConfig ?? {}) as Record<string, ParsedServerConfig>),
      resolveScheduledMCPRequirements(
        identity.agentId,
        user,
        {
          getAgentGraphNodes: deps.getNodes,
          resolveAgentGraphAccess: () => deps.resolveGraphAccess(user),
          getModelsConfig: deps.getModelsConfig,
        },
        async () => appConfig,
        signal,
      ),
    ]);
    const names = Object.keys(servers);
    const aliases = buildServerNameAliases(names);
    const candidates = [...names, ...aliases.keys()];
    const others = new Map<string, Set<string>>();
    if (options.otherTools !== 'ignore') {
      for (const { name, agentId } of candidateTools) {
        if (!isScheduledToolItem(name)) continue;
        const names_ = others.get(agentId) ?? new Set<string>();
        names_.add(name);
        others.set(agentId, names_);
      }
    }
    const selected = new Map<string, Map<string, Set<string>>>();
    /**
     * In use, whether or not it can be offered. A server a grant holds a consent for and the
     * agents still use, but which is no longer among the targets, has lost its declaration:
     * the grant is stale there, where a server the agents dropped is simply gone.
     */
    const used = new Set<string>();
    for (const { name: key, agentId } of tools) {
      if (
        !key.includes(Constants.mcp_delimiter) ||
        key.startsWith(`${Constants.mcp_server}${Constants.mcp_delimiter}`)
      )
        continue;
      // A selection of every tool on a server is kept under its marker (`mcp_all`): it names
      // no tool to tick, but the server is in use, and a whole-agent grant covers it.
      const [tool, alias] = splitMCPToolKey(key, candidates);
      if (!alias) continue;
      const name = servers[alias] ? alias : aliases.get(alias);
      if (!name || !tool) continue;
      used.add(name);
      if (!mcp) continue;
      // A server the operator declared nothing for has no recipient to hold a consent for.
      // Where the grant covers the agents' other tools, each tool the agents select there is
      // offered among them, under the key the agent has it by: allowed, it is called as the
      // owner's own use would call it. A selection of the whole server is one such key.
      if (bindings[name] === undefined) {
        if (options.otherTools !== 'ignore') {
          const keys = others.get(agentId) ?? new Set<string>();
          keys.add(key);
          others.set(agentId, keys);
        }
        continue;
      }
      const agents = selected.get(name) ?? new Map<string, Set<string>>();
      const names_ = agents.get(agentId) ?? new Set<string>();
      names_.add(tool);
      agents.set(agentId, names_);
      selected.set(name, agents);
    }
    const targets = new Map<string, ScheduledMCPTarget>();
    for (const [name, agents] of selected) {
      const config = servers[name];
      const binding = scheduledMCPResourceBindingSchema.safeParse(bindings[name]);
      if (
        !binding.success ||
        !config ||
        !('url' in config) ||
        config.url !== binding.data.url ||
        binding.data.credentialMode === 'browser_bearer'
      )
        continue;
      const metadata = binding.data;
      if (
        ['stored_oauth', 'renewable_obo', 'resource_bearer'].includes(metadata.credentialMode) &&
        (!metadata.issuer || !metadata.audience)
      )
        continue;
      let configurationRevision: string;
      try {
        configurationRevision = getScheduledMCPConfigurationRevision(config, metadata);
      } catch (error) {
        if (error instanceof ScheduleMCPConsentError) continue;
        throw error;
      }
      targets.set(name, {
        resource: { ...metadata, serverName: name, configurationRevision },
        policyRevision: '',
        permittedTools: [...agents].map(([agentId, selectedTools]) => ({
          agentId,
          tools: [...selectedTools].sort(),
        })),
      });
    }
    signal?.throwIfAborted();
    for (const target of targets.values()) {
      target.permittedTools.sort((a, b) => a.agentId.localeCompare(b.agentId));
      target.policyRevision = getScheduledMCPPolicyRevision(target.permittedTools);
    }
    return {
      targets: [...targets.values()],
      tools: [...others]
        .map(([agentId, selected]) => ({ agentId, tools: [...selected].sort() }))
        .sort((a, b) => a.agentId.localeCompare(b.agentId)),
      servers: [...used].sort(),
    };
  };
  return {
    targets: async (identity, { signal }) => (await resolve(identity, signal)).targets,
    tools: async (identity, { signal }) => (await resolve(identity, signal)).tools,
    servers: async (identity, { signal }) => (await resolve(identity, signal)).servers,
  };
}
