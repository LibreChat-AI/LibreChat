import { useMemo } from 'react';
import {
  Providers,
  resolveModelReasoning,
  hasExplicitReasoningEffort,
} from 'librechat-data-provider';
import type { TEndpointsConfig, TModelReasoning } from 'librechat-data-provider';
import { useReasoningCapabilitiesQuery } from '~/data-provider';

/**
 * Whether the endpoint's efforts come from a per-model catalog: an OpenRouter parameter set
 * whose administrator did not define `reasoning_effort` themselves. Anything else needs no
 * request and no waiting.
 */
export function usesReasoningCapabilities(
  endpointsConfig: TEndpointsConfig | undefined,
  endpoint: string,
): boolean {
  const customParams = endpointsConfig?.[endpoint]?.customParams;
  return (
    customParams?.defaultParamsEndpoint === Providers.OPENROUTER &&
    !hasExplicitReasoningEffort(customParams.paramDefinitions)
  );
}

/**
 * The reasoning efforts the selected OpenRouter model accepts, for `applyModelAwareDefaults`
 * and `resolveReasoningSettingForTarget` (see `resolveModelReasoning`). `pending` is true while
 * the first request is in flight: the efforts are hidden then, so a choice cannot be made from
 * the generic list, but a value already stored or staged must be kept, not cleared, until the
 * catalog can confirm or refute it.
 */
export function useModelReasoning(
  endpointsConfig: TEndpointsConfig | undefined,
  endpoint: string,
  model: string,
): { modelReasoning: TModelReasoning | null | undefined; pending: boolean } {
  const enabled = usesReasoningCapabilities(endpointsConfig, endpoint);
  const { data: capabilities, isInitialLoading } = useReasoningCapabilitiesQuery(endpoint, {
    enabled,
  });
  const pending = enabled && isInitialLoading;
  const modelReasoning = useMemo(
    () =>
      enabled && model
        ? resolveModelReasoning({ capabilities, settled: !pending, endpoint, model })
        : undefined,
    [capabilities, enabled, endpoint, model, pending],
  );
  return { modelReasoning, pending };
}
