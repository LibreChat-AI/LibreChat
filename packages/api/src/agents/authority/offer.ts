import {
  Constants,
  buildServerNameAliases,
  splitMCPToolKey,
  runGrantResourceBindingSchema,
} from 'librechat-data-provider';
import type {
  TModelsConfig,
  RunGrantIdentity,
  RunGrantTarget,
  ScheduledMCPIdentity,
  RunGrantToolSelection,
  RunGrantResourceBinding,
} from 'librechat-data-provider';
import type {
  AgentGraphAccessContext,
  AgentGraphNode,
  IUser,
  AppConfig,
} from '@librechat/data-schemas';
import type {
  RunGrantToolsResolver,
  RunGrantServersResolver,
  RunGrantTargetResolver,
} from './service';
import type { GetAppConfigOptions } from '~/app/service';
import type { ParsedServerConfig } from '~/mcp/types';
import { getRunGrantPolicyRevision, isRunGrantToolItem } from './policy';
import { getRunGrantConfigurationRevision } from './configuration';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { resolveRequirements } from './requirements';
import { RunGrantError } from './service';

export interface RunGrantOfferDeps {
  findUser: (id: string) => Promise<IUser | null>;
  canUseRoot: (agentId: string, user: IUser) => Promise<boolean>;
  /** Whether the owner may use MCP servers. Absent, they may. Their other tools are offered either way. */
  canUseMCP?: (user: IUser) => Promise<boolean>;
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig | undefined>;
  resolveGraphAccess: (user: IUser) => Promise<AgentGraphAccessContext>;
  getNodes: (ids: string[], access?: AgentGraphAccessContext) => Promise<AgentGraphNode[]>;
  getModelsConfig: (user: IUser) => Promise<TModelsConfig>;
  /**
   * The operator's servers as the registry holds them, inspected. A server `librechat.yaml`
   * defines unchanged is left out, since the registry already has it; what comes back is
   * handed to `getServers`, as a run's readiness check does.
   */
  ensureConfigServers: (
    config: NonNullable<AppConfig['mcpConfig']>,
  ) => Promise<Record<string, ParsedServerConfig>>;
  getServers: (
    user: IUser,
    config: Record<string, ParsedServerConfig>,
  ) => Promise<Record<string, ParsedServerConfig>>;
}

interface OfferOptions {
  /** Where the operator declared the servers this kind of grant may cover. */
  resources?: (
    appConfig: AppConfig | undefined,
  ) => Record<string, RunGrantResourceBinding> | undefined;
  /**
   * A schedule's grant covers the whole run, so the agents' other tools are offered too, each
   * to be allowed or left out. A grant that only limits MCP use leaves them alone.
   */
  otherTools?: 'offer' | 'ignore';
}

interface Offer {
  targets: RunGrantTarget[];
  tools: RunGrantToolSelection[];
  /** Every MCP server the agents select a tool on, offered or not. */
  servers: string[];
}

/**
 * Resolves what the owner can be offered: the MCP tools the agent graph selects, on servers
 * whose recipient the operator declared. Does not mint, and connects to nothing the registry
 * has inspected already.
 *
 * A server whose configuration no longer matches the operator's declaration is left out, and
 * the rest is still offered. A grant that lists its tools then does not cover it; a grant of
 * the whole agent does, as the owner's own use would.
 *
 * A server the operator declared nothing for is not a target either: there is no recipient
 * to bind. Its tools are offered among the agents' other tools (see `createRunGrantOffer`),
 * where the grant covers those.
 */
export function createRunGrantTargetResolver<
  Identity extends RunGrantIdentity = ScheduledMCPIdentity,
>(deps: RunGrantOfferDeps, options: OfferOptions = {}): RunGrantTargetResolver<Identity> {
  return createRunGrantOffer<Identity>(deps, options).targets;
}

/**
 * Whether a key selects something on an MCP server: a tool, or every tool there. The marker
 * that only attaches a server to an agent, with no tool selected, does not.
 */
