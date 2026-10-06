import { useMemo, useState, type RefObject } from 'react';
import { Folder } from 'lucide-react';
import {
  Button,
  ControlCombobox,
  Label,
  OGDialog,
  OGDialogClose,
  OGDialogContent,
  OGDialogHeader,
  OGDialogTitle,
  Spinner,
  useToastContext,
} from '@librechat/client';
import type { TChatProject } from 'librechat-data-provider';
import type { OptionWithIcon } from '~/common';
import { useAssignConversationToProjectMutation, useProjectsInfiniteQuery } from '~/data-provider';
import { NotificationSeverity } from '~/common';
import { useLocalize } from '~/hooks';

type ProjectButtonProps = {
  conversationId: string;
  chatProjectId?: string | null;
  showProjectDialog?: boolean;
  setShowProjectDialog?: (value: boolean) => void;
  triggerRef?: RefObject<HTMLButtonElement>;
  setMenuOpen?: (open: boolean) => void;
  /** Called with the new project once the assignment has landed. */
  onAssigned?: (projectId: string) => void;
};

function ProjectConversationDialog({
  conversationId,
  chatProjectId,
  setMenuOpen,
  setShowProjectDialog,
  onAssigned,
}: {
  conversationId: string;
  chatProjectId?: string | null;
  setMenuOpen?: (open: boolean) => void;
  setShowProjectDialog: (value: boolean) => void;
  onAssigned?: (projectId: string) => void;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [selectedProjectId, setSelectedProjectId] = useState(chatProjectId ?? '');
  const assignConversation = useAssignConversationToProjectMutation();
  const { data, fetchNextPage, isFetchingNextPage } = useProjectsInfiniteQuery({
    sortBy: 'name',
    sortDirection: 'asc',
    limit: 100,
  });

  const projects = useMemo<TChatProject[]>(
    () => data?.pages.flatMap((page) => page.projects) ?? [],
    [data?.pages],
  );
  const hasNextPage = data?.pages[data.pages.length - 1]?.nextCursor != null;
  const selectedProject = projects.find((project) => project._id === selectedProjectId);
  const projectItems = useMemo<OptionWithIcon[]>(
    () =>
      projects.map((project) => ({
        label: project.name,
        value: project._id,
        icon: <Folder className="text-text-secondary h-4 w-4" aria-hidden="true" />,
      })),
    [projects],
  );
  const canSave =
    Boolean(selectedProjectId) &&
    selectedProjectId !== (chatProjectId ?? '') &&
    !assignConversation.isLoading;

  const saveProject = () => {
    if (!canSave) {
      return;
    }
    assignConversation.mutate(
      {
        conversationId,
        projectId: selectedProjectId,
      },
      {
        onSuccess: () => {
          onAssigned?.(selectedProjectId);
          setShowProjectDialog(false);
          setMenuOpen?.(false);
          showToast({
            message: localize('com_ui_project_updated'),
            severity: NotificationSeverity.SUCCESS,
            showIcon: true,
          });
        },
        onError: () => {
          showToast({
            message: localize('com_ui_project_update_error'),
            severity: NotificationSeverity.ERROR,
            showIcon: true,
          });
        },
      },
    );
  };

  return (
    <OGDialogContent
      id="project-conversation-dialog"
      className="w-11/12 max-w-md overflow-visible"
      showCloseButton={false}
    >
      <OGDialogHeader>
        <OGDialogTitle>{localize('com_ui_change_project')}</OGDialogTitle>
      </OGDialogHeader>
      <div className="flex flex-col gap-2">
        <Label htmlFor="change-project-select" className="text-text-primary text-sm font-medium">
          {localize('com_ui_select_project')}
        </Label>
        <ControlCombobox
          selectId="change-project-select"
          selectedValue={selectedProjectId}
          displayValue={selectedProject?.name}
          items={projectItems}
          setValue={setSelectedProjectId}
          SelectIcon={<Folder className="text-text-secondary h-4 w-4" aria-hidden="true" />}
          ariaLabel={localize('com_ui_select_project')}
          searchPlaceholder={localize('com_ui_search_projects')}
          selectPlaceholder={localize('com_ui_select_project')}
          isCollapsed={false}
          showCarat={true}
          placement="bottom-start"
          portal={false}
          matchTriggerWidth={true}
          containerClassName="w-full px-0"
          className="border-border-light bg-surface-tertiary text-text-primary hover:bg-surface-hover h-10 w-full justify-start gap-2 rounded-xl border px-3 text-sm"
        />
        {hasNextPage ? (
          <Button
            type="button"
            variant="link"
            className="h-auto justify-start px-0 text-sm"
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? localize('com_ui_loading') : localize('com_ui_load_more')}
          </Button>
        ) : null}
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <OGDialogClose asChild>
          <Button type="button" variant="outline">
            {localize('com_ui_cancel')}
          </Button>
        </OGDialogClose>
        <Button type="button" variant="submit" onClick={saveProject} disabled={!canSave}>
          {assignConversation.isLoading ? <Spinner /> : localize('com_ui_save')}
        </Button>
      </div>
    </OGDialogContent>
  );
}

export default function ProjectButton({
  conversationId,
  chatProjectId,
  setMenuOpen,
  showProjectDialog,
  setShowProjectDialog,
  triggerRef,
  onAssigned,
}: ProjectButtonProps) {
  if (showProjectDialog === undefined || setShowProjectDialog === undefined) {
    return null;
  }

  if (!conversationId) {
    return null;
  }

  return (
    <OGDialog open={showProjectDialog} onOpenChange={setShowProjectDialog} triggerRef={triggerRef}>
      <ProjectConversationDialog
        conversationId={conversationId}
        chatProjectId={chatProjectId}
        setMenuOpen={setMenuOpen}
        setShowProjectDialog={setShowProjectDialog}
        onAssigned={onAssigned}
      />
    </OGDialog>
  );
}
