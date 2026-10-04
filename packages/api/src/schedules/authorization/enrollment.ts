import {
  Constants,
  buildServerNameAliases,
  splitMCPToolKey,
  normalizeServerName,
  stripServerNamePrefix,
  scheduledMCPResourceBindingSchema,
  scheduledMCPReadOnlyPolicySchema,
} from 'librechat-data-provider';
import type {
  AgentGraphAccessContext,
  AgentGraphNode,
  IUser,
  AppConfig,
} from '@librechat/data-schemas';
import type { ScheduledMCPTarget, TModelsConfig } from 'librechat-data-provider';
import type { ScheduleMCPEnrollmentResolver } from './service';
import type { GetAppConfigOptions } from '~/app/service';
import type { ParsedServerConfig } from '~/mcp/types';
import { getScheduledMCPPolicyRevision, isScheduledMCPCandidate } from './policy';
import { getScheduledMCPConfigurationRevision } from './configuration';
import { resolveScheduledMCPRequirements } from '../requirements';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { ScheduleMCPConsentError } from './service';

export interface ScheduleMCPEnrollmentDeps {
  findUser: (id: string) => Promise<IUser | null>;
  canUseRoot: (agentId: string, user: IUser) => Promise<boolean>;
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig | undefined>;
  resolveGraphAccess: (user: IUser) => Promise<AgentGraphAccessContext>;
  getNodes: (ids: string[], access?: AgentGraphAccessContext) => Promise<AgentGraphNode[]>;
  getModelsConfig: (user: IUser) => Promise<TModelsConfig>;
  getServers: (
    user: IUser,
    config: Record<string, ParsedServerConfig>,
  ) => Promise<Record<string, ParsedServerConfig>>;
}

/** Resolves persisted selections and operator-declared recipients without connecting or minting. */
export function createScheduleMCPEnrollmentResolver(
  deps: ScheduleMCPEnrollmentDeps,
): ScheduleMCPEnrollmentResolver {
  return async (identity, { signal }) => {
    signal?.throwIfAborted();
    const user = await deps.findUser(identity.ownerId);
    if (!user || (user.tenantId ?? null) !== identity.tenantId)
      throw new ScheduleMCPConsentError('consent_forbidden');
    user.id = identity.ownerId;
    if (!(await deps.canUseRoot(identity.agentId, user)))
      throw new ScheduleMCPConsentError('consent_forbidden');
    const [appConfig, baseConfig] = await Promise.all([
      deps.getAppConfig({ ...getAppConfigOptionsFromUser(user), failClosed: true }),
      deps.getAppConfig({ baseOnly: true, failClosed: true }),
    ]);
    const schedules = appConfig?.interfaceConfig?.schedules;
    const bindings = typeof schedules === 'object' ? schedules?.mcpConsent?.resources : undefined;
    if (!bindings || !Object.keys(bindings).length) return [];
    const servers = await deps.getServers(
      user,
      (appConfig?.mcpConfig ?? {}) as Record<string, ParsedServerConfig>,
    );
    const names = Object.keys(servers);
    const aliases = buildServerNameAliases(names);
    const candidates = [...names, ...aliases.keys()];
    const { tools, candidates: candidateTools } = await resolveScheduledMCPRequirements(
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
    if (candidateTools.some(({ name }) => !isScheduledMCPCandidate(name)))
      throw new ScheduleMCPConsentError('consent_unavailable');
    const selected = new Map<string, Map<string, Set<string>>>();
    for (const { name: key, agentId } of tools) {
      if (
        !key.includes(Constants.mcp_delimiter) ||
        key.startsWith(`${Constants.mcp_server}${Constants.mcp_delimiter}`)
      )
        continue;
      if (key.startsWith(`${Constants.mcp_all}${Constants.mcp_delimiter}`))
        throw new ScheduleMCPConsentError('consent_unavailable');
      const [tool, alias] = splitMCPToolKey(key, candidates);
      if (!alias) throw new ScheduleMCPConsentError('consent_unavailable');
      const name = servers[alias] ? alias : aliases.get(alias);
      if (!name || !tool) throw new ScheduleMCPConsentError('consent_unavailable');
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
        throw new ScheduleMCPConsentError('consent_unavailable');
      const metadata = binding.data;
      if (
        ['stored_oauth', 'renewable_obo', 'resource_bearer'].includes(metadata.credentialMode) &&
        (!metadata.issuer || !metadata.audience)
      )
        throw new ScheduleMCPConsentError('consent_unavailable');
      const configurationRevision = getScheduledMCPConfigurationRevision(config, metadata);
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
      const baseSchedules = baseConfig?.interfaceConfig?.schedules;
      const declaration =
        typeof baseSchedules === 'object'
          ? baseSchedules.mcpConsent?.readOnlyPolicy?.[target.resource.serverName]
          : undefined;
      const effective =
        typeof schedules === 'object'
          ? schedules.mcpConsent?.readOnlyPolicy?.[target.resource.serverName]
          : undefined;
      if (effective != null && JSON.stringify(effective) !== JSON.stringify(declaration))
        throw new ScheduleMCPConsentError('consent_unavailable');
      const policy = scheduledMCPReadOnlyPolicySchema.safeParse(declaration);
      if (
        !policy.success ||
        target.permittedTools.some(({ tools }) =>
          tools.some(
            (selection) =>
              Object.keys(policy.data.tools).filter(
                (name) =>
                  name === selection ||
                  stripServerNamePrefix(name, normalizeServerName(target.resource.serverName)) ===
                    selection,
              ).length !== 1,
          ),
        )
      )
        throw new ScheduleMCPConsentError('consent_unavailable');
      target.policyRevision = getScheduledMCPPolicyRevision(target.permittedTools, policy.data);
    }
    return [...targets.values()];
  };
}
