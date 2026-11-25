import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { Button, TooltipAnchor, OGDialogTrigger } from '@librechat/client';
import CreatePromptDialog from '../dialogs/CreatePromptDialog';
import { useHasAccess, useLocalize } from '~/hooks';

export default function CreatePromptButton() {
  const localize = useLocalize();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const hasCreateAccess = useHasAccess({
    permissionType: PermissionTypes.PROMPTS,
    permission: Permissions.CREATE,
  });

  if (!hasCreateAccess) {
    return null;
  }

  return (
    <CreatePromptDialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
      <OGDialogTrigger asChild>
        <TooltipAnchor
          description={localize('com_ui_create_prompt')}
          side="bottom"
          render={
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label={localize('com_ui_create_prompt')}
              onClick={() => setIsDialogOpen(true)}
            >
              <Plus className="size-4" aria-hidden="true" />
            </Button>
          }
        />
      </OGDialogTrigger>
    </CreatePromptDialog>
  );
}
