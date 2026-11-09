import { useMemo } from 'react';
import { isAgentsEndpoint, resolveModelCatalogKey } from 'librechat-data-provider';
import type { TConversation, TModelTokenomics } from 'librechat-data-provider';
import { useTokenConfigQuery, useGetAgentByIdQuery, useGetEndpointsQuery } from '~/data-provider';
import { useChatSettings } from '~/Providers/ChatSettingsContext';

export interface TokenLimits {
  /** Statically resolved max context; live snapshots override this at run time */
  maxContextTokens?: number;
  rates?: TModelTokenomics;
  endpoint?: string;
  model?: string;
}

function toNumber(value: unknown): number | undefined {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  return typeof num === 'number' && Number.isFinite(num) && num > 0 ? num : undefined;
}

/**
 * Mirrors the backend resolution chain (packages/api agents/initialize.ts):
 * explicit conversation setting → agent params → model spec preset →
 * server-resolved token config lookup.
 */
export default function useTokenLimits(conversation: TConversation | null): TokenLimits {
  const { modelSpecs } = useChatSettings().config;

  const endpoint = conversation?.endpoint ?? '';
  const agentId = isAgentsEndpoint(endpoint) ? conversation?.agent_id : null;
  const { data: agent } = useGetAgentByIdQuery(agentId);

  const { data: endpointsConfig } = useGetEndpointsQuery();
  const selection = useMemo(() => {
    const specPreset = modelSpecs?.find((item) => item.name === conversation?.spec)?.preset;
    let provider = endpoint;
    let model = conversation?.model ?? '';
    if (agent) {
      provider = agent.provider ?? provider;
      model = agent.model ?? model;
    } else if (specPreset) {
      provider = specPreset.endpoint ?? provider;
      model = model || (specPreset.model ?? '');
    }
    return {
      endpoint: resolveModelCatalogKey(provider, endpointsConfig),
      model,
      maxContextTokens:
        toNumber(conversation?.maxContextTokens) ??
        toNumber(agent?.model_parameters?.maxContextTokens) ??
        toNumber(specPreset?.maxContextTokens),
    };
  }, [
    agent,
    conversation?.spec,
    conversation?.model,
    conversation?.maxContextTokens,
    modelSpecs,
    endpoint,
    endpointsConfig,
  ]);
  const { data: tokenConfig } = useTokenConfigQuery(
    { enabled: !!selection.endpoint && (!agentId || agent != null) },
    selection.endpoint,
  );
  return useMemo(() => {
    const rates = tokenConfig?.[selection.endpoint]?.[selection.model];
    return { ...selection, rates, maxContextTokens: selection.maxContextTokens ?? rates?.context };
  }, [selection, tokenConfig]);
}
