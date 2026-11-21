import { useCallback, useEffect } from 'react';
import { safelyTrack } from 'librechat-data-provider';
import type { BrowserProductFact, ProductPromptReference } from 'librechat-data-provider';
import { useProductTracking, useProductTrackingContext } from '~/Providers/TrackingContext';

type PromptOpened = Extract<BrowserProductFact, { name: 'librechat.prompts.opened' }>;
export type PromptEntryPoint = PromptOpened['entryPoint'];

export { getProductPromptReference } from './reference';

export function usePromptOpened(entryPoint: PromptEntryPoint, visible = true, groupId?: string) {
  const track = useProductTracking();
  useEffect(() => {
    if (!visible) return;
    track({
      name: 'librechat.prompts.opened',
      feature: 'prompts',
      entryPoint,
      ...(groupId ? { groupId } : {}),
    });
  }, [track, entryPoint, visible, groupId]);
}

/** Explicit prompt resolution finishes after variable entry, before any later chat submission. */
export function usePromptResolved(entryPoint: PromptEntryPoint) {
  const track = useProductTracking();
  const getContext = useProductTrackingContext();
  return useCallback(
    (prompt: ProductPromptReference | undefined, variables: boolean) => {
      if (prompt) {
        safelyTrack(
          track,
          {
            name: 'librechat.prompts.resolved',
            feature: 'prompts',
            entryPoint,
            prompt,
            variables,
          },
          getContext(),
        );
      }
    },
    [track, getContext, entryPoint],
  );
}
