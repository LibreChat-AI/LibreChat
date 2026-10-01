import { OGDialog, OGDialogTitle, OGDialogHeader, OGDialogContent } from '@librechat/client';
import type { TChatProject } from 'librechat-data-provider';
import type { ComponentProps } from 'react';
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
  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
      <OGDialogContent className="w-11/12 max-w-md" showCloseButton={false}>
        <OGDialogHeader>
          <OGDialogTitle>{localize('com_ui_edit_project')}</OGDialogTitle>
        </OGDialogHeader>
        {/* Mounted per opening so the form starts from the saved project. */}
        {open ? (
          <ProjectEditor project={project} layout="dialog" onDone={() => onOpenChange(false)} />
        ) : null}
      </OGDialogContent>
    </OGDialog>
  );
}
