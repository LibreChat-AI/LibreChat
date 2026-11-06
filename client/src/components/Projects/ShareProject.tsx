import { Share2Icon } from 'lucide-react';
import { Button, TooltipAnchor } from '@librechat/client';
import { Permissions, ResourceType, PermissionTypes } from 'librechat-data-provider';
import type { TChatProject } from 'librechat-data-provider';
import { GenericGrantAccessDialog } from '~/components/Sharing';
import { useHasAccess, useLocalize } from '~/hooks';

interface ShareProjectProps {
  project: Pick<TChatProject, '_id' | 'name'>;
}

/** Opens the shared access dialog for a project; shown only to its owner. */
export default function ShareProject({ project }: ShareProjectProps) {
  const localize = useLocalize();
  const canShareProjects = useHasAccess({
    permissionType: PermissionTypes.PROJECTS,
    permission: Permissions.SHARE,
  });

  if (!canShareProjects) {
    return null;
  }

  return (
    <GenericGrantAccessDialog
      resourceDbId={project._id}
      resourceId={project._id}
      resourceName={project.name}
      resourceType={ResourceType.CHAT_PROJECT}
    >
      <TooltipAnchor
        description={localize('com_ui_share_project')}
        side="bottom"
        render={
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0"
            aria-label={localize('com_ui_share_project')}
          >
            <Share2Icon className="size-5" aria-hidden="true" />
          </Button>
        }
      />
    </GenericGrantAccessDialog>
  );
}
