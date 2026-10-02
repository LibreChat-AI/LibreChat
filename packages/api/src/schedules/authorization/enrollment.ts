import { createHash } from 'node:crypto';
import {
  Constants,
  MAX_SUBAGENT_GRAPH_NODES,
  buildServerNameAliases,
  splitMCPToolKey,
  isActionTool,
  scheduledMCPResourceBindingSchema,
} from 'librechat-data-provider';
import type {
  AgentGraphAccessContext,
  AgentGraphNode,
  IUser,
  AppConfig,
} from '@librechat/data-schemas';
import type { ScheduledMCPTarget } from 'librechat-data-provider';
import type { ScheduleMCPEnrollmentResolver } from './service';
import type { GetAppConfigOptions } from '~/app/service';
import type { ParsedServerConfig } from '~/mcp/types';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { ScheduleMCPConsentError } from './service';

export interface ScheduleMCPEnrollmentDeps {
  findUser: (id: string) => Promise<IUser | null>;
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig | undefined>;
  resolveGraphAccess: (user: IUser) => Promise<AgentGraphAccessContext>;
  getNodes: (ids: string[], access: AgentGraphAccessContext) => Promise<AgentGraphNode[]>;
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
    const [appConfig, access] = await Promise.all([
      deps.getAppConfig({ ...getAppConfigOptionsFromUser(user), failClosed: true }),
      deps.resolveGraphAccess(user),
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
    const targets = new Map<string, ScheduledMCPTarget>();
    const visited = new Set<string>();
    let frontier = [identity.agentId];
    while (frontier.length) {
      signal?.throwIfAborted();
      const batch = [...new Set(frontier)].filter(
        (id) => !visited.has(id) && id !== '__start__' && id !== '__end__',
      );
      if (!batch.length) break;
      if (visited.size + batch.length > MAX_SUBAGENT_GRAPH_NODES)
        throw new ScheduleMCPConsentError('consent_unavailable');
      batch.forEach((id) => visited.add(id));
      const nodes = await deps.getNodes(batch, access);
      if (nodes.length !== batch.length) throw new ScheduleMCPConsentError('consent_forbidden');
      frontier = [];
      for (const node of nodes) {
        frontier.push(...(node.agent_ids ?? []));
        for (const edge of node.edges ?? []) frontier.push(...[edge.from, edge.to].flat());
        if (node.subagents?.enabled) {
          frontier.push(...(node.subagents.agent_ids ?? []));
          for (const graph of node.subagents.graphs ?? [])
            frontier.push(...(graph.agent_ids ?? []));
        }
        const selections = new Map<string, string[]>();
        for (const key of node.tools ?? []) {
          if (
            isActionTool(key) ||
            !key.includes(Constants.mcp_delimiter) ||
            key.startsWith(`${Constants.mcp_server}${Constants.mcp_delimiter}`)
          )
            continue;
          // A wildcard is not a stable enrollment surface. Owners must select explicit tools.
          if (key.startsWith(`${Constants.mcp_all}${Constants.mcp_delimiter}`))
            throw new ScheduleMCPConsentError('consent_unavailable');
          const [tool, alias] = splitMCPToolKey(key, [...names, ...aliases.keys()]);
          if (!alias) throw new ScheduleMCPConsentError('consent_unavailable');
          const name = servers[alias] ? alias : aliases.get(alias);
          if (!name || !tool || !servers[name])
            throw new ScheduleMCPConsentError('consent_unavailable');
          const tools = selections.get(name) ?? [];
          tools.push(tool);
          selections.set(name, tools);
        }
        for (const [name, tools] of selections) {
          let target = targets.get(name);
          if (!target) {
            const config = servers[name];
            const binding = scheduledMCPResourceBindingSchema.safeParse(bindings[name]);
            if (
              !binding.success ||
              !('url' in config) ||
              config.url !== binding.data.url ||
              binding.data.credentialMode === 'browser_bearer'
            )
              throw new ScheduleMCPConsentError('consent_unavailable');
            const metadata = binding.data;
            if (
              ['stored_oauth', 'renewable_obo', 'resource_bearer'].includes(
                metadata.credentialMode,
              ) &&
              (!metadata.issuer || !metadata.audience)
            )
              throw new ScheduleMCPConsentError('consent_unavailable');
            const configurationRevision = createHash('sha256')
              .update(
                JSON.stringify({
                  metadata,
                  type: config.type,
                  oauth: config.oauth && {
                    authorization: config.oauth.authorization_url,
                    token: config.oauth.token_url,
                    client: config.oauth.client_id,
                  },
                  obo: 'obo' in config ? config.obo : undefined,
                  apiKey: config.apiKey && {
                    source: config.apiKey.source,
                    type: config.apiKey.authorization_type,
                    header: config.apiKey.custom_header,
                  },
                }),
              )
              .digest('hex');
            target = {
              resource: { ...metadata, serverName: name, configurationRevision },
              permittedTools: [],
              policyRevision: '',
            };
            targets.set(name, target);
          }
          target.permittedTools.push({ agentId: node.id, tools: [...new Set(tools)].sort() });
        }
      }
    }
    signal?.throwIfAborted();
    for (const target of targets.values()) {
      target.permittedTools.sort((a, b) => a.agentId.localeCompare(b.agentId));
      // Selection revision is not read-only certification; invocation still requires trusted policy.
      target.policyRevision = createHash('sha256')
        .update(JSON.stringify(target.permittedTools))
        .digest('hex');
    }
    return [...targets.values()];
  };
}
