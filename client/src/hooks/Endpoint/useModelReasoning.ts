import { useMemo } from 'react';
import { usesReasoningCapabilities } from '@librechat/chat';
import { resolveModelReasoning } from 'librechat-data-provider';
import type { TEndpointsConfig, TModelReasoning } from 'librechat-data-provider';
import { useReasoningCapabilitiesQuery } from '~/data-provider';

export { usesReasoningCapabilities };

/**
 * The reasoning efforts the selected OpenRouter model accepts, for `applyModelAwareDefaults`
 * and `resolveReasoningSettingForTarget` (see `resolveModelReasoning`). `pending` is true while
 * the capabilities are unknown, because the request is in flight or failed: the efforts are hidden
 * then, so a choice cannot be made from the generic list, but a value already stored or staged
 * must be kept, not cleared, until the catalog can confirm or refute it.
 */
export function useModelReasoning(
  endpointsConfig: TEndpointsConfig | undefined,
  endpoint: string,
  model: string,
): { modelReasoning: TModelReasoning | null | undefined; pending: boolean } {
  const enabled = usesReasoningCapabilities(endpointsConfig, endpoint);
  const { data, isError, isFetching } = useReasoningCapabilitiesQuery(endpoint, { enabled });
  /** React Query keeps the previous data while a refresh runs or fails, so the query state, not the
   *  data, says whether the efforts are known. The query only refetches once the server's entry
   *  has expired or a request failed, so the retained data is out of date for as long as it runs. */
  const capabilities = isError || isFetching ? undefined : data?.capabilities;
  const paramDefinitions = endpointsConfig?.[endpoint]?.customParams?.paramDefinitions;
  const pending = enabled && capabilities == null;
  const modelReasoning = useMemo(
    () =>
      enabled && model
        ? resolveModelReasoning({ capabilities, endpoint, model, paramDefinitions })
        : undefined,
    [capabilities, enabled, endpoint, model, paramDefinitions],
  );
  return { modelReasoning, pending };
}
