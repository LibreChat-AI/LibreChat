import { useEffect, useRef } from 'react';
import type { BrowserProductFact, ProductTracker } from 'librechat-data-provider';
import { useProductTracking } from '~/Providers/TrackingContext';

type Observation = Extract<BrowserProductFact, { name: 'librechat.feature.observed' }>;

/** Hidden panels do not count as opens. A later open produces a new observation. */
export function useFeatureObservation(
  feature: Observation['feature'],
  entryPoint: Observation['entryPoint'],
  visible = true,
  observation: Observation['observation'] = 'opened',
) {
  const track = useProductTracking();
  const recorded = useRef<{ track: ProductTracker<BrowserProductFact>; key: string }>();
  const key = `${feature}:${entryPoint}:${observation}`;
  useEffect(() => {
    if (!visible) {
      recorded.current = undefined;
      return;
    }
    if (recorded.current?.track === track && recorded.current.key === key) {
      return;
    }
    recorded.current = { track, key };
    track({ name: 'librechat.feature.observed', feature, entryPoint, observation });
  }, [track, feature, entryPoint, visible, observation, key]);
}
