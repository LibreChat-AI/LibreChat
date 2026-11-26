import type { TSkill } from 'librechat-data-provider';
import { useSkillsOpened } from '~/hooks/useProductObservation';

/** Route text becomes an object identity only after the skill lookup succeeds. */
export function useSkillOpened(
  requestedId: string,
  skill: Pick<TSkill, '_id'> | undefined,
  loaded: boolean,
) {
  useSkillsOpened('route', loaded && skill?._id === requestedId, loaded ? skill?._id : undefined);
}
