import { useEffect } from 'react';
import type { BrowserProductFact } from 'librechat-data-provider';
import { useProductTracking } from '~/Providers/TrackingContext';

type SkillOpen = Extract<BrowserProductFact, { name: 'librechat.skills.opened' }>;

/** Hidden panels do not count as opens. A later open produces a new fact. */
export function useSkillsOpened(
  entryPoint: SkillOpen['entryPoint'],
  visible = true,
  skillId?: string,
) {
  const track = useProductTracking();
  useEffect(() => {
    if (!visible) return;
    track({
      name: 'librechat.skills.opened',
      feature: 'skills',
      entryPoint,
      ...(skillId ? { skillId } : {}),
    });
  }, [track, entryPoint, visible, skillId]);
}
