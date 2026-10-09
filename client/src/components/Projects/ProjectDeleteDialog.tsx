import { useNavigate, useLocation } from 'react-router-dom';
import {
  Button,
  Spinner,
  OGDialog,
  OGDialogClose,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogContent,
  useToastContext,
} from '@librechat/client';
import type { TChatProject } from 'librechat-data-provider';
import type { ComponentProps } from 'react';
import { useDeleteProjectMutation } from '~/data-provider';
import { NotificationSeverity } from '~/common';
import { useLocalize } from '~/hooks';

type ProjectDeleteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: TChatProject;
  triggerRef?: ComponentProps<typeof OGDialog>['triggerRef'];
};

export default function ProjectDeleteDialog({
  open,
  onOpenChange,
  project,
  triggerRef,
}: ProjectDeleteDialogProps) {
  const localize = useLocalize();
  const navigate = useNavigate();
  const location = useLocation();
  const deleteProject = useDeleteProjectMutation();
  const { showToast } = useToastContext();

  const confirmDelete = () => {
    deleteProject.mutate(project._id, {
      onSuccess: () => {
        onOpenChange(false);
        if (location.pathname === `/projects/${project._id}`) {
          navigate('/projects');
        }
      },
      onError: () =>
        showToast({
          message: localize('com_ui_project_delete_error'),
          severity: NotificationSeverity.ERROR,
          showIcon: true,
        }),
    });
  };

  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
      <OGDialogContent className="w-11/12 max-w-md" showCloseButton={false}>
        <OGDialogHeader>
          <OGDialogTitle>{localize('com_ui_delete_project')}</OGDialogTitle>
        </OGDialogHeader>
        <div className="text-text-secondary text-sm">
          {localize('com_ui_delete_project_confirm', { name: project.name })}
        </div>
        <div className="flex justify-end gap-4 pt-4">
          <OGDialogClose asChild>
            <Button aria-label={localize('com_ui_cancel')} variant="outline">
              {localize('com_ui_cancel')}
            </Button>
          </OGDialogClose>
          <Button variant="destructive" onClick={confirmDelete} disabled={deleteProject.isLoading}>
            {deleteProject.isLoading ? <Spinner className="size-4" /> : localize('com_ui_delete')}
          </Button>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
