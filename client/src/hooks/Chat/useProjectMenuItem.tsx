import { useToastContext } from '@librechat/client';
import { Check, Folder, FolderInput, FolderX } from 'lucide-react';
import type * as t from '~/common';
import { useAssignConversationToProjectMutation, useProjectsInfiniteQuery } from '~/data-provider';
import { NotificationSeverity } from '~/common';
import { useLocalize } from '~/hooks';

const iconClass = 'size-4 text-text-secondary';

type ProjectMenuItemParams = {
  conversationId: string;
  chatProjectId: string | null;
  /** The project list is only fetched while the menu that shows it is open. */
  enabled: boolean;
  /** Called once an assignment has landed, with `null` when the chat left its project. */
  onAssigned: (projectId: string | null) => void;
};

/**
 * One "Change project" menu item whose submenu lists every project, marks the current one,
 * and offers removal from it. Picking a project assigns it immediately.
 */
export default function useProjectMenuItem({
  conversationId,
  chatProjectId,
  enabled,
  onAssigned,
}: ProjectMenuItemParams): t.MenuItemProps {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const assignMutation = useAssignConversationToProjectMutation();
  const { data, isError, hasNextPage, fetchNextPage, refetch, isFetchingNextPage } =
    useProjectsInfiniteQuery({ sortBy: 'name', sortDirection: 'asc', limit: 100 }, { enabled });

  const assign = (projectId: string | null) => {
    assignMutation.mutate(
      { conversationId, projectId },
      {
        onSuccess: () => {
          onAssigned(projectId);
          showToast({
            message: localize('com_ui_project_updated'),
            severity: NotificationSeverity.SUCCESS,
            showIcon: true,
          });
        },
        onError: () =>
          showToast({
            message: localize('com_ui_project_update_error'),
            severity: NotificationSeverity.ERROR,
            showIcon: true,
          }),
      },
    );
  };

  const trigger: t.MenuItemProps = {
    label: localize('com_ui_change_project'),
    icon: <FolderInput className={iconClass} aria-hidden="true" />,
  };
  /** A disabled query still exposes cached data, and every row of the project page mounts this hook,
   *  so a closed menu builds nothing: the items exist only while their menu is open. */
  if (!enabled) {
    return { ...trigger, subItems: [{ label: localize('com_ui_loading'), disabled: true }] };
  }

  const projects = data?.pages.flatMap((page) => page.projects) ?? [];
  const subItems: t.MenuItemProps[] = [];
  if (projects.length > 0) {
    for (const project of projects) {
      const isCurrent = project._id === chatProjectId;
      subItems.push({
        label: project.name,
        onClick: () => assign(project._id),
        disabled: isCurrent,
        ariaChecked: isCurrent,
        ariaRole: 'menuitemradio',
        icon: isCurrent ? (
          <Check className={iconClass} aria-hidden="true" />
        ) : (
          <Folder className={iconClass} aria-hidden="true" />
        ),
      });
    }
  } else {
    let emptyKey: Parameters<typeof localize>[0] = 'com_ui_loading';
    if (isError) {
      emptyKey = 'com_ui_projects_load_error';
    } else if (data != null) {
      emptyKey = 'com_ui_no_projects';
    }
    subItems.push({ label: localize(emptyKey), disabled: true });
  }

  /** A failed request keeps whatever pages already loaded, so the failure is shown beside them
   *  with the retry that repeats the request that failed. */
  if (isError) {
    if (projects.length > 0) {
      subItems.push({ label: localize('com_ui_projects_load_error'), disabled: true });
    }
    subItems.push({
      label: localize('com_ui_retry'),
      onClick: () => (projects.length > 0 ? fetchNextPage() : refetch()),
      disabled: isFetchingNextPage,
      hideOnClick: false,
    });
  } else if (hasNextPage) {
    subItems.push({
      label: localize('com_ui_load_more'),
      onClick: () => fetchNextPage(),
      disabled: isFetchingNextPage,
      hideOnClick: false,
    });
  }

  if (chatProjectId != null) {
    subItems.push(
      { separate: true },
      {
        label: localize('com_ui_remove_from_project'),
        onClick: () => assign(null),
        icon: <FolderX className={iconClass} aria-hidden="true" />,
      },
    );
  }

  return { ...trigger, subItems };
}
