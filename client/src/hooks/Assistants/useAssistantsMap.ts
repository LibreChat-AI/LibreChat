import { useMemo } from 'react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TAssistantsMap, AssistantListResponse } from 'librechat-data-provider';
import { useCatalogReady } from '~/hooks/useCatalogWarmup';
import { useListAssistantsQuery } from '~/data-provider';
import { mapAssistants } from '~/utils';

const selectAssistants = (res: AssistantListResponse) => mapAssistants(res.data);

/**
 * Root feeds this straight into `AssistantsMapContext.Provider`, so the
 * returned reference must only change when the underlying data does. The
 * previous bare object literal (and `= {}` defaults) minted a new value every
 * render, which re-rendered every context consumer — message rows included —
 * on any unrelated Root render, e.g. the mobile drawer toggle.
 */
export default function useAssistantsMap({
  isAuthenticated,
  enabled,
}: {
  isAuthenticated: boolean;
  enabled?: boolean;
}): TAssistantsMap {
  const ready = useCatalogReady('assistants');
  const { data: assistants } = useListAssistantsQuery(EModelEndpoint.assistants, undefined, {
    select: selectAssistants,
    enabled: isAuthenticated && (enabled ?? ready),
  });
  const { data: azureAssistants } = useListAssistantsQuery(
    EModelEndpoint.azureAssistants,
    undefined,
    {
      select: selectAssistants,
      enabled: isAuthenticated && (enabled ?? ready),
    },
  );

  return useMemo(
    () => ({
      [EModelEndpoint.assistants]: assistants ?? {},
      [EModelEndpoint.azureAssistants]: azureAssistants ?? {},
    }),
    [assistants, azureAssistants],
  );
}
