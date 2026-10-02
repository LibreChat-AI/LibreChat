import { OGDialog, OGDialogTitle, OGDialogHeader, OGDialogContent } from '@librechat/client';
import type { TChatProject } from 'librechat-data-provider';
import type { ComponentProps } from 'react';
import { useUpdateProjectMutation } from '~/data-provider';
import ProjectEditor from './ProjectEditor';
import { useLocalize } from '~/hooks';

type ProjectEditDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: TChatProject;
  triggerRef?: ComponentProps<typeof OGDialog>['triggerRef'];
};

export default function ProjectEditDialog({
  open,
  onOpenChange,
  project,
  triggerRef,
}: ProjectEditDialogProps) {
  const localize = useLocalize();
  /** Owned here, so a save in flight settles with its toast; the dialog stays open meanwhile. */
  const updateProject = useUpdateProjectMutation();
  const isBusy = updateProject.isLoading;
  return (
    <OGDialog
      open={open}
      onOpenChange={(next) => {
        if (next || !isBusy) {
          onOpenChange(next);
        }
      }}
      triggerRef={triggerRef}
    >
      <OGDialogContent
        className="w-11/12 max-w-md"
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          if (isBusy) {
            event.preventDefault();
          }
        }}
        onInteractOutside={(event) => {
          if (isBusy) {
            event.preventDefault();
          }
        }}
      >
        <OGDialogHeader>
          <OGDialogTitle>{localize('com_ui_edit_project')}</OGDialogTitle>
        </OGDialogHeader>
        {/* Mounted per opening so the form starts from the saved project. */}
        {open ? (
          <ProjectEditor
            project={project}
            layout="dialog"
            updateProject={updateProject}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </OGDialogContent>
    </OGDialog>
  );
}
