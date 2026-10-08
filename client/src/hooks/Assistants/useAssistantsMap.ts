import { useMemo } from 'react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TAssistantsMap } from 'librechat-data-provider';
import { useListAssistantsQuery } from '~/data-provider';
import { mapAssistants } from '~/utils';

/**
 * Root feeds this straight into `AssistantsMapContext.Provider`, so the
 * returned reference must only change when the underlying data does. The
 * previous bare object literal (and `= {}` defaults) minted a new value every
 * render, which re-rendered every context consumer — message rows included —
 * on any unrelated Root render, e.g. the mobile drawer toggle.
 */
export default function useAssistantsMap({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}): TAssistantsMap {
  const { data: assistants } = useListAssistantsQuery(EModelEndpoint.assistants, undefined, {
    select: (res) => mapAssistants(res.data),
    enabled: isAuthenticated,
  });
  const { data: azureAssistants } = useListAssistantsQuery(
    EModelEndpoint.azureAssistants,
    undefined,
    {
      select: (res) => mapAssistants(res.data),
      enabled: isAuthenticated,
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
