import { memo } from 'react';
import { Share2Icon } from 'lucide-react';
import { Button, TooltipAnchor } from '@librechat/client';
import { Permissions, ResourceType, PermissionTypes } from 'librechat-data-provider';
import type { TSkill } from 'librechat-data-provider';
import { useHasAccess, useLocalize, useSkillPermissions } from '~/hooks';
import { GenericGrantAccessDialog } from '~/components/Sharing';

// Memoed because it renders inside `SkillForm`'s header, which re-renders on
// every keystroke via react-hook-form state updates. The `skill` prop stays
// referentially stable between renders as long as the server-side version
// hasn't changed, so the memo skips that work.

interface ShareSkillProps {
  skill: TSkill;
  disabled?: boolean;
}

function ShareSkill({ skill, disabled }: ShareSkillProps) {
  const localize = useLocalize();
  const permissions = useSkillPermissions(skill);

  const hasAccessToShareSkills = useHasAccess({
    permissionType: PermissionTypes.SKILLS,
    permission: Permissions.SHARE,
  });

  if (permissions.isLoading || !hasAccessToShareSkills || !permissions.canShare) {
    return null;
  }

  return (
    <GenericGrantAccessDialog
      resourceDbId={skill._id}
      resourceName={skill.name}
      resourceType={ResourceType.SKILL}
      disabled={disabled}
    >
      <TooltipAnchor
        description={localize('com_ui_share')}
        side="bottom"
        render={
          <Button
            variant="outline"
            size="icon"
            className="border-border-medium size-9"
            aria-label={localize('com_ui_share')}
            disabled={disabled}
          >
            <Share2Icon className="size-5" aria-hidden="true" />
          </Button>
        }
      />
    </GenericGrantAccessDialog>
  );
}

export default memo(ShareSkill);
