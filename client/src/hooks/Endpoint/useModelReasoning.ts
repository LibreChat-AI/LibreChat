import { useMemo } from 'react';
import { Providers, getModelReasoning, effectiveModelReasoning } from 'librechat-data-provider';
import type { TEndpointsConfig, TModelReasoning } from 'librechat-data-provider';
import { useReasoningCapabilitiesQuery } from '~/data-provider';

/** Whether the endpoint's parameter set is OpenRouter's, the only one with per-model efforts. */
export function isOpenRouterEndpoint(
  endpointsConfig: TEndpointsConfig | undefined,
  endpoint: string,
): boolean {
  return endpointsConfig?.[endpoint]?.customParams?.defaultParamsEndpoint === Providers.OPENROUTER;
}

/**
 * The reasoning efforts the selected OpenRouter model accepts, for
 * `applyModelAwareDefaults` and `resolveReasoningSettingForTarget`: `undefined`
 * while unknown (loading, failed, or not an OpenRouter endpoint), so the
 * generic list stays, and `null` once loaded when the model reports none.
 * The request is made only for an OpenRouter endpoint.
 */
export function useModelReasoning(
  endpointsConfig: TEndpointsConfig | undefined,
  endpoint: string,
  model: string,
): { modelReasoning: TModelReasoning | null | undefined } {
  const enabled = isOpenRouterEndpoint(endpointsConfig, endpoint);
  const { data: capabilities } = useReasoningCapabilitiesQuery({ enabled });
  const paramDefinitions = endpointsConfig?.[endpoint]?.customParams?.paramDefinitions;
  const modelReasoning = useMemo(
    () =>
      enabled && model
        ? effectiveModelReasoning(
            getModelReasoning(capabilities, endpoint, model),
            paramDefinitions,
          )
        : undefined,
    [capabilities, enabled, endpoint, model, paramDefinitions],
  );
  return { modelReasoning };
}
