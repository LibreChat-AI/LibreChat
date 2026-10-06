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
 * The reasoning efforts the selected OpenRouter model accepts, for `applyModelAwareDefaults`
 * and `resolveReasoningSettingForTarget`: `undefined` when unknown (the request failed, or
 * this is not an OpenRouter endpoint), so the generic list stays; `null` once loaded when the
 * model reports none, and also while the first request is in flight. Hiding the control then
 * is deliberate: a choice made from the generic list could be refused by the server, and a
 * saved value is kept regardless of what the control shows. An administrator-defined
 * `reasoning_effort` is never narrowed or hidden. The request is made only for an OpenRouter
 * endpoint.
 */
export function useModelReasoning(
  endpointsConfig: TEndpointsConfig | undefined,
  endpoint: string,
  model: string,
): { modelReasoning: TModelReasoning | null | undefined } {
  const enabled = isOpenRouterEndpoint(endpointsConfig, endpoint);
  const { data: capabilities, isInitialLoading } = useReasoningCapabilitiesQuery(endpoint, {
    enabled,
  });
  const paramDefinitions = endpointsConfig?.[endpoint]?.customParams?.paramDefinitions;
  const modelReasoning = useMemo(() => {
    if (!enabled || !model) {
      return undefined;
    }
    const reported = isInitialLoading ? null : getModelReasoning(capabilities, endpoint, model);
    return effectiveModelReasoning(reported, paramDefinitions);
  }, [capabilities, enabled, endpoint, isInitialLoading, model, paramDefinitions]);
  return { modelReasoning };
}
