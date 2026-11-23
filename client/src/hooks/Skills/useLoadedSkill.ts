import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import type { LoadedSkill } from '@librechat/chat/react';
import { useGetSkillQuery, useSkillsInfiniteQuery } from '~/data-provider';
import { useHasAccess } from '~/hooks';

/**
 * The skill a call loaded, when the user can open it. The call carries a name, not an id, and
 * names are unique only per author: the skill resolves only when exactly one accessible skill
 * has the name, the same set the run resolved it from. Same-name duplicates, deployment skills
 * and skills the user cannot see resolve to nothing.
 */
export default function useLoadedSkill(name: string, enabled: boolean): LoadedSkill | undefined {
  const navigate = useNavigate();
  const canUse = useHasAccess({
    permissionType: PermissionTypes.SKILLS,
    permission: Permissions.USE,
  });
  const active = enabled && canUse && !!name;
  const { data: pages } = useSkillsInfiniteQuery({ search: name, limit: 10 }, { enabled: active });
  const id = useMemo(() => {
    if (!pages || pages.pages.at(-1)?.has_more) {
      return undefined;
    }
    const matches = pages.pages
      .flatMap((page) => page.skills)
      .filter((skill) => skill.name === name);
    return matches.length === 1 ? matches[0]._id : undefined;
  }, [pages, name]);
  const { data: skill } = useGetSkillQuery(id, { enabled: active });
  return useMemo(() => {
    if (!active || skill == null) {
      return undefined;
    }
    return { instructions: skill.body, open: () => navigate(`/skills/${skill._id}`) };
  }, [active, skill, navigate]);
}
