import { useMemo } from 'react';
import type { TMessage } from 'librechat-data-provider';
import { getLiteLLMAgentModelLabel } from '~/utils/litellm';
import { useGetStartupConfig } from '~/data-provider';

/**
 * The routed-model label of one agent's column of a comparison response, read from
 * the metadata of the message being rendered, so it costs one lookup per render and
 * needs no subscription of its own.
 */
export default function useRoutedModelLabel({
  agentId,
  metadata,
}: {
  agentId?: string;
  metadata?: TMessage['metadata'];
}): string | undefined {
  const { data: startupConfig } = useGetStartupConfig();
  const modelSpecs = startupConfig?.modelSpecs;
  return useMemo(
    () =>
      agentId != null && metadata != null
        ? getLiteLLMAgentModelLabel(modelSpecs, { metadata }, agentId)
        : undefined,
    [agentId, metadata, modelSpecs],
  );
}
