import { useMemo } from 'react';
import {
  AuthTypeEnum,
  actionDelimiter,
  openapiToFunction,
  validateAndParseOpenAPISpec,
} from 'librechat-data-provider';
import { useAgentCapabilities, useGetAgentsConfig } from '~/hooks';
import { useGetExpandedAgentByIdQuery } from '~/data-provider';
import { useAgentPanelContext } from '~/Providers';
import { isEphemeralAgent } from '~/common';
import Background from '../Background';

/** "Background execution" switch for a saved action — opts every operation of
 *  the action into background dispatch via `tool_options`. Hidden for OAuth
 *  actions: their calls can block on an interactive login prompt that a
 *  detached run could never surface (the server excludes them regardless). */
export default function ActionBackground({ agentId }: { agentId: string }) {
  const { action } = useAgentPanelContext();
  const { agentsConfig } = useGetAgentsConfig();
  const { backgroundToolsEnabled } = useAgentCapabilities(agentsConfig?.capabilities);
  const { data: agent } = useGetExpandedAgentByIdQuery(agentId, {
    enabled: backgroundToolsEnabled && action != null && !isEphemeralAgent(agentId),
  });

  /** The agent's `actions` entries are `${encodedDomain}_action_${action_id}`,
   *  so the saved encoded domain is recoverable without re-implementing the
   *  server's domain encoding. The domain alone is NOT enough to identify this
   *  action's tools: two actions may share a hostname, and their operations
   *  then share the suffix. Narrow by this spec's own operation ids, falling
   *  back to the suffix only when no other action shares the domain. */
  const actionToolIds = useMemo(() => {
    const actionId = action?.action_id;
    if (!actionId || !agent) {
      return [];
    }
    let domain = '';
    const domainCounts = new Map<string, number>();
    for (const entry of agent.actions ?? []) {
      const idx = entry.indexOf(actionDelimiter);
      if (idx < 1) {
        continue;
      }
      const entryDomain = entry.slice(0, idx);
      domainCounts.set(entryDomain, (domainCounts.get(entryDomain) ?? 0) + 1);
      if (entry.slice(idx + actionDelimiter.length) === actionId) {
        domain = entryDomain;
      }
    }
    if (!domain) {
      return [];
    }

    const sharesDomain = (domainCounts.get(domain) ?? 0) > 1;
    const suffix = `${actionDelimiter}${domain}`;
    const domainTools = (agent.tools ?? []).filter((tool) => tool.endsWith(suffix));
    const spec = action?.metadata.raw_spec;
    const parsed = spec ? validateAndParseOpenAPISpec(spec) : undefined;
    if (!parsed?.spec) {
      return sharesDomain ? [] : domainTools;
    }
    const functionSignatures = openapiToFunction(parsed.spec).functionSignatures;
    const operationIds = new Set(functionSignatures.map((sig) => sig.name));
    const backgroundOperationIds = new Set(
      functionSignatures
        .filter((sig) => sig.parameters.properties.run_in_background == null)
        .map((sig) => sig.name),
    );
    const ownTools = domainTools.filter((tool) =>
      operationIds.has(tool.slice(0, tool.length - suffix.length)),
    );
    if (ownTools.length === 0) {
      return sharesDomain ? [] : domainTools;
    }
    return ownTools.filter((tool) =>
      backgroundOperationIds.has(tool.slice(0, tool.length - suffix.length)),
    );
  }, [action?.action_id, action?.metadata.raw_spec, agent]);

  if (action?.metadata.auth?.type === AuthTypeEnum.OAuth) {
    return null;
  }

  return (
    <Background
      toolIds={actionToolIds}
      switchId="action-background-tools"
      labelKey="com_ui_tool_background"
      infoKey="com_nav_info_tool_background"
    />
  );
}
