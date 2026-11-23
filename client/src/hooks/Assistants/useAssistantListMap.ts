import { useMemo } from 'react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { AssistantListResponse, AssistantsEndpoint } from 'librechat-data-provider';
import type { AssistantListItem } from '~/common';
import { useCatalogReady } from '~/hooks/useCatalogWarmup';
import { useListAssistantsQuery } from '~/data-provider';

const selectAssistantsResponse = (res: AssistantListResponse): AssistantListItem[] =>
  res.data.map(({ id, name, metadata, model }) => ({
    id,
    name: name ?? '',
    metadata,
    model,
  }));

export default function useAssistantListMap<T = AssistantListItem[] | null>(
  selector: (res: AssistantListResponse) => T = selectAssistantsResponse as (
    res: AssistantListResponse,
  ) => T,
  options?: { enabled?: boolean; eager?: boolean },
): Record<AssistantsEndpoint, T | null> {
  const ready = useCatalogReady('assistants');
  const enabled = (options?.enabled ?? true) && (ready || options?.eager === true);
  const { data: assistantsList = null } = useListAssistantsQuery(
    EModelEndpoint.assistants,
    undefined,
    {
      select: selector,
      enabled,
    },
  );

  const { data: azureAssistants = null } = useListAssistantsQuery(
    EModelEndpoint.azureAssistants,
    undefined,
    {
      select: selector,
      enabled,
    },
  );

  const assistantListMap = useMemo(() => {
    return {
      [EModelEndpoint.assistants]: assistantsList,
      [EModelEndpoint.azureAssistants]: azureAssistants,
    };
  }, [assistantsList, azureAssistants]);

  return assistantListMap;
}