const selectsTool = (key: string): boolean =>
  key.includes(Constants.mcp_delimiter) &&
  !key.startsWith(`${Constants.mcp_server}${Constants.mcp_delimiter}`);

/**
 * The operator's servers to hand the registry, so that a declared server the agents use comes
 * back as a run will see it. A grant is bound to that configuration, and inspection fills in
 * what the operator left out (whether the server requires OAuth): the entry as written would
 * never match the one a run checks the grant against.
 *
 * Only the declared servers the agents select are inspected, as a run's readiness check
 * inspects only what it needs: a cold or unreachable server nobody selected must not hold up
 * an offer. A declared server is never handed over as written. The rest are, since nothing
 * is bound to them and only their names are read.
 */
async function configured(
  deps: Pick<RunGrantOfferDeps, 'ensureConfigServers'>,
  raw: NonNullable<AppConfig['mcpConfig']>,
  declared: ReadonlySet<string>,
  tools: ReadonlyArray<{ name: string }>,
): Promise<Record<string, ParsedServerConfig>> {
  const names = Object.keys(raw);
  const aliases = buildServerNameAliases(names);
  const candidates = [...names, ...aliases.keys()];
  const selected = new Set<string>();
  for (const { name: key } of tools) {
    if (!selectsTool(key)) continue;
    const [tool, alias] = splitMCPToolKey(key, candidates);
    const name = alias && (raw[alias] ? alias : aliases.get(alias));
    if (tool && name && declared.has(name)) selected.add(name);
  }
  const entries = Object.entries(raw);
  const rest = Object.fromEntries(entries.filter(([name]) => !declared.has(name)));
  const inspected = await deps.ensureConfigServers(
    Object.fromEntries(entries.filter(([name]) => selected.has(name))),
  );
  return { ...(rest as Record<string, ParsedServerConfig>), ...inspected };
}

/**
 * Both halves of an offer, read once: the MCP tools on declared servers, and the agents'
 * other tools. Asked for together, as the consent view does, they share one walk of the
 * agent graph.
 */
export function createRunGrantOffer<Identity extends RunGrantIdentity = ScheduledMCPIdentity>(
  deps: RunGrantOfferDeps,
  options: OfferOptions = {},
): {
  targets: RunGrantTargetResolver<Identity>;
  tools: RunGrantToolsResolver<Identity>;
  servers: RunGrantServersResolver<Identity>;
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
      throw new RunGrantError('consent_forbidden');
    user.id = identity.ownerId;
    if (!(await deps.canUseRoot(identity.agentId, user)))
      throw new RunGrantError('consent_forbidden');
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
    const { tools, candidates: candidateTools } = await resolveRequirements(
      identity.agentId,
      user,
      {
        getAgentGraphNodes: deps.getNodes,
        resolveAgentGraphAccess: () => deps.resolveGraphAccess(user),
        getModelsConfig: deps.getModelsConfig,
      },
      async () => appConfig,
      signal,
    );
    signal?.throwIfAborted();
    const servers = await deps.getServers(
      user,
      await configured(
        deps,
        appConfig?.mcpConfig ?? {},
        new Set(mcp ? Object.keys(bindings) : []),
        tools,
      ),
    );
    const names = Object.keys(servers);
    const aliases = buildServerNameAliases(names);
    const candidates = [...names, ...aliases.keys()];
    const others = new Map<string, Set<string>>();
    if (options.otherTools !== 'ignore') {
      for (const { name, agentId } of candidateTools) {
        if (!isRunGrantToolItem(name)) continue;
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
      if (!selectsTool(key)) continue;
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
    const targets = new Map<string, RunGrantTarget>();
    for (const [name, agents] of selected) {
      const config = servers[name];
      const binding = runGrantResourceBindingSchema.safeParse(bindings[name]);
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
        configurationRevision = getRunGrantConfigurationRevision(config, metadata);
      } catch (error) {
        if (error instanceof RunGrantError) continue;
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
      target.policyRevision = getRunGrantPolicyRevision(target.permittedTools);
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
