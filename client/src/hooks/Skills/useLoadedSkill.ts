import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import type { LoadedSkill } from '@librechat/chat/react';
import { useGetSkillQuery } from '~/data-provider';
import { useHasAccess } from '~/hooks';

/**
 * The skill a call loaded, by the id the server stamped on the call, when the user can open it.
 * A skill the user cannot see, or one deleted since, answers 404 and resolves to nothing, so the
 * card keeps the output the call recorded.
 */
export default function useLoadedSkill(id: string, enabled: boolean): LoadedSkill | undefined {
  const navigate = useNavigate();
  const canUse = useHasAccess({
    permissionType: PermissionTypes.SKILLS,
    permission: Permissions.USE,
  });
  const active = enabled && canUse && !!id;
  const { data: skill } = useGetSkillQuery(id, { enabled: active });
  return useMemo(() => {
    if (!active || skill == null) {
      return undefined;
    }
    return { instructions: skill.body, open: () => navigate(`/skills/${skill._id}`) };
  }, [active, skill, navigate]);
}
