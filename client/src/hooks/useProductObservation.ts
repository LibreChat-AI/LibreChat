import { useEffect, useRef } from 'react';
import type { BrowserProductFact, ProductTracker } from 'librechat-data-provider';
import { useProductTracking } from '~/Providers/TrackingContext';

type Observation = Extract<BrowserProductFact, { name: 'librechat.feature.observed' }>;

/** Hidden panels do not count as opens. A later open produces a new observation. */
type SkillOpen = Extract<BrowserProductFact, { name: 'librechat.skills.opened' }>;
type ObservationArgs =
  | [
      feature: 'skills',
      entryPoint: SkillOpen['entryPoint'],
      visible?: boolean,
      observation?: Observation['observation'],
      skillId?: string,
    ]
  | [
      feature: 'prompts',
      entryPoint: Observation['entryPoint'],
      visible?: boolean,
      observation?: Observation['observation'],
      skillId?: undefined,
    ];

export function useFeatureObservation(
  ...[feature, entryPoint, visible = true, observation = 'opened', skillId]: ObservationArgs
) {
  const track = useProductTracking();
  const recorded = useRef<{ track: ProductTracker<BrowserProductFact>; key: string }>();
  const key = `${feature}:${entryPoint}:${observation}:${skillId ?? ''}`;
  useEffect(() => {
    if (!visible) {
      recorded.current = undefined;
      return;
    }
    if (recorded.current?.track === track && recorded.current.key === key) {
      return;
    }
    recorded.current = { track, key };
    if (feature === 'skills') {
      track({
        name: 'librechat.skills.opened',
        feature,
        entryPoint,
        ...(skillId ? { skillId } : {}),
      });
    } else {
      track({ name: 'librechat.feature.observed', feature, entryPoint, observation });
    }
    return () => {
      recorded.current = undefined;
    };
  }, [track, feature, entryPoint, visible, observation, key, skillId]);
}
