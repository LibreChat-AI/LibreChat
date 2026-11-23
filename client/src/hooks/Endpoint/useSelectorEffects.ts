import React, { useEffect } from 'react';
import { isAgentsEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';
import type * as t from 'librechat-data-provider';
import type { SelectedValues } from '~/common';

export default function useSelectorEffects({
  conversation,
  setSelectedValues,
}: {
  index?: number;
  agentsMap: t.TAgentsMap | undefined;
  assistantsMap: t.TAssistantsMap | undefined;
  conversation: t.TConversation | null;
  setSelectedValues: React.Dispatch<React.SetStateAction<SelectedValues>>;
}) {
  const { endpoint, model: selectedModel, spec, agent_id, assistant_id } = conversation ?? {};
  useEffect(() => {
    if (!endpoint) return;
    let model = selectedModel ?? '';
    if (isAgentsEndpoint(endpoint)) model = agent_id ?? '';
    if (isAssistantsEndpoint(endpoint)) model = assistant_id ?? '';
    const timer = setTimeout(
      () =>
        setSelectedValues({
          endpoint,
          model,
          modelSpec: spec ?? '',
        }),
      150,
    );
    return () => clearTimeout(timer);
  }, [endpoint, selectedModel, spec, agent_id, assistant_id, setSelectedValues]);
}
